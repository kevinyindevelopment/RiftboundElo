/**
 * Ingest the full event history of stores from carde.io — everything reachable
 * with the current token: event metadata, player counts, formats, dates, plus
 * any registrations / decklists / standings that happen to be published.
 *
 *   npm run ingest:stores                       # default: stores near your area
 *   npm run ingest:stores -- --store 1877 3436  # specific store ids
 *   npm run ingest:stores -- --near 43.42,-83.95 --miles 40
 *   npm run ingest:stores -- --decklists        # also try to pull decklists/players (slower)
 *
 * Match results are gated per-event, so most events store metadata only. Run
 * `npm run elo:recompute` afterwards if any matches were ingested.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  ensureAuth,
  hasToken,
  searchEvents,
  searchEventsNear,
  getRegistrations,
  getEventDetail,
  getRoundMatches,
  getRoundStandings,
  type V2Event,
  type V2Store,
  type V2Match,
  type V2UserEventStatus,
} from "../src/lib/carde";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RATE_MS = Number(process.env.INGEST_RATE_MS ?? 350);

// Default to the user's local Saginaw/Bay-area stores.
const DEFAULT_NEAR = { lat: 43.4195, lon: -83.9508, miles: 40 };

function parseArgs(argv: string[]) {
  const a = {
    stores: [] as number[],
    near: null as null | { lat: number; lon: number },
    miles: DEFAULT_NEAR.miles,
    results: true, // fetch rosters/records/matches by default
    full: false, // re-fetch results even for unchanged completed events
    discover: false, // run geo-discovery to find new stores
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--store") {
      while (argv[i + 1] && /^\d+$/.test(argv[i + 1])) a.stores.push(Number(argv[++i]));
    } else if (t === "--near") {
      const [lat, lon] = (argv[++i] ?? "").split(",").map(Number);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) a.near = { lat, lon };
    } else if (t === "--miles") {
      a.miles = Number(argv[++i]) || a.miles;
    } else if (t === "--meta-only") {
      a.results = false; // event metadata only, skip rosters/matches
    } else if (t === "--full") {
      a.full = true; // ignore incremental skip; re-fetch all results
    } else if (t === "--discover") {
      a.discover = true; // run geo-discovery for new stores near you
    }
  }
  return a;
}

async function upsertStore(s: V2Store) {
  await prisma.store.upsert({
    where: { id: String(s.id) },
    create: {
      id: String(s.id),
      name: s.name,
      country: s.country ?? null,
      state: s.state ?? null,
      city: s.city ?? null,
      address: s.full_address ?? null,
      website: s.website ?? null,
      latitude: s.latitude ?? null,
      longitude: s.longitude ?? null,
    },
    update: {
      name: s.name,
      country: s.country ?? null,
      state: s.state ?? null,
      city: s.city ?? null,
      address: s.full_address ?? null,
      website: s.website ?? null,
      latitude: s.latitude ?? null,
      longitude: s.longitude ?? null,
    },
  });
}

/** Some fields arrive as either a plain string or a { name } object. */
function asStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "name" in (v as object)) {
    const n = (v as { name?: unknown }).name;
    return typeof n === "string" ? n : null;
  }
  return null;
}

async function upsertEvent(e: V2Event) {
  const data = {
    name: e.name,
    format: asStr(e.gameplay_format) ?? asStr(e.event_format),
    gameType: asStr(e.event_type),
    gameplayFormat: asStr(e.event_format) ?? asStr(e.gameplay_format),
    eventType: asStr(e.event_type),
    startDatetime: e.start_datetime ? new Date(e.start_datetime) : null,
    endDatetime: e.end_datetime ? new Date(e.end_datetime) : null,
    status: e.display_status ?? e.event_status ?? null,
    numPlayers: e.registered_user_count ?? e.starting_player_count ?? 0,
    capacity: e.capacity ?? null,
    costCents: e.cost_in_cents ?? null,
    currency: e.currency ?? null,
    url: e.url ?? null,
    isOnline: Boolean(e.event_is_online),
    // detail-only fields: use `undefined` so a metadata-only refresh from the
    // list endpoint never wipes values we filled in from the detail endpoint.
    description: e.description || undefined,
    rulesEnforcement: e.rules_enforcement_level ?? undefined,
    numRounds: e.number_of_rounds ?? undefined,
    topCut: e.top_cut_size ?? undefined,
    sourceUpdatedAt: e.updated_at ? new Date(e.updated_at) : undefined,
    storeId: e.store ? String(e.store.id) : null,
  };
  await prisma.event.upsert({
    where: { id: String(e.id) },
    create: { id: String(e.id), ...data },
    update: data,
  });
}

/** Upsert a player using gamer tag (handle) + real name (displayName). */
async function upsertPlayer(
  id: string,
  gamerTag: string | null | undefined,
  realName: string | null | undefined,
) {
  const handle = gamerTag || null;
  const displayName = realName || gamerTag || id;
  await prisma.player.upsert({
    where: { id },
    create: { id, handle, displayName },
    update: {
      // keep the better value if we already have one
      handle: handle ?? undefined,
      displayName: realName ?? undefined,
    },
  });
}

/** Upsert a deck keyed by its Legend name. */
async function upsertLegendDeck(name?: string | null): Promise<string | null> {
  if (!name) return null;
  const id = `legend:${name}`;
  await prisma.deck.upsert({
    where: { id },
    create: { id, name, legend: name, archetype: name },
    update: {},
  });
  return id;
}

function winnerId(m: V2Match): number | null {
  const w = m.winning_player;
  if (w == null) return null;
  return typeof w === "object" ? w.id : w;
}

/**
 * Ingest a single event's published results: roster (with gamer tag, real name,
 * standing, record, deck) plus head-to-head matches for Elo. Returns counts.
 */
async function ingestEventResults(eventId: number) {
  let players = 0;
  let matches = 0;
  let hasResults = false;

  // 1) Roster + per-event record/standing/deck from registrations.
  const ues = new Map<string, V2UserEventStatus>(); // userId -> status (for decks in matches)
  try {
    const regs = await getRegistrations(eventId);
    for (const r of regs.results ?? []) {
      const u = (r.user as { id: number; best_identifier?: string } | undefined) ?? null;
      const id = u?.id ?? r.id;
      if (id == null) continue;
      const gamerTag = (r.best_identifier as string) || u?.best_identifier; // reg-level = gamer tag
      const realName = u?.best_identifier; // user-level = real name
      await upsertPlayer(String(id), gamerTag, realName);

      const w = Number(r.matches_won ?? 0);
      const l = Number(r.matches_lost ?? 0);
      const d = Number(r.matches_drawn ?? 0);
      if (w + l + d > 0) hasResults = true;
      const deckId = await upsertLegendDeck(
        (r.deck_defining_card as { name?: string } | undefined)?.name,
      );
      await prisma.eventEntry.upsert({
        where: { eventId_playerId: { eventId: String(eventId), playerId: String(id) } },
        create: {
          eventId: String(eventId),
          playerId: String(id),
          finalStanding: (r.final_place_in_standings as number) ?? null,
          matchPoints: (r.total_match_points as number) ?? null,
          matchesWon: w,
          matchesLost: l,
          matchesDrawn: d,
          deckId,
        },
        update: {
          finalStanding: (r.final_place_in_standings as number) ?? null,
          matchPoints: (r.total_match_points as number) ?? null,
          matchesWon: w,
          matchesLost: l,
          matchesDrawn: d,
          deckId: deckId ?? undefined,
        },
      });
      players++;
    }
  } catch {
    /* gated/empty */
  }

  // 2) Head-to-head matches (only if results exist) for Elo.
  if (hasResults) {
    try {
      const detail = await getEventDetail(eventId);
      const rounds: { id: number; round_number: number }[] = [];
      for (const phase of detail.tournament_phases ?? []) {
        for (const r of phase.rounds ?? []) {
          if (/PLAY|SWISS|ELIM|DRAFT|POD|OPPONENT/i.test(r.round_type ?? "")) {
            rounds.push({ id: r.id, round_number: r.round_number });
          }
        }
      }
      // Richer metadata only exists on the detail endpoint.
      await prisma.event.update({
        where: { id: String(eventId) },
        data: {
          description: detail.description || undefined,
          rulesEnforcement: detail.rules_enforcement_level ?? undefined,
          numRounds: detail.number_of_rounds ?? (rounds.length || undefined),
          topCut: detail.top_cut_size ?? undefined,
        },
      });
      for (const round of rounds) {
        const roundMatches = await getRoundMatches(round.id);
        for (const m of roundMatches) {
          const pmrs = [...m.player_match_relationships].sort(
            (a, b) => (a.player_order ?? 0) - (b.player_order ?? 0),
          );
          const p1 = pmrs[0]?.player;
          const p2 = pmrs[1]?.player;
          if (!p1) continue;
          // ensure players exist (in case not in registrations)
          await upsertPlayer(String(p1.id), pmrs[0]?.user_event_status?.best_identifier, p1.best_identifier);
          if (p2) await upsertPlayer(String(p2.id), pmrs[1]?.user_event_status?.best_identifier, p2.best_identifier);

          const isBye = Boolean(m.match_is_bye) || !p2;
          const isDraw = Boolean(m.match_is_intentional_draw || m.match_is_unintentional_draw);
          const win = isDraw ? null : winnerId(m);
          const gw = Number(m.games_won_by_winner ?? 0);
          const gl = Number(m.games_won_by_loser ?? 0);
          const p1IsWinner = win != null && win === p1.id;
          const deck1 = await upsertLegendDeck(pmrs[0]?.user_event_status?.deck_defining_card?.name);
          const deck2 = await upsertLegendDeck(pmrs[1]?.user_event_status?.deck_defining_card?.name);

          await prisma.match.upsert({
            where: { id: String(m.id) },
            create: {
              id: String(m.id),
              eventId: String(eventId),
              roundNumber: round.round_number ?? null,
              playerOneId: String(p1.id),
              playerTwoId: String(p2?.id ?? p1.id),
              playerOneWins: isBye ? 0 : p1IsWinner ? gw : gl,
              playerTwoWins: isBye ? 0 : p1IsWinner ? gl : gw,
              draws: Number(m.games_drawn ?? 0),
              winnerId: win == null ? null : String(win),
              isBye,
              deckOneId: deck1,
              deckTwoId: deck2,
              playedAt: m.created_at ? new Date(m.created_at) : null,
            },
            update: {
              playerOneWins: isBye ? 0 : p1IsWinner ? gw : gl,
              playerTwoWins: isBye ? 0 : p1IsWinner ? gl : gw,
              winnerId: win == null ? null : String(win),
              isBye,
            },
          });
          matches++;
        }
        await sleep(RATE_MS);
      }

      // Official standings + tiebreakers from the final round.
      const finalRound = rounds.reduce(
        (best, r) => (r.round_number > (best?.round_number ?? -1) ? r : best),
        rounds[0],
      );
      if (finalRound) {
        const { standings } = await getRoundStandings(finalRound.id);
        for (const s of standings ?? []) {
          const pid = String(s.player?.id);
          if (!pid || pid === "undefined") continue;
          await prisma.eventEntry.upsert({
            where: { eventId_playerId: { eventId: String(eventId), playerId: pid } },
            create: {
              eventId: String(eventId),
              playerId: pid,
              finalStanding: s.rank ?? null,
              matchPoints: s.match_points ?? null,
              omwPct: s.opponent_match_win_percentage ?? null,
              gwPct: s.game_win_percentage ?? null,
              ogwPct: s.opponent_game_win_percentage ?? null,
            },
            update: {
              finalStanding: s.rank ?? undefined,
              matchPoints: s.match_points ?? undefined,
              omwPct: s.opponent_match_win_percentage ?? undefined,
              gwPct: s.game_win_percentage ?? undefined,
              ogwPct: s.opponent_game_win_percentage ?? undefined,
            },
          });
        }
        await sleep(RATE_MS);
      }
    } catch {
      /* round/match data gated */
    }
  }

  return { players, matches, hasResults };
}

// NOTE: the v2 events API misbehaves when several display_statuses are combined
// (it collapses to upcoming-only), so we query each status separately and merge.
const STATUSES = ["completed", "upcoming", "inProgress"] as const;

function timeMs(d: Date | null | undefined): number | null {
  return d ? d.getTime() : null;
}

async function ingestStore(storeId: number, opts: { results: boolean; full: boolean }) {
  let total = 0;
  let fetched = 0;
  let skipped = 0;
  let storeName = `store ${storeId}`;
  const seen = new Set<number>();

  // Prefetch what we already have for this store to drive incremental sync.
  const existing = new Map<string, number | null>();
  for (const ev of await prisma.event.findMany({
    where: { storeId: String(storeId) },
    select: { id: true, sourceUpdatedAt: true },
  })) {
    existing.set(ev.id, timeMs(ev.sourceUpdatedAt));
  }

  for (const status of STATUSES) {
    let page = 1;
    for (;;) {
      const res = await searchEvents({ storeId, statuses: [status], page, pageSize: 50 });
      const events = res.results ?? [];
      if (events.length === 0) break;
      for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (e.store) {
          await upsertStore(e.store);
          storeName = e.store.name;
        }

        // Decide whether the expensive result-fetch is worth doing.
        const isCompleted = /complete/i.test(status);
        const isUpcoming = /upcoming/i.test(status);
        const prev = existing.get(String(e.id));
        const apiUpdated = e.updated_at ? new Date(e.updated_at).getTime() : null;
        const changed = prev == null || apiUpdated == null || prev !== apiUpdated;

        await upsertEvent(e); // always refresh cheap metadata (counts, status…)
        total++;

        // Completed + unchanged → skip the whole result chain. Upcoming has no
        // results yet. In-progress / new / changed events get a full fetch.
        const fetchResults =
          opts.results && !isUpcoming && (opts.full || changed || !isCompleted);
        if (!fetchResults) {
          if (opts.results && isCompleted) skipped++;
          continue;
        }

        const extra = await ingestEventResults(e.id);
        fetched++;
        if (extra.players || extra.matches) {
          console.log(
            `    event ${e.id}: +${extra.players} players` +
              (extra.matches ? `, ${extra.matches} matches` : "") +
              (extra.hasResults ? " ✓results" : ""),
          );
        }
        await sleep(RATE_MS);
      }
      if (!res.next) break;
      page++;
      await sleep(RATE_MS);
    }
  }
  console.log(`✓ ${storeName}: ${total} events (${fetched} fetched, ${skipped} unchanged-skipped)`);
  return total;
}

async function discoverStores(lat: number, lon: number, miles: number): Promise<number[]> {
  const ids = new Set<number>();
  // Query each status separately (combined statuses collapse to upcoming-only)
  // so we also find stores that only have past events.
  for (const status of STATUSES) {
    for (let page = 1; page <= 10; page++) {
      const res = await searchEventsNear({
        latitude: lat,
        longitude: lon,
        miles,
        statuses: [status],
        page,
        pageSize: 50,
      });
      for (const e of res.results ?? []) if (e.store) ids.add(e.store.id);
      if (!res.next) break;
      await sleep(RATE_MS);
    }
  }
  return [...ids];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const authed = await ensureAuth().catch(() => false);
  console.log(
    hasToken() ? "Authenticated to carde.io." : "No token set — results will be limited.",
  );

  let storeIds = args.stores;
  if (storeIds.length === 0) {
    // Prefer the stores we already know (reference old data first — never
    // re-discover blindly). Only hit the geo-discovery API when explicitly
    // asked (--discover / --near) or when the DB has no stores yet.
    const known = (await prisma.store.findMany({ select: { id: true } })).map((s) => Number(s.id));
    if (args.discover || args.near || known.length === 0) {
      const near = args.near ?? { lat: DEFAULT_NEAR.lat, lon: DEFAULT_NEAR.lon };
      console.log(`Discovering stores within ${args.miles}mi of ${near.lat},${near.lon}…`);
      const found = await discoverStores(near.lat, near.lon, args.miles);
      storeIds = [...new Set([...known, ...found])];
      console.log(`Found ${found.length} stores (${storeIds.length} total incl. known).`);
    } else {
      storeIds = known;
      console.log(`Re-syncing ${storeIds.length} known stores (pass --discover to find new ones).`);
    }
  }

  let grand = 0;
  for (const id of storeIds) {
    grand += await ingestStore(id, { results: args.results, full: args.full });
    await sleep(RATE_MS);
  }

  const counts = {
    stores: await prisma.store.count(),
    events: await prisma.event.count(),
    players: await prisma.player.count(),
  };
  console.log(`\nIngested ${grand} events. DB now:`, counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
