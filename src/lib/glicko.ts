/**
 * Glicko-2 rating math (Glickman 2013).
 *
 * Why not classic Elo? Elo seeds everyone at a fixed value (1000) and moves
 * every rating by the same K, so a brand-new player is treated as a known
 * average-skill player. Their most informative games (the first few) barely
 * move the number, and the 1000 seed acts as a soft floor — a player can't
 * realistically sink to their true beginner level before improving past it.
 *
 * Glicko-2 fixes this by tracking, per player, not just a rating `r` but a
 * rating *deviation* `rd` (how unsure we are) and a `volatility`. New players
 * start with a huge RD, so their early results swing the rating hard; as they
 * accumulate games the RD shrinks and the rating settles near their true skill.
 * Uncertainty, not an arbitrary seed, drives how fast the number moves.
 *
 * We run one match per "rating period" (the same granularity lichess uses), so
 * ratings update per game and the recompute/sparkline stay per-match.
 */

// Center of the scale. Reuses ELO_START so existing config / displayed numbers
// stay familiar (~1000) — Glicko-2 is translation-invariant, the center is free.
export const RATING_START = Number(process.env.ELO_START ?? 1500);
export const RD_START = Number(process.env.GLICKO_RD_START ?? 350);
export const VOL_START = Number(process.env.GLICKO_VOL ?? 0.06);
/** System constant τ: constrains volatility change. Smaller = steadier. */
export const TAU = Number(process.env.GLICKO_TAU ?? 0.5);
/** RD floor — stops established ratings from becoming permanently frozen. */
export const RD_MIN = Number(process.env.GLICKO_RD_MIN ?? 30);
/** At/below this RD the system is confident enough to call a rating settled. */
export const RD_ESTABLISHED = Number(process.env.GLICKO_RD_ESTABLISHED ?? 110);

// Glicko-2 internal scale factor (= 400 / ln(10)).
const SCALE = 173.7178;
const CONVERGENCE = 1e-6;

export interface GlickoState {
  r: number; // rating (display scale, centered on RATING_START)
  rd: number; // rating deviation
  vol: number; // volatility
}

export function newPlayer(): GlickoState {
  return { r: RATING_START, rd: RD_START, vol: VOL_START };
}

/** A rating is "provisional" until the system has seen enough games. */
export function isProvisional(rd: number): boolean {
  return rd > RD_ESTABLISHED;
}

/**
 * Games needed for a rating to count at ~half weight. Riftbound has real luck,
 * so a few-game record (especially an undefeated one) is weak evidence — we
 * regress it toward the population average until the sample is large enough.
 */
export const SHRINK_GAMES = Number(process.env.RATING_SHRINK_GAMES ?? 25);

/**
 * Sample-size–regressed rating: pull the raw Glicko mean toward the population
 * average (RATING_START) by how few games the player has. 200 games => trust the
 * number; 15 games => heavily regressed. This is what makes the displayed rating
 * track demonstrated skill rather than a small lucky (or unlucky) streak.
 */
export function shrinkRating(mean: number, games: number): number {
  if (games <= 0) return RATING_START;
  return RATING_START + (mean - RATING_START) * (games / (games + SHRINK_GAMES));
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

interface Opp {
  r: number;
  rd: number;
  score: number; // this player's score vs the opponent: 1 win / 0.5 draw / 0 loss
}

/** Glicko-2 update for one player against a set of opponents in a period. */
function updateOne(player: GlickoState, opponents: Opp[]): GlickoState {
  // No games this period: rating holds, only uncertainty grows.
  if (opponents.length === 0) {
    const phi = player.rd / SCALE;
    const phiStar = Math.sqrt(phi * phi + player.vol * player.vol);
    return { r: player.r, rd: clampRd(SCALE * phiStar), vol: player.vol };
  }

  const mu = (player.r - RATING_START) / SCALE;
  const phi = player.rd / SCALE;

  let vInv = 0;
  let deltaSum = 0; // Σ g(φ_j)(s_j − E_j)
  for (const o of opponents) {
    const muj = (o.r - RATING_START) / SCALE;
    const phij = o.rd / SCALE;
    const gj = g(phij);
    const ej = 1 / (1 + Math.exp(-gj * (mu - muj)));
    vInv += gj * gj * ej * (1 - ej);
    deltaSum += gj * (o.score - ej);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Iteratively solve for the new volatility (Illinois algorithm).
  const a = Math.log(player.vol * player.vol);
  const phi2 = phi * phi;
  const delta2 = delta * delta;
  const f = (x: number) => {
    const ex = Math.exp(x);
    const num = ex * (delta2 - phi2 - v - ex);
    const den = 2 * Math.pow(phi2 + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > CONVERGENCE) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const newVol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi2 + newVol * newVol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;

  return {
    r: RATING_START + SCALE * newMu,
    rd: clampRd(SCALE * newPhi),
    vol: newVol,
  };
}

function clampRd(rd: number): number {
  return Math.min(RD_START, Math.max(RD_MIN, rd));
}

/**
 * Apply a single match between A and B. Both updates use the *pre-match*
 * snapshot of the opponent, so the exchange is order-independent.
 * `scoreA` is A's score in {1, 0.5, 0}.
 */
export function updateMatch(
  a: GlickoState,
  b: GlickoState,
  scoreA: number,
): { a: GlickoState; b: GlickoState } {
  return {
    a: updateOne(a, [{ r: b.r, rd: b.rd, score: scoreA }]),
    b: updateOne(b, [{ r: a.r, rd: a.rd, score: 1 - scoreA }]),
  };
}

/**
 * Update one player against a single fixed opponent reference (r, rd). Used by
 * the iterative recompute to rate a player against an opponent's stable
 * full-history rating rather than the opponent's noisy at-the-moment rating.
 */
export function updateAgainst(
  player: GlickoState,
  oppR: number,
  oppRd: number,
  score: number,
): GlickoState {
  return updateOne(player, [{ r: oppR, rd: oppRd, score }]);
}

/** Convert game-win counts into A's score in [0,1]. */
export function scoreFromGames(winsA: number, winsB: number): number {
  if (winsA > winsB) return 1;
  if (winsA < winsB) return 0;
  return 0.5;
}

/**
 * A's expected score (≈ win probability for a 1-game match) against B under
 * Glicko-2. This is the same E used inside the update, but symmetric: both
 * players' deviations widen the curve toward 50/50, so a confident favorite vs a
 * provisional opponent reads less lopsided than the bare ratings suggest. Draws
 * are rare in Riftbound, so we treat the expected score as the win probability.
 */
export function winProbability(
  aR: number,
  aRd: number,
  bR: number,
  bRd: number,
): number {
  const mu = (aR - RATING_START) / SCALE;
  const muj = (bR - RATING_START) / SCALE;
  // Combine both uncertainties — a match between two fuzzy ratings is fuzzier.
  const phi = Math.sqrt((aRd / SCALE) ** 2 + (bRd / SCALE) ** 2);
  return 1 / (1 + Math.exp(-g(phi) * (mu - muj)));
}
