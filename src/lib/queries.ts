import { prisma } from "@/lib/prisma";

/** Top players by rating (the nationwide ladder). Requires >=1 game played. */
export async function getLeaderboard(limit = 100, offset = 0) {
  return prisma.player.findMany({
    where: { gamesPlayed: { gt: 0 } },
    orderBy: [{ rating: "desc" }, { gamesPlayed: "desc" }],
    take: limit,
    skip: offset,
  });
}

export async function getGlobalStats() {
  const [players, rankedPlayers, events, matches, decks, stores] = await Promise.all([
    prisma.player.count(),
    prisma.player.count({ where: { gamesPlayed: { gt: 0 } } }),
    prisma.event.count(),
    prisma.match.count(),
    prisma.deck.count(),
    prisma.store.count(),
  ]);
  return { players, rankedPlayers, events, matches, decks, stores };
}

const now = () => new Date();

export async function getUpcomingEvents(limit = 12) {
  return prisma.event.findMany({
    where: { startDatetime: { gte: now() } },
    orderBy: { startDatetime: "asc" },
    take: limit,
    include: { store: true },
  });
}

export async function getRecentEvents(limit = 12) {
  return prisma.event.findMany({
    where: { startDatetime: { lt: now() } },
    orderBy: { startDatetime: "desc" },
    take: limit,
    include: { store: true, _count: { select: { entries: true } } },
  });
}

export async function getStores() {
  return prisma.store.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { events: true } } },
  });
}

export async function getStore(id: string) {
  return prisma.store.findUnique({
    where: { id },
    include: {
      events: {
        orderBy: { startDatetime: "desc" },
        include: { _count: { select: { entries: true } } },
      },
    },
  });
}

/** Players ranked by event attendance (used when no Elo data exists yet). */
export async function getPlayersByAttendance(limit = 300) {
  const players = await prisma.player.findMany({
    include: { _count: { select: { entries: true } } },
    take: 1000,
  });
  return players
    .sort((a, b) => b._count.entries - a._count.entries || b.rating - a.rating)
    .slice(0, limit);
}

export async function hasEloData(): Promise<boolean> {
  return (await prisma.match.count()) > 0;
}

export async function getPlayer(id: string) {
  return prisma.player.findUnique({ where: { id } });
}

export async function getPlayerRatingHistory(id: string) {
  return prisma.ratingChange.findMany({
    where: { playerId: id },
    orderBy: { createdAt: "asc" },
    include: {
      match: {
        select: {
          id: true,
          roundNumber: true,
          playedAt: true,
          event: { select: { id: true, name: true } },
        },
      },
    },
  });
}

export async function getPlayerRank(rating: number): Promise<number> {
  const higher = await prisma.player.count({
    where: { gamesPlayed: { gt: 0 }, rating: { gt: rating } },
  });
  return higher + 1;
}

/** A player's deck usage across events, with per-deck record. */
export async function getPlayerDecks(playerId: string) {
  const entries = await prisma.eventEntry.findMany({
    where: { playerId, deckId: { not: null } },
    include: { deck: true },
  });
  const byDeck = new Map<string, { name: string; legend: string | null; count: number }>();
  for (const e of entries) {
    if (!e.deck) continue;
    const cur = byDeck.get(e.deck.id) ?? {
      name: e.deck.name,
      legend: e.deck.legend,
      count: 0,
    };
    cur.count += 1;
    byDeck.set(e.deck.id, cur);
  }
  return [...byDeck.values()].sort((a, b) => b.count - a.count);
}

export async function getPlayerEvents(playerId: string) {
  return prisma.eventEntry.findMany({
    where: { playerId },
    include: { event: { include: { store: true } } },
    orderBy: { event: { startDatetime: "desc" } },
  });
}

export async function getPlayerRecentMatches(playerId: string, limit = 20) {
  const matches = await prisma.match.findMany({
    where: {
      OR: [{ playerOneId: playerId }, { playerTwoId: playerId }],
      isBye: false,
    },
    orderBy: [{ playedAt: "desc" }, { id: "desc" }],
    take: limit,
    include: {
      playerOne: { select: { id: true, displayName: true, handle: true } },
      playerTwo: { select: { id: true, displayName: true, handle: true } },
      event: { select: { id: true, name: true } },
      changes: { where: { playerId }, select: { delta: true } },
    },
  });
  return matches.map((m) => {
    const isP1 = m.playerOneId === playerId;
    const opp = isP1 ? m.playerTwo : m.playerOne;
    const result =
      m.winnerId == null
        ? "draw"
        : m.winnerId === playerId
          ? "win"
          : "loss";
    return {
      id: m.id,
      event: m.event,
      roundNumber: m.roundNumber,
      opponent: opp,
      result: result as "win" | "loss" | "draw",
      delta: m.changes[0]?.delta ?? 0,
      playedAt: m.playedAt,
    };
  });
}

export async function getEvents(limit = 100) {
  return prisma.event.findMany({
    orderBy: { startDatetime: "desc" },
    take: limit,
    include: { store: true, _count: { select: { matches: true, entries: true } } },
  });
}

export async function getEvent(id: string) {
  return prisma.event.findUnique({
    where: { id },
    include: {
      store: true,
      entries: {
        include: { player: true, deck: true },
        orderBy: { finalStanding: "asc" },
      },
      matches: {
        orderBy: [{ roundNumber: "asc" }, { id: "asc" }],
        include: {
          playerOne: { select: { id: true, displayName: true, handle: true } },
          playerTwo: { select: { id: true, displayName: true, handle: true } },
        },
      },
    },
  });
}

/** Metagame: aggregate by Legend across all event entries, with win rates. */
export async function getMetagame() {
  // Pull every entry's deck legend, then compute record from that player's
  // matches in that event where the deck was used.
  const decks = await prisma.deck.findMany();
  const legendOf = new Map<string, string>();
  for (const d of decks) legendOf.set(d.id, d.legend ?? d.name);

  const matches = await prisma.match.findMany({
    where: { isBye: false },
    select: {
      deckOneId: true,
      deckTwoId: true,
      winnerId: true,
      playerOneId: true,
      playerTwoId: true,
    },
  });

  type Agg = { legend: string; entries: number; wins: number; losses: number; draws: number };
  const byLegend = new Map<string, Agg>();
  const get = (legend: string) => {
    let a = byLegend.get(legend);
    if (!a) {
      a = { legend, entries: 0, wins: 0, losses: 0, draws: 0 };
      byLegend.set(legend, a);
    }
    return a;
  };

  for (const m of matches) {
    const l1 = m.deckOneId ? legendOf.get(m.deckOneId) : undefined;
    const l2 = m.deckTwoId ? legendOf.get(m.deckTwoId) : undefined;
    if (l1) {
      const a = get(l1);
      if (m.winnerId == null) a.draws++;
      else if (m.winnerId === m.playerOneId) a.wins++;
      else a.losses++;
    }
    if (l2) {
      const a = get(l2);
      if (m.winnerId == null) a.draws++;
      else if (m.winnerId === m.playerTwoId) a.wins++;
      else a.losses++;
    }
  }

  // entries = distinct event participations per legend
  const entries = await prisma.eventEntry.findMany({
    where: { deckId: { not: null } },
    select: { deckId: true },
  });
  for (const e of entries) {
    if (!e.deckId) continue;
    const legend = legendOf.get(e.deckId);
    if (legend) get(legend).entries++;
  }

  return [...byLegend.values()]
    .filter((a) => a.wins + a.losses + a.draws > 0)
    .sort((a, b) => b.wins + b.draws + b.losses - (a.wins + a.draws + a.losses));
}
