/**
 * Legend-field analysis for an upcoming event: for every registrant, what
 * Legend are they most likely to pilot?
 *
 *   npx tsx scripts/legend-field.ts [eventId]     # defaults to 791304
 *
 * Sources, best first:
 *   1. Actual decklist submissions (auth-gated; needs CARDE_TOKEN and usually
 *      only visible once the organizer publishes decklists).
 *   2. DB history: the player's Legend in past ingested events (MI/CA stores +
 *      premier). Prediction = the Legend from their most recent event,
 *      tie-broken by how often they've piloted it.
 *
 * Also reports new-set (Vendetta) adoption: the tracked-store meta since the
 * set's release, and which registrants have already played post-release events
 * (their predictions are marked as new-set-aware).
 *
 * Reads are tiny (three indexed queries) — negligible Neon egress. Designed to
 * run in GitHub Actions (workflow legend-field.yml) where the DB/carde secrets
 * live; output goes to the workflow log.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  getAllRegistrations,
  getDeckSubmissions,
  getDeckAuxiliaryCards,
  getEventDetail,
  hasToken,
  CardeError,
} from "../src/lib/carde";

const EVENT = Number(process.argv[2] ?? 791304);

// Vendetta (set 4) released 2026-07-31 and added nine NEW champions to the
// legend pool. Any tracked event since then is post-Vendetta meta — the best
// available signal for whether the field will bring new-set decks.
const NEW_SET_SINCE = process.env.NEW_SET_SINCE ?? "2026-07-31";
const NEW_SET_CHAMPS = [
  "Akali", "Zed", "Kennen", "Shen", "Mel", "Jayce", "Ambessa", "Renekton", "Nasus",
];
const isNewSet = (legend: string) =>
  NEW_SET_CHAMPS.some((c) => legend === c || legend.startsWith(`${c},`));
const vTag = (legend: string) => (isNewSet(legend) ? " [VENDETTA]" : "");

/** Recursively scan an unknown payload for legend names keyed by user id. */
function scanForLegends(node: unknown, out: Map<number, string>, userId?: number) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) scanForLegends(item, out, userId);
    return;
  }
  const o = node as Record<string, unknown>;
  // Track the nearest enclosing user id.
  const u = o.user as Record<string, unknown> | undefined;
  const uid =
    typeof o.user_id === "number" ? o.user_id
    : u && typeof u.id === "number" ? (u.id as number)
    : userId;
  // deck_defining_card: { name }
  const ddc = o.deck_defining_card as Record<string, unknown> | undefined;
  if (uid != null && ddc && typeof ddc.name === "string") out.set(uid, ddc.name);
  // auxiliary card slot: { auxiliary_type: { code: "legend" }, card: { name } }
  const aux = o.auxiliary_type as Record<string, unknown> | undefined;
  const card = o.card as Record<string, unknown> | undefined;
  if (
    uid != null &&
    aux && String(aux.code).toLowerCase() === "legend" &&
    card && typeof card.name === "string"
  ) {
    out.set(uid, card.name as string);
  }
  for (const v of Object.values(o)) scanForLegends(v, out, uid);
}

async function main() {
  const detail = await getEventDetail(EVENT);
  console.log(
    `EVENT ${EVENT}: ${detail.name} | ${detail.display_status} | ` +
      `${detail.registered_user_count}/${detail.capacity} | starts ${detail.start_datetime}`,
  );

  // ---- Roster (public) ---------------------------------------------------
  const regs = await getAllRegistrations(EVENT);
  const roster = regs
    .filter((r) => r.user?.id != null)
    .map((r) => ({
      uid: r.user!.id,
      pid: String(r.user!.id),
      realName: r.user!.best_identifier ?? "?",
      tag: (r as Record<string, unknown>).best_identifier as string | undefined,
    }));
  console.log(`roster: ${roster.length} registrants\n`);

  // ---- Source 1: actual submissions (auth-gated) -------------------------
  const submitted = new Map<number, string>(); // carde user id -> legend
  if (hasToken()) {
    try {
      const subs = await getDeckSubmissions(EVENT);
      console.log(`deck submissions endpoint: total=${subs.total_submissions}`);
      scanForLegends(subs.submissions, submitted);
      // Submission payloads carry deck_id but not the deck's legend; resolve
      // via the (auth-gated) auxiliary-cards endpoint.
      for (const s of subs.submissions as Array<Record<string, unknown>>) {
        const uid = typeof s.user_id === "number" ? s.user_id : null;
        const deckId = typeof s.deck_id === "string" ? s.deck_id : null;
        if (uid == null || deckId == null || submitted.has(uid)) continue;
        try {
          const aux = await getDeckAuxiliaryCards(deckId);
          const legend = aux.find(
            (a) => a.auxiliary_type?.code?.toLowerCase() === "legend",
          )?.card?.name;
          if (legend) submitted.set(uid, legend);
        } catch {
          /* deck private or endpoint refused — skip */
        }
      }
      console.log(`  -> legends extracted for ${submitted.size} players`);
    } catch (e) {
      console.log(
        `deck submissions unavailable: ${e instanceof CardeError ? e.status : e}`,
      );
    }
  } else {
    console.log("no CARDE_TOKEN — skipping submissions endpoint");
  }

  // ---- Source 2: DB history ---------------------------------------------
  const ids = roster.map((r) => r.pid);
  const sinceDate = new Date(NEW_SET_SINCE);
  const [players, entries, recentMeta] = await Promise.all([
    prisma.player.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, rating: true, gamesPlayed: true },
    }),
    prisma.eventEntry.findMany({
      where: { playerId: { in: ids }, deckId: { not: null } },
      select: {
        playerId: true,
        deck: { select: { legend: true, name: true } },
        event: { select: { startDatetime: true } },
      },
    }),
    // Whole tracked meta since the new set's release (all players, not just
    // this event's roster) — measures new-set adoption in the wild.
    prisma.eventEntry.findMany({
      where: {
        deckId: { not: null },
        event: { startDatetime: { gte: sinceDate } },
      },
      select: {
        playerId: true,
        deck: { select: { legend: true, name: true } },
        event: { select: { name: true, startDatetime: true } },
      },
    }),
  ]);
  const known = new Map(players.map((p) => [p.id, p]));

  // playerId -> legend -> { count, last }
  const hist = new Map<string, Map<string, { count: number; last: number }>>();
  for (const e of entries) {
    const legend = e.deck?.legend ?? e.deck?.name;
    if (!legend) continue;
    const t = e.event.startDatetime?.getTime() ?? 0;
    let byLegend = hist.get(e.playerId);
    if (!byLegend) hist.set(e.playerId, (byLegend = new Map()));
    const cur = byLegend.get(legend) ?? { count: 0, last: 0 };
    cur.count++;
    cur.last = Math.max(cur.last, t);
    byLegend.set(legend, cur);
  }

  interface Row {
    name: string;
    tag?: string;
    rating?: number;
    games?: number;
    legend: string | null;
    source: "submitted" | "recent" | "none";
    fresh: boolean; // prediction backed by a post-new-set event
    history: string;
  }
  const sinceT = sinceDate.getTime();
  const rows: Row[] = [];
  for (const r of roster) {
    const p = known.get(r.pid);
    const byLegend = hist.get(r.pid);
    const fresh = byLegend
      ? Math.max(...[...byLegend.values()].map((v) => v.last)) >= sinceT
      : false;
    let legend: string | null = null;
    let source: Row["source"] = "none";
    if (submitted.has(r.uid)) {
      legend = submitted.get(r.uid)!;
      source = "submitted";
    } else if (byLegend?.size) {
      // Most recent event's legend; ties broken by frequency.
      legend = [...byLegend.entries()].sort(
        (a, b) => b[1].last - a[1].last || b[1].count - a[1].count,
      )[0][0];
      source = "recent";
    }
    const history = byLegend
      ? [...byLegend.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([l, v]) => `${l}×${v.count}`)
          .join(", ")
      : "";
    rows.push({
      name: r.realName,
      tag: r.tag,
      rating: p?.rating,
      games: p?.gamesPlayed,
      legend,
      source,
      fresh,
      history,
    });
  }

  // ---- Report ------------------------------------------------------------
  const withLegend = rows.filter((r) => r.legend);
  console.log(
    `\ncoverage: ${known.size}/${roster.length} registrants known to the DB, ` +
      `${withLegend.length} with a legend signal ` +
      `(${rows.filter((r) => r.source === "submitted").length} submitted, ` +
      `${rows.filter((r) => r.source === "recent").length} inferred from history; ` +
      `${rows.filter((r) => r.source === "recent" && r.fresh).length} of those ` +
      `from a post-${NEW_SET_SINCE} event)\n`,
  );

  // ---- New-set adoption in the tracked meta ------------------------------
  const metaCount = new Map<string, number>();
  const metaEvents = new Set<string>();
  for (const e of recentMeta) {
    const legend = e.deck?.legend ?? e.deck?.name;
    if (!legend) continue;
    metaCount.set(legend, (metaCount.get(legend) ?? 0) + 1);
    metaEvents.add(`${e.event.name} (${e.event.startDatetime?.toISOString().slice(0, 10)})`);
  }
  const metaTotal = [...metaCount.values()].reduce((a, b) => a + b, 0);
  const newSetTotal = [...metaCount.entries()]
    .filter(([l]) => isNewSet(l))
    .reduce((a, [, n]) => a + n, 0);
  console.log(
    `=== TRACKED META SINCE ${NEW_SET_SINCE} (${metaEvents.size} events, ${metaTotal} deck entries) ===`,
  );
  console.log(
    `new-set legends: ${newSetTotal}/${metaTotal} entries ` +
      `(${metaTotal ? ((100 * newSetTotal) / metaTotal).toFixed(1) : 0}%)`,
  );
  for (const [legend, n] of [...metaCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(
      `${String(n).padStart(3)}  ${((100 * n) / metaTotal).toFixed(1).padStart(5)}%  ${legend}${vTag(legend)}`,
    );
  }

  // ---- Historical precedent: Unleashed (set 3) adoption curve ------------
  // Unleashed released (EN) 2026-05-08 and added 12 champions. Measure how
  // fast its legends took over tracked events — the best available prior for
  // how much Vendetta will show up on a date ~2 weeks after ITS release.
  const S3_RELEASE = new Date("2026-05-08");
  const rosterIdSet = new Set(ids);
  const S3_CHAMPS = [
    "Vi", "Vex", "Diana", "Ivern", "Jhin", "Kha'Zix",
    "LeBlanc", "Lillia", "Master Yi", "Poppy", "Pyke", "Rengar",
  ];
  const s3Decks = await prisma.deck.findMany({
    where: { OR: S3_CHAMPS.map((c) => ({ legend: { startsWith: c } })) },
    select: { id: true, legend: true },
  });
  // Empirical check: a candidate legend really is set-3-new only if its first
  // appearance in the full entry history is at/after the release window.
  const firstSeen = new Map<string, number>();
  if (s3Decks.length) {
    const s3All = await prisma.eventEntry.findMany({
      where: { deckId: { in: s3Decks.map((d) => d.id) } },
      select: { deckId: true, event: { select: { startDatetime: true } } },
    });
    for (const e of s3All) {
      const t = e.event.startDatetime?.getTime();
      if (t == null || e.deckId == null) continue;
      const cur = firstSeen.get(e.deckId);
      if (cur == null || t < cur) firstSeen.set(e.deckId, t);
    }
  }
  const graceT = new Date("2026-05-01").getTime(); // prerelease grace
  const s3NewIds = new Set(
    s3Decks
      .filter((d) => (firstSeen.get(d.id) ?? Infinity) >= graceT)
      .map((d) => d.id),
  );
  const s3OldTimers = s3Decks.filter((d) => !s3NewIds.has(d.id));
  if (s3OldTimers.length) {
    console.log(
      `note: candidate set-3 legends seen BEFORE release (excluded): ` +
        s3OldTimers
          .map((d) => `${d.legend} (first ${new Date(firstSeen.get(d.id)!).toISOString().slice(0, 10)})`)
          .join("; "),
    );
  }

  const winEntries = await prisma.eventEntry.findMany({
    where: {
      deckId: { not: null },
      event: {
        startDatetime: { gte: new Date("2026-04-24"), lt: new Date("2026-06-20") },
      },
    },
    select: {
      playerId: true,
      deckId: true,
      event: { select: { startDatetime: true, numPlayers: true, name: true } },
    },
  });
  const WEEK = 7 * 24 * 3600 * 1000;
  const byWeek = new Map<number, { total: number; s3: number }>();
  const bigEvents = new Map<string, { total: number; s3: number; when: string }>();
  const rosterS3Adopters = new Map<string, number>(); // pid -> days-to-first-s3-deck
  for (const e of winEntries) {
    const t = e.event.startDatetime?.getTime();
    if (t == null) continue;
    const wk = Math.floor((t - S3_RELEASE.getTime()) / WEEK);
    const b = byWeek.get(wk) ?? { total: 0, s3: 0 };
    b.total++;
    const isS3 = e.deckId != null && s3NewIds.has(e.deckId);
    if (isS3) b.s3++;
    byWeek.set(wk, b);
    if ((e.event.numPlayers ?? 0) >= 32 && t >= S3_RELEASE.getTime()) {
      const key = `${e.event.name}`;
      const g = bigEvents.get(key) ?? {
        total: 0, s3: 0, when: e.event.startDatetime!.toISOString().slice(0, 10),
      };
      g.total++;
      if (isS3) g.s3++;
      bigEvents.set(key, g);
    }
    if (isS3 && rosterIdSet.has(e.playerId)) {
      const days = Math.floor((t - S3_RELEASE.getTime()) / (24 * 3600 * 1000));
      const cur = rosterS3Adopters.get(e.playerId);
      if (cur == null || days < cur) rosterS3Adopters.set(e.playerId, days);
    }
  }
  console.log(
    `=== PRECEDENT: UNLEASHED (SET 3) ADOPTION AFTER 2026-05-08 RELEASE ===`,
  );
  for (const wk of [...byWeek.keys()].sort((a, b) => a - b)) {
    const b = byWeek.get(wk)!;
    const label =
      wk < 0 ? `wk ${wk} (pre)` : `wk +${wk + 1} (days ${wk * 7}-${wk * 7 + 6})`;
    console.log(
      `${label.padEnd(24)} ${String(b.s3).padStart(4)}/${String(b.total).padEnd(5)} = ${((100 * b.s3) / (b.total || 1)).toFixed(1)}% set-3 legends`,
    );
  }
  if (bigEvents.size) {
    console.log(`\nlarger events (32+ players) in the first weeks:`);
    for (const [name, g] of [...bigEvents.entries()].sort((a, b) =>
      a[1].when.localeCompare(b[1].when),
    )) {
      console.log(
        `  ${g.when}  ${String(g.s3).padStart(3)}/${String(g.total).padEnd(4)} (${((100 * g.s3) / g.total).toFixed(0)}%)  ${name}`,
      );
    }
  }
  const adopters14 = [...rosterS3Adopters.values()].filter((d) => d <= 14).length;
  console.log(
    `\nTHIS event's registrants during that window: ${rosterS3Adopters.size} ` +
      `played a set-3 legend within the first 6 weeks; ${adopters14} did so ` +
      `within 14 days of release (the Gen.G event is day 15 for Vendetta).\n`,
  );

  // ---- Which registrants have shown up post-release, and on what ---------
  const rosterIds = new Set(ids);
  const seenRecent = new Map<string, Map<string, number>>(); // pid -> legend -> n
  for (const e of recentMeta) {
    if (!rosterIds.has(e.playerId)) continue;
    const legend = e.deck?.legend ?? e.deck?.name;
    if (!legend) continue;
    let m = seenRecent.get(e.playerId);
    if (!m) seenRecent.set(e.playerId, (m = new Map()));
    m.set(legend, (m.get(legend) ?? 0) + 1);
  }
  console.log(
    `\n=== REGISTRANTS SEEN IN TRACKED EVENTS SINCE ${NEW_SET_SINCE} (${seenRecent.size}) ===`,
  );
  for (const r of roster) {
    const m = seenRecent.get(r.pid);
    if (!m) continue;
    const p = known.get(r.pid);
    const legends = [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([l, n]) => `${l}${vTag(l)}×${n}`)
      .join(", ");
    console.log(
      `${r.realName.padEnd(24)} ${String(p?.rating ?? "?").padEnd(6)} ${legends}`,
    );
  }
  console.log();

  const dist = new Map<string, Row[]>();
  for (const r of withLegend) {
    const list = dist.get(r.legend!) ?? [];
    list.push(r);
    dist.set(r.legend!, list);
  }
  console.log("=== PREDICTED LEGEND DISTRIBUTION ===");
  const ranked = [...dist.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [legend, pilots] of ranked) {
    const pct = ((100 * pilots.length) / withLegend.length).toFixed(1);
    const top = pilots
      .filter((p) => p.rating != null)
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 3)
      .map((p) => `${p.name} (${p.rating})`)
      .join(", ");
    console.log(
      `${String(pilots.length).padStart(3)}  ${pct.padStart(5)}%  ${(legend + vTag(legend)).padEnd(34)} top: ${top || "-"}`,
    );
  }

  console.log("\n=== PER-PLAYER ===");
  for (const r of [...rows].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))) {
    const tag = r.tag && r.tag !== r.name ? ` "${r.tag}"` : "";
    const rate = r.rating != null ? `${r.rating} (${r.games}g)` : "unknown";
    const src = r.source === "recent" && r.fresh ? "recent✓post-set" : r.source;
    console.log(
      `${(r.name + tag).padEnd(36)} ${rate.padEnd(14)} ${(r.legend ?? "?").padEnd(34)} [${src}] ${r.history}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
