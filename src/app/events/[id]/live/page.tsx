import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvent } from "@/lib/queries";
import { winProbability } from "@/lib/glicko";
import {
  bubbleAnalysis,
  computeStandings,
  legendRaces,
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

// DELIBERATELY still force-dynamic. This is the in-venue tournament companion —
// players refresh it between rounds for live pairings and standings, so serving
// a cached copy would be actively wrong. Note this also disables `unstable_cache`
// for anything this page calls (see src/lib/cache.ts), which is exactly what we
// want here: `getEvent` must always hit the database.
export const dynamic = "force-dynamic";

/** A match counts toward standings only once it has a real result. */
function isDecided(m: RawMatch): boolean {
  return m.isBye || m.winnerId != null || m.playerOneWins > 0 || m.playerTwoWins > 0 || m.draws > 0;
}

export default async function LiveEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
  const standings = computeStandings(decided, entries, scoring);
  const byId = new Map<string, Standing>(standings.map((s) => [s.playerId, s]));

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
              <StandingsTable standings={standings} bubble={bubble} odds={odds} />
            )}
            {odds && (
              <p className="text-[11px] text-muted mt-3">
                Odds = estimated Top {topCut} chance from 1,500 simulated finishes
                of the remaining {roundsLeft} round{roundsLeft === 1 ? "" : "s"}. Cut
                status is provable; odds are an estimate.
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
