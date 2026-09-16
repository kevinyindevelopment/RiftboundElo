# Riftbound Elo

A competitive analytics platform for the **Riftbound** (League of Legends TCG)
ladder. It ingests tournament data from the carde.io / UVS tournament API,
reconstructs match history, computes a **Glicko-2** rating for every player, and
serves nationwide rankings, player profiles, event results, and a deck / Legend
metagame breakdown.

Coverage is deliberately scoped: Michigan stores, California stores, and UVS
premier / Organized-Play events (Regional Qualifiers and similar). Stores and
players are grouped into **Tri-Cities**, **Flint**, and **Other**. The dataset
currently spans ~17.9K events and ~33K players.

**Live:** [kevin-yin.com/riftelo](https://kevin-yin.com/riftelo) — access-gated;
the deployment is tuned to keep database compute near idle.

## Stack

| Layer | Technology |
| --- | --- |
| App | Next.js 16 (App Router, TypeScript, Tailwind v4) |
| Runtime | Cloudflare Workers via the OpenNext adapter |
| Database | Neon Postgres — Prisma `engineType = "client"` + `@prisma/adapter-neon` |
| Cache | Cloudflare KV as OpenNext's incremental cache |
| Pipelines | `tsx` scripts: incremental ingest + deterministic Glicko-2 recompute |
| Scheduling | GitHub Actions, every 6 hours, concurrency-guarded |

## Architecture

```
carde.io / UVS tournament API
        │
        │  ingest:stores  (incremental, rate-limited, bounded concurrency)
        ▼
   Neon Postgres
   Event · EventEntry · Match · Player · Deck · RatingChange
        │
        │  elo:recompute  (full-history deterministic Glicko-2 replay)
        ▼
   Player rating snapshots + per-match rating history
        │
        ▼
   Next.js on Cloudflare Workers
   /rankings  /players/[id]  /events/[id]  /decks  /stores
```

Writes go to Neon over the **direct** connection; the deployed app reads
through the **pooled** connection. New results are live on the next request —
no redeploy required for data changes.

## Data pipeline

`npm run ingest:stores` is incremental by design. Each event stores the
provider's `updated_at` timestamp, and a completed event is immutable, so
unchanged events are skipped outright — no metadata write and no rounds,
standings, or match fetch. A steady-state sync of the tracked stores takes
about 40 seconds, versus roughly 10 minutes for a full backfill.

- Only new or changed events fetch rounds, standings, and head-to-head matches.
- Events are classified by their own `display_status`, not the query bucket they
  arrive in (the provider returns some upcoming and canceled events inside the
  "completed" listing). Canceled events are never result-fetched.
- Upcoming events get their registration roster refreshed, so player lists are
  populated before play begins.
- Requests are globally rate-limited (`INGEST_RPS`) with bounded concurrency
  (`INGEST_CONCURRENCY`), so a large backfill stays a predictable load on the
  upstream API.

## Rating model — Glicko-2

Ratings live in [`src/lib/glicko.ts`](src/lib/glicko.ts). Each player carries a
rating, a **rating deviation** (how uncertain the system is), and a volatility.
New players start with a large RD so their first results move the rating hard;
as they play, RD shrinks and the rating settles near their true skill. This
avoids classic Elo's failure mode where a fixed seed acts as a soft floor and a
beginner's most informative games barely move the number.

- Every match is its own rating period (the granularity lichess uses), so
  `elo:recompute` replays the entire match history in chronological order.
- The replay is **deterministic**: the same match data always produces the same
  ratings, and the full rating history is re-derivable from scratch.
- Each match writes up to two `RatingChange` rows, which power the rating curve
  on player pages.
- A rating stays **provisional** (shown with a `?`) until RD drops to
  `GLICKO_RD_ESTABLISHED`.

## Engineering notes

**Incremental ingest.** The routine update path is bounded and cheap in steady
state: it compares the provider's `updated_at` against the stored value and
only deep-fetches what actually changed.

**Diff-gated writes.** The recompute diffs inside Postgres
(`ON CONFLICT ... WHERE IS DISTINCT FROM`) instead of downloading tables to
diff in application code. That cut per-run egress from ~91 MB to ~22 MB, with
byte-identical output, and stopped rewriting rows that had not changed — which
also keeps retained database history from inflating.

**Caching is a cost and availability control here, not just a speed tweak.**
Every read goes through `cachedQuery` / `unstable_cache` with long TTLs, and
page segments export `revalidate` rather than `force-dynamic` (which silently
disables `unstable_cache`). Enabling OpenNext's cache interception returns
cached responses before the server function runs at all: median render CPU
dropped from ~550 ms to ~141 ms and the 503 rate fell from ~12% to ~3%.

**Prisma on Workers.** Cloudflare Workers cannot run Prisma's native Rust query
engine, so the client is generated with `engineType = "client"` (a WASM query
compiler, no native engine to mismatch) and always constructed with the Neon
driver adapter. On the app side, `neonConfig.poolQueryViaFetch` makes each query
a stateless HTTP fetch, and `.prisma/client` is listed in
`serverExternalPackages` so OpenNext resolves the `workerd` export condition
instead of trying to read the wasm from disk. See
[DEPLOYMENT.md](DEPLOYMENT.md) for the full wiring and its failure modes.

**Schema and index tuning against real usage.** The rating-history table uses a
composite `(playerId, matchId)` primary key instead of a synthetic id, an
unused 9.8 MB index was dropped after checking its lifetime scan count, and FK
indexes were added on `Match` so cascade deletes and player lookups stop
sequential-scanning. `npx tsx scripts/db-audit.ts` reports table sizes and
per-index scan counts.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run the app locally |
| `npm run ingest:stores` | Incremental sync of tracked MI/CA stores |
| `npm run ingest:stores -- --premier` | Also ingest the UVS Organized-Play events |
| `npm run ingest:stores -- --discover` | Geo-discover new nearby stores (occasional) |
| `npm run elo:recompute` | Replay all match history into Glicko-2 ratings |
| `npm run regions` | Assign stores and players to Tri-Cities / Flint / Other |
| `npm run probe -- --event <id>` | Inspect what the provider API returns for an event |
| `npx tsx scripts/db-audit.ts` | Table sizes and index scan counts |
| `npm run db:export` / `db:import` | Snapshot and restore the database |
| `npm run neon:tune` | Apply Neon compute settings (dry-run by default) |
| `npm run cf:build` / `cf:preview` / `cf:deploy` | OpenNext build, preview, deploy |

## Local setup

```bash
npm install            # also runs `prisma generate` (postinstall)
cp .env.example .env   # fill in the Neon connection URLs
npm run dev            # http://localhost:3000
```

`.env` needs a Neon Postgres `DATABASE_URL` (pooled) and `DIRECT_DATABASE_URL`
(direct). Ingesting fresh data additionally needs `CARDE_API_BASE` and a
`CARDE_TOKEN`. Rating and throughput knobs (`ELO_START`, `GLICKO_*`,
`INGEST_RPS`, `INGEST_CONCURRENCY`) are documented inline in
[`.env.example`](.env.example).

## Deployment

Production runs on Cloudflare Workers behind the `/riftelo` base path, with
Neon Postgres. Builds and deploys must run inside WSL — OpenNext's bundler does
not work on native Windows paths:

```sh
wsl.exe -e bash -lc "bash /mnt/c/Users/kyin9/Documents/GitHub/RiftboundElo/scripts/deploy.sh"
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full architecture and
[COST.md](COST.md) for the cost model that shapes the caching and scheduling
decisions.

## Disclaimer

Unofficial fan project. Not affiliated with, endorsed by, or sponsored by Riot
Games, UVS Games, or carde.io. Riftbound and League of Legends are trademarks
of Riot Games, Inc. Tournament data belongs to its respective owners.
