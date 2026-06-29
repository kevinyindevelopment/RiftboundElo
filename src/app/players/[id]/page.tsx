import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPlayer,
  getPlayerEvents,
  getPlayerRank,
  getPlayerRatingHistory,
  getPlayerRecentMatches,
} from "@/lib/queries";
import {
  Card,
  Delta,
  PlayerLink,
  RatingSparkline,
  ResultBadge,
  StatCard,
} from "@/components/ui";
import { fmtDate, ordinal, pct, winRate } from "@/lib/format";
import { isRegion, REGION_LABELS } from "@/lib/regions";

export const dynamic = "force-dynamic";

export default async function PlayerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const player = await getPlayer(id);
  if (!player) notFound();

  const rated = player.gamesPlayed > 0;
  const [rank, history, events, matches] = await Promise.all([
    rated ? getPlayerRank(player.rating) : Promise.resolve(0),
    getPlayerRatingHistory(id),
    getPlayerEvents(id),
    getPlayerRecentMatches(id, 25),
  ]);

  const curve = [
    history[0]?.ratingBefore ?? player.rating,
    ...history.map((h) => h.ratingAfter),
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {player.handle || player.displayName}
          </h1>
          <p className="text-muted text-sm mt-1">
            {player.handle && player.displayName && player.handle !== player.displayName
              ? player.displayName
              : ""}
            {isRegion(player.region) ? ` · ${REGION_LABELS[player.region]}` : ""}
            {!rated && " · unrated (no match results yet)"}
          </p>
        </div>
        <Link href="/players" className="text-sm text-accent-2 hover:underline">← All players</Link>
      </div>

      {rated ? (
        <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatCard label="Elo" value={<span className="text-accent">{player.rating}</span>} />
          <StatCard label="Global rank" value={ordinal(rank)} />
          <StatCard label="Peak" value={player.peakRating} />
          <StatCard label="Record" value={`${player.wins}-${player.losses}-${player.draws}`} />
          <StatCard label="Win %" value={pct(winRate(player.wins, player.losses, player.draws))} />
        </section>
      ) : (
        <section className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="Events attended" value={events.length} />
          <StatCard label="Elo" value={<span className="text-muted">—</span>} />
          <StatCard label="Record" value={<span className="text-muted">—</span>} />
        </section>
      )}

      {rated && (
        <Card className="p-4">
          <h2 className="text-sm uppercase tracking-wide text-muted mb-2">Rating history</h2>
          <RatingSparkline points={curve} />
        </Card>
      )}

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <Card className="p-4">
          <h2 className="text-sm uppercase tracking-wide text-muted mb-3">
            Events ({events.length})
          </h2>
          {events.length === 0 ? (
            <p className="text-muted text-sm">No events recorded.</p>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-2">
                  <Link href={`/events/${e.event.id}`} className="font-medium truncate hover:text-accent">
                    {e.event.name}
                  </Link>
                  <span className="ml-auto text-xs text-muted whitespace-nowrap">
                    {e.event.store?.name} · {fmtDate(e.event.startDatetime)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="text-sm uppercase tracking-wide text-muted mb-3">Recent matches</h2>
          {matches.length === 0 ? (
            <p className="text-muted text-sm">
              No match results recorded yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {matches.map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-2">
                  <ResultBadge result={m.result} />
                  <span className="text-muted">vs</span>
                  {m.opponent ? (
                    <PlayerLink id={m.opponent.id} name={m.opponent.displayName} handle={m.opponent.handle} />
                  ) : (
                    <span className="font-medium">—</span>
                  )}
                  <span className="ml-auto w-12 text-right">
                    <Delta value={m.delta} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
