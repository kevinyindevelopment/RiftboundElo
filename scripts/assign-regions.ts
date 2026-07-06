/**
 * Assign every store and player to a region (tri-cities / flint / other).
 * Stores are classified by location; a player's region is wherever they've
 * played the most events. Idempotent — safe to re-run.
 *
 *   npm run regions
 *
 * Runs automatically at the end of `npm run ingest:stores`.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { REGION_ORDER, regionForStore, type Region } from "../src/lib/regions";

export async function assignAllRegions(quiet = false) {
  // Chunk id lists so updateMany stays well under Postgres limits.
  const chunk = <T>(arr: T[], n = 1000): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };

  // 1) Stores by location — batch the changed ones grouped by region.
  const stores = await prisma.store.findMany();
  const storeRegion = new Map<string, Region>();
  const storeChanges = new Map<Region, string[]>();
  for (const s of stores) {
    const region = regionForStore(s.city, s.latitude, s.longitude);
    storeRegion.set(s.id, region);
    if (s.region !== region) {
      const list = storeChanges.get(region) ?? [];
      list.push(s.id);
      storeChanges.set(region, list);
    }
  }
  for (const [region, ids] of storeChanges)
    for (const c of chunk(ids))
      await prisma.store.updateMany({ where: { id: { in: c } }, data: { region } });

  // 2) Players by where they play most — group by target region, then one
  //    updateMany per region (chunked) instead of a write per player.
  const entries = await prisma.eventEntry.findMany({
    select: { playerId: true, event: { select: { storeId: true } } },
  });
  const emptyCounts = () =>
    Object.fromEntries(REGION_ORDER.map((r) => [r, 0])) as Record<Region, number>;
  const counts = new Map<string, Record<Region, number>>();
  for (const e of entries) {
    const sr = e.event.storeId ? storeRegion.get(e.event.storeId) : undefined;
    if (!sr) continue;
    const m = counts.get(e.playerId) ?? emptyCounts();
    m[sr] += 1;
    counts.set(e.playerId, m);
  }
  const playersByRegion = new Map<Region, string[]>();
  for (const [playerId, m] of counts) {
    let best: Region = "other";
    let bestC = -1;
    for (const r of REGION_ORDER) {
      if (m[r] > bestC) {
        bestC = m[r];
        best = r;
      }
    }
    const list = playersByRegion.get(best) ?? [];
    list.push(playerId);
    playersByRegion.set(best, list);
  }
  let updated = 0;
  for (const [region, ids] of playersByRegion)
    for (const c of chunk(ids)) {
      await prisma.player.updateMany({ where: { id: { in: c } }, data: { region } });
      updated += c.length;
    }

  if (!quiet) {
    const tally: Record<string, number> = {};
    for (const r of REGION_ORDER) {
      tally[r] = await prisma.store.count({ where: { region: r } });
    }
    console.log("Store regions:", tally);
    const ptally: Record<string, number> = {};
    for (const r of REGION_ORDER) {
      ptally[r] = await prisma.player.count({ where: { region: r } });
    }
    console.log(`Player regions (of ${updated} assigned):`, ptally);
  }
}

// Allow running standalone.
if (process.argv[1] && /assign-regions/.test(process.argv[1])) {
  assignAllRegions()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
