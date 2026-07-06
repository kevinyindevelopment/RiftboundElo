/**
 * One-shot data export for the SQLite -> Postgres migration.
 *
 *   npm run db:export
 *
 * Dumps every table to a single JSON file. Run this while the datasource is
 * STILL sqlite (provider unchanged), so it reads the committed dev.db. The
 * companion db-import.ts loads the same file after the provider is switched to
 * postgresql and the schema is pushed.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";

const OUT = process.env.DB_DUMP_PATH ?? "prisma/dump.json";

async function main() {
  const [
    players,
    stores,
    decks,
    events,
    eventEntries,
    matches,
    ratingChanges,
    ingestState,
  ] = await Promise.all([
    prisma.player.findMany(),
    prisma.store.findMany(),
    prisma.deck.findMany(),
    prisma.event.findMany(),
    prisma.eventEntry.findMany(),
    prisma.match.findMany(),
    prisma.ratingChange.findMany(),
    prisma.ingestState.findMany(),
  ]);

  const dump = {
    players,
    stores,
    decks,
    events,
    eventEntries,
    matches,
    ratingChanges,
    ingestState,
  };

  writeFileSync(OUT, JSON.stringify(dump));
  const counts = Object.fromEntries(
    Object.entries(dump).map(([k, v]) => [k, (v as unknown[]).length]),
  );
  console.log(`Exported to ${OUT}`);
  console.table(counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
