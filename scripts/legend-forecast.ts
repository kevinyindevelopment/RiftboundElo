/**
 * Legend-field FORECAST for an upcoming event — the modelling companion to
 * scripts/legend-field.ts.
 *
 *   npx tsx scripts/legend-forecast.ts [eventId]     # defaults to 791304
 *
 * legend-field.ts answers "what did each registrant last play?". That is a
 * backward-looking snapshot, and it has a known bias: a player's *most recent*
 * tracked legend can be a year stale, and it structurally cannot predict a set
 * that released after their last tracked event. This script corrects for both:
 *
 *   1. CURRENT META BASELINE — legend share over recent windows (not each
 *      player's lifetime history), overall / California-only / larger events.
 *      An LA event is predicted better by the recent CA meta than by a Michigan
 *      FNM from March.
 *   2. RECENCY-WEIGHTED per-player prediction — exponential decay on entry age
 *      instead of strict argmax-by-last-event, so one stale outlier event does
 *      not outvote a consistent recent pilot.
 *   3. NEW-SET DISPLACEMENT — when Unleashed (set 3) landed, *which* legends
 *      lost share, and did adoption differ by rating tier? That is the only
 *      empirical basis for how a brand-new set redistributes an existing field.
 *
 * All queries are aggregate `groupBy`s over indexed columns — a handful of
 * round trips, no row-by-row egress. Designed for GitHub Actions where the
 * secrets live (workflow legend-field.yml, `script` input).
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { getAllRegistrations, getEventDetail } from "../src/lib/carde";

const EVENT = Number(process.argv[2] ?? 791304);

const VENDETTA_RELEASE = new Date(process.env.NEW_SET_SINCE ?? "2026-07-31");
const S3_RELEASE = new Date("2026-05-08");
const NEW_SET_CHAMPS = [
  "Akali", "Zed", "Kennen", "Shen", "Mel", "Jayce", "Ambessa", "Renekton", "Nasus",
];
const isNewSet = (legend: string) =>
  NEW_SET_CHAMPS.some((c) => legend === c || legend.startsWith(`${c},`));

const DAY = 24 * 3600 * 1000;
const pct = (n: number, d: number) => (d ? (100 * n) / d : 0);
const fmtPct = (n: number, d: number) => `${pct(n, d).toFixed(1).padStart(5)}%`;

/** deckId -> legend, for every deck referenced by the given ids. */
async function legendMap(deckIds: string[]): Promise<Map<string, string>> {
  const decks = await prisma.deck.findMany({
    where: { id: { in: deckIds } },
    select: { id: true, legend: true, name: true },
  });
  return new Map(
    decks.map((d) => [d.id, (d.legend ?? d.name ?? "unknown").trim()]),
  );
}

interface Share {
  legend: string;
  n: number;
}

/** Legend share over a window, optionally restricted by state / min event size. */
async function metaShare(opts: {
  from: Date;
  to: Date;
  state?: string;
  minPlayers?: number;
}): Promise<{ shares: Share[]; total: number; events: number }> {
  const eventWhere: Record<string, unknown> = {
    startDatetime: { gte: opts.from, lt: opts.to },
  };
  if (opts.state) eventWhere.store = { state: opts.state };
  if (opts.minPlayers) eventWhere.numPlayers = { gte: opts.minPlayers };

  const grouped = await prisma.eventEntry.groupBy({
    by: ["deckId"],
    where: { deckId: { not: null }, event: eventWhere },
    _count: { _all: true },
  });
  const events = await prisma.event.count({ where: eventWhere });

  const ids = grouped.map((g) => g.deckId!).filter(Boolean);
  const legends = await legendMap(ids);

  const byLegend = new Map<string, number>();
  for (const g of grouped) {
    const l = legends.get(g.deckId!) ?? "unknown";
    byLegend.set(l, (byLegend.get(l) ?? 0) + g._count._all);
  }
  const shares = [...byLegend.entries()]
    .map(([legend, n]) => ({ legend, n }))
    .sort((a, b) => b.n - a.n);
  const total = shares.reduce((a, s) => a + s.n, 0);
  return { shares, total, events };
}

function printShares(title: string, r: { shares: Share[]; total: number; events: number }, top = 15) {
  console.log(`\n--- ${title} — ${r.total} entries over ${r.events} events ---`);
  if (!r.total) {
    console.log("  (no data)");
    return;
  }
  for (const s of r.shares.slice(0, top)) {
    console.log(`  ${String(s.n).padStart(5)}  ${fmtPct(s.n, r.total)}  ${s.legend}`);
  }
  const tail = r.shares.slice(top).reduce((a, s) => a + s.n, 0);
  if (tail) console.log(`  ${String(tail).padStart(5)}  ${fmtPct(tail, r.total)}  (${r.shares.length - top} other legends)`);
}

async function main() {
  const detail = await getEventDetail(EVENT);
  console.log(
    `FORECAST for ${EVENT}: ${detail.name} | ${detail.display_status} | ` +
      `${detail.registered_user_count}/${detail.capacity} | starts ${detail.start_datetime}`,
  );
  const eventStart = detail.start_datetime ? new Date(detail.start_datetime) : new Date();
  const daysSinceSet = Math.round((eventStart.getTime() - VENDETTA_RELEASE.getTime()) / DAY);
  console.log(`Vendetta released ${VENDETTA_RELEASE.toISOString().slice(0, 10)} — event is day ${daysSinceSet}.\n`);

  // ---- 1. Current meta baseline -----------------------------------------
  console.log("=".repeat(72));
  console.log("1. CURRENT META BASELINE (what is actually being played lately)");
  console.log("=".repeat(72));

  const preSet = VENDETTA_RELEASE;
  for (const days of [30, 60, 90]) {
    const r = await metaShare({ from: new Date(preSet.getTime() - days * DAY), to: preSet });
    printShares(`ALL tracked stores, last ${days}d before Vendetta`, r, 12);
  }
  const ca30 = await metaShare({
    from: new Date(preSet.getTime() - 30 * DAY),
    to: preSet,
    state: "CA",
  });
  printShares("CALIFORNIA stores only, last 30d before Vendetta", ca30, 15);
  const ca60 = await metaShare({
    from: new Date(preSet.getTime() - 60 * DAY),
    to: preSet,
    state: "CA",
  });
  printShares("CALIFORNIA stores only, last 60d before Vendetta", ca60, 15);
  const big60 = await metaShare({
    from: new Date(preSet.getTime() - 60 * DAY),
    to: preSet,
    minPlayers: 32,
  });
  printShares("LARGER events (32+ players), last 60d before Vendetta", big60, 15);

  // ---- 2. New-set displacement, learned from Unleashed -------------------
  console.log("\n" + "=".repeat(72));
  console.log("2. NEW-SET DISPLACEMENT — how Unleashed (set 3) reshaped the field");
  console.log("=".repeat(72));

  // Identify set-3 legends empirically: first tracked appearance at/after the
  // prerelease grace date. (Names alone misfire — several set-3 champions had
  // earlier legend cards.)
  const S3_CHAMPS = [
    "Vi", "Vex", "Diana", "Ivern", "Jhin", "Kha'Zix",
    "LeBlanc", "Lillia", "Master Yi", "Poppy", "Pyke", "Rengar",
  ];
  const s3Decks = await prisma.deck.findMany({
    where: { OR: S3_CHAMPS.map((c) => ({ legend: { startsWith: c } })) },
    select: { id: true, legend: true },
  });
  const firstSeen = new Map<string, number>();
  if (s3Decks.length) {
    // groupBy cannot min across a relation, so read the (few thousand) rows.
    const rows = await prisma.eventEntry.findMany({
      where: { deckId: { in: s3Decks.map((d) => d.id) } },
      select: { deckId: true, event: { select: { startDatetime: true } } },
    });
    for (const r of rows) {
      const t = r.event.startDatetime?.getTime();
      if (t == null || !r.deckId) continue;
      const cur = firstSeen.get(r.deckId);
      if (cur == null || t < cur) firstSeen.set(r.deckId, t);
    }
  }
  const grace = new Date("2026-05-01").getTime();
  const s3New = new Set(
    s3Decks.filter((d) => (firstSeen.get(d.id) ?? Infinity) >= grace).map((d) => d.id),
  );
  const s3NewLegends = new Set(
    s3Decks.filter((d) => s3New.has(d.id)).map((d) => (d.legend ?? "").trim()),
  );
  console.log(`set-3 legends (empirically new): ${[...s3NewLegends].join(", ")}\n`);

  const before = await metaShare({
    from: new Date(S3_RELEASE.getTime() - 30 * DAY),
    to: S3_RELEASE,
  });
  const after = await metaShare({
    from: new Date(S3_RELEASE.getTime() + 7 * DAY),
    to: new Date(S3_RELEASE.getTime() + 21 * DAY),
  });
  const beforePct = new Map(before.shares.map((s) => [s.legend, pct(s.n, before.total)]));
  const afterPct = new Map(after.shares.map((s) => [s.legend, pct(s.n, after.total)]));
  const newAfter = after.shares
    .filter((s) => s3NewLegends.has(s.legend))
    .reduce((a, s) => a + s.n, 0);
  console.log(
    `set-3 share in days 7-21 after release: ${newAfter}/${after.total} = ${pct(newAfter, after.total).toFixed(1)}%`,
  );
  console.log(
    `\nBiggest share LOSERS among pre-existing legends (pre-30d -> days 7-21), pp change:`,
  );
  const deltas = [...beforePct.entries()]
    .filter(([l]) => !s3NewLegends.has(l))
    .map(([l, b]) => ({ legend: l, before: b, after: afterPct.get(l) ?? 0, d: (afterPct.get(l) ?? 0) - b }))
    .filter((x) => x.before >= 1.5)
    .sort((a, b) => a.d - b.d);
  for (const x of deltas.slice(0, 12)) {
    console.log(
      `  ${x.before.toFixed(1).padStart(5)}% -> ${x.after.toFixed(1).padStart(5)}%  (${x.d >= 0 ? "+" : ""}${x.d.toFixed(1)}pp)  ${x.legend}`,
    );
  }
  const retention = deltas.length
    ? deltas.reduce((a, x) => a + (x.before ? x.after / x.before : 0), 0) / deltas.length
    : 0;
  console.log(`\nmean retention of pre-existing legends' share: ${(100 * retention).toFixed(0)}%`);

  // Adoption by rating tier (current rating as a proxy for skill tier).
  const s3Entries = await prisma.eventEntry.findMany({
    where: {
      deckId: { not: null },
      event: {
        startDatetime: {
          gte: new Date(S3_RELEASE.getTime() + 7 * DAY),
          lt: new Date(S3_RELEASE.getTime() + 21 * DAY),
        },
      },
    },
    select: { playerId: true, deckId: true },
  });
  const pids = [...new Set(s3Entries.map((e) => e.playerId))];
  const ratings = new Map(
    (
      await prisma.player.findMany({
        where: { id: { in: pids } },
        select: { id: true, rating: true },
      })
    ).map((p) => [p.id, p.rating]),
  );
  const tiers: Array<{ label: string; min: number; max: number; n: number; s3: number }> = [
    { label: "1750+", min: 1750, max: 9999, n: 0, s3: 0 },
    { label: "1650-1749", min: 1650, max: 1750, n: 0, s3: 0 },
    { label: "1550-1649", min: 1550, max: 1650, n: 0, s3: 0 },
    { label: "<1550", min: 0, max: 1550, n: 0, s3: 0 },
  ];
  for (const e of s3Entries) {
    const r = ratings.get(e.playerId);
    if (r == null) continue;
    const t = tiers.find((t) => r >= t.min && r < t.max);
    if (!t) continue;
    t.n++;
    if (e.deckId && s3New.has(e.deckId)) t.s3++;
  }
  console.log(`\nset-3 adoption by (current) rating tier, days 7-21:`);
  for (const t of tiers) {
    console.log(`  ${t.label.padEnd(10)} ${String(t.s3).padStart(4)}/${String(t.n).padEnd(5)} = ${fmtPct(t.s3, t.n)}`);
  }

  // ---- 3. Recency-weighted per-player prediction -------------------------
  console.log("\n" + "=".repeat(72));
  console.log("3. RECENCY-WEIGHTED PER-PLAYER PREDICTION");
  console.log("=".repeat(72));

  const regs = await getAllRegistrations(EVENT);
  const roster = regs
    .filter((r) => r.user?.id != null)
    .map((r) => ({ pid: String(r.user!.id), name: r.user!.best_identifier ?? "?" }));
  const ids = roster.map((r) => r.pid);

  const entries = await prisma.eventEntry.findMany({
    where: { playerId: { in: ids }, deckId: { not: null } },
    select: {
      playerId: true,
      deck: { select: { legend: true, name: true } },
      event: { select: { startDatetime: true, numPlayers: true } },
    },
  });
  const players = await prisma.player.findMany({
    where: { id: { in: ids } },
    select: { id: true, rating: true, gamesPlayed: true },
  });
  const pinfo = new Map(players.map((p) => [p.id, p]));

  const HALFLIFE = Number(process.env.HALFLIFE_DAYS ?? 60);
  const now = eventStart.getTime();
  // playerId -> legend -> weight
  const wt = new Map<string, Map<string, number>>();
  for (const e of entries) {
    const legend = (e.deck?.legend ?? e.deck?.name)?.trim();
    const t = e.event.startDatetime?.getTime();
    if (!legend || t == null) continue;
    const ageDays = Math.max(0, (now - t) / DAY);
    const w = Math.pow(0.5, ageDays / HALFLIFE);
    let m = wt.get(e.playerId);
    if (!m) wt.set(e.playerId, (m = new Map()));
    m.set(legend, (m.get(legend) ?? 0) + w);
  }

  const predicted = new Map<string, number>();
  let withSignal = 0;
  const perPlayer: Array<{ name: string; rating: number | null; legend: string; conf: number }> = [];
  for (const r of roster) {
    const m = wt.get(r.pid);
    if (!m?.size) continue;
    withSignal++;
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const totalW = ranked.reduce((a, x) => a + x[1], 0);
    const [legend, w] = ranked[0];
    predicted.set(legend, (predicted.get(legend) ?? 0) + 1);
    perPlayer.push({
      name: r.name,
      rating: pinfo.get(r.pid)?.rating ?? null,
      legend,
      conf: totalW ? w / totalW : 0,
    });
  }
  console.log(
    `\n${withSignal}/${roster.length} registrants have a weighted legend signal ` +
      `(half-life ${HALFLIFE}d)\n`,
  );
  for (const [legend, n] of [...predicted.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${fmtPct(n, withSignal)}  ${legend}`);
  }

  const lowConf = perPlayer.filter((p) => p.conf < 0.5).length;
  console.log(
    `\n${lowConf}/${withSignal} of those predictions are low-confidence ` +
      `(top legend holds <50% of the player's weighted history)`,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
