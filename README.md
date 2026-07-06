# Riftbound Elo

A personal-use recreation of [riftelo.com](https://riftelo.com) — a competitive
**Riftbound** (the League of Legends TCG) ladder. It ingests tournament data from
the carde.io / UVS "Riftbound Gaming Network" backend, computes an **Elo rating**
per player, and presents nationwide rankings, player profiles, events, and a
deck/Legend metagame breakdown.

> **For private use only.** RiftELO was taken down after a cease-and-desist from
> carde.io. This project is intended to run locally for your own analysis. Don't
> republish or redistribute the ingested data, keep request rates polite, and be
> aware that scraping may violate carde.io's terms of service. The private API can
> also change without notice and break ingestion.

## Stack

- **Next.js 16** (App Router, TypeScript) + **Tailwind v4** — UI & server queries
- **Prisma 6** + **SQLite** (`dev.db`) — storage (swap `datasource` to Postgres for prod)
- **tsx** scripts — ingestion, seeding, Elo recompute

## Quick start

```bash
npm install            # also runs `prisma generate` (postinstall)
npm run dev            # http://localhost:3000
```

**The database is committed to the repo** (`prisma/dev.db`, ~2 MB of public
Riftbound data), so a fresh clone works immediately with no setup or credentials —
`npm install && npm run dev` and the ladder is populated. You only need a token to
*refresh* the data (see below).

To start from an empty DB instead: `npm run db:push` (recreates schema), then either
`npm run seed` (synthetic demo data) or `npm run ingest:stores` (real data, needs a
token).

## How the data flows

```
carde.io Hydra API  ──ingest──▶  SQLite (Event/Match/Player/Deck)  ──recompute──▶  Player.rating
        │                                                                                │
        └─ public:  /api/magic-events/{id}/             (event meta, format, points)     └─ /  rankings
        └─ public:  /api/v2/deckbuilder/decks/browse/   (decks, Legend, domains)            /players/[id]
        └─ auth:    /api/magic-events/{id}/get_all_rounds/   (match results → Elo)           /events/[id]
        └─ auth:    /api/event-statuses/search/         (registrations/standings)            /decks
```

The base URL and credentials live in `.env`:

```ini
DATABASE_URL="file:./dev.db"
CARDE_API_BASE="https://api.cloudflare.riftbound.uvsgames.com/hydraproxy"

# Match results (who beat whom) are auth-gated. Supply ONE of:
CARDE_TOKEN=""              # paste an API token, OR
CARDE_EMAIL=""              # log in with your own carde.io account
CARDE_PASSWORD=""

ELO_START="1000"            # rating scale center / seed for new players
GLICKO_RD_START="350"       # initial rating deviation (uncertainty) for new players
GLICKO_VOL="0.06"           # initial Glicko-2 volatility
GLICKO_TAU="0.5"            # system constant: how much volatility can change
GLICKO_RD_MIN="30"          # RD floor (stops ratings freezing solid)
GLICKO_RD_ESTABLISHED="110" # at/below this RD a rating is no longer "provisional"
```

## What's actually reachable

With a normal carde.io player token, for the Riftbound Gaming Network you can read:
- **Event metadata** nationwide — names, stores, dates, formats, player counts, geo.
- **Rosters + per-event records + standings** for events that published results
  (gamer tag, real name, W-L-D, final place, deck Legend).
- **Head-to-head match pairings** for those events — who played whom and who won —
  which is what the **Elo ladder** is computed from.

Events that never published results (many casual/learn-to-play events) return empty
rosters/matches and are stored as metadata only. Bulk-aggregating this data is what
got the original RiftELO a cease-and-desist, so keep this private.

So this build is a **personal + local-scene tracker**: browse local stores and their
full event history, with a real Elo ladder from every event that published results.

## Ingesting real data

```bash
# Incremental sync (DEFAULT): re-syncs the stores already in the DB, refreshes
# cheap metadata, and SKIPS the expensive result-fetch for completed events whose
# carde `updated_at` is unchanged. Only new / in-progress / changed events are
# fetched. A no-op re-run takes ~40s instead of ~10min.
npm run ingest:stores

npm run ingest:stores -- --discover          # also geo-discover NEW nearby stores
npm run ingest:stores -- --store 1877 3436   # specific store ids
npm run ingest:stores -- --near 43.42,-83.95 --miles 40
npm run ingest:stores -- --full              # force re-fetch everything (ignore skip)
npm run ingest:stores -- --meta-only         # metadata only, no rosters/matches

npm run elo:recompute                         # rebuild ratings after new matches
npm run regions                               # (re)assign stores+players to regions

# Inspect what your token can read for a given event id:
npm run probe -- --event 199693
```

**Incremental by design:** the ingest always references existing data first and
never blindly re-fetches. Each event stores carde's `updated_at`; a completed event
is immutable, so it's skipped on subsequent runs unless it actually changed.

Set `CARDE_TOKEN` in `.env` first (copy `.env.example`; grab the token from a
`hydraproxy` request's `Authorization: Token …` header while signed in to
play.carde.io). No token is needed just to view the committed data.

## Rating model — Glicko-2

The ladder uses **Glicko-2** (see [`src/lib/glicko.ts`](src/lib/glicko.ts)), not
plain Elo. Each player carries a rating **plus a rating deviation (RD)** — how
unsure the system is — and a volatility. New players start with a large RD, so
their early results move the rating hard; as they play, RD shrinks and the rating
settles near their true skill. This deliberately avoids classic Elo's failure mode
where a fixed 1000 seed acts as a soft floor and a beginner's most informative
(first) games barely move the number.

A rating stays **provisional** (shown with a `?`) until RD drops to
`GLICKO_RD_ESTABLISHED`. The displayed "Elo" is the Glicko mean (rounded, centered
on `ELO_START`); player pages also show the `± RD` uncertainty.

We treat each match as its own rating period (the granularity lichess uses), so
`elo:recompute` replays **all** matches in chronological order — ratings stay fully
deterministic and re-derivable from match history, and each match still gets a
`RatingChange` row to draw the rating curve.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run the app |
| `npm run db:push` / `db:studio` | Sync schema / open Prisma Studio |
| `npm run seed` | Load synthetic demo data |
| `npm run ingest:stores -- …` | Pull local store event history from carde.io |
| `npm run probe -- …` | See what your token can read for given event ids |
| `npm run ingest -- --decks N` | Pull public featured decks |
| `npm run elo:recompute` | Recompute every rating from match history |
