import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPlayer,
  getPlayerAccomplishments,
  getPlayerEvents,
  getPlayerLegendStats,
  getPlayerMatchHistory,
  getPlayerRank,
  getPlayerRatingHistory,
} from "@/lib/queries";
import {
  Card,
  Delta,
  DomainDots,
  PlayerLink,
  ResultBadge,
  StatCard,
} from "@/components/ui";
import { Accomplishments } from "@/components/accomplishments";
import { RatingChart, type RatingPoint } from "@/components/rating-chart";
import { SetTabs } from "@/components/set-tabs";
import { fmtDate, fmtDateShort, ordinal, pct, teamFormat, winRate } from "@/lib/format";
import { isRegion, REGION_LABELS } from "@/lib/regions";
import { calendarForCountry, isSetCode, SET_LABELS, setForDate } from "@/lib/sets";
import { isProvisional } from "@/lib/glicko";

// See src/lib/cache.ts — `force-dynamic` would disable the query cache.
export const revalidate = 300;

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mp?: string; set?: string }>;
}) {
  const { id } = await params;
  const { mp, set } = await searchParams;
  const matchPage = Number(mp) >= 1 ? Math.floor(Number(mp)) : 1;
  const activeSet = isSetCode(set) ? set : undefined;
  const player = await getPlayer(id);
  if (!player) notFound();

  const rated = player.gamesPlayed > 0;
  const provisional = isProvisional(player.ratingDeviation);
  const [rank, history, events, matchHist, legends, accomplishments] = await Promise.all([
    rated ? getPlayerRank(player) : Promise.resolve(null),
    getPlayerRatingHistory(id),
    getPlayerEvents(id),
    getPlayerMatchHistory(id, { page: matchPage }),
    getPlayerLegendStats(id),
    getPlayerAccomplishments(id),
  ]);
  const matches = matchHist.matches;
  // `legends` is the full (all-sets) history — drives whether the card shows.
  // When a set is selected, re-query restricted to that set's events.
  const legendsShown = activeSet ? await getPlayerLegendStats(id, activeSet) : legends;

  // Build dated points for the chart: a seed point (rating before the first
  // match) followed by the rating after each match, each carrying its date.
  const dateOf = (h: (typeof history)[number]) =>
    h.match.playedAt ?? h.match.event?.startDatetime ?? null;
  // When a set is selected, restrict the curve to matches played while it was
  // live — so the chart shows the rating trajectory within that set.
  const historyShown = activeSet
    ? history.filter(
        (h) =>
          setForDate(dateOf(h), calendarForCountry(h.match.event?.store?.country)) ===
          activeSet,
      )
    : history;
  const curve: RatingPoint[] = historyShown.length
    ? [
        {
          rating: historyShown[0].ratingBefore,
          axisDate: fmtDateShort(dateOf(historyShown[0])),
          fullDate: fmtDate(dateOf(historyShown[0])),
          event: null,
          delta: null,
        },
        ...historyShown.map((h) => ({
          rating: h.ratingAfter,
          axisDate: fmtDateShort(dateOf(h)),
          fullDate: fmtDate(dateOf(h)),
          event: h.match.event?.name ?? null,
          delta: h.delta,
        })),
      ]
    : [];

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
            {rated && provisional && " · provisional (still calibrating)"}
          </p>
        </div>
        <Link href="/players" className="text-sm text-accent-2 hover:underline">← All players</Link>
      </div>

      {rated ? (
        <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatCard
            label="Elo"
            value={
              <span className="text-accent">
                {player.rating}
                <span
                  className="text-muted text-base font-normal ml-1"
                  title="Glicko rating deviation — uncertainty around the rating"
                >
                  ± {Math.round(player.ratingDeviation)}
                </span>
              </span>
            }
          />
          <StatCard label="Global rank" value={rank ? ordinal(rank) : "Unranked"} />
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

      <Accomplishments items={accomplishments} />

      {rated && (
        <Card className="p-4">
          <h2 className="text-sm uppercase tracking-wide text-muted mb-2">
            Rating history{activeSet ? ` · ${SET_LABELS[activeSet]}` : ""}
          </h2>
          <div className="mb-3">
            <SetTabs basePath={`/players/${id}`} current={activeSet} extraParams={{ mp }} />
          </div>
          {curve.length > 1 ? (
            <RatingChart points={curve} />
          ) : (
            <p className="text-muted text-sm py-6 text-center">
              No rated games{activeSet ? ` during ${SET_LABELS[activeSet]}` : ""} yet.
            </p>
          )}
        </Card>
      )}

      {legends.length > 0 && (
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-sm uppercase tracking-wide text-muted">
              Legends played{activeSet ? ` · ${SET_LABELS[activeSet]}` : ""}
            </h2>
            <span className="text-xs text-muted">record from events with published decklists</span>
          </div>
          <div className="mb-3">
            <SetTabs basePath={`/players/${id}`} current={activeSet} extraParams={{ mp }} />
          </div>
          {legendsShown.length === 0 ? (
            <p className="text-muted text-sm py-2">
              No Legends piloted during the {activeSet ? SET_LABELS[activeSet] : ""} set.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-muted text-xs uppercase tracking-wide border-b border-border">
                <tr>
                  <th className="text-left py-1.5">Legend</th>
                  <th className="text-right py-1.5">Events</th>
                  <th className="text-right py-1.5">W-L-D</th>
                  <th className="text-right py-1.5">Win %</th>
                  <th className="text-right py-1.5 hidden sm:table-cell" title="Net Elo change while piloting this Legend">Net Elo</th>
                  <th className="text-right py-1.5 hidden sm:table-cell" title="Best final placing with this Legend">Best</th>
                </tr>
              </thead>
              <tbody>
                {legendsShown.map((l) => {
                  const games = l.wins + l.losses + l.draws;
                  const wr = winRate(l.wins, l.losses, l.draws);
                  return (
                    <tr key={l.legend} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5 pr-2">
                        <span className="font-medium">{l.legend}</span>
                        <DomainDots domains={l.domains} />
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{l.events}</td>
                      <td className="py-1.5 text-right tabular-nums whitespace-nowrap">
                        {games > 0 ? `${l.wins}-${l.losses}-${l.draws}` : "—"}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-semibold">
                        {games > 0 ? pct(wr) : "—"}
                      </td>
                      <td className="py-1.5 text-right tabular-nums hidden sm:table-cell">
                        {games > 0 ? <Delta value={l.netDelta} /> : <span className="text-muted">—</span>}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted hidden sm:table-cell">
                        {l.bestStanding != null ? ordinal(l.bestStanding) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
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
              {events.map((e) => {
                const games = e.matchesWon + e.matchesLost + e.matchesDrawn;
                const tf = teamFormat(e.event.name);
                return (
                  <li key={e.id} className="flex items-center gap-3 py-2">
                    <Link href={`/events/${e.event.id}`} className="font-medium truncate hover:text-accent">
                      {e.event.name}
                    </Link>
                    {tf && (
                      <span className="text-[10px] rounded px-1 py-0.5 bg-accent-2/15 text-accent-2 font-medium shrink-0">
                        {tf}
                      </span>
                    )}
                    {games > 0 && (
                      <span
                        className="text-xs tabular-nums whitespace-nowrap"
                        title={tf ? "Your team's record at this event" : "Your record at this event"}
                      >
                        <span className="text-foreground">
                          {e.matchesWon}-{e.matchesLost}-{e.matchesDrawn}
                        </span>
                        {e.finalStanding != null && (
                          <span className="text-muted"> · {ordinal(e.finalStanding)}</span>
                        )}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted whitespace-nowrap">
                      {e.event.store?.name} · {fmtDate(e.event.startDatetime)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h2 className="text-sm uppercase tracking-wide text-muted">Match history</h2>
            {matchHist.total > 0 && (
              <span className="text-xs text-muted tabular-nums">{matchHist.total} matches</span>
            )}
          </div>
          {matches.length === 0 ? (
            <p className="text-muted text-sm">
              No match results recorded yet.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border/60 text-sm">
                {matches.map((m) => {
                  const loc = m.event?.store
                    ? [m.event.store.city, m.event.store.state].filter(Boolean).join(", ")
                    : null;
                  return (
                    <li key={m.id} className="py-2">
                      <div className="flex items-center gap-3">
                        <ResultBadge result={m.result} />
                        <span className="text-muted tabular-nums text-xs w-8">{m.score}</span>
                        <span className="text-muted">vs</span>
                        {m.opponent ? (
                          <PlayerLink id={m.opponent.id} name={m.opponent.displayName} handle={m.opponent.handle} />
                        ) : (
                          <span className="font-medium">—</span>
                        )}
                        <span className="ml-auto w-12 text-right">
                          <Delta value={m.delta} />
                        </span>
                      </div>
                      {/* markers: event · location · decklist */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 pl-9 text-xs text-muted">
                        {m.event && (
                          <Link href={`/events/${m.event.id}`} className="hover:text-accent truncate max-w-[16rem]">
                            {m.event.name}
                          </Link>
                        )}
                        {loc && <span>· {loc}</span>}
                        {m.myLegend && (
                          <span className="text-accent-2">
                            · {m.myLegend}
                            {m.oppLegend ? <span className="text-muted"> vs {m.oppLegend}</span> : null}
                          </span>
                        )}
                        {m.playedAt && <span className="ml-auto">{fmtDateShort(m.playedAt)}</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {matchHist.pages > 1 && (
                <div className="flex items-center justify-between gap-3 mt-3 text-sm">
                  <span className="text-muted tabular-nums">
                    page {matchHist.page} / {matchHist.pages}
                  </span>
                  <div className="flex items-center gap-2">
                    {matchHist.page > 1 ? (
                      <Link
                        href={`/players/${id}?mp=${matchHist.page - 1}`}
                        className="px-2.5 py-1 rounded-md border border-border hover:bg-surface-2/60"
                      >
                        ← Newer
                      </Link>
                    ) : (
                      <span className="px-2.5 py-1 rounded-md border border-border/50 text-muted/50">← Newer</span>
                    )}
                    {matchHist.page < matchHist.pages ? (
                      <Link
                        href={`/players/${id}?mp=${matchHist.page + 1}`}
                        className="px-2.5 py-1 rounded-md border border-border hover:bg-surface-2/60"
                      >
                        Older →
                      </Link>
                    ) : (
                      <span className="px-2.5 py-1 rounded-md border border-border/50 text-muted/50">Older →</span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
