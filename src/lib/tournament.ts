/**
 * Live-event ("between rounds") tournament math for the in-progress RQ companion.
 *
 * Everything here is derived from the Match rows we crawl as rounds complete, so
 * it stays current even when the event's ingested standings (matchPoints/omwPct)
 * lag behind. Three things competitors actually want to know between rounds:
 *
 *   1. Standings + tiebreakers, computed live from match results.
 *   2. Bubble math — am I clinched / alive / out of the Top cut, and what does
 *      the next round need to be? (plus a Monte-Carlo Top-cut probability)
 *   3. The per-Legend "best-of" bonus race — RQs award a side prize to the best
 *      finisher on each Legend, so who currently leads each Legend's race?
 *
 * Fair-play note: this consumes only publicly-posted pairings/results, the same
 * info a player could read off the standings board. It is a between-rounds
 * research tool, not an in-match aid.
 */

import { winProbability, isProvisional, RATING_START, RD_START } from "@/lib/glicko";

export interface Scoring {
  win: number;
  draw: number;
  loss: number;
}

export interface RawPlayerRef {
  id: string;
  displayName: string;
  handle: string | null;
}

export interface RawMatch {
  roundNumber: number | null;
  playerOneId: string;
  playerTwoId: string;
  playerOne: RawPlayerRef;
  playerTwo: RawPlayerRef;
  playerOneWins: number;
  playerTwoWins: number;
  draws: number;
  winnerId: string | null;
  isBye: boolean;
  deckOneId: string | null;
  deckTwoId: string | null;
}

export interface RawEntry {
  player: {
    id: string;
    displayName: string;
    handle: string | null;
    rating: number;
    ratingDeviation: number;
  };
  deck: { legend: string | null; name: string; domains: string | null } | null;
}

export interface Standing {
  playerId: string;
  displayName: string;
  handle: string | null;
  legend: string | null;
  domains: string | null;
  rating: number;
  rd: number;
  provisional: boolean;
  wins: number;
  losses: number;
  draws: number;
  byes: number;
  points: number;
  roundsPlayed: number;
  gameWins: number;
  gameLosses: number;
  omw: number; // opponents' average match-win % (primary tiebreaker)
  gw: number; // own game-win %
  ogw: number; // opponents' average game-win %
  opponents: string[]; // non-bye opponent ids (for tiebreakers / simulation)
  rank: number;
}

const MIN_PCT = 1 / 3; // Swiss tiebreaker floor (a la WotC / carde)

/** Pull "Norra" out of a synthesized deck id "legend:Norra". */
function legendFromDeckId(deckId: string | null): string | null {
  if (!deckId) return null;
  return deckId.startsWith("legend:") ? deckId.slice("legend:".length) : null;
}

interface Acc {
  ref: RawPlayerRef;
  wins: number;
  losses: number;
  draws: number;
  byes: number;
  points: number;
  roundsPlayed: number;
  gameWins: number;
  gameLosses: number;
  opponents: string[];
}

/**
 * Live standings from match results. Points come from the event's own scoring;
 * tiebreakers (OMW%, GW%, OGW%) are the standard Swiss formulas — a player's
 * match-win % is points/(maxPointsPerRound · rounds), floored at 1/3, and the
 * "opponents' …" breakers average that over the people they actually played
 * (byes excluded, as in real Swiss).
 */
export function computeStandings(
  matches: RawMatch[],
  entries: RawEntry[],
  scoring: Scoring,
): Standing[] {
  const legendByPlayer = new Map<string, { legend: string; domains: string | null }>();
  const meta = new Map<
    string,
    { rating: number; rd: number; ref?: RawPlayerRef }
  >();
  for (const e of entries) {
    meta.set(e.player.id, {
      rating: e.player.rating,
      rd: e.player.ratingDeviation,
      ref: { id: e.player.id, displayName: e.player.displayName, handle: e.player.handle },
    });
    const legend = e.deck?.legend ?? e.deck?.name ?? null;
    if (legend) legendByPlayer.set(e.player.id, { legend, domains: e.deck?.domains ?? null });
  }

  const accs = new Map<string, Acc>();
  const get = (ref: RawPlayerRef): Acc => {
    let a = accs.get(ref.id);
    if (!a) {
      a = {
        ref,
        wins: 0,
        losses: 0,
        draws: 0,
        byes: 0,
        points: 0,
        roundsPlayed: 0,
        gameWins: 0,
        gameLosses: 0,
        opponents: [],
      };
      accs.set(ref.id, a);
    }
    return a;
  };

  for (const m of matches) {
    // Fall back to the per-match deck id if a player never formally registered a
    // decklist (recorded mid-event) — keeps the Legend race complete.
    if (!legendByPlayer.has(m.playerOneId)) {
      const l = legendFromDeckId(m.deckOneId);
      if (l) legendByPlayer.set(m.playerOneId, { legend: l, domains: null });
    }
    if (!legendByPlayer.has(m.playerTwoId)) {
      const l = legendFromDeckId(m.deckTwoId);
      if (l) legendByPlayer.set(m.playerTwoId, { legend: l, domains: null });
    }

    if (m.isBye) {
      const a = get(m.playerOne);
      a.byes++;
      a.wins++;
      a.points += scoring.win;
      a.roundsPlayed++;
      continue;
    }

    const a = get(m.playerOne);
    const b = get(m.playerTwo);
    a.roundsPlayed++;
    b.roundsPlayed++;
    a.gameWins += m.playerOneWins;
    a.gameLosses += m.playerTwoWins;
    b.gameWins += m.playerTwoWins;
    b.gameLosses += m.playerOneWins;
    a.opponents.push(b.ref.id);
    b.opponents.push(a.ref.id);

    if (m.winnerId == null) {
      a.draws++;
      b.draws++;
      a.points += scoring.draw;
      b.points += scoring.draw;
    } else if (m.winnerId === a.ref.id) {
      a.wins++;
      b.losses++;
      a.points += scoring.win;
      b.points += scoring.loss;
    } else {
      b.wins++;
      a.losses++;
      b.points += scoring.win;
      a.points += scoring.loss;
    }
  }

  // First pass: each player's own match-win % and game-win % (floored).
  const matchWinPct = new Map<string, number>();
  const gameWinPct = new Map<string, number>();
  for (const [id, a] of accs) {
    const maxPts = scoring.win * Math.max(1, a.roundsPlayed);
    matchWinPct.set(id, Math.max(MIN_PCT, a.points / maxPts));
    const games = a.gameWins + a.gameLosses;
    gameWinPct.set(id, games ? Math.max(MIN_PCT, a.gameWins / games) : MIN_PCT);
  }

  const standings: Standing[] = [];
  for (const [id, a] of accs) {
    const opps = a.opponents;
    const omw = opps.length
      ? opps.reduce((s, o) => s + (matchWinPct.get(o) ?? MIN_PCT), 0) / opps.length
      : 0;
    const ogw = opps.length
      ? opps.reduce((s, o) => s + (gameWinPct.get(o) ?? MIN_PCT), 0) / opps.length
      : 0;
    const m = meta.get(id);
    const leg = legendByPlayer.get(id);
    standings.push({
      playerId: id,
      displayName: a.ref.displayName,
      handle: a.ref.handle,
      legend: leg?.legend ?? null,
      domains: leg?.domains ?? null,
      rating: m?.rating ?? RATING_START,
      rd: m?.rd ?? RD_START,
      provisional: isProvisional(m?.rd ?? RD_START),
      wins: a.wins,
      losses: a.losses,
      draws: a.draws,
      byes: a.byes,
      points: a.points,
      roundsPlayed: a.roundsPlayed,
      gameWins: a.gameWins,
      gameLosses: a.gameLosses,
      omw,
      gw: gameWinPct.get(id) ?? MIN_PCT,
      ogw,
      opponents: opps,
      rank: 0,
    });
  }

  standings.sort(
    (x, y) =>
      y.points - x.points ||
      y.omw - x.omw ||
      y.ogw - x.ogw ||
      y.gw - x.gw ||
      x.displayName.localeCompare(y.displayName),
  );
  standings.forEach((s, i) => (s.rank = i + 1));
  return standings;
}

/** Rounds finished so far = the highest round number that has any result. */
export function completedRounds(matches: RawMatch[]): number {
  return matches.reduce((mx, m) => Math.max(mx, m.roundNumber ?? 0), 0);
}

export type BubbleState = "in" | "alive" | "out";

export interface Bubble {
  state: BubbleState;
  minFinal: number;
  maxFinal: number;
  advice: string;
}

/**
 * Provable Top-cut status from points bounds. A player is **clinched** only when
 * fewer than `topCut` other players can *possibly* reach their floor, and
 * **eliminated** only when at least `topCut` players are *guaranteed* above their
 * ceiling — both are true guarantees (ties counted against the player, so
 * "clinched" never lies). Everyone else is on the **bubble**. `advice` reads the
 * next round: what result keeps you alive or seals the cut.
 */
export function bubbleAnalysis(
  standings: Standing[],
  roundsLeft: number,
  topCut: number,
  scoring: Scoring,
): Map<string, Bubble> {
  const pts = standings.map((s) => s.points);

  // Status of a focal player holding `selfPts` with `selfLeft` rounds to go,
  // while every *other* player still has `othersLeft` rounds of upside from now.
  const statusFor = (
    selfIdx: number,
    selfPts: number,
    selfLeft: number,
    othersLeft: number,
  ): BubbleState => {
    const minSelf = selfPts + selfLeft * scoring.loss;
    const maxSelf = selfPts + selfLeft * scoring.win;
    let threats = 0; // others who could finish at or above my floor
    let locked = 0; // others guaranteed to finish above my ceiling
    for (let j = 0; j < pts.length; j++) {
      if (j === selfIdx) continue;
      if (pts[j] + othersLeft * scoring.win >= minSelf) threats++;
      if (pts[j] + othersLeft * scoring.loss > maxSelf) locked++;
    }
    if (locked >= topCut) return "out";
    if (threats < topCut) return "in";
    return "alive";
  };

  const out = new Map<string, Bubble>();
  standings.forEach((s, i) => {
    const minFinal = s.points + roundsLeft * scoring.loss;
    const maxFinal = s.points + roundsLeft * scoring.win;
    const state = statusFor(i, s.points, roundsLeft, roundsLeft);

    let advice: string;
    if (roundsLeft <= 0) {
      advice =
        state === "in" ? `Top ${topCut}` : state === "out" ? "Missed cut" : "On the bubble — tiebreakers decide";
    } else if (state === "in") {
      advice = `Clinched Top ${topCut}`;
    } else if (state === "out") {
      advice = `Eliminated from Top ${topCut}`;
    } else {
      // Look one round ahead: others keep their full upside (othersLeft = roundsLeft).
      const win = statusFor(i, s.points + scoring.win, roundsLeft - 1, roundsLeft);
      const draw = statusFor(i, s.points + scoring.draw, roundsLeft - 1, roundsLeft);
      const loss = statusFor(i, s.points + scoring.loss, roundsLeft - 1, roundsLeft);
      if (draw === "in") advice = `A draw clinches Top ${topCut}`;
      else if (win === "in") advice = "Win and you're in";
      else if (loss === "out" && draw === "out") advice = "Must win to stay alive";
      else if (loss === "out") advice = "Win or draw to stay alive";
      else advice = "Alive even with a loss";
    }

    out.set(s.playerId, { state, minFinal, maxFinal, advice });
  });
  return out;
}

export interface LegendRace {
  legend: string;
  domains: string | null;
  pilots: Standing[]; // ranked best-first within the Legend
  leaderId: string;
}

/**
 * The "best-of" bonus race: group pilots by Legend and rank them by the same
 * live standing order, so the leader of each list is currently winning that
 * Legend's side prize. A player checks here to see if they're still on top of —
 * or chasing — their archetype's bonus.
 */
export function legendRaces(standings: Standing[]): LegendRace[] {
  const byLegend = new Map<string, Standing[]>();
  for (const s of standings) {
    if (!s.legend) continue;
    let list = byLegend.get(s.legend);
    if (!list) byLegend.set(s.legend, (list = []));
    list.push(s);
  }
  const races: LegendRace[] = [];
  for (const [legend, pilots] of byLegend) {
    pilots.sort((a, b) => a.rank - b.rank); // standings are already tiebroken
    races.push({ legend, domains: pilots[0].domains, pilots, leaderId: pilots[0].playerId });
  }
  // Show the most-contested Legends first, then by who their leader is.
  races.sort((a, b) => b.pilots.length - a.pilots.length || a.pilots[0].rank - b.pilots[0].rank);
  return races;
}

/** Upper bound on simulations, used for small fields where it is cheap. */
const MAX_SIMS = 1500;
/** Never drop below this — fewer than ~120 runs makes the odds visibly jittery. */
const MIN_SIMS = 120;
/**
 * Rough comparison budget for a whole `simulateTopCut` call. Each simulated
 * round sorts the field, so the cost is ~ sims x rounds x n log2(n) comparisons.
 */
const SIM_WORK_BUDGET = 8_000_000;

/**
 * How many simulations to run for a field of `n` with `roundsLeft` to play.
 *
 * A flat 1500 is fine for a 32-player local event but catastrophic for a large
 * Regional: at n=1953 with 3 rounds left it is ~100M comparisons, which blew the
 * Cloudflare Worker CPU limit and made the live page return intermittent 503s
 * (`outcome: exceededCpu`) for exactly the biggest, busiest events. Scaling the
 * count keeps the work bounded; the odds are explicitly an estimate, and at the
 * floor of 120 runs the standard error on a 50% chance is ~4.5pp — well inside
 * "a guide, not a verdict".
 *
 * Exported so the UI can state the real number it used.
 */
export function simCountFor(n: number, roundsLeft: number): number {
  if (n <= 1 || roundsLeft <= 0) return MAX_SIMS;
  const perSim = roundsLeft * n * Math.max(1, Math.log2(n));
  return Math.max(MIN_SIMS, Math.min(MAX_SIMS, Math.floor(SIM_WORK_BUDGET / perSim)));
}

/**
 * Monte-Carlo Top-cut probability. Simulates the remaining Swiss rounds many
 * times — pairing within score brackets, resolving each game by the Glicko
 * win-probability of the two players — then cuts the field by final points
 * (current OMW% as the tiebreak proxy). An estimate, not a guarantee: it ignores
 * rematch-avoidance and draws, so read it next to the provable bubble status.
 *
 * `sims` defaults to a size-aware budget — see `simCountFor`.
 */
export function simulateTopCut(
  standings: Standing[],
  roundsLeft: number,
  topCut: number,
  scoring: Scoring,
  sims = simCountFor(standings.length, roundsLeft),
): Map<string, number> {
  const counts = new Map<string, number>();
  const n = standings.length;
  for (const s of standings) counts.set(s.playerId, 0);
  if (n === 0) return counts;
  if (roundsLeft <= 0) {
    // Field is final: just take the current top `topCut`.
    standings.slice(0, topCut).forEach((s) => counts.set(s.playerId, sims));
    return counts.size ? mapDiv(counts, sims) : counts;
  }

  // Static per-player data, indexed for speed.
  const id = standings.map((s) => s.playerId);
  const r = standings.map((s) => s.rating);
  const rd = standings.map((s) => s.rd);
  const omw = standings.map((s) => s.omw); // tiebreak proxy, held fixed
  const basePts = standings.map((s) => s.points);

  for (let sim = 0; sim < sims; sim++) {
    const pts = basePts.slice();
    const noise = new Array(n);
    for (let i = 0; i < n; i++) noise[i] = Math.random();

    for (let round = 0; round < roundsLeft; round++) {
      // Pair within score brackets: sort by points (noise breaks ties / shuffles
      // pairings), then pair neighbours top-down.
      const order = [...Array(n).keys()].sort(
        (a, b) => pts[b] - pts[a] || noise[a] - noise[b],
      );
      for (let k = 0; k + 1 < order.length; k += 2) {
        const a = order[k];
        const b = order[k + 1];
        const pa = winProbability(r[a], rd[a], r[b], rd[b]);
        if (Math.random() < pa) {
          pts[a] += scoring.win;
          pts[b] += scoring.loss;
        } else {
          pts[b] += scoring.win;
          pts[a] += scoring.loss;
        }
      }
      if (order.length % 2 === 1) {
        pts[order[order.length - 1]] += scoring.win; // odd one out gets the bye
      }
      // Reshuffle pairing noise between rounds.
      for (let i = 0; i < n; i++) noise[i] = Math.random();
    }

    const finalOrder = [...Array(n).keys()].sort(
      (a, b) => pts[b] - pts[a] || omw[b] - omw[a] || noise[a] - noise[b],
    );
    for (let k = 0; k < topCut && k < finalOrder.length; k++) {
      const i = finalOrder[k];
      counts.set(id[i], (counts.get(id[i]) ?? 0) + 1);
    }
  }

  return mapDiv(counts, sims);
}

function mapDiv(m: Map<string, number>, d: number): Map<string, number> {
  for (const [k, v] of m) m.set(k, v / d);
  return m;
}
