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
import { assignAllRegions } from "./assign-regions";
import {
  ensureAuth,
  hasToken,
  searchEvents,
  searchEventsNear,
  getEventDetail,
  getRoundMatches,
  getRoundStandings,
  pool,
  type V2Event,
  type V2Store,
  type V2Match,
} from "../src/lib/carde";

// Default to the user's local Saginaw/Bay-area stores.
const DEFAULT_NEAR = { lat: 43.4195, lon: -83.9508, miles: 40 };

function parseArgs(argv: string[]) {
  const a = {
    stores: [] as number[],
    events: [] as number[], // ingest specific event ids directly (--event)
    near: null as null | { lat: number; lon: number },
    miles: DEFAULT_NEAR.miles,
    results: true, // fetch rosters/records/matches by default
    full: false, // re-fetch results even for unchanged completed events
    discover: false, // run geo-discovery to find new stores
    global: false, // nationwide date-windowed delta (ignores stores)
    sinceDays: 21, // global window: events starting within the last N days
    stateGrid: null as string | null, // tile a whole state with discovery discs (e.g. "CA","MI")
    gridMiles: 50, // grid disc radius
    gridStep: 65, // spacing between grid centers (≤ radius·√2 ⇒ gapless)
    premier: false, // ingest the official Organized Play hub store(s) — RQs etc.
    premierScan: false, // (thorough) global name/size scan for premier events anywhere
    minPlayers: 32, // premier-scan threshold: events with >= this many players
    country: null as string | null, // premier-scan: restrict to a store country (e.g. "US")
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--store") {
      while (argv[i + 1] && /^\d+$/.test(argv[i + 1])) a.stores.push(Number(argv[++i]));
    } else if (t === "--event") {
      while (argv[i + 1] && /^\d+$/.test(argv[i + 1])) a.events.push(Number(argv[++i]));
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
    } else if (t === "--global") {
      a.global = true; // nationwide date-windowed delta sync
    } else if (t === "--since-days") {
      a.sinceDays = Number(argv[++i]) || a.sinceDays;
    } else if (t === "--ca-grid") {
      a.stateGrid = "CA"; // tile all of California
    } else if (t === "--mi-grid") {
      a.stateGrid = "MI"; // tile all of Michigan
    } else if (t === "--state-grid") {
      a.stateGrid = (argv[++i] ?? "").trim().toUpperCase() || null; // any state
    } else if (t === "--grid-miles") {
      a.gridMiles = Number(argv[++i]) || a.gridMiles;
    } else if (t === "--grid-step") {
      a.gridStep = Number(argv[++i]) || a.gridStep;
    } else if (t === "--premier") {
      a.premier = true; // ingest the Organized Play hub store(s) (RQs etc.)
    } else if (t === "--premier-scan") {
      a.premierScan = true; // global name/size scan (catches premier under any store)
    } else if (t === "--min-players") {
      a.minPlayers = Number(argv[++i]) || a.minPlayers;
    } else if (t === "--country") {
      a.country = (argv[++i] ?? "").trim() || null;
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
    // Premier events report a misleading registered_user_count (often 1) but a
    // real starting_player_count — take the larger so big events show correctly.
    numPlayers: Math.max(
      Number(e.registered_user_count ?? 0),
      Number(e.starting_player_count ?? 0),
    ),
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

  // 1) One detail call gives round IDs, richer metadata, AND a cheap results
  // gate (per-round pairings/standings status) — no registrations call needed.
  let detail;
  try {
    detail = await getEventDetail(eventId);
  } catch {
    return { players: 0, matches: 0, hasResults: false };
  }
  const rounds: { id: number; round_number: number; pairings: boolean }[] = [];
  let resultsPublished = false;
  for (const phase of detail.tournament_phases ?? []) {
    for (const r of phase.rounds ?? []) {
      if (/PLAY|SWISS|ELIM|DRAFT|POD|OPPONENT/i.test(r.round_type ?? "")) {
        const pairings = r.pairings_status === "GENERATED";
        rounds.push({ id: r.id, round_number: r.round_number, pairings });
        if (pairings || r.standings_status === "GENERATED") resultsPublished = true;
      }
    }
  }

  // Refresh richer metadata regardless of results.
  await prisma.event.update({
    where: { id: String(eventId) },
    data: {
      description: detail.description || undefined,
      rulesEnforcement: detail.rules_enforcement_level ?? undefined,
      numRounds: detail.number_of_rounds ?? (rounds.length || undefined),
      topCut: detail.top_cut_size ?? undefined,
    },
  });

  // No published results → stop here (saved the registrations + matches +
  // standings calls entirely; only the 1 detail call was spent).
  if (!resultsPublished) return { players: 0, matches: 0, hasResults: false };
  const hasResults = true;

  try {
    // Fetch all rounds' matches + the final standings CONCURRENTLY.
    const finalRound = rounds.reduce(
      (best, r) => (r.round_number > (best?.round_number ?? -1) ? r : best),
      rounds[0],
    );
    const [roundResults, standingsRes] = await Promise.all([
      pool(
        rounds.filter((r) => r.pairings),
        (r) =>
          getRoundMatches(r.id)
            .then((ms) => ({ round: r, ms }))
            .catch(() => ({ round: r, ms: [] as V2Match[] })),
      ),
      finalRound
        ? getRoundStandings(finalRound.id).catch(() => ({ standings: [] }))
        : Promise.resolve({ standings: [] }),
    ]);

    // Collect rows in memory, then write in a FEW batched statements instead of
    // ~5 awaited round-trips per match. Per-row upserts to remote Neon were the
    // real bottleneck (a 400-match event = ~2000 round-trips ≈ a minute).
    const eid = String(eventId);
    const playerRows = new Map<string, { id: string; handle: string | null; displayName: string }>();
    const deckRows = new Map<string, { id: string; name: string; legend: string; archetype: string }>();
    const matchRows = new Map<string, Record<string, unknown>>();
    const entryRows = new Map<string, Record<string, unknown>>();

    const addPlayer = (id: string, tag?: string | null, real?: string | null) => {
      if (!playerRows.has(id))
        playerRows.set(id, { id, handle: tag || null, displayName: real || tag || id });
    };
    const addDeck = (name?: string | null): string | null => {
      if (!name) return null;
      const id = `legend:${name}`;
      if (!deckRows.has(id)) deckRows.set(id, { id, name, legend: name, archetype: name });
      return id;
    };

    for (const { round, ms: roundMatches } of roundResults) {
      for (const m of roundMatches) {
        const pmrs = [...m.player_match_relationships].sort(
          (a, b) => (a.player_order ?? 0) - (b.player_order ?? 0),
        );
        const p1 = pmrs[0]?.player;
        const p2 = pmrs[1]?.player;
        if (!p1) continue;
        addPlayer(String(p1.id), pmrs[0]?.user_event_status?.best_identifier, p1.best_identifier);
        if (p2) addPlayer(String(p2.id), pmrs[1]?.user_event_status?.best_identifier, p2.best_identifier);

        const isBye = Boolean(m.match_is_bye) || !p2;
        const isDraw = Boolean(m.match_is_intentional_draw || m.match_is_unintentional_draw);
        const win = isDraw ? null : winnerId(m);
        const gw = Number(m.games_won_by_winner ?? 0);
        const gl = Number(m.games_won_by_loser ?? 0);
        const p1IsWinner = win != null && win === p1.id;
        const deck1 = addDeck(pmrs[0]?.user_event_status?.deck_defining_card?.name);
        const deck2 = addDeck(pmrs[1]?.user_event_status?.deck_defining_card?.name);

        matchRows.set(String(m.id), {
          id: String(m.id),
          eventId: eid,
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
        });
      }
    }

    // Roster + records + standing + deck — ALL from the standings payload.
    for (const s of standingsRes.standings ?? []) {
      const pid = String(s.player?.id);
      if (!pid || pid === "undefined" || entryRows.has(pid)) continue;
      const u = s.user_event_status;
      addPlayer(pid, u?.best_identifier, s.player?.best_identifier);
      const deckId = addDeck(u?.deck_defining_card?.name);
      entryRows.set(pid, {
        eventId: eid,
        playerId: pid,
        finalStanding: s.rank ?? null,
        matchPoints: s.match_points ?? u?.total_match_points ?? null,
        matchesWon: u?.matches_won ?? 0,
        matchesLost: u?.matches_lost ?? 0,
        matchesDrawn: u?.matches_drawn ?? 0,
        omwPct: s.opponent_match_win_percentage ?? null,
        gwPct: s.game_win_percentage ?? null,
        ogwPct: s.opponent_game_win_percentage ?? null,
        deckId,
      });
    }

    // FK-safe order: players + decks first, then matches/entries. Replace this
    // event's matches/entries (delete+create) so re-ingest is idempotent.
    // Chunk every createMany — a big RQ (1900+ players, 10k+ matches) would
    // otherwise blow past Postgres's 65,535-parameter-per-statement limit.
    const CHUNK = 1000;
    const inChunks = <T>(arr: T[]): T[][] => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
      return out;
    };
    for (const c of inChunks([...playerRows.values()]))
      await prisma.player.createMany({ data: c, skipDuplicates: true });
    for (const c of inChunks([...deckRows.values()]))
      await prisma.deck.createMany({ data: c, skipDuplicates: true });
    await prisma.match.deleteMany({ where: { eventId: eid } });
    await prisma.eventEntry.deleteMany({ where: { eventId: eid } });
    for (const c of inChunks([...matchRows.values()]))
      await prisma.match.createMany({ data: c as never, skipDuplicates: true });
    for (const c of inChunks([...entryRows.values()]))
      await prisma.eventEntry.createMany({ data: c as never, skipDuplicates: true });
    matches = matchRows.size;
    players = entryRows.size;
  } catch (err) {
    // Results were published but a round/standings call or DB write failed —
    // surface it (don't silently drop a real event).
    console.error(`    ! event ${eventId} result-ingest failed:`, (err as Error)?.message ?? err);
  }

  return { players, matches, hasResults };
}

// NOTE: the v2 events API misbehaves when several display_statuses are combined
// (it collapses to upcoming-only), so we query each status separately and merge.
const STATUSES = ["completed", "upcoming", "inProgress"] as const;

// UVS's official "Organized Play" umbrella store hosts the premier events
// (Regional Qualifiers, and future premier event types) regardless of host city
// — the city is in the event name. Re-ingesting these stores picks up new
// premier event types automatically. Override/extend via OP_STORE_IDS env.
const OP_STORE_IDS = (process.env.OP_STORE_IDS ?? "19428")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

function timeMs(d: Date | null | undefined): number | null {
  return d ? d.getTime() : null;
}

async function ingestStore(storeId: number, opts: { results: boolean; full: boolean }) {
  let storeName = `store ${storeId}`;
  let storeUpserted = false;
  const seen = new Set<number>();
  let skipped = 0;
  const toFetch: number[] = []; // events needing the (expensive) result chain

  // Prefetch what we already have for this store to drive incremental sync.
  const existing = new Map<string, number | null>();
  for (const ev of await prisma.event.findMany({
    where: { storeId: String(storeId) },
    select: { id: true, sourceUpdatedAt: true },
  })) {
    existing.set(ev.id, timeMs(ev.sourceUpdatedAt));
  }

  // Pass 1: page listings, refresh metadata, decide what needs a deep fetch.
  for (const status of STATUSES) {
    let page = 1;
    for (;;) {
      const res = await searchEvents({ storeId, statuses: [status], page, pageSize: 100 });
      const events = res.results ?? [];
      if (events.length === 0) break;
      for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        // Upsert the store ONCE per ingestStore run (it's the same store for
        // every event) instead of once per event.
        if (e.store) {
          storeName = e.store.name;
          if (!storeUpserted) {
            await upsertStore(e.store);
            storeUpserted = true;
          }
        }
        const isCompleted = /complete/i.test(status);
        const isUpcoming = /upcoming/i.test(status);
        const prev = existing.get(String(e.id));
        const apiUpdated = e.updated_at ? new Date(e.updated_at).getTime() : null;
        const changed = prev == null || apiUpdated == null || prev !== apiUpdated;

        // Only write metadata when it actually changed (or is new). Unchanged
        // events are skipped entirely — makes routine refreshes near-instant.
        if (changed) await upsertEvent(e);

        const fetchResults =
          opts.results && !isUpcoming && (opts.full || changed || !isCompleted);
        if (fetchResults) toFetch.push(e.id);
        else if (opts.results && isCompleted) skipped++;
      }
      if (!res.next) break;
      page++;
    }
  }

  // Pass 2: deep-fetch results CONCURRENTLY for the events that need it.
  await pool(toFetch, async (id) => {
    const extra = await ingestEventResults(id);
    if (extra.players || extra.matches) {
      console.log(
        `    event ${id}: +${extra.players} players` +
          (extra.matches ? `, ${extra.matches} matches` : "") +
          (extra.hasResults ? " ✓results" : ""),
      );
    }
  });

  console.log(`✓ ${storeName}: ${seen.size} events (${toFetch.length} fetched, ${skipped} unchanged-skipped)`);
  return seen.size;
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
    }
  }
  return [...ids];
}

// State bounding boxes (generous; clipped to in-state stores by isStateStore).
// UP + Lower peninsula for MI means the box spans a lot of Great-Lakes water —
// empty grid cells there are harmless (they just find no stores).
const STATE_BBOX: Record<
  string,
  { south: number; north: number; west: number; east: number; names: string[] }
> = {
  CA: { south: 32.5, north: 42.05, west: -124.45, east: -114.05, names: ["ca", "california"] },
  MI: { south: 41.65, north: 48.35, west: -90.5, east: -82.3, names: ["mi", "michigan"] },
};

function inBbox(
  bbox: { south: number; north: number; west: number; east: number },
  lat?: number | null,
  lon?: number | null,
): boolean {
  return (
    lat != null && lon != null &&
    lat >= bbox.south && lat <= bbox.north &&
    lon >= bbox.west && lon <= bbox.east
  );
}

/** A store counts as in-state if it says so, or (state missing) sits in the box. */
function isStateStore(s: V2Store, code: string): boolean {
  const bbox = STATE_BBOX[code];
  const st = (s.state ?? "").trim().toLowerCase();
  if (bbox.names.includes(st)) return true;
  if (!st && inBbox(bbox, s.latitude, s.longitude)) return true;
  return false; // explicit out-of-state (neighbor/border spillover)
}

/** Grid centers covering a state's bbox; `step` mi apart (lon adjusted by latitude). */
function stateGridCenters(code: string, step: number): { lat: number; lon: number }[] {
  const bbox = STATE_BBOX[code];
  const out: { lat: number; lon: number }[] = [];
  const dLat = step / 69;
  for (let lat = bbox.south; lat <= bbox.north + 1e-9; lat += dLat) {
    const milesPerLon = Math.cos((lat * Math.PI) / 180) * 69;
    const dLon = step / milesPerLon;
    for (let lon = bbox.west; lon <= bbox.east + 1e-9; lon += dLon) {
      out.push({ lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
    }
  }
  return out;
}

/** Like discoverStores but returns full store payloads, with a higher page cap. */
async function discoverStoresNear(
  lat: number,
  lon: number,
  miles: number,
  maxPages = 20,
): Promise<V2Store[]> {
  const byId = new Map<number, V2Store>();
  for (const status of STATUSES) {
    for (let page = 1; page <= maxPages; page++) {
      const res = await searchEventsNear({
        latitude: lat, longitude: lon, miles, statuses: [status], page, pageSize: 50,
      });
      for (const e of res.results ?? []) if (e.store) byId.set(e.store.id, e.store);
      if (!res.next) break;
    }
  }
  return [...byId.values()];
}

/** Tile a whole state, returning the IDs of every in-state store discovered. */
async function discoverStateGrid(code: string, miles: number, step: number): Promise<number[]> {
  const centers = stateGridCenters(code, step);
  console.log(
    `${code} grid discovery: ${centers.length} cells (${miles}mi radius, ${step}mi step)…`,
  );
  const ids = new Set<number>();
  let outState = 0, cellsWithHits = 0, done = 0;
  for (const c of centers) {
    const hits = await discoverStoresNear(c.lat, c.lon, miles);
    let cellNew = 0;
    for (const st of hits) {
      if (isStateStore(st, code)) {
        if (!ids.has(st.id)) { ids.add(st.id); cellNew++; }
        await upsertStore(st);
      } else outState++;
    }
    done++;
    if (hits.length) cellsWithHits++;
    if (cellNew > 0 || done % 15 === 0) {
      console.log(
        `  [${done}/${centers.length}] ${c.lat},${c.lon}: ${hits.length} hits` +
          (cellNew ? ` (+${cellNew} new ${code})` : "") + ` — ${ids.size} ${code} total`,
      );
    }
  }
  console.log(
    `${code} grid: ${ids.size} ${code} stores found (${outState} out-of-state hits ignored); ` +
      `${cellsWithHits}/${centers.length} cells had stores.`,
  );
  return [...ids];
}

/**
 * Nationwide/regional delta sync: instead of iterating stores, query ALL
 * Riftbound events in a recent start-date window (covers new + recently-finished
 * events whose results just published), then deep-fetch only the changed ones.
 * Cost scales with the delta, not the total dataset.
 */
async function ingestGlobalWindow(opts: { full: boolean; sinceDays: number }) {
  const since = new Date(Date.now() - opts.sinceDays * 86400_000).toISOString();
  console.log(`Global delta: events starting since ${since.slice(0, 10)} (last ${opts.sinceDays}d)…`);

  const seen = new Set<number>();
  const toFetch: number[] = [];
  let listed = 0;

  for (const status of STATUSES) {
    let page = 1;
    for (;;) {
      const res = await searchEvents({
        statuses: [status],
        startDateAfter: since,
        page,
        pageSize: 100,
      });
      const events = res.results ?? [];
      if (events.length === 0) break;

      // Batch-read prior timestamps for this page to detect changes.
      const ids = events.map((e) => String(e.id));
      const prior = new Map<string, number | null>();
      for (const ev of await prisma.event.findMany({
        where: { id: { in: ids } },
        select: { id: true, sourceUpdatedAt: true },
      })) {
        prior.set(ev.id, timeMs(ev.sourceUpdatedAt));
      }

      for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        listed++;
        if (e.store) await upsertStore(e.store);
        await upsertEvent(e);

        const isCompleted = /complete/i.test(status);
        const isUpcoming = /upcoming/i.test(status);
        const prev = prior.get(String(e.id));
        const apiUpdated = e.updated_at ? new Date(e.updated_at).getTime() : null;
        const changed = prev == null || apiUpdated == null || prev !== apiUpdated;
        if (!isUpcoming && (opts.full || changed || !isCompleted)) toFetch.push(e.id);
      }
      if (!res.next) break;
      page++;
    }
  }

  console.log(`Listed ${listed} events in window; deep-fetching ${toFetch.length} new/changed…`);
  let withResults = 0;
  await pool(toFetch, async (id) => {
    const extra = await ingestEventResults(id);
    if (extra.hasResults) withResults++;
  });
  console.log(`Global delta done: ${listed} listed, ${toFetch.length} fetched, ${withResults} had results.`);
  return seen.size;
}

// Names that mark a premier/bridge event even at modest attendance.
const PREMIER_NAME = /regional|qualifier|championship|nationals?|invitational|open\b|grand prix|circuit|masters|world|store championship|ptq|rcq|wcq/i;

function eventPlayerCount(e: V2Event): number {
  return Number(e.registered_user_count ?? e.starting_player_count ?? 0);
}

/** Does this event look like a big/premier event worth importing as a bridge? */
function isPremier(e: V2Event, minPlayers: number): boolean {
  if (eventPlayerCount(e) >= minPlayers) return true;
  const type = typeof e.event_type === "string" ? e.event_type : "";
  return PREMIER_NAME.test(e.name ?? "") || PREMIER_NAME.test(type);
}

/**
 * Import big/premier events from ANYWHERE (qualifiers, championships, opens…).
 * These draw players across many stores/regions, so their matches are the
 * "bridges" that connect otherwise-isolated regional pools into one comparable
 * rating graph. Lists all events (optionally windowed/by country) cheaply, then
 * deep-fetches results only for the premier ones.
 */
async function ingestPremierEvents(opts: {
  full: boolean;
  minPlayers: number;
  country: string | null;
  sinceDays: number | null;
}) {
  const since = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 86400_000).toISOString()
    : undefined;
  console.log(
    `Premier scan: events with ≥${opts.minPlayers} players or premier names` +
      (opts.country ? `, country=${opts.country}` : ", worldwide") +
      (since ? `, since ${since.slice(0, 10)}` : ", all-time") + "…",
  );

  const seen = new Set<number>();
  const toFetch: number[] = [];
  let listed = 0, premier = 0;

  for (const status of STATUSES) {
    const isUpcoming = /upcoming/i.test(status);
    const isCompleted = /complete/i.test(status);
    let page = 1;
    for (;;) {
      const res = await searchEvents({
        statuses: [status],
        startDateAfter: since,
        page,
        pageSize: 100,
      });
      const events = res.results ?? [];
      if (events.length === 0) break;

      const bigOnPage = events.filter(
        (e) =>
          !seen.has(e.id) &&
          isPremier(e, opts.minPlayers) &&
          (!opts.country ||
            (e.store?.country ?? "").toUpperCase() === opts.country.toUpperCase()),
      );

      // Incremental: only deep-fetch premier events that are new/changed.
      const ids = bigOnPage.map((e) => String(e.id));
      const prior = new Map<string, number | null>();
      if (ids.length) {
        for (const ev of await prisma.event.findMany({
          where: { id: { in: ids } },
          select: { id: true, sourceUpdatedAt: true },
        })) {
          prior.set(ev.id, timeMs(ev.sourceUpdatedAt));
        }
      }

      for (const e of bigOnPage) {
        seen.add(e.id);
        listed++;
        premier++;
        if (e.store) await upsertStore(e.store);
        await upsertEvent(e);
        if (isUpcoming) continue; // no results to fetch yet
        const prev = prior.get(String(e.id));
        const apiUpdated = e.updated_at ? new Date(e.updated_at).getTime() : null;
        const changed = prev == null || apiUpdated == null || prev !== apiUpdated;
        if (opts.full || changed || !isCompleted) toFetch.push(e.id);
      }
      if (!res.next) break;
      page++;
    }
  }

  console.log(`Premier scan: ${premier} premier events found; deep-fetching ${toFetch.length} new/changed…`);
  let withResults = 0;
  await pool(toFetch, async (id) => {
    const extra = await ingestEventResults(id);
    if (extra.hasResults) withResults++;
    if (extra.players || extra.matches) {
      console.log(`    event ${id}: +${extra.players} players, ${extra.matches} matches` + (extra.hasResults ? " ✓" : ""));
    }
  });
  console.log(`Premier done: ${premier} premier events, ${toFetch.length} fetched, ${withResults} had results.`);
  return premier;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureAuth().catch(() => false);
  console.log(
    hasToken() ? "Authenticated to carde.io." : "No token set — results will be limited.",
  );

  if (args.global) {
    await ingestGlobalWindow({ full: args.full, sinceDays: args.sinceDays });
    await assignAllRegions(true);
    const counts = {
      stores: await prisma.store.count(),
      events: await prisma.event.count(),
      players: await prisma.player.count(),
    };
    console.log("\nDB now:", counts);
    return;
  }

  if (args.premierScan) {
    await ingestPremierEvents({
      full: args.full,
      minPlayers: args.minPlayers,
      country: args.country,
      // default to all-time unless a window was explicitly requested
      sinceDays: process.argv.includes("--since-days") ? args.sinceDays : null,
    });
    await assignAllRegions(true);
    const counts = {
      stores: await prisma.store.count(),
      events: await prisma.event.count(),
      players: await prisma.player.count(),
    };
    console.log("\nDB now:", counts);
    return;
  }

  if (args.events.length) {
    // Targeted single-event ingest (e.g. a specific RQ). Upsert the event first
    // so its row exists, then pull full results.
    for (const id of args.events) {
      try {
        const detail = await getEventDetail(id);
        if (detail.store) await upsertStore(detail.store);
        await upsertEvent(detail);
      } catch (e) {
        console.error(`event ${id}: detail fetch failed`, (e as Error)?.message);
      }
      const r = await ingestEventResults(id);
      console.log(`event ${id}: ${r.players} players, ${r.matches} matches, results=${r.hasResults}`);
    }
    await assignAllRegions(true);
    console.log("\nDB now:", {
      stores: await prisma.store.count(),
      events: await prisma.event.count(),
      players: await prisma.player.count(),
      matches: await prisma.match.count(),
    });
    return;
  }

  let storeIds = args.stores;
  if (args.premier) {
    // Premier mode: ingest the official Organized Play hub store(s) in full.
    // Events with no published results (demos/learn-to-play) self-skip; the
    // Regional Qualifiers and other premier events get full result ingestion.
    storeIds = [...new Set([...storeIds, ...OP_STORE_IDS])];
    console.log(`Premier: ingesting Organized Play hub store(s): ${OP_STORE_IDS.join(", ")}`);
  }
  if (storeIds.length === 0) {
    // Prefer the stores we already know (reference old data first — never
    // re-discover blindly). Only hit the geo-discovery API when explicitly
    // asked (--discover / --near) or when the DB has no stores yet.
    const known = (await prisma.store.findMany({ select: { id: true } })).map((s) => Number(s.id));
    if (args.stateGrid) {
      if (!STATE_BBOX[args.stateGrid]) {
        console.error(
          `Unknown state grid "${args.stateGrid}". Known: ${Object.keys(STATE_BBOX).join(", ")}.`,
        );
        process.exit(1);
      }
      const found = await discoverStateGrid(args.stateGrid, args.gridMiles, args.gridStep);
      // Ingest ONLY the discovered in-state stores — adding a state shouldn't
      // re-poll every other known store (that's what `--global` delta is for).
      // Grid discovery already upserts the store rows; here we pull their events.
      storeIds = found;
      console.log(
        `${args.stateGrid} grid: ${found.length} ${args.stateGrid} stores to ingest ` +
          `(${known.length} other known stores left untouched — use --global for a full refresh).`,
      );
    } else if (args.discover || args.near || known.length === 0) {
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
  }

  // Keep store/player region assignments in sync with the latest data.
  await assignAllRegions(true);

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
