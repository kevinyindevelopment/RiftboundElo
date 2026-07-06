import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";

// Neon exposes two connection strings:
//   DATABASE_URL         — pooled (PgBouncer), for the app's many short-lived
//                          connections (esp. once deployed to Cloudflare Workers).
//   DIRECT_DATABASE_URL  — direct (non-pooler), required for the bulk-write CLI
//                          scripts (ingest / recompute) and interactive txns.
// The Next.js server sets NEXT_RUNTIME; CLI scripts don't — so the app runs
// through the pooled connection and scripts through the direct one.
const pooled = process.env.DATABASE_URL;
const direct = process.env.DIRECT_DATABASE_URL ?? pooled;
// Which side is running? The APP must use the Neon adapter (esp. on Cloudflare
// Workers, which can't load Prisma's native engine); the CLI scripts use the
// native engine on the direct connection. Detect the app via two signals:
//   - Cloudflare Workers exposes navigator.userAgent === "Cloudflare-Workers"
//     (workerd does NOT populate process.env.NEXT_RUNTIME, so this is the only
//     reliable signal there — missing it sends the app down the native path and
//     it 500s at runtime).
//   - `next dev` / `next build` on Node set NEXT_RUNTIME.
// CLI scripts (plain `tsx`) match neither → native/direct path preserved.
const isWorkers =
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined" ||
  (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers");
const isAppServer = isWorkers || Boolean(process.env.NEXT_RUNTIME);

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  // With queryCompiler there is no native engine, so EVERYTHING goes through the
  // Neon serverless driver adapter — the app on Cloudflare Workers, `next dev`
  // on Node, and the CLI scripts on Node (Node 22+/workerd both expose a global
  // WebSocket for Neon's Pool, so no `ws` shim). Runtime detection now only
  // picks the connection string, so a wrong guess still WORKS (just pooled vs
  // direct): the app uses the pooled/PgBouncer URL, scripts the direct one.
  const connectionString = isAppServer ? pooled : direct;
  if (isAppServer) {
    // Cloudflare Workers can't reuse a WebSocket Pool connection across
    // requests, so a global client's connection goes bad after the first hit
    // (intermittent 500s). Run each query as a stateless HTTP fetch instead —
    // ideal for the app's read-only queries. CLI scripts keep the WebSocket
    // Pool (below) since their bulk writes use interactive transactions.
    neonConfig.poolQueryViaFetch = true;
  }
  const adapter = new PrismaNeon({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Reuse a single client across hot-reloads in dev and across script runs.
export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
