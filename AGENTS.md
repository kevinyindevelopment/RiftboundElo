<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Hosting & deployment

This app is **live in production** at **https://kevin-yin.com/riftelo**, hosted on
**Cloudflare Workers** (via the OpenNext adapter) with a **Neon Postgres** DB.
Read **[DEPLOYMENT.md](DEPLOYMENT.md)** before touching hosting/DB config or
deploying — it explains the architecture and the exact process.

Critical facts:
- **Deploy = run `scripts/deploy.sh` inside WSL.** Native Windows builds/deploys
  DO NOT WORK (OpenNext's bundler breaks on Windows paths). There is no `git push`
  deploy; changes go straight from the working tree to Cloudflare.
- **Don't casually change the Prisma/DB wiring.** `engineType = "client"` +
  always-adapter (`PrismaNeon`) + `.prisma/client` in `serverExternalPackages` +
  `neonConfig.poolQueryViaFetch` are what make Prisma work on Workers. Reverting
  any of them breaks the live site (engine-not-found / wasm-fs-read / random 500s).
- The app is served under the **`/riftelo`** basePath; the root of the domain is
  reserved for other content.

# Data scope — READ THIS FIRST

The site's data coverage is **deliberately scoped**, NOT global:
**Michigan stores + California stores + UVS premier / Organized-Play events**
(Regional Qualifiers etc.). The ~450 "known stores" already in the DB *are* this
scope. Regions are split **Tri-Cities / Flint / Other**.

⚠️ **NEVER run a global/worldwide ingest** (`npm run ingest:stores -- --global`).
Riftbound is globally huge — a **1-day worldwide window is ~59,000 completed
events**, and `--global` lists ~137k events and serially upserts every one, so it
runs for **well over an hour** and pulls data the site never displays. This has
bitten past sessions. If you're "measuring update cost," measure the *scoped*
command the automation actually runs (below), not the biggest variant.

# Data pipeline (ingest → ratings)

Source data comes from the **carde.io / UVS "Hydra"** backend (`src/lib/carde.ts`).
Everything writes to Neon over the **direct** connection (`DIRECT_DATABASE_URL`);
the live SSR site reads it on the next request, so **no redeploy is needed** for
data changes.

**Ingest** (`scripts/ingest-stores.ts`, `npm run ingest:stores`):
- **No args** = re-sync the known MI/CA stores. Incremental: it lists each store's
  events and compares carde's `updated_at` to the stored `sourceUpdatedAt`, so
  **unchanged events are skipped** (no write, no deep result-fetch). Only new/
  changed events get their rounds+standings+matches pulled. This is the routine
  update path — bounded and cheap in steady state.
  - Events are classified by their **own `display_status`**, not the query bucket
    (carde returns some upcoming/canceled events inside the "completed" listing).
    `canceled` events are never result-fetched.
  - **Upcoming events** get their **registration roster** pulled (so player lists
    show before play). carde doesn't bump `updated_at` on registration, so these
    are re-fetched every run — but only for upcoming events that have registrants.
- `--premier` = also ingest the UVS Organized-Play hub store (`OP_STORE_IDS`,
  default 19428) where premier events (RQs) are hosted.
- `--discover` / `--near` / `--mi-grid` / `--ca-grid` / `--state-grid` = geo-discovery
  to find *new stores*. Occasional / manual — NOT part of the routine update.
- `--global` = worldwide date-window delta. **Banned** (see Data scope above).
- First run over a store that was only metadata-ingested before does a **one-time
  backfill** of historical results, which is slow; subsequent runs skip it.

**Ratings** (`scripts/recompute-elo.ts`, `npm run elo:recompute`): **Glicko-2**
(`src/lib/glicko.ts`), not classic Elo. It replays the full match history in
**iterative passes** (deterministic: same data → same ratings), rewrites the
`RatingChange` history (~2 rows/match) and updates each player's snapshot. It only
needs to run **when new matches were ingested** — new tournament results always add
`Match` rows, so a changed `Match` count means "recompute".

# Automatic updates (cloud, always-on)

Updates run on **GitHub Actions**, NOT a local machine — the repo is
**`kevinyindevelopment/RiftboundElo`** (private), workflow
**`.github/workflows/update.yml`**:
- **Schedule:** every 3 hours (`cron`), plus manual `workflow_dispatch`. Runs on
  GitHub's always-on runners, so the site updates **even when every local PC is
  off** (the whole point — the old job only ran when the work PC was on).
- **What it does:** scoped `ingest:stores` (+`--premier`), then `elo:recompute`
  **only if the `Match` count changed** (gate via `scripts/match-count.ts`).
- **Secrets** (GitHub repo → Settings → Secrets → Actions): `DATABASE_URL`,
  `DIRECT_DATABASE_URL`, `CARDE_TOKEN`. Mirror the values in local `.env`.
- **Caveat:** GitHub auto-disables scheduled workflows after **60 days with no
  repo commits** — an occasional push (or a heartbeat commit) keeps it alive.

The old **Windows Task Scheduler** job (`scripts/daily-update.ps1`,
`register-daily-task.ps1`) is **DISABLED and superseded** — it only fired when the
PC was on and stalled on the backfill before reaching recompute. Don't re-enable it
as the primary mechanism; keep changes in the GitHub Actions workflow.
