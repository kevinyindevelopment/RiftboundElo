/**
 * Recompute every player's Elo from scratch by replaying all matches in
 * chronological order. Deterministic: same data in => same ratings out.
 *
 *   npm run elo:recompute
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { ELO_START, applyMatch, scoreFromGames } from "../src/lib/elo";

type Ratings = Map<string, number>;

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

async function main() {
  console.log("Loading matches…");
  const matches = await prisma.match.findMany({
    include: { event: { select: { startDatetime: true } } },
  });

  // Sort chronologically so ratings evolve in real order.
  const ordered = matches
    .map((m) => ({
      ...m,
      eventStart: m.event?.startDatetime ?? null,
    }))
    .sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));

  const ratings: Ratings = new Map();
  const peaks: Ratings = new Map();
  const stats = new Map<string, { w: number; l: number; d: number; g: number }>();
  const get = (id: string) => ratings.get(id) ?? ELO_START;
  const bump = (id: string, key: "w" | "l" | "d") => {
    const s = stats.get(id) ?? { w: 0, l: 0, d: 0, g: 0 };
    s[key] += 1;
    s.g += 1;
    stats.set(id, s);
  };

  console.log(`Replaying ${ordered.length} matches…`);
  // Clear prior history; we rewrite it fully.
  await prisma.ratingChange.deleteMany({});

  const changeRows: {
    playerId: string;
    matchId: string;
    ratingBefore: number;
    ratingAfter: number;
    delta: number;
  }[] = [];

  for (const m of ordered) {
    if (m.isBye) continue; // byes don't move Elo

    const rA = get(m.playerOneId);
    const rB = get(m.playerTwoId);
    const scoreA = m.winnerId
      ? m.winnerId === m.playerOneId
        ? 1
        : m.winnerId === m.playerTwoId
          ? 0
          : 0.5
      : scoreFromGames(m.playerOneWins, m.playerTwoWins);

    const res = applyMatch(rA, rB, scoreA);
    ratings.set(m.playerOneId, res.newA);
    ratings.set(m.playerTwoId, res.newB);
    peaks.set(m.playerOneId, Math.max(peaks.get(m.playerOneId) ?? ELO_START, res.newA));
    peaks.set(m.playerTwoId, Math.max(peaks.get(m.playerTwoId) ?? ELO_START, res.newB));

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

    changeRows.push(
      { playerId: m.playerOneId, matchId: m.id, ratingBefore: rA, ratingAfter: res.newA, delta: res.deltaA },
      { playerId: m.playerTwoId, matchId: m.id, ratingBefore: rB, ratingAfter: res.newB, delta: res.deltaB },
    );
  }

  // Persist rating history in batches.
  console.log(`Writing ${changeRows.length} rating changes…`);
  for (let i = 0; i < changeRows.length; i += 500) {
    await prisma.ratingChange.createMany({ data: changeRows.slice(i, i + 500) });
  }

  // Update player snapshots.
  const playerIds = new Set<string>([
    ...ratings.keys(),
    ...(await prisma.player.findMany({ select: { id: true } })).map((p) => p.id),
  ]);
  console.log(`Updating ${playerIds.size} player snapshots…`);
  for (const id of playerIds) {
    const s = stats.get(id) ?? { w: 0, l: 0, d: 0, g: 0 };
    await prisma.player.update({
      where: { id },
      data: {
        rating: get(id),
        peakRating: peaks.get(id) ?? ELO_START,
        gamesPlayed: s.g,
        wins: s.w,
        losses: s.l,
        draws: s.d,
      },
    });
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
