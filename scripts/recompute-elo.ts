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
import { isPreRiftEvent, PRE_RIFT_SQL } from "../src/lib/prerift";
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
  // Fetch matches and events SEPARATELY, then join in memory. An
  // `include: { event: ... }` inlines the event's name + start date into every
  // one of the ~500k match rows — the same few thousand event names repeated
  // hundreds of times each, all of it crossing the wire from Neon on every run.
  // Two flat queries transfer each event once. `select` likewise drops the
  // columns ratings don't read (draws, deck ids, eventId payload duplication).
  const [matches, events] = await Promise.all([
    prisma.match.findMany({
      select: {
        id: true,
        eventId: true,
        roundNumber: true,
        playedAt: true,
        playerOneId: true,
        playerTwoId: true,
        playerOneWins: true,
        playerTwoWins: true,
        winnerId: true,
        isBye: true,
      },
    }),
    prisma.event.findMany({ select: { id: true, name: true, startDatetime: true } }),
  ]);
  const eventById = new Map(events.map((e) => [e.id, e]));
  // Pre-Rift (set pre-release) events don't count toward Elo — drop their
  // matches entirely so they produce no RatingChange rows and don't touch any
  // player's rating/record. See src/lib/prerift.ts.
  //
  // Pre-Rift is the ONLY exclusion, deliberately. Team formats (2v2/trios, 1.7%
  // of rated matches), free-for-all (0.0%) and limited/draft (5.0%) all still
  // feed the ladder, because team results are considered indicative enough of
  // player skill to be worth rating.
  //
  // This is knowingly asymmetric with `classifyForAccomplishment` in
  // src/lib/queries.ts, which DOES exclude 2v2/team and limited events from
  // profile badges. Badges are meant to mark notable competitive finishes;
  // ratings are meant to track skill broadly. Don't "fix" one to match the
  // other without asking — the difference is intended.
  const eligible = matches.filter(
    (m) => !isPreRiftEvent(eventById.get(m.eventId)?.name),
  );
  const preRiftDropped = matches.length - eligible.length;
  console.log(`  excluded ${preRiftDropped} pre-rift matches; rating ${eligible.length}.`);
  const ordered = eligible
    .map((m) => ({ ...m, eventStart: eventById.get(m.eventId)?.startDatetime ?? null }))
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

  // Persist rating history (from the final pass) WITHOUT reading the table back.
  //
  // This used to download every existing RatingChange row (~660k) to diff them
  // in JS. Together with the full Match read above, each recompute pulled well
  // over a hundred megabytes OUT of Neon, and at 8 scheduled runs a day that
  // exhausted the account's monthly data-transfer allowance in a few days.
  // Neon then refused EVERY query with HTTP 402 and the live site served
  // nothing but 500s. Egress is the scarce resource here, so the diff belongs
  // in the database rather than in this process.
  //
  // `ON CONFLICT ... DO UPDATE ... WHERE IS DISTINCT FROM` reproduces the old
  // diff exactly: new pairs are inserted, genuinely-changed rows are updated,
  // and unchanged rows are left untouched — no rewrite, so no dead tuples and
  // no WAL churn (which is what also kept billed storage inflated). Sending
  // rows UP is ingress, which Neon does not meter.
  console.log(`Upserting ${finalChanges.length} rating-history rows...`);
  // 5 columns per row; Postgres caps a statement at 65535 bound parameters.
  const RCHUNK = 5000;
  for (let i = 0; i < finalChanges.length; i += RCHUNK) {
    const batch = finalChanges.slice(i, i + RCHUNK);
    const tuples: string[] = [];
    const args: unknown[] = [];
    let p = 0;
    for (const r of batch) {
      tuples.push(`($${++p},$${++p},$${++p}::int,$${++p}::int,$${++p}::int)`);
      args.push(r.playerId, r.matchId, r.ratingBefore, r.ratingAfter, r.delta);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RatingChange" ("playerId","matchId","ratingBefore","ratingAfter",delta)
       VALUES ${tuples.join(",")}
       ON CONFLICT ("playerId","matchId") DO UPDATE SET
         "ratingBefore" = EXCLUDED."ratingBefore",
         "ratingAfter"  = EXCLUDED."ratingAfter",
         delta          = EXCLUDED.delta
       WHERE ("RatingChange"."ratingBefore", "RatingChange"."ratingAfter", "RatingChange".delta)
             IS DISTINCT FROM
             (EXCLUDED."ratingBefore", EXCLUDED."ratingAfter", EXCLUDED.delta)`,
      ...args,
    );
  }

  // Remove history rows that should no longer exist. Deleting a Match already
  // cascades to its RatingChange rows, so the strays are matches that are still
  // present but whose rows are no longer correct:
  //   - the match became a bye, or its event was reclassified as pre-Rift, so
  //     it is no longer rated at all (see src/lib/prerift.ts);
  //   - a re-ingest CORRECTED who played, leaving rows keyed to a player who is
  //     no longer one of the two participants. The old client-side diff caught
  //     these as "in the table but not in the desired set"; expressed here as a
  //     participant check so it still works without reading the table.
  // Resolved entirely inside Postgres — the old code could only find any of
  // this by downloading all ~660k rows first.
  const unrated = await prisma.$executeRawUnsafe(
    `DELETE FROM "RatingChange" rc
      USING "Match" m
       JOIN "Event" e ON e.id = m."eventId"
      WHERE rc."matchId" = m.id
        AND (
             m."isBye" = true
          OR e.name ~* '${PRE_RIFT_SQL}'
          OR (rc."playerId" <> m."playerOneId" AND rc."playerId" <> m."playerTwoId")
        )`,
  );
  if (unrated > 0) console.log(`  removed ${unrated} stale history rows.`);

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
    // The trailing IS DISTINCT FROM makes this a DIFF, not a blind rewrite.
    // Without it every recompute rewrote all ~N player rows even when the
    // numbers were identical — and under MVCC an UPDATE is always a new tuple
    // plus a dead one, so 8 scheduled runs a day churned the whole Player table
    // 8 times over into WAL and dead tuples that Neon bills as storage. Same
    // bug the RatingChange diff above fixed; Player was missed. Final table
    // state is byte-identical either way.
    const sql = `UPDATE "Player" AS pl SET
        rating = v.rating::int,
        "peakRating" = v.peak::int,
        "ratingDeviation" = v.rd::double precision,
        volatility = v.vol::double precision,
        "gamesPlayed" = v.g::int,
        wins = v.w::int, losses = v.l::int, draws = v.d::int
      FROM (VALUES ${tuples.join(",")}) AS v(id, rating, peak, rd, vol, g, w, l, d)
      WHERE pl.id = v.id::text
        AND (pl.rating, pl."peakRating", pl."ratingDeviation", pl.volatility,
             pl."gamesPlayed", pl.wins, pl.losses, pl.draws)
            IS DISTINCT FROM
            (v.rating::int, v.peak::int, v.rd::double precision, v.vol::double precision,
             v.g::int, v.w::int, v.l::int, v.d::int)`;
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
