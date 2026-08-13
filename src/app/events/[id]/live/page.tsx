import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvent } from "@/lib/queries";
import { winProbability } from "@/lib/glicko";
import {
  bubbleAnalysis,
  computeStandings,
  legendRaces,
  simCountFor,
  simulateTopCut,
  type RawEntry,
  type RawMatch,
  type Scoring,
  type Standing,
} from "@/lib/tournament";
import { Card } from "@/components/ui";
import { StatusBadge } from "@/components/events";
import {
  LegendRaceList,
  PendingPairings,
  StandingsTable,
  type PendingPairing,
} from "@/components/tournament";
import { fmtDate } from "@/lib/format";

// The in-venue tournament companion: players refresh it between rounds. 30s is
// imperceptible here (rounds run ~50 minutes) but collapses a venue full of
// simultaneous refreshes into roughly one database read. It must NOT be
// `force-dynamic` — that implies fetchCache="force-no-store", which would
// silently disable getEvent's cache entirely. See src/lib/cache.ts and COST.md.
export const revalidate = 30;

/** A match counts toward standings only once it has a real result. */
function isDecided(m: RawMatch): boolean {
  return m.isBye || m.winnerId != null || m.playerOneWins > 0 || m.playerTwoWins > 0 || m.draws > 0;
}

/**
 * Rows of standings rendered per page.
 *
 * This exists for a hard platform reason, not taste. Server-rendering the whole
 * field of a large Regional (RQ Utrecht: 1,953 entrants) produced ~3.5 MB of
 * HTML and overran the Cloudflare Worker CPU budget, so the page returned
 * intermittent 503s (`outcome: exceededCpu`, error 1102) on exactly the biggest
 * events. The account is on the Workers Free plan, where the CPU ceiling cannot
 * be raised, so the render has to be bounded instead.
 *
 * Standings are still COMPUTED over the entire field — ranks, OMW/OGW and cut
 * status are all field-wide and correct — only the slice that is rendered is
 * limited. Matches the pagination /events/[id] already uses.
 */
const LIVE_STANDINGS_PAGE = 100;

export default async function LiveEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sp?: string }>;
}) {
  const { id } = await params;
  const { sp } = await searchParams;
  const event = await getEvent(id);
  if (!event) notFound();

  const scoring: Scoring = {
    win: event.pointsPerWin,
    draw: event.pointsPerDraw,
    loss: event.pointsPerLoss,
  };
  const matches = event.matches as unknown as RawMatch[];
  const entries: RawEntry[] = event.entries.map((e) => ({
    player: {
      id: e.player.id,
      displayName: e.player.displayName,
      handle: e.player.handle,
      rating: e.player.rating,
      ratingDeviation: e.player.ratingDeviation,
    },
    deck: e.deck
      ? { legend: e.deck.legend, name: e.deck.name, domains: e.deck.domains }
      : null,
  }));

  const decided = matches.filter(isDecided);
  // Computed over the WHOLE field: ranks, OMW/OGW and cut status are field-wide.
  // Only the rendered slice below is bounded (see LIVE_STANDINGS_PAGE).
  const standings = computeStandings(decided, entries, scoring);
  const byId = new Map<string, Standing>(standings.map((s) => [s.playerId, s]));

  const standingsPages = Math.max(
    1,
    Math.ceil(standings.length / LIVE_STANDINGS_PAGE),
  );
  const spNum = Number(sp);
  const standingsPage = Math.min(
    Math.max(1, Number.isFinite(spNum) && spNum >= 1 ? Math.floor(spNum) : 1),
    standingsPages,
  );
  const standingsFrom = (standingsPage - 1) * LIVE_STANDINGS_PAGE + 1;
  const standingsShown = standings.slice(
    standingsFrom - 1,
    standingsFrom - 1 + LIVE_STANDINGS_PAGE,
  );
  const standingsTo = standingsFrom - 1 + standingsShown.length;

  // Rounds already in the books = highest round with a decided result. A freshly
  // posted, all-pending round doesn't count yet — those are the next round's odds.
  const playedRound = decided.reduce((mx, m) => Math.max(mx, m.roundNumber ?? 0), 0);
  const totalRounds = event.numRounds ?? null;
  const roundsLeft = totalRounds != null ? Math.max(0, totalRounds - playedRound) : null;
  const topCut = event.topCut ?? null;

  const bubble =
    roundsLeft != null && topCut
      ? bubbleAnalysis(standings, roundsLeft, topCut, scoring)
      : null;
  const odds =
    roundsLeft != null && roundsLeft > 0 && topCut && standings.length > 1
      ? simulateTopCut(standings, roundsLeft, topCut, scoring)
      : null;
  const races = legendRaces(standings);

  // Pending pairings (posted but unplayed) → matchup odds for the next round.
  const entryInfo = new Map(entries.map((e) => [e.player.id, e]));
  const synth = (ref: RawMatch["playerOne"]): Standing | null => {
    const existing = byId.get(ref.id);
    if (existing) return existing;
    const info = entryInfo.get(ref.id);
    if (!info) return null;
    return {
      playerId: ref.id,
      displayName: ref.displayName,
      handle: ref.handle,
      legend: info.deck?.legend ?? info.deck?.name ?? null,
      domains: info.deck?.domains ?? null,
      rating: info.player.rating,
      rd: info.player.ratingDeviation,
      provisional: false,
      wins: 0, losses: 0, draws: 0, byes: 0, points: 0, roundsPlayed: 0,
      gameWins: 0, gameLosses: 0, omw: 0, gw: 0, ogw: 0, opponents: [], rank: 0,
    };
  };
  const pending: PendingPairing[] = matches
    .filter((m) => !m.isBye && !isDecided(m))
    .map((m) => {
      const one = synth(m.playerOne);
      const two = synth(m.playerTwo);
      if (!one || !two) return null;
      return {
        id: `${m.roundNumber}-${one.playerId}-${two.playerId}`,
        one,
        two,
        pA: winProbability(one.rating, one.rd, two.rating, two.rd),
      };
    })
    .filter((p): p is PendingPairing => p !== null)
    .sort((a, b) => b.one.points + b.two.points - (a.one.points + a.two.points));

  const hasData = standings.length > 0 || pending.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{event.name}</h1>
            <StatusBadge status={event.status} />
          </div>
          <p className="text-muted text-sm mt-1">
            Tournament companion
            {event.store ? ` · ${event.store.name}` : ""}
            {` · ${fmtDate(event.startDatetime)}`}
          </p>
        </div>
        <Link href={`/events/${event.id}`} className="text-sm text-accent-2 hover:underline">
          ← Event overview
        </Link>
      </div>

      <Card className="px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span>
          <span className="text-muted">Round </span>
          <span className="font-semibold tabular-nums">
            {playedRound}
            {totalRounds != null ? ` of ${totalRounds}` : ""}
          </span>
        </span>
        {roundsLeft != null && (
          <span>
            <span className="text-muted">Rounds left </span>
            <span className="font-semibold tabular-nums">{roundsLeft}</span>
          </span>
        )}
        {topCut != null && (
          <span>
            <span className="text-muted">Top cut </span>
            <span className="font-semibold tabular-nums">{topCut}</span>
          </span>
        )}
        <span>
          <span className="text-muted">Players </span>
          <span className="font-semibold tabular-nums">{standings.length || event.entries.length}</span>
        </span>
      </Card>

      {!hasData ? (
        <Card className="px-6 py-8 text-center text-muted">
          No pairings or results have been posted yet. This page fills in live as
          rounds are reported.
        </Card>
      ) : (
        <>
          {pending.length > 0 && (
            <Card className="p-4">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <h2 className="text-sm uppercase tracking-wide text-muted">
                  Next round · win probability
                </h2>
                <span className="text-xs text-muted">{pending.length} pairings</span>
              </div>
              <PendingPairings pairings={pending} />
              <p className="text-[11px] text-muted mt-3">
                Odds from each player&apos;s Glicko rating — a guide, not a verdict.
              </p>
            </Card>
          )}

          <Card className="p-4">
            <div className="flex items-baseline justify-between gap-3 mb-3">
              <h2 className="text-sm uppercase tracking-wide text-muted">Live standings</h2>
              {bubble && topCut && (
                <span className="text-xs text-muted">
                  <span className="text-win">In</span> / <span className="text-draw">Bubble</span> /{" "}
                  <span className="text-loss">Out</span> = provable Top {topCut} status
                </span>
              )}
            </div>
            {standings.length === 0 ? (
              <p className="text-muted text-sm">No results recorded yet.</p>
            ) : (
              <>
                <StandingsTable
                  standings={standingsShown}
                  bubble={bubble}
                  odds={odds}
                />
                {standingsPages > 1 && (
                  <div className="flex items-center justify-between gap-3 mt-3 text-sm">
                    <span className="text-muted tabular-nums">
                      {standingsFrom}–{standingsTo} of {standings.length}
                    </span>
                    <div className="flex items-center gap-2">
                      {standingsPage > 1 ? (
                        <Link
                          href={`/events/${event.id}/live?sp=${standingsPage - 1}`}
                          className="px-2.5 py-1 rounded-md border border-border hover:bg-surface-2/60"
                        >
                          ← Prev
                        </Link>
                      ) : (
                        <span className="px-2.5 py-1 rounded-md border border-border/50 text-muted/50">
                          ← Prev
                        </span>
                      )}
                      <span className="text-muted tabular-nums">
                        {standingsPage} / {standingsPages}
                      </span>
                      {standingsPage < standingsPages ? (
                        <Link
                          href={`/events/${event.id}/live?sp=${standingsPage + 1}`}
                          className="px-2.5 py-1 rounded-md border border-border hover:bg-surface-2/60"
                        >
                          Next →
                        </Link>
                      ) : (
                        <span className="px-2.5 py-1 rounded-md border border-border/50 text-muted/50">
                          Next →
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
            {odds && (
              <p className="text-[11px] text-muted mt-3">
                Odds = estimated Top {topCut} chance from{" "}
                {simCountFor(standings.length, roundsLeft ?? 0).toLocaleString()}{" "}
                simulated finishes of the remaining {roundsLeft} round
                {roundsLeft === 1 ? "" : "s"}. Cut status is provable; odds are an
                estimate.
              </p>
            )}
          </Card>

          {races.length > 0 && (
            <Card className="p-4">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <h2 className="text-sm uppercase tracking-wide text-muted">
                  Best-of race · Legend bonus
                </h2>
                <span className="text-xs text-muted">{races.length} Legends in contention</span>
              </div>
              <LegendRaceList races={races} />
              <p className="text-[11px] text-muted mt-3">
                ★ currently leads their Legend&apos;s bonus prize, ranked by the same
                standings tiebreakers.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
