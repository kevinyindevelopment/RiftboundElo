/**
 * One-shot data import for the SQLite -> Postgres migration.
 *
 *   npm run db:import
 *
 * Loads prisma/dump.json (produced by db-export.ts) into the CURRENT datasource.
 * Run this AFTER switching the provider to postgresql and running
 * `prisma db push` so the tables exist. Inserts in FK-dependency order and
 * revives DateTime columns (JSON carries them as ISO strings).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";

const IN = process.env.DB_DUMP_PATH ?? "prisma/dump.json";
const CHUNK = 2000;

// DateTime columns per model — JSON.stringify wrote these as ISO strings, so we
// revive them to Date before insert.
const DATE_FIELDS: Record<string, string[]> = {
  players: ["createdAt", "updatedAt"],
  events: ["startDatetime", "endDatetime", "ingestedAt", "sourceUpdatedAt"],
  matches: ["playedAt"],
  ratingChanges: ["createdAt"],
  ingestState: ["updatedAt"],
};

function revive(rows: Record<string, unknown>[], key: string) {
  const fields = DATE_FIELDS[key];
  if (!fields) return rows;
  for (const row of rows) {
    for (const f of fields) {
      if (row[f] != null) row[f] = new Date(row[f] as string);
    }
  }
  return rows;
}

async function load(
  key: string,
  rows: Record<string, unknown>[],
  create: (chunk: Record<string, unknown>[]) => Promise<{ count: number }>,
) {
  revive(rows, key);
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { count } = await create(chunk);
    done += count;
  }
  console.log(`  ${key}: ${done}/${rows.length}`);
}

async function main() {
  const dump = JSON.parse(readFileSync(IN, "utf8")) as Record<
    string,
    Record<string, unknown>[]
  >;

  // FK-dependency order: parents before children.
  console.log("Importing (FK order)…");
  await load("players", dump.players, (d) =>
    prisma.player.createMany({ data: d as never, skipDuplicates: true }),
  );
  await load("stores", dump.stores, (d) =>
    prisma.store.createMany({ data: d as never, skipDuplicates: true }),
  );
  await load("decks", dump.decks, (d) =>
    prisma.deck.createMany({ data: d as never, skipDuplicates: true }),
  );
  await load("events", dump.events, (d) =>
    prisma.event.createMany({ data: d as never, skipDuplicates: true }),
  );
  await load("eventEntries", dump.eventEntries, (d) =>
    prisma.eventEntry.createMany({ data: d as never, skipDuplicates: true }),
  );
  await load("matches", dump.matches, (d) =>
    prisma.match.createMany({ data: d as never, skipDuplicates: true }),
  );
  await load("ratingChanges", dump.ratingChanges, (d) =>
    prisma.ratingChange.createMany({ data: d as never, skipDuplicates: true }),
  );
  await load("ingestState", dump.ingestState, (d) =>
    prisma.ingestState.createMany({ data: d as never, skipDuplicates: true }),
  );

  console.log("Done. Row counts in Postgres:");
  console.table({
    players: await prisma.player.count(),
    stores: await prisma.store.count(),
    decks: await prisma.deck.count(),
    events: await prisma.event.count(),
    eventEntries: await prisma.eventEntry.count(),
    matches: await prisma.match.count(),
    ratingChanges: await prisma.ratingChange.count(),
    ingestState: await prisma.ingestState.count(),
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
