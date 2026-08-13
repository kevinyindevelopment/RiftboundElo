/**
 * Where is the Neon storage/compute actually going?
 *
 *   npx tsx scripts/db-audit.ts
 *
 * Prints total DB size, per-table heap/index/toast breakdown, per-index size +
 * scan counts (unused indexes are pure storage waste), dead-tuple bloat, and a
 * scope check: how much of the data is OUTSIDE the intended MI/CA/premier scope
 * (a stray `--global` run leaves hundreds of thousands of rows the site never
 * displays). Read-only — safe to run against production.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const mb = (b: unknown) => `${(Number(b ?? 0) / 1024 / 1024).toFixed(1)} MB`;
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const rpad = (s: unknown, n: number) => String(s).padStart(n);

async function main() {
  const [{ size, bytes }] = await prisma.$queryRawUnsafe<
    { size: string; bytes: bigint }[]
  >(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
            pg_database_size(current_database()) AS bytes`);
  // Neon free tier caps at 0.5 GiB; the site starts 500ing once writes are refused.
  const limit = 512 * 1024 * 1024;
  console.log(
    `DATABASE SIZE: ${size}  (${((Number(bytes) / limit) * 100).toFixed(1)}% of a 0.5 GiB free-tier cap)\n`,
  );

  const tables = await prisma.$queryRawUnsafe<
    { name: string; total: bigint; heap: bigint; idx: bigint; toast: bigint | null; rows: bigint }[]
  >(`SELECT c.relname AS name,
            pg_total_relation_size(c.oid) AS total,
            pg_relation_size(c.oid) AS heap,
            pg_indexes_size(c.oid) AS idx,
            pg_total_relation_size(c.reltoastrelid) AS toast,
            c.reltuples::bigint AS rows
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC`);
  console.log(`${pad("TABLE", 16)}${rpad("TOTAL", 10)}${rpad("HEAP", 10)}${rpad("INDEXES", 10)}${rpad("ROWS", 12)}`);
  for (const t of tables) {
    console.log(
      pad(t.name, 16) + rpad(mb(t.total), 10) + rpad(mb(t.heap), 10) +
        rpad(mb(t.idx), 10) + rpad(t.rows, 12),
    );
  }

  const idx = await prisma.$queryRawUnsafe<
    { tbl: string; idx: string; size: bigint; scans: bigint }[]
  >(`SELECT relname AS tbl, indexrelname AS idx,
            pg_relation_size(indexrelid) AS size, idx_scan AS scans
     FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC LIMIT 25`);
  console.log(`\n${pad("INDEX", 44)}${rpad("SIZE", 10)}${rpad("SCANS", 12)}`);
  for (const i of idx) {
    // scans = 0 means nothing has ever used it — it costs storage + write time
    // for nothing (but check it isn't only needed by cascade deletes first).
    console.log(pad(`${i.tbl}.${i.idx}`, 44) + rpad(mb(i.size), 10) + rpad(i.scans, 12) + (Number(i.scans) === 0 ? "  <- never used" : ""));
  }

  const dead = await prisma.$queryRawUnsafe<
    { relname: string; live: bigint; dead: bigint; vac: Date | null }[]
  >(`SELECT relname, n_live_tup AS live, n_dead_tup AS dead,
            GREATEST(last_autovacuum, last_vacuum) AS vac
     FROM pg_stat_user_tables WHERE n_dead_tup > 0 ORDER BY n_dead_tup DESC`);
  console.log(`\n${pad("BLOAT (dead tuples)", 20)}${rpad("LIVE", 12)}${rpad("DEAD", 12)}  LAST VACUUM`);
  for (const d of dead) {
    const ratio = Number(d.live) ? ((Number(d.dead) / Number(d.live)) * 100).toFixed(0) : "-";
    console.log(pad(d.relname, 20) + rpad(d.live, 12) + rpad(`${d.dead} (${ratio}%)`, 12) + `  ${d.vac?.toISOString() ?? "never"}`);
  }

  // Scope check — the site only ever displays MI + CA stores + the UVS premier
  // hub. Anything else is dead weight from a past discovery/global run.
  const scope = await prisma.$queryRawUnsafe<
    { bucket: string; stores: bigint; events: bigint; matches: bigint }[]
  >(`SELECT CASE
              WHEN s.id IS NULL THEN 'no store (orphan)'
              WHEN UPPER(COALESCE(s.state,'')) IN ('MI','CA') THEN 'in scope (MI/CA)'
              ELSE 'OUT OF SCOPE: ' || COALESCE(s.state, s.country, '?')
            END AS bucket,
            COUNT(DISTINCT s.id) AS stores,
            COUNT(DISTINCT e.id) AS events,
            COUNT(m.id) AS matches
     FROM "Event" e
     LEFT JOIN "Store" s ON s.id = e."storeId"
     LEFT JOIN "Match" m ON m."eventId" = e.id
     GROUP BY 1 ORDER BY 4 DESC`);
  console.log(`\n${pad("SCOPE", 34)}${rpad("STORES", 9)}${rpad("EVENTS", 9)}${rpad("MATCHES", 10)}`);
  for (const s of scope) {
    console.log(pad(s.bucket, 34) + rpad(s.stores, 9) + rpad(s.events, 9) + rpad(s.matches, 10));
  }

  // Players with zero matches AND zero entries are pure dead weight (they cost a
  // row + 2 index entries each and are never rendered anywhere).
  const [orphans] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Player" p
     WHERE NOT EXISTS (SELECT 1 FROM "EventEntry" ee WHERE ee."playerId" = p.id)
       AND NOT EXISTS (SELECT 1 FROM "Match" m WHERE m."playerOneId" = p.id OR m."playerTwoId" = p.id)`,
  );
  console.log(`\nPlayers with no entries and no matches: ${orphans.n}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
