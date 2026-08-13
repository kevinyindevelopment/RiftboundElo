/**
 * Ingest Riftbound data from the carde.io / UVS Hydra backend.
 *
 * Usage:
 *   npm run ingest -- --decks [pages]            ingest public decks (no auth)
 *   npm run ingest -- --event 193148             ingest one event (public meta; results if authed)
 *   npm run ingest -- --from 193000 --to 193200  crawl an event-id range
 *   npm run ingest -- --event 193148 --raw       dump raw authed payloads for shape-mapping
 *
 * Public endpoints give event metadata + decks. Match RESULTS (needed for Elo)
 * are auth-gated: set CARDE_TOKEN, or CARDE_EMAIL + CARDE_PASSWORD in .env.
 *
 * After ingesting, run `npm run elo:recompute`.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  browseDecks,
  ensureAuth,
  extractLegend,
  getAllRegistrations,
  getEvent,
  getRounds,
  hasToken,
  CardeError,
  type CardeEvent,
} from "../src/lib/carde";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RATE_MS = Number(process.env.INGEST_RATE_MS ?? 600); // be polite

// ---------------------------------------------------------------- args
function parseArgs(argv: string[]) {
  const a = { decks: false, deckPages: 5, raw: false, events: [] as number[] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--decks") {
      a.decks = true;
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n)) a.deckPages = n;
    } else if (t === "--raw") {
      a.raw = true;
    } else if (t === "--event") {
      a.events.push(Number(argv[++i]));
    } else if (t === "--from") {
      const from = Number(argv[++i]);
      const toIdx = argv.indexOf("--to");
      const to = toIdx >= 0 ? Number(argv[toIdx + 1]) : from;
      for (let id = from; id <= to; id++) a.events.push(id);
    }
  }
  return a;
}

// ---------------------------------------------------------------- decks
async function ingestDecks(pages: number) {
  console.log(`Ingesting public decks (${pages} page(s))…`);
  let count = 0;
  for (let page = 1; page <= pages; page++) {
    const data = await browseDecks({ page, pageSize: 50 });
    if (!data.results?.length) break;
    for (const d of data.results) {
      const { legend, champion, domains } = extractLegend(d);
      await prisma.deck.upsert({
        where: { id: d.id },
        create: {
          id: d.id,
          name: d.name,
          legend,
          champion,
          domains: JSON.stringify(domains),
          format: d.format,
          archetype: champion ?? legend,
        },
        update: {
          name: d.name,
          legend,
          champion,
          domains: JSON.stringify(domains),
          format: d.format,
          archetype: champion ?? legend,
        },
      });
      count++;
    }
    console.log(`  page ${page}: ${data.results.length} decks (total ${count})`);
    await sleep(RATE_MS);
  }
  console.log(`Decks ingested: ${count}`);
}

// ---------------------------------------------------------------- events
async function upsertEvent(ev: CardeEvent) {
  if (ev.store) {
    await prisma.store.upsert({
      where: { id: String(ev.store.id) },
      create: {
        id: String(ev.store.id),
        name: ev.store.name,
        country: ev.store.country ?? null,
        latitude: ev.store.latitude ?? null,
        longitude: ev.store.longitude ?? null,
      },
      update: {
        name: ev.store.name,
        country: ev.store.country ?? null,
        latitude: ev.store.latitude ?? null,
        longitude: ev.store.longitude ?? null,
      },
    });
  }
  await prisma.event.upsert({
    where: { id: String(ev.id) },
    create: {
      id: String(ev.id),
      name: ev.name,
      format: ev.format_pretty ?? ev.event_format ?? null,
      gameType: ev.game_type_pretty ?? ev.game_type ?? null,
      startDatetime: ev.start_datetime ? new Date(ev.start_datetime) : null,
      endDatetime: ev.end_datetime ? new Date(ev.end_datetime) : null,
      status: ev.event_lifecycle_status ?? null,
      numPlayers: ev.registered_user_count ?? 0,
      pointsPerWin: ev.points_given_per_win ?? 3,
      pointsPerLoss: ev.points_given_per_loss ?? 0,
      pointsPerDraw: ev.points_given_per_draw ?? 1,
      storeId: ev.store ? String(ev.store.id) : null,
    },
    update: {
      name: ev.name,
      format: ev.format_pretty ?? ev.event_format ?? null,
      gameType: ev.game_type_pretty ?? ev.game_type ?? null,
      startDatetime: ev.start_datetime ? new Date(ev.start_datetime) : null,
      status: ev.event_lifecycle_status ?? null,
      numPlayers: ev.registered_user_count ?? 0,
      storeId: ev.store ? String(ev.store.id) : null,
    },
  });
}

/**
 * Tolerant match extraction from a `get_all_rounds` payload. The authed shape
 * isn't observable without a token, so we hunt for the common spicerack shape:
 * an array of rounds, each with a `matches`/`pairings` array, each match having
 * two participants (player_one/player_two or user_event_statuses) and a winner.
 */
interface ParsedMatch {
  id: string;
  roundNumber: number | null;
  p1: { id: string; name: string };
  p2: { id: string; name: string } | null; // null => bye
  p1Wins: number;
  p2Wins: number;
  winnerId: string | null;
}

function asArray(x: unknown): unknown[] {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of ["results", "rounds", "data", "matches", "pairings"]) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
  }
  return [];
}

/**
 * carde payloads are untrusted and their shape varies by endpoint, so navigate
 * them through these guards rather than casting to `any` (which silently
 * disabled type-checking on every access below).
 */
type Json = unknown;
const asObj = (v: Json): Record<string, Json> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, Json>)
    : null;
/** `v[key]`, or undefined when `v` isn't an object. Mirrors `v?.key`. */
const prop = (v: Json, key: string): Json => asObj(v)?.[key];
/** `v[i]`, or undefined when `v` isn't an array. Mirrors `v?.[i]`. */
const at = (v: Json, i: number): Json => (Array.isArray(v) ? v[i] : undefined);

function participant(p: unknown): { id: string; name: string } | null {
  const o = asObj(p);
  if (!o) return null;
  // common nests: { user: {...} }, { user_event_status: { user: {...} } }, direct user
  const u = prop(o, "user") ?? prop(prop(o, "user_event_status"), "user") ?? prop(o, "player") ?? o;
  const id = prop(u, "id") ?? prop(o, "user_id") ?? prop(o, "player_id");
  if (id == null) return null;
  // `[a,b].filter(Boolean).join(" ")` returns "" rather than null when both are
  // missing, and "" is not nullish — so a bare `??` chain stopped there and the
  // display_name/username fallbacks below were unreachable. Coerce "" to
  // undefined so they are actually tried.
  const full = [prop(u, "first_name"), prop(u, "last_name")].filter(Boolean).join(" ");
  const name =
    prop(u, "best_identifier") ??
    (full || undefined) ??
    prop(u, "display_name") ??
    prop(u, "username") ??
    String(id);
  return { id: String(id), name: String(name || id) };
}

function parseMatch(raw: unknown, roundNumber: number | null): ParsedMatch | null {
  const m = asObj(raw);
  if (!m) return null;
  const parts = prop(m, "participants");
  const p1 = participant(
    prop(m, "player_one") ?? prop(m, "user_one") ?? prop(m, "user_event_status_one") ?? at(parts, 0),
  );
  const p2 = participant(
    prop(m, "player_two") ?? prop(m, "user_two") ?? prop(m, "user_event_status_two") ?? at(parts, 1),
  );
  if (!p1) return null;
  const p1Wins = Number(prop(m, "player_one_wins") ?? prop(m, "user_one_wins") ?? prop(m, "wins_one") ?? 0);
  const p2Wins = Number(prop(m, "player_two_wins") ?? prop(m, "user_two_wins") ?? prop(m, "wins_two") ?? 0);
  let winnerId: string | null = null;
  const w = prop(m, "winner") ?? prop(m, "winner_id") ?? prop(m, "winning_user_id");
  if (w != null && typeof w === "object") winnerId = String(prop(w, "id"));
  else if (w != null) winnerId = String(w);
  else if (p2) winnerId = p1Wins > p2Wins ? p1.id : p1Wins < p2Wins ? p2.id : null;
  return {
    id: String(prop(m, "id") ?? `${roundNumber}-${p1.id}-${p2?.id ?? "bye"}`),
    roundNumber,
    p1,
    p2,
    p1Wins,
    p2Wins,
    winnerId,
  };
}

function parseRounds(payload: unknown): ParsedMatch[] {
  const rounds = asArray(payload);
  const out: ParsedMatch[] = [];
  rounds.forEach((r, idx) => {
    const roundNumber = Number(prop(r, "round_number") ?? prop(r, "number") ?? idx + 1);
    const matches = asArray(prop(r, "matches") ?? prop(r, "pairings") ?? r);
    for (const m of matches) {
      const pm = parseMatch(m, Number.isNaN(roundNumber) ? null : roundNumber);
      if (pm) out.push(pm);
    }
  });
  return out;
}

/**
 * Real names for an event's players, keyed by carde user id. The registrations
 * endpoint exposes first_name/last_name only when we're authorized for the event
 * (e.g. crawling a live RQ we have access to); otherwise it's gated or carries
 * just best_identifier. Best-effort — never throws, so ingest still succeeds with
 * initial-only names when full names aren't available.
 */
async function fetchRegistrationNames(
  eventId: number,
): Promise<Map<string, { first?: string; last?: string }>> {
  const names = new Map<string, { first?: string; last?: string }>();
  try {
    const regs = await getAllRegistrations(eventId);
    for (const r of regs) {
      const u = r.user ?? undefined;
      const id = u?.id ?? (r as { user_id?: number }).user_id;
      if (id == null) continue;
      const first = (u?.first_name ?? "").trim() || undefined;
      const last = (u?.last_name ?? "").trim() || undefined;
      if (first || last) names.set(String(id), { first, last });
    }
  } catch {
    /* registrations often gated/empty — callers fall back to match names */
  }
  return names;
}

async function ingestResults(eventId: number) {
  const payload = await getRounds(eventId);
  const matches = parseRounds(payload);
  if (!matches.length) {
    console.log(`  event ${eventId}: no matches parsed (shape may differ — use --raw to inspect)`);
    return;
  }
  // Upsert players first.
  const seen = new Map<string, string>();
  for (const m of matches) {
    seen.set(m.p1.id, m.p1.name);
    if (m.p2) seen.set(m.p2.id, m.p2.name);
  }

  // Prefer full names from registrations when available; fall back to the
  // initial-only match names (best_identifier). Guard against downgrading a
  // previously-captured full name on a later run that can't see registrations.
  const regNames = await fetchRegistrationNames(eventId);
  const existing = await prisma.player.findMany({
    where: { id: { in: [...seen.keys()] } },
    select: { id: true, lastName: true },
  });
  const hasFullName = new Set(existing.filter((e) => e.lastName).map((e) => e.id));

  let fullNamed = 0;
  for (const [id, matchName] of seen) {
    const reg = regNames.get(id);
    const full = reg?.first && reg?.last ? `${reg.first} ${reg.last}` : null;
    if (full) fullNamed++;

    // What to write on an EXISTING row: upgrade to a full name when we have one,
    // otherwise refresh the initials only if there's no full name to protect.
    const update = full
      ? { displayName: full, firstName: reg!.first, lastName: reg!.last }
      : hasFullName.has(id)
        ? {}
        : { displayName: matchName };

    await prisma.player.upsert({
      where: { id },
      create: full
        ? { id, displayName: full, firstName: reg!.first, lastName: reg!.last }
        : { id, displayName: matchName },
      update,
    });
    await prisma.eventEntry.upsert({
      where: { eventId_playerId: { eventId: String(eventId), playerId: id } },
      create: { eventId: String(eventId), playerId: id },
      update: {},
    });
  }
  for (const m of matches) {
    await prisma.match.upsert({
      where: { id: m.id },
      create: {
        id: m.id,
        eventId: String(eventId),
        roundNumber: m.roundNumber,
        playerOneId: m.p1.id,
        playerTwoId: m.p2?.id ?? m.p1.id,
        playerOneWins: m.p1Wins,
        playerTwoWins: m.p2Wins,
        winnerId: m.winnerId,
        isBye: !m.p2,
      },
      update: {
        playerOneWins: m.p1Wins,
        playerTwoWins: m.p2Wins,
        winnerId: m.winnerId,
      },
    });
  }
  await prisma.event.update({
    where: { id: String(eventId) },
    data: { resultsComplete: true },
  });
  const nameNote = fullNamed > 0 ? `, ${fullNamed} full names` : " (initials only)";
  console.log(`  event ${eventId}: ${matches.length} matches, ${seen.size} players${nameNote}`);
}

async function ingestEvent(eventId: number, raw: boolean) {
  try {
    const ev = await getEvent(eventId);
    await upsertEvent(ev);
    console.log(`event ${eventId}: "${ev.name}" (${ev.registered_user_count ?? 0} players)`);
    if (raw) {
      const rounds = await getRounds(eventId).catch((e) => ({ error: String(e) }));
      console.log("  RAW get_all_rounds:\n", JSON.stringify(rounds, null, 2).slice(0, 4000));
      return;
    }
    if (hasToken()) {
      await ingestResults(eventId).catch((e) =>
        console.log(`  results error: ${e instanceof CardeError ? e.status : e}`),
      );
    }
  } catch (e) {
    if (e instanceof CardeError && e.status === 404) {
      // expected for non-existent ids while crawling a range
    } else {
      console.log(`event ${eventId}: ${e}`);
    }
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const authed = await ensureAuth().catch(() => false);
  console.log(authed ? "Authenticated to carde.io." : "No credentials — public data only (events + decks, no match results / Elo).");

  if (args.decks) await ingestDecks(args.deckPages);

  for (const id of args.events) {
    await ingestEvent(id, args.raw);
    await sleep(RATE_MS);
  }

  if (!args.decks && args.events.length === 0) {
    console.log("Nothing to do. Try: npm run ingest -- --decks  OR  --event <id>  OR  --from <id> --to <id>");
  } else if (hasToken() && args.events.length) {
    console.log("\nDone ingesting. Run: npm run elo:recompute");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
