/**
 * Print a cheap fingerprint of all match RESULTS and nothing else, used by the
 * scheduled update workflow to decide whether a Glicko recompute is needed.
 *
 * The fingerprint is `count:hashsum` where hashsum is an ORDER-INDEPENDENT sum of
 * a per-row hash over the fields that affect ratings (winner + game scores). It
 * changes iff a match was added, removed, OR edited in place (e.g. a store
 * corrects a reported result) — even when the row COUNT stays the same. A plain
 * count would miss same-count corrections.
 *
 * Metadata-only event edits (description, date, etc.) do NOT change this
 * fingerprint — they don't affect ratings, and they're already reflected on the
 * site by the ingest's own `updated_at` change detection. So we don't waste a
 * recompute on them.
 *
 * Cost: a single sequential scan of Match with no sort and no large string
 * allocation — sub-second even at ~500k rows (measured), negligible next to the
 * multi-minute ingest/recompute it guards.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

(async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ fp: string }>>(
    `SELECT count(*)::text || ':' || coalesce(sum(hashtext(
        id || '|' || coalesce("winnerId", '') || '|' ||
        "playerOneWins"::text || '|' || "playerTwoWins"::text || '|' ||
        draws::text || '|' || "isBye"::text
      )::bigint), 0)::text AS fp
     FROM "Match"`,
  );
  process.stdout.write(rows[0]?.fp ?? "0:0");
})()
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
