# Cost model — read this before optimising anything

**Running this project as cheaply as possible is the number one priority.**
Optimise against the price list below, not against instinct. Several "obvious"
optimisations are worth approximately nothing here, and the thing that actually
costs money is not the thing that took the site down.

## There are TWO separate bills — don't conflate them

| Vendor | What it is | Plan |
|---|---|---|
| **Neon** | the Postgres database | **Launch (paid)** |
| **Cloudflare Workers** | the hosting that runs the site | **Free** |

They are unrelated accounts, and each has produced its own outage:

- **Neon** refused every query with **HTTP 402** ("exceeded the data transfer
  quota") when the recompute was pulling whole tables. Fixed by the Launch
  upgrade *and* by the egress work below.
- **Cloudflare** kills renders with **HTTP 503 / `exceededCpu`** because of the
  Free plan's 10 ms CPU cap. Upgrading Neon did nothing for this, and nothing in
  the database section below applies to it. See the Workers section.

When a limit bites, identify which vendor it came from before reasoning about
it — the fixes have nothing in common.

## The database plan

**Neon — Launch**

| | |
|---|---|
| Free limits | removed |
| Autoscale | up to **16 CU** |
| Scale to zero | after **5 minutes** idle |
| Projects | up to 100 |
| Branches | 10 per project |
| **Public network transfer** | **500 GB/month included** |
| Read replicas | instant |

Usage-based, on top of the plan fee:

| Meter | Price |
|---|---|
| Storage | **$0.35 / GB-month** |
| Instant restore (history/WAL retention) | **$0.20 / GB-month** |

> Not captured here: the plan's base fee, how much compute it includes, and the
> per-CU-hour overage rate. **Do not guess these.** If a decision hinges on
> compute pricing, check the Neon dashboard's billing page and update this file.

## What this means in practice

### 1. Compute time is the main lever. Optimise for the database being ASLEEP.

Neon scales to zero after 5 minutes idle and autoscales to 16 CU. So the bill
tracks **how many minutes per day the database is awake**, and how hard it is
pushed while awake — not how elegant the SQL is.

The practical consequence is unintuitive: **a query that runs once per hour is
cheaper than a more efficient query that runs every two minutes.** Anything that
touches Neon on a timer sets a floor on awake-time, because each wake bills the
work plus the 5-minute idle countdown.

Rules that follow:

- **Cache aggressively and with LONG TTLs.** Source data only changes when the
  ingest lands (every 3 hours), so a 2-minute TTL buys no freshness a user could
  perceive and costs up to 30x the wakes. See `src/lib/cache.ts`.
- **Fewer scheduled runs beats faster scheduled runs.** Halving the cron in
  `.github/workflows/update.yml` halves a fixed cost floor. That is a bigger
  lever than most query tuning.
- **Keep jobs short.** Recompute is ~61s; that is fine. Watch for regressions.
- Beware heavy queries: autoscaling to a higher CU to serve one expensive page
  costs more per second than the same second at 0.25 CU.

### 2. Transfer is no longer a constraint. Stop optimising it.

500 GB/month is included. Current usage after the fixes is roughly **5 GB/month**
— about **1%** of the allowance.

This is worth stating plainly because transfer is what caused the outage: on the
old free plan the allowance was 5 GB, recompute pulled ~91 MB per run, and Neon
began refusing every query with HTTP 402 (see DEPLOYMENT.md). That is fixed and
the headroom is now 100x. **Further egress micro-optimisation has almost no
monetary value.** Do it only where it also reduces awake-time or latency.

### 3. Storage is real but small. Do not contort the schema for it.

The database is ~339 MB, so about **$0.12/month**. Trimming 25 MB saves about
**one cent a month**.

Worth doing when it is clean and safe (dropping a genuinely unused index, not
storing data nothing reads). **Not** worth a risky migration, a denormalisation
that complicates queries, or deleting source data that would have to be
re-ingested. A schema change that saves 25 MB and costs an hour of debugging a
production migration is a bad trade at these prices.

Rough table shares (from `npm run db:audit`, Aug 2026): RatingChange 115 MB,
Match 100 MB, EventEntry 73 MB, Event 30 MB, Player 11 MB, Store 1.7 MB.
Optimising `Store` is pointless — it is 0.5% of the database.

### 4. Instant restore bills retained history — so write churn costs money.

At $0.20/GB-month, this scales with the WAL/history kept for the restore window.
Rewriting rows that did not change inflates it for nothing. Both bulk writers
therefore diff before writing, via `... WHERE IS DISTINCT FROM` — see
`scripts/recompute-elo.ts`. Keep it that way; a blind `UPDATE` over every row
costs storage *and* restore *and* compute.

If this line item ever looks large, **shortening the restore window in the Neon
dashboard is the direct fix** and needs no code change.

## The cache store: KV → R2 (Aug 2026), and the outage it caused

**A cache that silently stops caching bills you at the database, not the cache.**
This is the most expensive failure mode this project has hit, and it is worth
understanding in full because nothing about it is visible in logs or the UI.

### What happened

The incremental cache was a **KV** namespace. KV's free tier allows **1,000
writes/day**, and — the part that matters — that quota is **per Cloudflare
account**, shared with the `riftmarket` Worker on the same account.

This app generates far more than 1,000 writes/day, structurally:

- Every distinct URL is its own cache key.
- No `[id]` route defines `generateStaticParams`, so all of them are **on-demand
  ISR**, and `robots.ts` documents **~51k crawlable URLs** (33k players + 17.9k
  events).
- A cold `/events/[id]` costs about **6 writes** — the ISR entry plus one per
  `cachedQuery` it renders.

So a crawler walking even a few hundred detail pages exhausts the account's
entire daily write budget. A full sweep would want ~300k writes against a 1,000
allowance.

### Measured, 2026-08-14 (Cloudflare GraphQL + Neon API)

KV operations, `NEXT_INC_CACHE_KV` (riftelo) vs `RIFTMARKET_CACHE`:

| Date (UTC) | riftelo writes | riftelo reads | riftmarket writes | Account total writes |
|---|---|---|---|---|
| 2026-08-13 (from 17:00Z) | 730 | 1,970 | 10 | 740 |
| 2026-08-14 (to 20:00Z) | **2,640** | 4,120 | 0 | **2,640 — 2.6x the 1,000 cap** |

**Reads were never close to their 100k/day limit.** The binding constraint is
writes, and riftelo is ~100% of them. The 1,000/day cap was exhausted at
**10:00Z**, so the cache was dead for the following ~14 hours of the UTC day.
One hour (16:00Z) alone drew **1,120 writes** — a crawler sweep.

Neon, same window (28.0 h, both projects on one org):

| Project | CU-hours | Awake | Awake % | Avg CU while awake |
|---|---|---|---|---|
| **RiftElo** | **8.09** | **17.6 h** | **63%** | 0.46 |
| RiftMarket | 1.73 | 6.7 h | 24% | 0.26 |

RiftElo is **82% of all Neon compute**, at ~6.9 CU-hours/day — which is the
~$1/day. Two things fall straight out of these numbers:

- **Awake-time is the whole cost, exactly as this file predicted.** Average CU
  while awake is **0.46**, barely off the 0.25 floor, so autoscaling is *not*
  the driver and raising/lowering the ceiling would save almost nothing. The
  database being awake **63% of the wall clock** is the driver.
- **It is not the cron.** Four scheduled runs a day at ~5–10 min each plus the
  5-minute idle tail is ~3% of the day. The other ~60% is request-driven — i.e.
  the dead cache, converting every hit into a full uncached query set.

Note RiftElo's endpoint was **untuned** at the time of this measurement:
`min_cu 0.25 / max_cu 8 / suspend_timeout 0` (0 = "use account default", NOT
"never suspend"). Given the 0.46 average, lowering the ceiling is **tail-risk
insurance, not a saving** — worth doing to cap a pathological query, but it is
not where the dollar is.

**Resolved 2026-08-19: `npm run neon:tune`** (ported from RiftMarket) now encodes
the targets and applies them idempotently. Dry-run by default; `-- --apply`
writes. It picks the project by matching `DIRECT_DATABASE_URL`'s host, so it
cannot retune RiftMarket by mistake — both live in the same Neon org.

| Setting | Target | Why |
| --- | --- | --- |
| `autoscaling_limit_min_cu` | 0.25 | The floor, and the number actually billed for every awake minute. |
| `autoscaling_limit_max_cu` | **4** (was 8) | Halves the blast radius of a pathological query. **Not** 2 like RiftMarket: this project runs an ~11-min ingest and a full-history Glicko recompute, and a ceiling tight enough to throttle those would make them run *longer* — raising awake-time and costing more. A too-low ceiling is a cost regression here. |
| `suspend_timeout_seconds` | **300** (was 0) | The quiet one. `0` inherits the account default, so the idle tail on *every* wake was unpinned and could drift silently. This pins the 5-minute tail the whole cost model above assumes. |
| `history_retention_seconds` | **86400** | PITR is billed $0.20/GB-month *on WAL churn*, and `elo:recompute` rewrites ~2 RatingChange rows per match on every run where matches changed — so churn here is high and each retained day bills on it. Safe to shorten because the DB is reproducible (`ingest:stores` re-syncs from carde.io, recompute is deterministic, and `db:export`/`db:import` exist). Trades slow recovery for a smaller bill. |

Run the dry run first — it prints the current values, so the real drift is
visible before anything is written. `suspend_timeout` is the one to actually care
about; the rest is insurance.

## GitHub Actions minutes are a real meter on private repos

**2026-08-19: the account's Actions quota was exhausted and every scheduled job
in every repo failed.** Not this project's cron in isolation — the 2,000
minutes/month free allowance is **pooled account-wide across all private repos**,
and three projects were drawing on it at once:

| Repo | Pace |
|---|---|
| RiftboundElo (`update.yml`, 4x/day at ~14 min) | ~1,710 min/mo |
| RiftboundMarketWatch (two hourly polls, live from 08-13) | ~2,450 min/mo |
| DoomOSRS (nightly integration tests) | ~400 min/mo |

The failure signature is distinctive and easy to misread as a code bug: jobs
complete in **2-4 seconds with zero steps** and `runner_id: 0` in the API. That
is GitHub declining to assign a runner, not the workflow failing.

**Fix: RiftboundElo and RiftboundMarketWatch were made public**, which makes
standard-runner minutes unlimited and free, with no cadence loss and no spend.
A secret audit ran first — only `.env.example` was ever committed, and no tokens
or connection strings appear anywhere in either history.

> **Rule:** "cost is the number one priority" covers CI minutes as well as Neon.
> Before adding a scheduled workflow to a *private* repo, count it against the
> shared 2,000. Each job is rounded **up to a whole minute** and pays ~40s of
> checkout + `setup-node` + `npm ci` before doing any work, so frequent short
> crons are especially minute-inefficient. Making these repos private again
> re-arms this immediately.

### Why it was invisible

Once the quota is gone, KV operations fail — and
`@opennextjs/cloudflare`'s KV cache **swallows the error**:

```js
catch (e) { error("Failed to set to cache", e); }   // kv-incremental-cache.js
```

`get` failures likewise `return null`, which is indistinguishable from a miss.
So the cache does not report an outage; it just **stops working for the rest of
the UTC day**, and every request falls through to a full render and a full set
of Neon queries. That is precisely the uncached state this whole file exists to
prevent, arrived at silently. The symptom was **~$1/day of Neon compute** —
roughly $30/month against a project whose stated goal is to be near-free.

**These were also the least valuable writes possible.** A bot reads a long-tail
page once; by its next visit the TTL has expired, so the entry is rewritten
having never once been served from. The cache was paying full write price for a
~0% hit rate on the tail.

### The fix: cut the traffic, not scale the cache

The obvious fix was to move the cache to **R2** (1M class-A ops/month ≈ 33k/day,
~30x the headroom). That was built and then **deliberately abandoned**, because
R2 bills overage with no hard spend cap, and the requirement here is *never
exceed free tier*, not *probably stay under it*.

What made R2 unnecessary was measuring **who the traffic actually was**
(2026-08-14, 23 h of `/riftelo*`, 7,253 requests):

| Requests | User agent | Value to us |
|---|---|---|
| 2,202 | MJ12bot (Majestic backlink crawler) | none |
| 1,536 | GPTBot (OpenAI) | none |
| 3,514 | 3 real browser UAs | the actual users |

**51.5% of all traffic was two crawlers that send nothing back**, and Googlebot
did not appear in the sample at all — so the "we allow crawlers for SEO" trade
`robots.ts` was protecting largely did not exist. Bots also hit *distinct* URLs,
so they drove a far larger share of cache writes than 51% suggests.

So the traffic was cut at the edge instead:

1. **WAF custom rule** on `kevin-yin.com/riftelo*` blocking `cf.client.bot`,
   empty UAs, and any UA matching bot/crawl/spider/slurp/scrapy/python-requests/
   headlesschrome. Verified: MJ12bot, GPTBot, Googlebot, empty UA → **403**;
   Chrome and Safari → **200**; bare `curl` deliberately still passes so
   `deploy.sh`'s smoke test works.
2. **Cloudflare Access** (Zero Trust, team domain `kevin-yin.cloudflareaccess.com`)
   in front of `kevin-yin.com/riftelo*`, allow-list of one person, 730 h
   sessions. The site is now private.
3. **`workers_dev` disabled.** This was the sharp edge: `riftelo.<sub>.workers.dev`
   is **not** covered by zone WAF rules *or* by Access, and was serving the whole
   app unauthenticated — a complete bypass. Verified 200 before, **404** after.

Net effect: traffic collapses to one user, so KV's 1,000 writes/day is now
enormous headroom rather than a ceiling, and **KV cannot bill overage — it
hard-fails.** That is why the app stays on `kvIncrementalCache`.

Two KV implementation details that no longer bite at this volume, but would
again if the site reopened:

- The KV `put` sets **no `expirationTtl`** (a literal `TODO` in the source), so
  entries never expire and accumulate against the 1 GB storage limit.
- `buildId` is part of the cache key, so **every deploy abandons the entire
  keyspace** and re-misses the whole site from cold.

> ⚠️ **Reopening the site publicly re-arms this bug.** The crawl surface is still
> ~51k URLs and nothing in the app changed. Before removing the Access policy,
> move `incrementalCache` to R2 (`r2IncrementalCache` + `withRegionalCache`) and
> add an R2 lifecycle rule (1–3 days) to bound storage — at 43 KB/entry measured,
> a fully-crawled keyspace is ~7.3 GB against a 10 GB free tier, plus a fresh
> generation per deploy.

> **Rule that generalises:** any cache whose failure path is a silent fallback to
> the database is a billing risk, not just a performance one. When adding a cache
> tier, check what its client does when the store returns an error. And when a
> cache is overflowing, check *who is filling it* before buying a bigger one —
> here the answer was two crawlers nobody wanted, and the bigger cache would have
> been pure cost.

## Cloudflare Workers: the Free plan's 10 ms CPU limit

The Worker runs on the **Workers Free** plan, which allows **10 ms of CPU per
invocation** and does not let you raise it. Adding `limits.cpu_ms` to
`wrangler.jsonc` is rejected by the API (`code 100328`) and **fails the entire
deploy** — don't.

Server-rendering any real page costs far more than 10 ms, so invocations that
actually render are sometimes killed with `outcome: exceededCpu`, surfacing as
**HTTP 503, Cloudflare error 1102**. Enforcement is bursty rather than absolute:
renders costing 500–800 ms of CPU frequently succeed, while others are cut off
at exactly `cpuTime = 10`. Measured across pages, roughly **10–15% of
cache-missing requests fail this way**, and it is NOT size-dependent — an event
with 1 entrant and 0 matches fails just as readily as a 1,953-player Regional,
and `/rankings` fails too.

Enforcement is evidently **burst-based rather than a hard ceiling**: renders
costing 550–880 ms of CPU routinely succeed, while others are cut off and
reported as `cpuTime: 10`. Don't reason about it as a clean cap.

For context on how expensive a render is here, `wrangler deploy` reports
`Worker Startup Time: ~29 ms` — the cost of initialising the Next.js/OpenNext
server before it renders anything at all.

**The single most effective fix is free**, and it is already applied:
`enableCacheInterception: true` in `open-next.config.ts`. It makes the routing
layer check the incremental cache and return the cached response *before* the
Next.js server function is invoked at all. Measured on the live site, same pages
and spacing:

| | failure rate | median CPU |
|---|---|---|
| without interception | **12%** (3/24) | ~550 ms |
| with interception | **~3%** (2/68) | **141 ms** |

The residual ~3% is cache-MISS and ISR-revalidation requests, which still have
to do a real render. Longer TTLs reduce how often that happens.

What follows from this:

- **Caching is the mitigation, and it is why the caching matters twice over.**
  A cache HIT serves stored HTML for almost no CPU. Only cache misses and ISR
  revalidations do a full render, so longer TTLs mean fewer exposed renders and
  proportionally fewer 503s. Before any caching existed, *every* request was a
  full render.
- **Short TTLs trade reliability for freshness here.** `/events/[id]/live` at 30s
  revalidates often and is therefore the most exposed page. That is a deliberate
  choice for tournament-day freshness, not an oversight.
- **Avoiding the render beats optimising it.** Cache interception wins because it
  skips the work entirely; trimming what a render does (see the live page's
  pagination) only shortens an invocation that still has to happen.

### Decision: we stay on Workers Free, knowingly (Aug 2026)

**Workers Paid (~$5/month)** would remove this failure class outright — it raises
the CPU ceiling to 30s (200x the worst render) and makes `limits.cpu_ms`
settable. It is the correct fix, and no free configuration closes the gap: even
a cache HIT costs ~141 ms against a ~10 ms budget.

We are **deliberately staying on Free for now**, because the site currently has
one user. Don't re-open this without new information. What it costs us:

- A failing request returns Cloudflare's own bare `error code: 1102` page — 17
  bytes of plain text, no styling. It cannot be caught or customised, because
  the runtime has already terminated the Worker; our code is not running.
- Refreshing almost always works.
- **The failure concentrates under bursts**, i.e. many people refreshing at once
  — which is precisely tournament-day usage of `/events/[id]/live`. Measured:
  back-to-back requests failed ~50%, requests 25s apart ~10%.

**Revisit the moment either becomes true:** the site gets more than one real
user, or a tournament day is actually disrupted. At that point it is a one-click
upgrade plus adding `limits.cpu_ms` to `wrangler.jsonc`.

## Checklist for a change that touches the database

1. Does it change how often Neon is **woken**? That dominates. Fewer wakes wins.
2. Does it add an **uncached** query to a page users refresh? That is the
   expensive shape. `/events/[id]/live` is the one deliberate exception.
3. Does it write rows that did not change? Guard it.
4. Does it only save **bytes**? Then it is probably not worth much — check
   section 2 before spending effort on it.
