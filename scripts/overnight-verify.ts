/**
 * Post-ingest sanity check + summary for the overnight run. Exits non-zero if
 * the data looks incomplete, so the self-healing loop knows to retry.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const [events, players, matches, changes] = await Promise.all([
    prisma.event.count(),
    prisma.player.count(),
    prisma.match.count(),
    prisma.ratingChange.count(),
  ]);
  const opEvents = await prisma.event.count({ where: { storeId: "19428" } });
  // Count OP-hub events that actually have results (RQs are named "RQ <City>"
  // OR "…Regional Qualifier…", so match broadly; but the real completeness
  // signal is "how many OP events have match data").
  const rq = await prisma.$queryRawUnsafe<{ c: number }[]>(
    `SELECT COUNT(DISTINCT e.id)::int c FROM "Event" e JOIN "Match" m ON m."eventId"=e.id
     WHERE e."storeId"='19428' AND (e.name ILIKE '%qualifier%' OR e.name ILIKE '%RQ %')`,
  );
  const opWithResults = await prisma.$queryRawUnsafe<{ c: number }[]>(
    `SELECT COUNT(DISTINCT e.id)::int c FROM "Event" e JOIN "Match" m ON m."eventId"=e.id
     WHERE e."storeId"='19428'`,
  );
  const hartford = await prisma.match.count({ where: { eventId: "683264" } });
  const top = await prisma.player.findMany({
    where: { gamesPlayed: { gte: 10 } },
    orderBy: [{ rating: "desc" }, { gamesPlayed: "desc" }],
    take: 5,
    select: { displayName: true, rating: true, wins: true, losses: true, draws: true },
  });

  console.log("=== OVERNIGHT VERIFY ===");
  console.log({
    events,
    players,
    matches,
    ratingChanges: changes,
    opHubEvents: opEvents,
    opEventsWithResults: opWithResults[0]?.c ?? 0,
    qualifierEventsWithResults: rq[0]?.c ?? 0,
    hartfordMatches: hartford,
  });
  console.log("Top 5 by rating:");
  for (const p of top) console.log(`  ${p.rating}  ${p.displayName}  (${p.wins}-${p.losses}-${p.draws})`);

  // Sanity gates: we already had ~283k matches + Hartford(6889) before the sweep,
  // so anything materially less means the run didn't complete.
  if (matches < 283000) {
    console.error(`⚠ SANITY FAIL: matches=${matches} < 283000`);
    process.exit(2);
  }
  if (hartford < 6000) {
    console.error(`⚠ SANITY FAIL: Hartford matches=${hartford} < 6000`);
    process.exit(2);
  }
  if ((opWithResults[0]?.c ?? 0) < 100) {
    console.error(`⚠ SANITY FAIL: only ${opWithResults[0]?.c} OP events with results`);
    process.exit(2);
  }
  console.log("✅ SANITY OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
