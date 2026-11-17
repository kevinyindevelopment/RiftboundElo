/** Scoped PlayRiftbound ingest. No credentials or schema migration needed.
 * Default: last 21 days through next 60 days near tracked MI/CA stores.
 * First backfill: npm run ingest:playriftbound -- --since 2026-09-14
 * Preview without writes: append --dry-run.
 */
import "dotenv/config";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { getPlayRiftboundEvent, searchPlayRiftbound, type RbSearchResult } from "../src/lib/playriftbound";
import { isTrackedState, normalizePlayRiftbound, searchCenters } from "../src/lib/playriftbound-normalize";
import { PLAYRIFTBOUND_PREFIX } from "../src/lib/event-source";

type Batch = ReturnType<typeof normalizePlayRiftbound>;

/** Typed table allowlist; all row values are passed as one JSON parameter.
 * PostgreSQL supplies defaults for omitted columns, and unchanged rows never
 * get rewritten (including Player.updatedAt and Event.ingestedAt).
 */
async function upsertRows(
  tx: Prisma.TransactionClient,
  table: "Store" | "Event" | "Player" | "EventEntry" | "Match",
  input: object[],
  conflict = ["id"],
): Promise<number> {
  if (!input.length) return 0;
  const rows = table === "Player" ? input.map(row => ({ ...row, updatedAt: new Date() })) : input;
  const columns = Object.keys(rows[0]);
  const quote = (key: string) => `"${key}"`;
  // Existing players' home regions are assigned from their whole event history,
  // not whichever event happens to be in this batch.
  const updates = columns.filter(c => !conflict.includes(c) && c !== "id" && !(table === "Player" && c === "region"));
  const compare = updates.filter(c => c !== "updatedAt");
  let written = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    written += await tx.$executeRawUnsafe(
      `INSERT INTO "${table}" (${columns.map(quote).join(",")})
       SELECT ${columns.map(quote).join(",")} FROM jsonb_populate_recordset(NULL::"${table}", $1::jsonb)
       ON CONFLICT (${conflict.map(quote).join(",")}) DO UPDATE SET
       ${updates.map(c => `${quote(c)} = EXCLUDED.${quote(c)}`).join(",")}
       WHERE (${compare.map(c => `"${table}".${quote(c)}`).join(",")})
       IS DISTINCT FROM (${compare.map(c => `EXCLUDED.${quote(c)}`).join(",")})`,
      JSON.stringify(rows.slice(i, i + 1000)),
    );
  }
  return written;
}

async function writeBatch(batch: Batch[]): Promise<number> {
  // Each event's roster, results and metadata land together. A failed write
  // rolls back instead of marking an incomplete event as successfully synced.
  return prisma.$transaction(async tx => {
    let changed = 0;
    const unique = <T extends { id?: string }>(rows: T[]) => [...new Map(rows.map(row => [row.id, row])).values()];
    changed += await upsertRows(tx, "Store", unique(batch.map(b => b.store)));
    changed += await upsertRows(tx, "Player", unique(batch.flatMap(b => b.players)));
    changed += await upsertRows(tx, "Event", batch.map(b => b.event));
    changed += await upsertRows(tx, "EventEntry", batch.flatMap(b => b.entries), ["eventId", "playerId"]);
    changed += await upsertRows(tx, "Match", batch.flatMap(b => b.matches));
    // Only remove stale source-owned rows from events with complete successful
    // detail responses; a withdrawn registration or corrected pairing can vanish.
    const ids = batch.map(b => b.event.id);
    const matches = batch.flatMap(b => b.matches.map(m => m.id));
    const entries = batch.flatMap(b => b.entries.map(e => e.id!));
    changed += await tx.$executeRawUnsafe(
      `DELETE FROM "Match" WHERE "eventId" = ANY($1::text[]) AND NOT (id = ANY($2::text[]))`, ids, matches);
    changed += await tx.$executeRawUnsafe(
      `DELETE FROM "EventEntry" WHERE "eventId" = ANY($1::text[]) AND NOT (id = ANY($2::text[]))`, ids, entries);
    return changed;
  }, { timeout: 60_000 });
}

async function main() {
  const args = process.argv.slice(2);
  const now = new Date();
  const sinceArg = args.indexOf("--since");
  let since = sinceArg >= 0 ? new Date(args[sinceArg + 1]) : new Date(now.getTime() - 21 * 86400_000);
  const until = new Date(now.getTime() + 60 * 86400_000);
  const dryRun = args.includes("--dry-run");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since") { i++; continue; }
    if (args[i] !== "--dry-run") throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!Number.isFinite(since.getTime()) || since >= until || since < new Date("2026-09-14")) {
    throw new Error("--since must be a valid date on/after 2026-09-14 and before the window end");
  }
  const [stores, existingCount] = await Promise.all([
    prisma.store.findMany({ select: { state: true, latitude: true, longitude: true } }),
    prisma.event.count({ where: { id: { startsWith: PLAYRIFTBOUND_PREFIX } } }),
  ]);
  if (sinceArg < 0 && existingCount === 0) since = new Date("2026-09-14T00:00:00Z");
  const centers = searchCenters(stores);
  if (!centers.length) throw new Error("No tracked MI/CA store coordinates; refusing an unscoped search");
  console.log(`PlayRiftbound: ${centers.length} search areas, ${since.toISOString()} to ${until.toISOString()}${dryRun ? " (dry run)" : ""}`);
  const found = new Map<string, RbSearchResult>();
  // API work is performed before the write transaction. No DB polling while
  // waiting on the upstream service, so Neon can suspend during a long backfill.
  for (const center of centers) {
    for (const row of await searchPlayRiftbound(center.latitude, center.longitude, since, until)) {
      if (isTrackedState(row.tournament.tournamentLocation?.adminArea1)) found.set(row.tournament.id, row);
    }
  }
  console.log(`Found ${found.size} unique MI/CA events; fetching public results.`);
  const batches: Batch[] = [];
  for (const row of found.values()) {
    const detail = await getPlayRiftboundEvent(row.tournament.id);
    batches.push(normalizePlayRiftbound(row, detail, now));
    if (batches.length % 100 === 0) console.log(`Fetched ${batches.length}/${found.size} events.`);
  }
  console.log(JSON.stringify({
    events: batches.length,
    stores: new Set(batches.map(b => b.store.id)).size,
    players: new Set(batches.flatMap(b => b.players.map(p => p.id))).size,
    entries: batches.reduce((n, b) => n + b.entries.length, 0),
    matches: batches.reduce((n, b) => n + b.matches.length, 0),
  }));
  if (dryRun) return;
  let changed = 0;
  for (let i = 0; i < batches.length; i += 25) changed += await writeBatch(batches.slice(i, i + 25));
  console.log(`PlayRiftbound: ${changed} changed rows; existing UVS records preserved (${PLAYRIFTBOUND_PREFIX} namespace).`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
