/**
 * What has each registrant of an upcoming event ACTUALLY been playing lately?
 *
 *   npx tsx scripts/roster-recent.ts [eventId] [lat] [lon] [miles] [sinceISO]
 *   # defaults: 791304, LA (34.05,-118.24), 60 miles, 2026-07-31 (Vendetta)
 *
 * Motivation: scripts/legend-field.ts predicts from the RiftElo DB, but the DB's
 * legend coverage is sparse for very recent events (results are fetched lazily,
 * and most local events never attach a deck at all). For a scouting report the
 * post-new-set weeks are exactly the rows that matter, so this goes straight to
 * carde and scans the standings of every recent event near the venue, looking
 * for the registrants by carde user id.
 *
 * `deck_defining_card` (the Legend) is REDACTED for anonymous callers — public
 * standings return it as null — so this needs CARDE_TOKEN and is meant to run in
 * GitHub Actions (workflow legend-field.yml, `script: roster-recent`).
 *
 * Read-only against carde; touches the DB only to attach ratings. This is NOT
 * an ingest — nothing is written, and it never enumerates globally (the search
 * is geo-bounded, per the data-scope rules in AGENTS.md).
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  getAllRegistrations,
  getEventDetail,
  getRoundStandings,
  getRoundMatches,
  hasToken,
  pool,
  type V2Event,
  type Paginated,
} from "../src/lib/carde";

const EVENT = Number(process.argv[2] ?? 791304);
const LAT = Number(process.argv[3] ?? 34.05);
const LON = Number(process.argv[4] ?? -118.24);
const MILES = Number(process.argv[5] ?? 60);
const SINCE = process.argv[6] ?? "2026-07-31";
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS ?? 4);

const NEW_SET_CHAMPS = [
  "Akali", "Zed", "Kennen", "Shen", "Mel", "Jayce", "Ambessa", "Renekton", "Nasus",
];
const isNewSet = (l: string) =>
  NEW_SET_CHAMPS.some((c) => l === c || l.startsWith(`${c},`));

interface Sighting {
  uid: number;
  legend: string | null;
  eventName: string;
  store: string;
  date: string;
  players: number;
  rank?: number;
  record?: string;
}

async function main() {
  if (!hasToken()) {
    console.log("WARNING: no CARDE_TOKEN — deck_defining_card will be null for every row.");
  }

  const target = await getEventDetail(EVENT);
  console.log(
    `TARGET ${EVENT}: ${target.name} | ${target.registered_user_count}/${target.capacity} | ` +
      `starts ${target.start_datetime}`,
  );

  // ---- roster ------------------------------------------------------------
  const regs = await getAllRegistrations(EVENT);
  const roster = new Map<number, { name: string; tag?: string }>();
  for (const r of regs) {
    if (r.user?.id == null) continue;
    roster.set(r.user.id, {
      name: r.user.best_identifier ?? "?",
      tag: (r as Record<string, unknown>).best_identifier as string | undefined,
    });
  }
  console.log(`roster: ${roster.size} registrants`);

  // ---- nearby events that have actually finished -------------------------
  // NOTE: the geo search must go out ANONYMOUSLY. Sending an Authorization
  // header scopes /api/v2/events/ to the token owner and it comes back empty;
  // only the standings call below needs (and benefits from) the token.
  const BASE =
    process.env.CARDE_API_BASE ??
    "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy";
  async function searchNearAnon(page: number): Promise<Paginated<V2Event>> {
    const q = new URLSearchParams({
      game_slug: "riftbound",
      latitude: String(LAT),
      longitude: String(LON),
      num_miles: String(MILES),
      start_date_after: SINCE,
      page: String(page),
      page_size: "100",
    });
    q.append("display_statuses", "completed");
    const r = await fetch(`${BASE}/api/v2/events/?${q}`, {
      headers: { Accept: "application/json", "User-Agent": "RiftboundElo/0.1 (personal use)" },
    });
    if (!r.ok) throw new Error(`anon event search ${r.status}`);
    return (await r.json()) as Paginated<V2Event>;
  }

  const now = Date.now();
  const seen = new Map<number, V2Event>();
  for (let page = 1; page <= 25; page++) {
    const res = await searchNearAnon(page);
    for (const e of res.results ?? []) {
      const t = e.start_datetime ? Date.parse(e.start_datetime) : NaN;
      if (!Number.isFinite(t) || t < Date.parse(SINCE) || t > now) continue;
      // carde returns upcoming/canceled events inside the "completed" bucket —
      // trust the event's OWN status, not the query bucket (see AGENTS.md).
      const status = (e.display_status ?? "").toLowerCase();
      if (status !== "completed" && status !== "complete") continue;
      if ((e.registered_user_count ?? 0) < MIN_PLAYERS) continue;
      seen.set(e.id, e);
    }
    if (!res.next || !(res.results ?? []).length) break;
  }
  const events = [...seen.values()].sort((a, b) =>
    (b.start_datetime ?? "").localeCompare(a.start_datetime ?? ""),
  );
  console.log(
    `finished events within ${MILES}mi of (${LAT},${LON}) since ${SINCE} ` +
      `with >=${MIN_PLAYERS} players: ${events.length}\n`,
  );

  // ---- scan standings ----------------------------------------------------
  const sightings: Sighting[] = [];
  let scanned = 0;
  await pool(
    events,
    async (ev) => {
      const detail = await getEventDetail(ev.id).catch(() => null);
      if (!detail) return;
      const rounds = (detail.tournament_phases ?? [])
        .flatMap((p) => p.rounds ?? [])
        .filter((r) => /PLAY|SWISS|ELIM|POD|OPPONENT/i.test(r.round_type ?? ""))
        .sort((a, b) => (b.round_number ?? 0) - (a.round_number ?? 0));
      const found: Sighting[] = [];
      for (const rd of rounds) {
        const st = await getRoundStandings(rd.id).catch(() => null);
        const list = st?.standings ?? [];
        if (!list.length) continue;
        for (const s of list) {
          const uid = s.player?.id ?? s.user_event_status?.user?.id;
          if (uid == null || !roster.has(uid)) continue;
          found.push({
            uid,
            legend: s.user_event_status?.deck_defining_card?.name ?? null,
            eventName: ev.name,
            store: ev.store?.name ?? "?",
            date: (ev.start_datetime ?? "").slice(0, 10),
            players: ev.registered_user_count ?? 0,
            rank: s.rank,
            record: s.record,
          });
        }
        break; // most recent round with standings is enough
      }
      scanned++;
      if (!found.length) return;

      // Standings frequently omit deck_defining_card even for the organizer's
      // own token; the per-match player_match_relationships carry it more often
      // (this is the same pair of sources scripts/ingest-stores.ts reads). Only
      // pay for the match fetch when a registrant actually played here AND the
      // Legend is still unknown.
      if (found.some((f) => !f.legend)) {
        const byUid = new Map<number, string>();
        for (const rd of rounds) {
          const ms = await getRoundMatches(rd.id).catch(() => []);
          for (const m of ms) {
            for (const pmr of m.player_match_relationships ?? []) {
              const uid = pmr.player?.id ?? pmr.user_event_status?.user?.id;
              const name = pmr.user_event_status?.deck_defining_card?.name;
              if (uid != null && name && !byUid.has(uid)) byUid.set(uid, name);
            }
          }
          if (byUid.size) break; // one round is enough; the deck is fixed per event
        }
        for (const f of found) if (!f.legend) f.legend = byUid.get(f.uid) ?? null;
      }
      sightings.push(...found);
    },
    8,
  );
  console.log(`scanned ${scanned} events; ${sightings.length} roster sightings\n`);

  // ---- report ------------------------------------------------------------
  const ratings = new Map(
    (
      await prisma.player.findMany({
        where: { id: { in: [...roster.keys()].map(String) } },
        select: { id: true, rating: true },
      })
    ).map((p) => [p.id, p.rating]),
  );

  const byPlayer = new Map<number, Sighting[]>();
  for (const s of sightings) {
    const arr = byPlayer.get(s.uid) ?? [];
    arr.push(s);
    byPlayer.set(s.uid, arr);
  }

  const withLegend = sightings.filter((s) => s.legend);
  console.log(
    `=== POST-${SINCE} SIGHTINGS: ${byPlayer.size}/${roster.size} registrants seen, ` +
      `${withLegend.length}/${sightings.length} rows carry a Legend ===\n`,
  );

  const ranked = [...byPlayer.entries()].sort(
    (a, b) => (ratings.get(String(b[0])) ?? 0) - (ratings.get(String(a[0])) ?? 0),
  );
  for (const [uid, list] of ranked) {
    const p = roster.get(uid)!;
    const r = ratings.get(String(uid));
    list.sort((a, b) => b.date.localeCompare(a.date));
    console.log(`${(p.name + (p.tag ? ` "${p.tag}"` : "")).padEnd(38)} ${String(r ?? "?").padEnd(6)}`);
    for (const s of list) {
      console.log(
        `    ${s.date}  ${String(s.players).padStart(3)}p  ` +
          `${(s.legend ?? "(legend hidden)").padEnd(32)}${s.legend && isNewSet(s.legend) ? "[VENDETTA] " : ""}` +
          `rank ${s.rank ?? "?"}  ${s.store.slice(0, 28)}`,
      );
    }
  }

  // Aggregate: what are these 128 people playing post-Vendetta?
  const legendCount = new Map<string, number>();
  const playerLatest = new Map<number, string>();
  for (const [uid, list] of byPlayer) {
    const withL = list.filter((s) => s.legend).sort((a, b) => b.date.localeCompare(a.date));
    if (withL.length) playerLatest.set(uid, withL[0].legend!);
  }
  for (const l of playerLatest.values()) legendCount.set(l, (legendCount.get(l) ?? 0) + 1);
  console.log(`\n=== ROSTER'S MOST RECENT POST-VENDETTA LEGEND (${playerLatest.size} players) ===`);
  for (const [l, n] of [...legendCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${l}${isNewSet(l) ? " [VENDETTA]" : ""}`);
  }
  const vN = [...playerLatest.values()].filter(isNewSet).length;
  console.log(
    `\nVendetta share among these: ${vN}/${playerLatest.size} = ` +
      `${playerLatest.size ? ((100 * vN) / playerLatest.size).toFixed(1) : 0}%`,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
