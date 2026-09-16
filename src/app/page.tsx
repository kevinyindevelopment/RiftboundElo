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
    <div className="space-y-9">
      <section className="relative overflow-hidden rounded-[18px] border border-border bg-surface/60 px-5 py-7 sm:px-8 sm:py-9 shadow-[var(--shadow-card)]">
        <div className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />
        <div className="pointer-events-none absolute -left-24 -bottom-32 h-56 w-56 rounded-full bg-accent-3/10 blur-3xl" />
        <div className="relative">
          <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-accent-3">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-3" />
            Live ladder · Glicko-2
          </div>
          <h1 className="mt-3 text-3xl sm:text-[40px] leading-[1.06] font-bold tracking-tight">
            Riftbound competitive ratings,{" "}
            <span className="text-irid">tracked to the match.</span>
          </h1>
          <p className="text-muted mt-3 max-w-2xl text-sm sm:text-[15px]">
            Local events, stores, players, and a full rating history — split
            across MBS, Flint, and beyond.
          </p>
        </div>
      </section>

      <section className="grid sm:grid-cols-3 gap-3">
        {regions.map((r) => (
          <Link key={r.region} href={`/rankings?region=${r.region}`}>
            <Card className="px-4 py-4 hover:bg-surface-2/60 hover:-translate-y-0.5 h-full">
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
