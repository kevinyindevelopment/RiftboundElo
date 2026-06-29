/**
 * Seed the database with synthetic Riftbound events, players, decks and matches
 * so the full pipeline (Elo + UI) is demonstrable without carde.io credentials.
 *
 *   npm run seed
 *
 * Deterministic (seeded PRNG) so repeated runs + recompute give stable ratings.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

// Tiny deterministic PRNG (mulberry32).
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

const LEGENDS = [
  { legend: "Master Yi, Wuju Bladesman", champion: "Master Yi", domains: ["body", "order"] },
  { legend: "Jinx, Loose Cannon", champion: "Jinx", domains: ["chaos", "fury"] },
  { legend: "Lux, Lady of Luminosity", champion: "Lux", domains: ["mind", "order"] },
  { legend: "Yasuo, the Unforgiven", champion: "Yasuo", domains: ["fury", "calm"] },
  { legend: "Ahri, the Nine-Tailed Fox", champion: "Ahri", domains: ["mind", "chaos"] },
  { legend: "Darius, Hand of Noxus", champion: "Darius", domains: ["body", "fury"] },
  { legend: "Lulu, the Fae Sorceress", champion: "Lulu", domains: ["calm", "mind"] },
  { legend: "Viktor, the Machine Herald", champion: "Viktor", domains: ["mind", "order"] },
];

const FIRST = ["Alex", "Sam", "Jordan", "Casey", "Riley", "Taylor", "Morgan", "Jamie", "Drew", "Quinn", "Avery", "Reese", "Skyler", "Charlie", "Emerson", "Finley"];
const LAST = ["Nguyen", "Patel", "Garcia", "Kim", "Smith", "Lopez", "Chen", "Khan", "Rossi", "Müller", "Sato", "Silva", "Cohen", "Brown", "Diaz", "Walsh"];

const STORES = [
  { id: "store-1", name: "Dragon's Den Games", country: "US", city: "Austin", latitude: 30.27, longitude: -97.74 },
  { id: "store-2", name: "The Game Cradle", country: "US", city: "Seattle", latitude: 47.6, longitude: -122.33 },
  { id: "store-3", name: "Mana Vault TCG", country: "US", city: "Chicago", latitude: 41.88, longitude: -87.63 },
];

async function main() {
  console.log("Clearing existing data…");
  await prisma.ratingChange.deleteMany();
  await prisma.match.deleteMany();
  await prisma.eventEntry.deleteMany();
  await prisma.event.deleteMany();
  await prisma.deck.deleteMany();
  await prisma.store.deleteMany();
  await prisma.player.deleteMany();

  await prisma.store.createMany({ data: STORES });

  // Decks (one per legend).
  const decks = LEGENDS.map((l, i) => ({
    id: `deck-${i}`,
    name: l.legend,
    legend: l.legend,
    champion: l.champion,
    domains: JSON.stringify(l.domains),
    format: "Constructed",
    archetype: l.champion,
  }));
  await prisma.deck.createMany({ data: decks });

  // Players.
  const PLAYER_COUNT = 48;
  const players = Array.from({ length: PLAYER_COUNT }, (_, i) => {
    const first = FIRST[i % FIRST.length];
    const last = LAST[Math.floor(i / FIRST.length) % LAST.length];
    return {
      id: `player-${i}`,
      displayName: `${first} ${last}`,
      handle: `${first.toLowerCase()}${i}`,
      firstName: first,
      lastName: last,
      country: "US",
      // Give players a hidden "skill" to make Elo converge realistically.
      _skill: 1000 + Math.floor(rand() * 400) - 100,
    };
  });
  await prisma.player.createMany({
    data: players.map(({ _skill, ...p }) => p),
  });
  const skill = new Map(players.map((p) => [p.id, p._skill]));

  // Events: weekly locals across stores over ~12 weeks.
  const base = new Date("2026-03-01T18:00:00Z").getTime();
  const week = 7 * 24 * 3600 * 1000;
  let matchSeq = 0;

  for (let e = 0; e < 18; e++) {
    const store = pick(STORES);
    const eventId = `event-${e}`;
    const start = new Date(base + e * (week / 2));
    // 8-16 players per event.
    const fieldSize = 8 + Math.floor(rand() * 9);
    const field = [...players].sort(() => rand() - 0.5).slice(0, fieldSize);

    await prisma.event.create({
      data: {
        id: eventId,
        name: `${store.name} Weekly #${e + 1}`,
        format: "Constructed",
        gameType: "Swiss",
        startDatetime: start,
        status: "completed",
        numPlayers: field.length,
        pointsPerWin: 3,
        pointsPerLoss: 0,
        pointsPerDraw: 1,
        storeId: store.id,
        resultsComplete: true,
      },
    });

    // Each player runs a deck for this event.
    const deckOf = new Map<string, string>();
    for (const p of field) {
      const deck = pick(decks);
      deckOf.set(p.id, deck.id);
      await prisma.eventEntry.create({
        data: { eventId, playerId: p.id, deckId: deck.id },
      });
    }

    // 4 swiss-ish rounds of random pairings.
    const rounds = 4;
    for (let r = 1; r <= rounds; r++) {
      const shuffled = [...field].sort(() => rand() - 0.5);
      for (let i = 0; i + 1 < shuffled.length; i += 2) {
        const a = shuffled[i];
        const b = shuffled[i + 1];
        const sa = skill.get(a.id)!;
        const sb = skill.get(b.id)!;
        // Win probability from skill difference (logistic).
        const pA = 1 / (1 + Math.pow(10, (sb - sa) / 400));
        const aWins = rand() < pA;
        const winner = aWins ? a.id : b.id;
        const playedAt = new Date(start.getTime() + r * 45 * 60 * 1000);
        await prisma.match.create({
          data: {
            id: `m-${matchSeq++}`,
            eventId,
            roundNumber: r,
            playerOneId: a.id,
            playerTwoId: b.id,
            playerOneWins: aWins ? 2 : Math.floor(rand() * 2),
            playerTwoWins: aWins ? Math.floor(rand() * 2) : 2,
            winnerId: winner,
            deckOneId: deckOf.get(a.id),
            deckTwoId: deckOf.get(b.id),
            playedAt,
          },
        });
      }
    }
  }

  const counts = {
    players: await prisma.player.count(),
    events: await prisma.event.count(),
    matches: await prisma.match.count(),
    decks: await prisma.deck.count(),
  };
  console.log("Seeded:", counts);
  console.log("Now run: npm run elo:recompute");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
