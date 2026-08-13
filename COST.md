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

**The decisive number:** `wrangler deploy` reports `Worker Startup Time: 28 ms`
for this bundle. That is the cost of initialising the Next.js/OpenNext server
*before it renders anything*, and it is nearly 3x the entire Free-plan CPU
budget. So any invocation that includes cold-start initialisation blows the cap
on arrival, regardless of the page, the query, or the cache. This is a platform
mismatch between Next.js-on-Workers and the Free plan — not something any
application-level change can resolve.

What follows from this:

- **Caching is the mitigation, and it is why the caching matters twice over.**
  A cache HIT serves stored HTML for almost no CPU. Only cache misses and ISR
  revalidations do a full render, so longer TTLs mean fewer exposed renders and
  proportionally fewer 503s. Before any caching existed, *every* request was a
  full render.
- **Short TTLs trade reliability for freshness here.** `/events/[id]/live` at 30s
  revalidates often and is therefore the most exposed page. That is a deliberate
  choice for tournament-day freshness, not an oversight.
- **Cutting per-render work does not fix it.** No amount of optimisation gets an
  SSR render under 10 ms. It reduces the odds of being cut off; it cannot
  eliminate them.

**The actual fix is the Workers Paid plan (~$5/month)**, which raises the default
CPU ceiling to 30s and makes `limits.cpu_ms` settable. Against a Neon Launch bill
this is small, and it removes a site-wide class of intermittent 503s that no code
change can. Treat it as the first thing to buy if reliability matters more than
the last few dollars.

## Checklist for a change that touches the database

1. Does it change how often Neon is **woken**? That dominates. Fewer wakes wins.
2. Does it add an **uncached** query to a page users refresh? That is the
   expensive shape. `/events/[id]/live` is the one deliberate exception.
3. Does it write rows that did not change? Guard it.
4. Does it only save **bytes**? Then it is probably not worth much — check
   section 2 before spending effort on it.
