import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";

// The app caches its database reads (see src/lib/cache.ts) and serves the home
// page as ISR, so it NEEDS a real incremental cache. Without one, `revalidate`
// and `unstable_cache` have nowhere to persist: the site falls back to hitting
// Neon on every request — which is what was burning the free tier's monthly
// compute budget in a couple of days.
//
// KV is the right store here: reads are free-tier generous (100k/day), entries
// are small (rendered HTML + JSON query results), and it is globally replicated
// so any edge location can serve a hit. Requires the NEXT_INC_CACHE_KV binding
// in wrangler.jsonc.
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
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  queue: "direct",
});
