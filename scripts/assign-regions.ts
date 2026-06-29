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
  // 1) Stores by location.
  const stores = await prisma.store.findMany();
  const storeRegion = new Map<string, Region>();
  for (const s of stores) {
    const region = regionForStore(s.city, s.latitude, s.longitude);
    storeRegion.set(s.id, region);
    if (s.region !== region) {
      await prisma.store.update({ where: { id: s.id }, data: { region } });
    }
  }

  // 2) Players by where they play most.
  const entries = await prisma.eventEntry.findMany({
    select: { playerId: true, event: { select: { storeId: true } } },
  });
  const counts = new Map<string, Record<Region, number>>();
  for (const e of entries) {
    const sr = e.event.storeId ? storeRegion.get(e.event.storeId) : undefined;
    if (!sr) continue;
    const m =
      counts.get(e.playerId) ?? ({ "tri-cities": 0, flint: 0, other: 0 } as Record<Region, number>);
    m[sr] += 1;
    counts.set(e.playerId, m);
  }
  let updated = 0;
  for (const [playerId, m] of counts) {
    let best: Region = "other";
    let bestC = -1;
    for (const r of REGION_ORDER) {
      if (m[r] > bestC) {
        bestC = m[r];
        best = r;
      }
    }
    await prisma.player.update({ where: { id: playerId }, data: { region: best } });
    updated++;
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
