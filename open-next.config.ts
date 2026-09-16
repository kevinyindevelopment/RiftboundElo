import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";

// The app caches its database reads (see src/lib/cache.ts) and serves the home
// page as ISR, so it NEEDS a real incremental cache. Without one, `revalidate`
// and `unstable_cache` have nowhere to persist: the site falls back to hitting
// Neon on every request — which is what was burning the free tier's monthly
// compute budget in a couple of days.
//
// ── Why KV, and the trap it comes with (read before changing) ──────────────
//
// KV's free tier allows **1,000 writes/day per ACCOUNT**, shared with the
// riftmarket Worker. In Aug 2026 this app blew through that — measured 2,640
// writes in one day, 2.6x the cap — because every distinct URL is its own cache
// key and ~51k URLs were crawlable (robots.ts: 33k players + 17.9k events),
// none of them with `generateStaticParams`. A cold `/events/[id]` costs ~6
// writes: the ISR entry plus one per cachedQuery it renders.
//
// The failure is SILENT. Once the quota is gone, KV `put`s fail and this
// adapter swallows the error (`catch (e) { error("Failed to set to cache", e) }`
// in kv-incremental-cache.js); `get` failures `return null`, indistinguishable
// from a miss. So the cache does not report an outage — it just stops working
// for the rest of the UTC day and every request falls through to Neon. The only
// symptom was the bill: ~$1/day of Neon compute, with the database awake 63% of
// the wall clock. See COST.md for the full measurement.
//
// **Why KV is nonetheless correct today:** the fix was applied at the traffic
// layer, not the storage layer. `/riftelo*` is now behind Cloudflare Access
// (single-user) plus a WAF crawler block, so the ~51% bot traffic and the whole
// 51k-URL long-tail crawl are gone. At single-user volume the write count is
// far under 1,000/day, and KV has a property R2 does not: it **cannot bill
// overage** — it hard-fails instead. That matches the "never exceed free tier"
// requirement exactly.
//
// ⚠️ **If the site is ever reopened to the public, this becomes wrong again.**
// The 1,000/day cap will be hit and the cache will silently die exactly as
// before. At that point move `incrementalCache` to R2
// (`r2IncrementalCache` + `withRegionalCache`, ~33k writes/day free) and add an
// R2 lifecycle rule to bound storage. Do NOT simply reopen and hope.
//
// `queue: "direct"` performs ISR revalidation inline on the request that finds a
// stale entry, instead of dispatching to a Durable Object / self-referencing
// service binding. That keeps the infrastructure to a single KV namespace, at
// the cost of one slower request per revalidation window — a fine trade at this
// traffic level.
//
// No `tagCache` is configured because nothing calls revalidateTag/revalidatePath
// yet; time-based revalidation does not need one. If the ingest ever grows a
// "publish now" hook, add a tag cache binding at the same time.
// `enableCacheInterception` is the reason the site survives the Cloudflare
// Workers FREE plan's CPU budget. Without it, every request — cache hit or not —
// boots the full Next.js server function before anything can be served. With it,
// the routing layer checks the incremental cache FIRST and returns the cached
// response directly (see @opennextjs/aws routingHandler.js: it returns before
// the server function is ever invoked), which is drastically less CPU.
//
// Safe here because it is only unsupported alongside PPR, and PPR arrives with
// `cacheComponents: true`, which this app does not enable. If Cache Components
// is ever adopted, this MUST be turned off.
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  queue: "direct",
  enableCacheInterception: true,
});
