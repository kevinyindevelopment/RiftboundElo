/**
 * Data-layer caching for the read-only site queries.
 *
 * WHY: every Prisma call is a separate HTTPS request to Neon
 * (`poolQueryViaFetch`, see src/lib/prisma.ts), and every page was
 * `force-dynamic`, so each visitor — and each crawler — re-ran the full query
 * set against the database. Neon auto-suspends only after ~5 minutes idle, so
 * even light, steady traffic pins the compute on 24/7 and burns the free tier's
 * monthly compute-hour budget in days. Caching reads is what lets it idle.
 *
 * Source data only changes when the scheduled ingest lands (every 3 hours, see
 * .github/workflows/update.yml), so minutes of staleness are invisible to users
 * but remove essentially all steady-state database load.
 *
 * ── Two traps this module exists to handle ─────────────────────────────────
 *
 * 1. `unstable_cache` is BYPASSED under `fetchCache === 'force-no-store'`, and
 *    the route segment config `dynamic = "force-dynamic"` sets exactly that.
 *    Wrapping a query here does nothing unless its page drops `force-dynamic`
 *    (use `export const revalidate = N` instead). See the note in each page.
 *
 * 2. `unstable_cache` persists values as `JSON.stringify(result)` and returns
 *    `JSON.parse(...)`, so `Date` fields come back as ISO **strings**. Callers
 *    typed against Prisma's models would be silently lied to, so everything
 *    here runs through `reviveDates` on the way out.
 *
 * `unstable_cache` is deprecated in Next 16 in favour of `use cache`, but
 * `use cache` requires `cacheComponents: true`, which turns on PPR app-wide and
 * defaults to an in-memory cache — near-useless on Workers, where isolates are
 * evicted constantly. Migrating means restructuring every route around Suspense
 * boundaries and adopting `use cache: remote`. Worth doing deliberately later;
 * not worth coupling to an urgent cost fix.
 */
import { unstable_cache } from "next/cache";

/**
 * Seconds a cached read may be served before it is refreshed.
 *
 * These are deliberately LONG, and that is a COST decision — see COST.md.
 * Neon scales to zero after 5 minutes idle and bills compute by awake-time, so
 * the TTL sets how often the database is woken. Source data only changes when
 * the ingest lands (every 3 hours, see .github/workflows/update.yml), so a
 * 2-minute TTL buys no freshness anybody can perceive while costing up to 15x
 * the wakes of a 30-minute one.
 *
 * The floor that matters is 5 minutes: a TTL below that means Neon cannot
 * suspend while that page is being trafficked. Only the two tournament-day
 * tiers sit below it, deliberately — see their notes.
 */
export const TTL = {
  /**
   * Live tournament standings. BELOW the 5-minute suspend floor on purpose.
   *
   * This looks like it violates the rule above, and the reasoning matters: the
   * live page is only trafficked *during* an event, when the ingest is running
   * anyway and Neon is awake regardless — so the wakes are not additional. What
   * it does remove is the per-refresh database hit from every player in the
   * venue reloading between rounds, which is ~60x fewer queries for staleness
   * nobody can perceive (rounds run ~50 minutes). Outside events nothing
   * requests this page, so it costs nothing at all.
   */
  live: 30,
  /** Event detail: standings/pairings pages, refreshed on the day. */
  event: 60,
  /** Listings that move when new events are ingested. Still >> the 3h cadence. */
  short: 600, // 10 min
  /** Default for dashboards, ladders and listings. */
  medium: 1800, // 30 min
  /** Whole-history aggregates: expensive, and change only after a recompute. */
  long: 3600, // 1 hour
} as const;

/** Field names holding Prisma `DateTime` values in anything we cache. */
const DATE_KEYS = new Set([
  "startDatetime",
  "endDatetime",
  "ingestedAt",
  "sourceUpdatedAt",
  "playedAt",
  "createdAt",
  "updatedAt",
  "date",
]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Turn the ISO strings that survived the cache's JSON round-trip back into
 * `Date`s, so callers get exactly the shape Prisma returned. Only rewrites
 * known date-bearing keys whose value actually looks like an ISO timestamp, so
 * ordinary strings (names, ids, domain JSON) are left alone.
 */
export function reviveDates<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = reviveDates(value[i]);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string") {
      if (DATE_KEYS.has(key) && ISO.test(v)) obj[key] = new Date(v);
    } else if (v !== null && typeof v === "object") {
      obj[key] = reviveDates(v);
    }
  }
  return value;
}

/**
 * Any async query function. Mirrors the `Callback` constraint `unstable_cache`
 * itself uses: inferring the parameter tuple through a generic `A extends
 * unknown[]` instead collapses defaulted parameters to `unknown`, and widens the
 * result enough to lose Prisma's `_count` payloads.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncQuery = (...args: any[]) => Promise<any>;

/**
 * Wrap a read-only query so its result is served from the incremental cache
 * (Cloudflare KV in production, see open-next.config.ts) instead of hitting
 * Neon on every request.
 *
 * `keyParts` must uniquely name the query — the function's own arguments are
 * already part of the cache key, but a shared name across two different
 * functions would collide.
 *
 * Only use this for data that is safe to serve slightly stale, and NEVER for
 * anything request-specific (`headers`/`cookies` are not readable inside a
 * cached scope).
 */
export function cachedQuery<T extends AsyncQuery>(
  fn: T,
  keyParts: string[],
  revalidate: number = TTL.medium,
): T {
  const wrapped = unstable_cache(fn, keyParts, {
    revalidate,
    // One tag for the whole dataset: a future ingest hook can call
    // revalidateTag("db") to publish new results immediately.
    tags: ["db"],
  });
  return (async (...args: Parameters<T>) =>
    reviveDates(await wrapped(...args))) as T;
}
