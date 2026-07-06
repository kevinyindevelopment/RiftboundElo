/**
 * Recompute every player's rating from the full match history.
 *
 *   npm run elo:recompute
 *
 * A single chronological pass suffers cold-start inflation: early events are
 * full of brand-new, high-uncertainty players whose ratings spike wildly, and
 * beating one of those temporarily-inflated opponents propagates the inflation
 * forward. So instead we ITERATE:
 *
 *   pass 1 — plain forward Glicko-2 (opponent = its evolving in-pass rating).
 *   pass 2…N — re-rate everyone from scratch, but judge each match against the
 *              opponent's *stable full-history* rating from the previous pass
 *              (held fixed). Early matches now see opponents at their true skill,
 *              so the inflation washes out and ratings converge to skill.
 *
 * Deterministic: same data in => same ratings out.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  RATING_START,
  newPlayer,
  updateAgainst,
  scoreFromGames,
  shrinkRating,
  type GlickoState,
} from "../src/lib/glicko";

const PASSES = Number(process.env.ELO_PASSES ?? 4);

type States = Map<string, GlickoState>;

function chronoKey(m: {
  playedAt: Date | null;
  roundNumber: number | null;
  eventStart: Date | null;
  id: string;
}): string {
  const t =
    m.playedAt?.getTime() ?? m.eventStart?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return `${String(t).padStart(16, "0")}-${String(m.roundNumber ?? 0).padStart(4, "0")}-${m.id}`;
}

interface ChangeRow {
  playerId: string;
  matchId: string;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
}

async function main() {
  console.log("Loading matches…");
  const matches = await prisma.match.findMany({
    include: { event: { select: { startDatetime: true } } },
  });
  const ordered = matches
    .map((m) => ({ ...m, eventStart: m.event?.startDatetime ?? null }))
    .sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));

  const scoreOf = (m: (typeof ordered)[number]) =>
    m.winnerId
      ? m.winnerId === m.playerOneId
        ? 1
        : m.winnerId === m.playerTwoId
          ? 0
          : 0.5
      : scoreFromGames(m.playerOneWins, m.playerTwoWins);

  // Iterative passes. `priors` holds the previous pass's final ratings.
  let priors: States = new Map();
  let finalStates: States = new Map();
  let finalChanges: ChangeRow[] = [];
  const stats = new Map<string, { w: number; l: number; d: number; g: number }>();
  const peaks = new Map<string, number>();
  const gamesSeen = new Map<string, number>(); // games-so-far, for regressing the displayed rating per match

  for (let pass = 0; pass < PASSES; pass++) {
    const usePrior = pass > 0;
    const isLast = pass === PASSES - 1;
    const states: States = new Map();
    const get = (id: string) => states.get(id) ?? newPlayer();
    const priorOf = (id: string) => priors.get(id) ?? newPlayer();
    const changes: ChangeRow[] = [];

    const bump = (id: string, key: "w" | "l" | "d") => {
      const s = stats.get(id) ?? { w: 0, l: 0, d: 0, g: 0 };
      s[key] += 1;
      s.g += 1;
      stats.set(id, s);
    };

    console.log(`Pass ${pass + 1}/${PASSES} — replaying ${ordered.length} matches…`);
    for (const m of ordered) {
      if (m.isBye) continue;
      const sA = get(m.playerOneId);
      const sB = get(m.playerTwoId);
      const scoreA = scoreOf(m);

      // Opponent reference: fixed full-history prior (passes ≥2) or the live
      // in-pass state (pass 1). Both sides read pre-match snapshots, so the
      // exchange stays order-independent.
      const refA = usePrior ? priorOf(m.playerTwoId) : sB;
      const refB = usePrior ? priorOf(m.playerOneId) : sA;
      const newA = updateAgainst(sA, refA.r, refA.rd, scoreA);
      const newB = updateAgainst(sB, refB.r, refB.rd, 1 - scoreA);
      states.set(m.playerOneId, newA);
      states.set(m.playerTwoId, newB);

      if (isLast) {
        // Displayed rating is the sample-size–regressed Glicko mean, so the
        // per-match deltas and peak match what the UI shows.
        const gbA = gamesSeen.get(m.playerOneId) ?? 0;
        const gbB = gamesSeen.get(m.playerTwoId) ?? 0;
        gamesSeen.set(m.playerOneId, gbA + 1);
        gamesSeen.set(m.playerTwoId, gbB + 1);
        const beforeA = Math.round(shrinkRating(sA.r, gbA));
        const afterA = Math.round(shrinkRating(newA.r, gbA + 1));
        const beforeB = Math.round(shrinkRating(sB.r, gbB));
        const afterB = Math.round(shrinkRating(newB.r, gbB + 1));
        peaks.set(m.playerOneId, Math.max(peaks.get(m.playerOneId) ?? RATING_START, afterA));
        peaks.set(m.playerTwoId, Math.max(peaks.get(m.playerTwoId) ?? RATING_START, afterB));
        if (scoreA === 1) {
          bump(m.playerOneId, "w");
          bump(m.playerTwoId, "l");
        } else if (scoreA === 0) {
          bump(m.playerOneId, "l");
          bump(m.playerTwoId, "w");
        } else {
          bump(m.playerOneId, "d");
          bump(m.playerTwoId, "d");
        }
        changes.push(
          { playerId: m.playerOneId, matchId: m.id, ratingBefore: beforeA, ratingAfter: afterA, delta: afterA - beforeA },
          { playerId: m.playerTwoId, matchId: m.id, ratingBefore: beforeB, ratingAfter: afterB, delta: afterB - beforeB },
        );
      }
    }

    priors = states;
    if (isLast) {
      finalStates = states;
      finalChanges = changes;
    }
  }

  // Persist rating history (from the final pass).
  console.log("Clearing old rating history…");
  await prisma.ratingChange.deleteMany({});
  console.log(`Writing ${finalChanges.length} rating changes…`);
  for (let i = 0; i < finalChanges.length; i += 500) {
    await prisma.ratingChange.createMany({ data: finalChanges.slice(i, i + 500) });
  }

  const playerIds = new Set<string>([
    ...finalStates.keys(),
    ...(await prisma.player.findMany({ select: { id: true } })).map((p) => p.id),
  ]);
  console.log(`Updating ${playerIds.size} player snapshots…`);
  // Bulk UPDATE ... FROM (VALUES ...) — one statement per ~1000 players with
  // each player's own values, instead of a round-trip per player.
  const snap = [...playerIds].map((id) => {
    const s = stats.get(id) ?? { w: 0, l: 0, d: 0, g: 0 };
    const st = finalStates.get(id) ?? newPlayer();
    return {
      id,
      rating: Math.round(shrinkRating(st.r, s.g)),
      peak: peaks.get(id) ?? RATING_START,
      rd: st.rd,
      vol: st.vol,
      g: s.g,
      w: s.w,
      l: s.l,
      d: s.d,
    };
  });
  const PCHUNK = 1000; // 9 cols * 1000 = 9000 params, well under PG's 65535
  for (let i = 0; i < snap.length; i += PCHUNK) {
    const batch = snap.slice(i, i + PCHUNK);
    const tuples: string[] = [];
    const args: unknown[] = [];
    let p = 0;
    for (const r of batch) {
      tuples.push(
        `($${++p},$${++p},$${++p},$${++p},$${++p},$${++p},$${++p},$${++p},$${++p})`,
      );
      args.push(r.id, r.rating, r.peak, r.rd, r.vol, r.g, r.w, r.l, r.d);
    }
    const sql = `UPDATE "Player" AS pl SET
        rating = v.rating::int,
        "peakRating" = v.peak::int,
        "ratingDeviation" = v.rd::double precision,
        volatility = v.vol::double precision,
        "gamesPlayed" = v.g::int,
        wins = v.w::int, losses = v.l::int, draws = v.d::int
      FROM (VALUES ${tuples.join(",")}) AS v(id, rating, peak, rd, vol, g, w, l, d)
      WHERE pl.id = v.id::text`;
    await prisma.$executeRawUnsafe(sql, ...args);
  }

  console.log("Done. Top 10:");
  const top = await prisma.player.findMany({
    orderBy: { rating: "desc" },
    take: 10,
    where: { gamesPlayed: { gt: 0 } },
  });
  for (const p of top) {
    console.log(`  ${p.rating}  ${p.displayName}  (${p.wins}-${p.losses}-${p.draws})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
