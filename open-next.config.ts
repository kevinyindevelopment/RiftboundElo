import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The app is force-dynamic SSR — no ISR, no `use cache`, no next/image — so no
// incremental-cache / image bindings are needed and the default (uncached)
// config is correct. If we ever add ISR, wire an R2 or KV cache here (see
// https://opennext.js.org/cloudflare/caching) and add the matching binding
// + WORKER_SELF_REFERENCE service in wrangler.jsonc.
export default defineCloudflareConfig();
