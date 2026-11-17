# PlayRiftbound and legacy UVS ingestion

The scheduled update imports both platforms. UVS history and its premier-event
sync remain in place. PlayRiftbound searches within 100 km of the tracked MI/CA
stores, clusters nearby search centers, and discards results outside those two
states. It does not perform a worldwide crawl.

```sh
npm run ingest:playriftbound
npm run ingest:playriftbound -- --since 2026-09-14 --dry-run
```

With no existing PlayRiftbound events, the first run backfills from its September
14, 2026 launch. Subsequent runs cover the preceding 21 days and next 60 days.
Use `--since YYYY-MM-DD` to repair older results. The API has no end-date input;
the client sorts by date and stops at the explicit upper bound. All pages are
deduplicated before fetching event details. The public API needs no new secret.

The existing six-hour GitHub Actions schedule runs this command before the UVS
sync and recomputes Glicko only when the match fingerprint changes. For the first
backfill, dispatch **Update ratings** with `playriftbound_only=true` to avoid
repeating a recently completed UVS sync. The normal schedule refreshes both.
The job reports upstream failures but still rates changes from the source that
succeeded. No database migration is required.

Event, organizer, player, and match IDs use a `playriftbound:` prefix. The source
uses integers larger than JavaScript's safe integer limit, so IDs stay strings.
Riot player accounts are not automatically linked to UVS accounts: matching
names alone is insufficient evidence. Their ratings remain separate until an
explicit, verified account mapping is available. Organizers also remain separate
from legacy stores; region filters work for both.

Public registrations, standings, completed head-to-head results, and byes are
imported. Unfinished pairings never become draws. A finalized round can contain
matches still labeled `IN_PROGRESS`; actual reciprocal outcomes are required.
Unplayed games in a best-of series can have null outcomes. Multi-player teams
retain roster/standings but are not synthesized into individual rated matches.
Explicit Pre-Rift events remain excluded from ratings even when their custom
name omits that category. Deck submissions are not fetched through admin APIs.

Source responses are collected before writing, and batches commit atomically.
Upserts compare stored values and do not rewrite unchanged rows. Only stale rows
belonging to successfully fetched PlayRiftbound events are removed; API errors
never erase existing data. Historical UVS records are not replaced. Normal page
caching and the Prisma/Neon adapter configuration are unchanged.

The client in `src/lib/playriftbound.ts` uses the read-only persisted operations
from the public event finder's Apollo manifest, verified November 7, 2026.
If Riot rotates those operation IDs, the job fails explicitly. Refresh the IDs
from the manifest loaded by the public site's JavaScript (the generated GraphQL
document hashes are **not** the manifest's operation IDs), verify response shapes,
then run `npx tsx --test src/lib/playriftbound.test.ts` and a scoped dry run.
