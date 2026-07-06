import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const size = await prisma.$queryRawUnsafe<{ size: string }[]>(
    "SELECT pg_size_pretty(pg_database_size(current_database())) AS size",
  );
  console.log("Neon DB size:", size[0].size);

  const top = await prisma.player.findMany({
    where: { gamesPlayed: { gte: 10 } },
    orderBy: [{ rating: "desc" }, { gamesPlayed: "desc" }],
    take: 5,
    select: { displayName: true, rating: true, wins: true, losses: true, draws: true },
  });
  console.log("Top 5 by rating:");
  for (const p of top) {
    console.log(`  ${p.rating}  ${p.displayName}  (${p.wins}-${p.losses}-${p.draws})`);
  }

  const byRegion = await prisma.player.groupBy({
    by: ["region"],
    _count: { _all: true },
    orderBy: { _count: { region: "desc" } },
  });
  console.log("Players by region:");
  for (const r of byRegion) console.log(`  ${r.region ?? "(none)"}: ${r._count._all}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
