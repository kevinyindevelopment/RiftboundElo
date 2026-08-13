# Deploying RiftElo

This documents **how the site is hosted and how to push local changes live**. If
you're an agent/dev who just made changes and needs them on the live site, jump
to [Deploy](#deploy-push-local-changes-live).

## TL;DR

- **Live at:** https://kevin-yin.com/riftelo (and the direct Worker URL
  https://riftelo.doombornegame.workers.dev/riftelo)
- **Host:** Cloudflare Workers, via the **OpenNext** adapter (`@opennextjs/cloudflare`)
- **DB:** Neon Postgres (serverless), reached through Prisma's **Neon driver adapter**
- **To deploy:** run `scripts/deploy.sh` **inside WSL** (see below). Native
  Windows deploys DO NOT WORK.

```sh
# From Windows (Bash tool or terminal):
wsl.exe -e bash -lc "bash /mnt/c/Users/kyin9/Documents/GitHub/RiftboundElo/scripts/deploy.sh"
```

---

## Architecture

| Piece | What / where |
|---|---|
| App | Next.js 16 (App Router, all pages `force-dynamic` SSR) |
| Runtime | Cloudflare Workers (`workerd`), bundled by OpenNext into `.open-next/worker.js` |
| Sub-path | Served under **`/riftelo`** via `basePath` in `next.config.ts` (the root of `kevin-yin.com` is reserved for other content) |
| Routing | A Cloudflare **Worker Route** `kevin-yin.com/riftelo*` → the `riftelo` Worker. The rest of the domain is untouched. |
| DNS | A **proxied `AAAA @ 100::`** record on the apex (a black-hole address; Cloudflare's edge fronts it and the route serves `/riftelo*`). Cloudflare returns both IPv4 + IPv6 anycast for it. |
| Database | Neon Postgres. App uses the **pooled** URL; CLI scripts use the **direct** URL. |
| Caching | Cloudflare **KV** namespace bound as `NEXT_INC_CACHE_KV`, used as OpenNext's incremental cache (see [Caching](#caching-dont-undo-this-either)) |
| Config files | `wrangler.jsonc` (Worker name `riftelo`, route, `nodejs_compat`, KV binding), `open-next.config.ts` |

### Why the app can talk to Postgres on Workers (don't undo this)

Cloudflare Workers can't run Prisma's native Rust query engine, so the setup is:

1. **`prisma/schema.prisma`** → `generator client { engineType = "client" }`.
   This is the GA "query compiler" mode: a **WASM** compiler, **no native
   engine**, so there's no per-platform binary to mismatch. It **requires** a
   driver adapter.
2. **`src/lib/prisma.ts`** always constructs `new PrismaClient({ adapter })` with
   `PrismaNeon` (`@prisma/adapter-neon` + `@neondatabase/serverless`). Runtime
   detection (`WebSocketPair` global / `NEXT_RUNTIME`) only chooses the
   **connection string** (pooled for the app, direct for CLI scripts) — a wrong
   guess still works.
3. On the app side it sets **`neonConfig.poolQueryViaFetch = true`** so each query
   is a stateless HTTP fetch. Workers can't reuse a WebSocket Pool connection
   across requests; without this you get **intermittent 500s**.
4. **`next.config.ts`** → `serverExternalPackages` includes **`.prisma/client`**
   (not just `@prisma/client`). This is the critical bit: it stops Next from
   inlining Prisma's Node loader during `next build`, so OpenNext resolves the
   `workerd` export condition and imports the wasm as a module instead of
   `fs`-reading it at runtime.

If any of these regress, symptoms are: `Could not locate the Query Engine`
(engineType), `readAll .../query_compiler_bg.wasm` (serverExternalPackages), or
intermittent 500s on heavy pages (poolQueryViaFetch).

### Caching (don't undo this either)

The site's database reads are cached. This is a **cost** feature, not a speed
one: every Prisma call is a separate HTTPS request to Neon, and Neon only
auto-suspends after ~5 minutes idle — so with uncached pages, one visitor (or
crawler) every few minutes pins the compute on 24/7 and burns the free tier's
monthly compute-hour budget in days. That is what took the site down.

Four pieces, all required together:

1. **`open-next.config.ts`** → `incrementalCache: kvIncrementalCache` and
   `queue: "direct"`. Without an incremental cache there is nowhere to persist
   cached values and every request falls through to Neon.
2. **`wrangler.jsonc`** → a KV namespace bound as **`NEXT_INC_CACHE_KV`**. The
   binding name is fixed by the adapter; it is looked up by that exact string.
   Create one with `npx wrangler kv namespace create NEXT_INC_CACHE_KV`.
3. **`src/lib/cache.ts`** → `cachedQuery()` wraps the read-only queries in
   `unstable_cache`.
4. **Route segment configs** → pages export `revalidate`, **not**
   `dynamic = "force-dynamic"`. This is the subtle one: `force-dynamic` implies
   `fetchCache = "force-no-store"`, and `unstable_cache` skips the cache
   entirely under that flag. Re-adding `force-dynamic` to a page silently turns
   its caching off with no error and no visible symptom except the Neon bill.

`/events/[id]` and `/events/[id]/live` are **deliberately** still
`force-dynamic` — they show live standings during a tournament.

The home page and `/stores` call `await connection()`. They read no
request-scoped input, so without it Next prerenders them during `next build`,
which would make every deploy require a reachable database and bake a
build-time snapshot into the bundle. `connection()` opts them out of
prerendering while leaving the query cache active — the build still runs with
no DB access at all.

`unstable_cache` persists values via `JSON.stringify` and returns
`JSON.parse`, so `Date` fields come back as ISO **strings**. `cachedQuery`
runs results through `reviveDates` to restore them; if you cache a new query
that returns a date under an unfamiliar field name, add it to `DATE_KEYS`.

---

## ⚠️ Windows can't build/deploy — use WSL

OpenNext's bundler is **broken on native Windows**:
- `opennextjs-cloudflare deploy` fails with a mangled wasm path
  (`ENOENT ...\\query_compiler_bg.wasm`, backslashes stripped).
- `opennextjs-cloudflare preview` binds a port but hangs (never responds).

So **all builds and deploys run inside WSL (Ubuntu)**, which uses POSIX paths.
The Windows working tree is the source of truth for edits; `scripts/deploy.sh`
rsyncs it into a WSL-native copy at `~/riftelo` and builds/deploys from there.
Windows and WSL **cannot share `node_modules`** (different native binaries), which
is why there's a separate WSL copy with its own `npm install`.

### One-time WSL setup (already done on this machine)

- Ubuntu WSL with **Node 22** via nvm (`nvm install 22`). wrangler needs ≥22.
- Wrangler auth copied from Windows to WSL:
  `cp -r /mnt/c/Users/<you>/AppData/Roaming/xdg.config/.wrangler/* ~/.config/.wrangler/`
  (or run `npx wrangler login` inside WSL). Re-auth if the token expires.

---

## Deploy (push local changes live)

1. Make your edits in the **Windows** working tree as normal.
2. Typecheck on Windows: `npx tsc --noEmit -p tsconfig.json`.
3. Run the deploy script **in WSL**:
   ```sh
   wsl.exe -e bash -lc "bash /mnt/c/Users/kyin9/Documents/GitHub/RiftboundElo/scripts/deploy.sh"
   ```
   It syncs → `npm install` → `prisma generate` → `opennextjs-cloudflare build`
   → `opennextjs-cloudflare deploy`.
4. Verify:
   ```sh
   # Worker URL (always resolvable):
   curl -s -o /dev/null -w '%{http_code}\n' https://riftelo.doombornegame.workers.dev/riftelo
   # Custom domain via a public resolver (see DNS caveat below):
   curl -s -o /dev/null -w '%{http_code}\n' --doh-url https://1.1.1.1/dns-query https://kevin-yin.com/riftelo
   ```
   Both should print `200`.

There is **no git push involved** — deploys go straight from the working tree to
Cloudflare. (Committing is a separate, optional step and is gated on the owner's
say-so.)

## Secrets

DB credentials are **Worker secrets**, not in the bundle or git:
```sh
# in WSL, from ~/riftelo:
printf '%s' "<pooled-neon-url>"  | npx wrangler secret put DATABASE_URL
printf '%s' "<direct-neon-url>"  | npx wrangler secret put DIRECT_DATABASE_URL
```
`.dev.vars` mirrors these for local preview (but preview doesn't work on Windows).
`.env` holds them for the CLI scripts (ingest/recompute) that run on Windows.

## Custom domain / DNS notes

- The Wrangler OAuth token can create **Worker routes** but **not DNS records**
  (no `dns_records:write` scope). DNS changes are done in the Cloudflare
  dashboard or with a DNS-scoped API token.
- **Corporate/ISP DNS negative-caching:** if `kevin-yin.com` won't resolve on a
  work machine right after a DNS change, its resolver cached "no record" (SOA
  negative TTL ~30 min). It's not a deploy problem — verify with
  `--doh-url https://1.1.1.1/dns-query`, or test on cellular.

## Gotchas / history

- **Worker size limit (free tier ~3 MB gzip):** never let native Prisma engines
  (`.so`/`.dll`/`.node`, ~15 MB each) into the bundle. `engineType = "client"`
  keeps only the ~4 MB wasm compiler. If a build balloons, wipe `src/generated`
  and `~/riftelo/src/generated` and regenerate.
- **Neon free tier auto-suspends** after ~5 min idle; the first request after a
  long idle can be slow (cold DB). Inherent to $0 Neon; it recovers on its own.
