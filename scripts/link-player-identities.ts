/** Apply verified identity links atomically. Dry run by default; --apply writes.
 * Run elo:recompute afterwards: ratings must replay the combined history.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { PLAYER_IDENTITY_LINKS } from "../src/lib/player-identity";

async function main() {
  const apply = process.argv.includes("--apply");
  for (const [alias, canonical] of Object.entries(PLAYER_IDENTITY_LINKS)) {
    await prisma.$transaction(async tx => {
      const source = await tx.player.findUnique({ where: { id: alias } });
      if (!source) { console.log(`${alias}: already linked or not imported`); return; }
      if (!await tx.player.findUnique({ where: { id: canonical } })) throw new Error(`Missing canonical player ${canonical}`);
      const conflicts = await tx.match.count({ where: { isBye: false, OR: [
        { playerOneId: alias, playerTwoId: canonical },
        { playerOneId: canonical, playerTwoId: alias },
      ] } });
      const entries = await tx.eventEntry.findMany({ where: { playerId: alias }, select: { eventId: true } });
      const overlaps = await tx.eventEntry.count({ where: { playerId: canonical, eventId: { in: entries.map(e => e.eventId) } } });
      if (conflicts || overlaps) throw new Error(`Conflicting participation for ${alias}; review before linking`);
      console.log(`${alias} -> ${canonical}: ${entries.length} events, ${source.gamesPlayed} rated matches${apply ? " (apply)" : " (dry run)"}`);
      if (!apply) return;
      await tx.eventEntry.updateMany({ where: { playerId: alias }, data: { playerId: canonical } });
      await tx.match.updateMany({ where: { playerOneId: alias }, data: { playerOneId: canonical } });
      await tx.match.updateMany({ where: { playerTwoId: alias }, data: { playerTwoId: canonical } });
      await tx.match.updateMany({ where: { winnerId: alias }, data: { winnerId: canonical } });
      // Derived rows are rebuilt by recompute; source matches and entries remain.
      await tx.ratingChange.deleteMany({ where: { playerId: alias } });
      await tx.player.delete({ where: { id: alias } });
    }, { timeout: 60_000 });
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Identity linking failed");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
