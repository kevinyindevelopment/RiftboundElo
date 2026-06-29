/**
 * Elo rating math.
 *
 * Classic Elo: each player has a rating; the expected score of A vs B is
 *   E_A = 1 / (1 + 10^((R_B - R_A)/400))
 * After a game with actual score S_A in {1 win, 0.5 draw, 0 loss}:
 *   R_A' = R_A + K * (S_A - E_A)
 * The exchange is symmetric, so points lost by one player are gained by the
 * other — matching RiftELO's "points transfer from loser to winner".
 */

export const ELO_START = Number(process.env.ELO_START ?? 1000);
export const ELO_K = Number(process.env.ELO_K ?? 32);

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

export interface EloResult {
  newA: number;
  newB: number;
  deltaA: number;
  deltaB: number;
}

/**
 * Apply one match. `scoreA` is A's actual score in [0,1]
 * (1 = A won, 0 = A lost, 0.5 = draw). K can be overridden per match.
 */
export function applyMatch(
  ratingA: number,
  ratingB: number,
  scoreA: number,
  k: number = ELO_K,
): EloResult {
  const expA = expectedScore(ratingA, ratingB);
  const expB = 1 - expA;
  const scoreB = 1 - scoreA;
  const deltaA = Math.round(k * (scoreA - expA));
  const deltaB = Math.round(k * (scoreB - expB));
  return {
    newA: ratingA + deltaA,
    newB: ratingB + deltaB,
    deltaA,
    deltaB,
  };
}

/** Convert game-win counts into A's score in [0,1]. */
export function scoreFromGames(winsA: number, winsB: number): number {
  if (winsA > winsB) return 1;
  if (winsA < winsB) return 0;
  return 0.5;
}
