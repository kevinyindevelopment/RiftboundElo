/**
 * Print the current Match row count and nothing else — a cheap change-detector
 * used by the scheduled update workflow to decide whether a recompute is needed.
 * New tournament results always add matches, so a changed count means "recompute".
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

prisma.match
  .count()
  .then((c) => {
    process.stdout.write(String(c));
  })
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
