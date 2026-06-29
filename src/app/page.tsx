import Link from "next/link";
import {
  getGlobalStats,
  getRecentEvents,
  getStores,
  getUpcomingEvents,
} from "@/lib/queries";
import { Card, StatCard } from "@/components/ui";
import { EventList } from "@/components/events";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [stats, upcoming, recent, stores] = await Promise.all([
    getGlobalStats(),
    getUpcomingEvents(8),
    getRecentEvents(8),
    getStores(),
  ]);

  const topStores = [...stores]
    .sort((a, b) => b._count.events - a._count.events)
    .slice(0, 6);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">
          <span className="text-accent">Rift</span>Elo
        </h1>
        <p className="text-muted mt-1">
          Your personal Riftbound tracker — local events, stores, players, and an
          Elo ladder that fills in from the games you play.
        </p>
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
