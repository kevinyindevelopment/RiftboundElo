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
 * Reads are tiny (two indexed queries over ~128 player ids) — negligible Neon
 * egress. Designed to run in GitHub Actions (workflow legend-field.yml) where
 * the DB/carde secrets live; output goes to the workflow log.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  getAllRegistrations,
  getDeckSubmissions,
  getEventDetail,
  hasToken,
  CardeError,
} from "../src/lib/carde";

const EVENT = Number(process.argv[2] ?? 791304);

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
      console.log(`  -> legends extracted for ${submitted.size} players`);
      if (subs.total_submissions > 0 && submitted.size === 0) {
        console.log(
          "  (submissions present but no legend field found — raw sample below)",
        );
        console.log(JSON.stringify(subs.submissions[0]).slice(0, 1500));
      }
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
  const [players, entries] = await Promise.all([
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
    history: string;
  }
  const rows: Row[] = [];
  for (const r of roster) {
    const p = known.get(r.pid);
    const byLegend = hist.get(r.pid);
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
      history,
    });
  }

  // ---- Report ------------------------------------------------------------
  const withLegend = rows.filter((r) => r.legend);
  console.log(
    `\ncoverage: ${known.size}/${roster.length} registrants known to the DB, ` +
      `${withLegend.length} with a legend signal ` +
      `(${rows.filter((r) => r.source === "submitted").length} submitted, ` +
      `${rows.filter((r) => r.source === "recent").length} inferred from history)\n`,
  );

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
      `${String(pilots.length).padStart(3)}  ${pct.padStart(5)}%  ${legend.padEnd(34)} top: ${top || "-"}`,
    );
  }

  console.log("\n=== PER-PLAYER ===");
  for (const r of [...rows].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))) {
    const tag = r.tag && r.tag !== r.name ? ` "${r.tag}"` : "";
    const rate = r.rating != null ? `${r.rating} (${r.games}g)` : "unknown";
    console.log(
      `${(r.name + tag).padEnd(36)} ${rate.padEnd(14)} ${(r.legend ?? "?").padEnd(34)} [${r.source}] ${r.history}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
