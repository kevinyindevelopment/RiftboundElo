import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvent } from "@/lib/queries";
import { Card, DomainDots, PageTitle, PlayerLink, StatCard } from "@/components/ui";
import { StatusBadge } from "@/components/events";
import { fmtDate } from "@/lib/format";

function cost(cents?: number | null, currency?: string | null): string {
  if (cents == null || cents === 0) return "Free";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: currency || "USD" });
}

export const dynamic = "force-dynamic";

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();

  // Group matches by round.
  const rounds = new Map<number, typeof event.matches>();
  for (const m of event.matches) {
    const r = m.roundNumber ?? 0;
    if (!rounds.has(r)) rounds.set(r, []);
    rounds.get(r)!.push(m);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{event.name}</h1>
            <StatusBadge status={event.status} />
          </div>
          <p className="text-muted text-sm mt-1">
            {event.store ? (
              <Link href={`/stores/${event.store.id}`} className="hover:text-accent">
                {event.store.name}
              </Link>
            ) : null}
            {event.store?.city ? ` · ${event.store.city}${event.store.state ? `, ${event.store.state}` : ""}` : ""}
            {` · ${fmtDate(event.startDatetime)}`}
          </p>
        </div>
        <Link href="/events" className="text-sm text-accent-2 hover:underline">
          ← All events
        </Link>
      </div>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Players"
          value={
            <>
              {event.entries.length || event.numPlayers}
              {event.capacity ? <span className="text-muted text-base">/{event.capacity}</span> : ""}
            </>
          }
        />
        <StatCard label="Format" value={<span className="text-base">{event.format ?? "—"}</span>} />
        <StatCard label="Type" value={<span className="text-base">{event.gameplayFormat ?? event.gameType ?? "—"}</span>} />
        <StatCard label="Entry" value={<span className="text-base">{cost(event.costCents, event.currency)}</span>} />
      </section>

      {(event.rulesEnforcement || event.numRounds || event.topCut || event.description) && (
        <Card className="p-4 space-y-2">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {event.rulesEnforcement && (
              <span><span className="text-muted">Rules: </span>{event.rulesEnforcement.toLowerCase()}</span>
            )}
            {event.numRounds != null && (
              <span><span className="text-muted">Rounds: </span>{event.numRounds}</span>
            )}
            {event.topCut != null && (
              <span><span className="text-muted">Top cut: </span>{event.topCut}</span>
            )}
          </div>
          {event.description && (
            <p className="text-sm text-muted whitespace-pre-line">{event.description}</p>
          )}
        </Card>
      )}

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <Card className="p-4">
          <h2 className="text-sm uppercase tracking-wide text-muted mb-3">
            Players {event.entries.some((e) => e.finalStanding) ? "& standings" : ""}
          </h2>
          {event.entries.length === 0 ? (
            <p className="text-muted text-sm">No registrations recorded.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-muted text-xs uppercase tracking-wide border-b border-border">
                <tr>
                  <th className="text-right py-1.5 pr-2 w-8">#</th>
                  <th className="text-left py-1.5">Player</th>
                  <th className="text-right py-1.5">Record</th>
                  <th className="text-right py-1.5 hidden sm:table-cell" title="Match points">Pts</th>
                  <th className="text-right py-1.5 hidden sm:table-cell" title="Opponent match-win %">OMW%</th>
                </tr>
              </thead>
              <tbody>
                {event.entries.map((e, i) => {
                  const games = e.matchesWon + e.matchesLost + e.matchesDrawn;
                  return (
                    <tr key={e.id} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5 pr-2 text-muted tabular-nums text-right">
                        {e.finalStanding ?? i + 1}
                      </td>
                      <td className="py-1.5">
                        <PlayerLink id={e.player.id} name={e.player.displayName} handle={e.player.handle} />
                        {e.deck && (
                          <span className="ml-2 text-xs text-muted inline-flex items-center gap-1 align-middle">
                            {e.deck.legend ?? e.deck.name}
                            <DomainDots domains={e.deck.domains} />
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums whitespace-nowrap">
                        {games > 0 ? `${e.matchesWon}-${e.matchesLost}-${e.matchesDrawn}` : "—"}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted hidden sm:table-cell">
                        {e.matchPoints ?? "—"}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted hidden sm:table-cell">
                        {e.omwPct != null ? `${(e.omwPct * 100).toFixed(0)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="text-sm uppercase tracking-wide text-muted mb-3">Rounds</h2>
          {rounds.size === 0 ? (
            <p className="text-muted text-sm">
              No published match results for this event.
            </p>
          ) : (
            <div className="space-y-4">
              {[...rounds.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([round, ms]) => (
                  <div key={round}>
                    <div className="text-xs font-semibold text-muted mb-1">
                      Round {round || "—"}
                    </div>
                    <ul className="text-sm space-y-1">
                      {ms.map((m) => (
                        <li key={m.id} className="flex items-center gap-2">
                          <span className={m.winnerId === m.playerOneId ? "text-win" : ""}>
                            <PlayerLink id={m.playerOne.id} name={m.playerOne.displayName} handle={m.playerOne.handle} />
                          </span>
                          {m.isBye ? (
                            <span className="text-muted">— bye</span>
                          ) : (
                            <>
                              <span className="text-muted text-xs tabular-nums">
                                {m.playerOneWins}–{m.playerTwoWins}
                              </span>
                              <span className={m.winnerId === m.playerTwoId ? "text-win" : ""}>
                                <PlayerLink id={m.playerTwo.id} name={m.playerTwo.displayName} handle={m.playerTwo.handle} />
                              </span>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
