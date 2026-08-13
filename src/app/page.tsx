import Link from "next/link";
import { connection } from "next/server";
import {
  getGlobalStats,
  getRecentEvents,
  getRegionSummary,
  getTopStores,
  getUpcomingEvents,
} from "@/lib/queries";
import { Card, StatCard } from "@/components/ui";
import { EventList } from "@/components/events";
import { REGION_LABELS, REGION_SUBTITLES, type Region } from "@/lib/regions";

// NOT `force-dynamic`: that implies `fetchCache = "force-no-store"`, which makes
// every `unstable_cache` read a no-op (see src/lib/cache.ts), so the page would
// re-run all its queries against Neon on every hit.
export const revalidate = 1800;

export default async function HomePage() {
  // This page reads no request-scoped input, so Next would otherwise PRERENDER
  // it during `next build` — which would make every deploy require a reachable
  // database and bake a build-time snapshot into the bundle. `connection()`
  // stops prerendering without disabling caches: the page renders per request,
  // while its queries below still serve from the KV incremental cache.
  // Must be called OUTSIDE the cached queries — request APIs are not readable
  // inside an `unstable_cache` scope.
  await connection();

  const [stats, upcoming, recent, topStores, regions] = await Promise.all([
    getGlobalStats(),
    getUpcomingEvents(8),
    getRecentEvents(8),
    getTopStores(6),
    getRegionSummary(),
  ]);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">
          <span className="text-accent">Rift</span>Elo
        </h1>
        <p className="text-muted mt-1">
          Your personal Riftbound tracker — local events, stores, players, and an
          Elo ladder, split across MBS, Flint, and beyond.
        </p>
      </section>

      <section className="grid sm:grid-cols-3 gap-3">
        {regions.map((r) => (
          <Link key={r.region} href={`/rankings?region=${r.region}`}>
            <Card className="px-4 py-4 hover:bg-surface-2/50 transition-colors h-full">
              <div className="text-lg font-semibold">{REGION_LABELS[r.region as Region]}</div>
              <div className="text-xs text-muted">{REGION_SUBTITLES[r.region as Region]}</div>
              <div className="mt-3 flex gap-4 text-sm text-muted">
                <span><span className="text-accent font-semibold tabular-nums">{r.rankedPlayers}</span> ranked</span>
                <span><span className="text-foreground tabular-nums">{r.stores}</span> stores</span>
                <span><span className="text-foreground tabular-nums">{r.events}</span> events</span>
              </div>
            </Card>
          </Link>
        ))}
      </section>

      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
        <StatCard label="Stores" value={stats.stores.toLocaleString()} />
        <StatCard label="Events" value={stats.events.toLocaleString()} />
        <StatCard label="Players" value={stats.players.toLocaleString()} />
        <StatCard label="Rated matches" value={stats.matches.toLocaleString()} />
        <StatCard label="Ranked" value={stats.rankedPlayers.toLocaleString()} />
      </section>

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold">Upcoming events</h2>
            <Link href="/events" className="text-sm text-accent-2 hover:underline">All events →</Link>
          </div>
          <EventList events={upcoming} />
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold">Recent events</h2>
            <Link href="/players" className="text-sm text-accent-2 hover:underline">Players →</Link>
          </div>
          <EventList events={recent} />
        </section>
      </div>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold">Stores</h2>
          <Link href="/stores" className="text-sm text-accent-2 hover:underline">All stores →</Link>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {topStores.map((s) => (
            <Link key={s.id} href={`/stores/${s.id}`}>
              <Card className="px-4 py-3 hover:bg-surface-2/50 transition-colors h-full">
                <div className="font-medium truncate">{s.name}</div>
                <div className="text-xs text-muted mt-0.5">
                  {[s.city, s.state].filter(Boolean).join(", ")}
                </div>
                <div className="text-sm text-accent mt-2 tabular-nums">
                  {s._count.events} events
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
