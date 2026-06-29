import { PrismaClient } from "@/generated/prisma";

// Default the DB to the committed SQLite file so a fresh clone works with no
// .env at all (the file path resolves relative to prisma/schema.prisma).
process.env.DATABASE_URL ??= "file:./dev.db";

// Reuse a single client across hot-reloads in dev and across script runs.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
