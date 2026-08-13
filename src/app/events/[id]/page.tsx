import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getEventSummary,
  getEventMetagame,
  getEventStandings,
  getEventRounds,
} from "@/lib/queries";
import { Card, DomainDots, PlayerLink, StatCard } from "@/components/ui";
import { StatusBadge } from "@/components/events";
import { SetBadge } from "@/components/set-tabs";
import { setForEvent } from "@/lib/sets";
import { fmtDate, ordinal, pct, teamFormat, winRate } from "@/lib/format";

function cost(cents?: number | null, currency?: string | null): string {
  if (cents == null || cents === 0) return "Free";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: currency || "USD" });
}

function toPage(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

type Cur = { sp: number; rp: number; legend?: string };

function pageHref(
  id: string,
  cur: Cur,
  o: { sp?: number; rp?: number; legend?: string | null },
): string {
  const params = new URLSearchParams();
  const s = o.sp ?? cur.sp;
  const r = o.rp ?? cur.rp;
  const l = "legend" in o ? o.legend : cur.legend;
  if (s > 1) params.set("sp", String(s));
  if (r > 1) params.set("rp", String(r));
  if (l) params.set("legend", l);
  const q = params.toString();
  return `/events/${id}${q ? `?${q}` : ""}`;
}

function Pager({
  id,
  cur,
  which,
  page,
  pages,
  total,
  pageSize,
}: {
  id: string;
  cur: Cur;
  which: "sp" | "rp";
  page: number;
  pages: number;
  total: number;
  pageSize: number;
}) {
  if (pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const link = "px-2 py-0.5 rounded border border-border text-xs hover:bg-surface-2/60";
  const off = "px-2 py-0.5 rounded border border-border/50 text-xs text-muted/50 pointer-events-none";
  return (
    <div className="flex items-center justify-between gap-2 mt-3 text-xs">
      <span className="text-muted tabular-nums">{from}–{to} of {total}</span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={pageHref(id, cur, { [which]: page - 1 })} className={link}>← Prev</Link>
        ) : (
          <span className={off}>← Prev</span>
        )}
        <span className="text-muted tabular-nums">{page}/{pages}</span>
        {page < pages ? (
          <Link href={pageHref(id, cur, { [which]: page + 1 })} className={link}>Next →</Link>
        ) : (
          <span className={off}>Next →</span>
        )}
      </div>
    </div>
  );
}

// Standings and pairings update round by round, and this is the page people
// check on the day — so 60s, not the site-wide default. Must not be
// `force-dynamic`: that would disable the query caches below. See COST.md.
export const revalidate = 60;

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sp?: string; rp?: string; legend?: string }>;
}) {
  const { id } = await params;
  const { sp, rp, legend } = await searchParams;
  const spPage = toPage(sp);
  const rpPage = toPage(rp);
  const legendFilter = legend?.trim() || undefined;

  const [event, meta, standings, rounds] = await Promise.all([
    getEventSummary(id),
    getEventMetagame(id),
    getEventStandings(id, { page: spPage, legend: legendFilter }),
    getEventRounds(id, { page: rpPage }),
  ]);
  if (!event) notFound();
  const cur: Cur = { sp: standings.page, rp: rounds.page, legend: legendFilter };
  const team = teamFormat(event.name); // e.g. "2v2" — records are team-shared

  // Group this page's matches by round.
  const roundGroups = new Map<number, typeof rounds.matches>();
  for (const m of rounds.matches) {
    const r = m.roundNumber ?? 0;
    if (!roundGroups.has(r)) roundGroups.set(r, []);
    roundGroups.get(r)!.push(m);
  }

  const hasDeckData = meta.stats.length > 0;
  const playerCount = event._count.entries || event.numPlayers;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{event.name}</h1>
            <StatusBadge status={event.status} />
            <SetBadge code={setForEvent(event)} />
            {team && (
              <span
                className="text-xs rounded-full px-2 py-0.5 bg-accent-2/15 text-accent-2 font-medium"
                title="Team-format event — standings records are shared by teammates"
              >
                {team}
              </span>
            )}
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
        <div className="flex items-center gap-3">
          {(event._count.matches > 0 || event.status?.toLowerCase() === "inprogress") && (
            <Link
              href={`/events/${event.id}/live`}
              className="text-sm rounded-md px-3 py-1.5 bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
            >
              Tournament companion →
            </Link>
          )}
          <Link href="/events" className="text-sm text-accent-2 hover:underline">
            ← All events
          </Link>
        </div>
      </div>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Players"
          value={
            <>
              {playerCount}
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

      {hasDeckData && (
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h2 className="text-sm uppercase tracking-wide text-muted">Deck breakdown</h2>
            <span className="text-xs text-muted">
              {meta.stats.length} Legend{meta.stats.length === 1 ? "" : "s"} · {meta.totalPlayers} pilots
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="text-muted text-xs uppercase tracking-wide border-b border-border">
              <tr>
                <th className="text-left py-1.5">Legend</th>
                <th className="text-right py-1.5">Pilots</th>
                <th className="text-right py-1.5 hidden sm:table-cell" title="Share of the field">Field</th>
                <th className="text-right py-1.5" title="Match record with this Legend at this event">W-L-D</th>
                <th className="text-right py-1.5">Win %</th>
                <th className="text-right py-1.5 hidden sm:table-cell" title="Best final placing among its pilots">Best</th>
              </tr>
            </thead>
            <tbody>
              {meta.stats.map((d) => {
                const games = d.wins + d.losses + d.draws;
                const wr = winRate(d.wins, d.losses, d.draws);
                const field = meta.totalPlayers ? d.players / meta.totalPlayers : 0;
                return (
                  <tr
                    key={d.legend}
                    className={`border-b border-border/50 last:border-0 ${legendFilter === d.legend ? "bg-accent/10" : ""}`}
                  >
                    <td className="py-1.5 pr-2">
                      <Link
                        href={pageHref(id, cur, {
                          legend: legendFilter === d.legend ? null : d.legend,
                          sp: 1,
                        })}
                        className="font-medium hover:text-accent"
                        title={legendFilter === d.legend ? "Clear filter" : `Show only ${d.legend} in standings`}
                      >
                        {d.legend}
                      </Link>
                      <DomainDots domains={d.domains} />
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{d.players}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted hidden sm:table-cell">{pct(field)}</td>
                    <td className="py-1.5 text-right tabular-nums whitespace-nowrap">
                      {games > 0 ? `${d.wins}-${d.losses}-${d.draws}` : "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums font-semibold">
                      {games > 0 ? pct(wr) : "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted hidden sm:table-cell">
                      {d.bestStanding != null ? ordinal(d.bestStanding) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h2 className="text-sm uppercase tracking-wide text-muted">
              Players {event.hasStandings ? "& standings" : ""}
            </h2>
            {standings.total > 0 && (
              <span className="text-xs text-muted tabular-nums">{standings.total}</span>
            )}
          </div>
          {team && (
            <p className="text-xs text-accent-2 mb-3">
              {team} team event — each player's record below is their team's shared result.
            </p>
          )}
          {legendFilter && (
            <div className="flex items-center gap-2 mb-3 text-xs">
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 text-accent px-2 py-0.5">
                {legendFilter}
                <Link href={pageHref(id, cur, { legend: null, sp: 1 })} className="hover:text-foreground" title="Clear filter">✕</Link>
              </span>
              <span className="text-muted">filtered</span>
            </div>
          )}
          {standings.entries.length === 0 ? (
            <p className="text-muted text-sm">
              {legendFilter ? `No ${legendFilter} pilots in the standings.` : "No registrations recorded."}
            </p>
          ) : (
            <>
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
                  {standings.entries.map((e, i) => {
                    const games = e.matchesWon + e.matchesLost + e.matchesDrawn;
                    return (
                      <tr key={e.id} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-2 text-muted tabular-nums text-right">
                          {e.finalStanding ?? standings.offset + i + 1}
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
              <Pager
                id={id}
                cur={cur}
                which="sp"
                page={standings.page}
                pages={standings.pages}
                total={standings.total}
                pageSize={standings.pageSize}
              />
            </>
          )}
        </Card>

        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h2 className="text-sm uppercase tracking-wide text-muted">Rounds</h2>
            {rounds.total > 0 && (
              <span className="text-xs text-muted tabular-nums">{rounds.total} pairings</span>
            )}
          </div>
          {rounds.matches.length === 0 ? (
            <p className="text-muted text-sm">No published match results for this event.</p>
          ) : (
            <>
              <div className="space-y-4">
                {[...roundGroups.entries()]
                  .sort((a, b) => a[0] - b[0])
                  .map(([round, ms]) => (
                    <div key={round}>
                      <div className="text-xs font-semibold text-muted mb-1">
                        Round {round || "—"}
                      </div>
                      <ul className="text-sm space-y-1.5">
                        {ms.map((m) => (
                          <li key={m.id}>
                            <div className="flex items-center gap-2">
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
                            </div>
                            {!m.isBye && (m.oneLegend || m.twoLegend) && (
                              <div className="text-xs text-muted pl-0.5">
                                {m.oneLegend ?? "Unknown"} <span className="opacity-60">vs</span> {m.twoLegend ?? "Unknown"}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
              <Pager
                id={id}
                cur={cur}
                which="rp"
                page={rounds.page}
                pages={rounds.pages}
                total={rounds.total}
                pageSize={rounds.pageSize}
              />
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
