import { prisma } from "@/lib/prisma";
import { cachedQuery, TTL } from "@/lib/cache";
import { fmtDate, ordinal } from "@/lib/format";
import { isRegion } from "@/lib/regions";
import {
  calendarForCountry,
  setForDate,
  SET_DEFS,
  SET_ORDER,
  type ReleaseCalendar,
  type SetCode,
} from "@/lib/sets";

/** Minimum games to appear on the ranked ladder (a real sample, not a fluke). */
export const MIN_RANKED_GAMES = Number(process.env.MIN_RANKED_GAMES ?? 10);

/** Narrow a query by region, or {} for "all". */
function playerRegion(region?: string) {
  return isRegion(region) ? { region } : {};
}
function eventRegion(region?: string) {
  return isRegion(region) ? { store: { region } } : {};
}

/**
 * Events that are worth showing. A cancelled event nobody registered for is
 * pure noise — it never happened and has no roster, standings or matches to
 * look at. carde produces a LOT of these: 11,021 of 28,900 events (38%) are
 * cancelled with zero registrations, and not one of them has a single match.
 *
 * carde spells it "canceled"; both spellings are matched so a source change
 * can't silently un-hide thousands of rows. Exported so listings and the
 * counts beside them stay in agreement — if a page shows "N events" but lists
 * fewer, this fragment was missed somewhere.
 *
 * NOTE: this hides, it does not delete. The rows stay ingested (a direct link
 * to one still resolves), and re-ingest keeps working.
 */
export const CANCELED_STATUSES = ["canceled", "cancelled"];
export const visibleEvent = {
  NOT: { AND: [{ status: { in: CANCELED_STATUSES } }, { numPlayers: 0 }] },
};
/** Same predicate for the raw-SQL counts. `e` is the Event alias. */
const VISIBLE_EVENT_SQL = `NOT (LOWER(COALESCE(e.status,'')) IN ('canceled','cancelled') AND e."numPlayers" = 0)`;

/**
 * The ranked ladder: players with at least MIN_RANKED_GAMES games. `rating` is
 * already the sample-size–regressed value (see recompute-elo / glicko), so a
 * straight sort by it ranks proven players above small lucky/unlucky samples.
 */
export const getLeaderboard = cachedQuery(
  async function getLeaderboard(limit = 100, region?: string, offset = 0) {
    return prisma.player.findMany({
      where: { gamesPlayed: { gte: MIN_RANKED_GAMES }, ...playerRegion(region) },
      orderBy: [{ rating: "desc" }, { gamesPlayed: "desc" }],
      take: limit,
      skip: offset,
    });
  },
  ["leaderboard"],
);

/**
 * Site-wide totals for the home dashboard. ONE round trip, not six: every query
 * here is a separate HTTPS request to Neon (`poolQueryViaFetch`, see prisma.ts),
 * so round-trip count — not scan cost — is what the home page pays for.
 */
export const getGlobalStats = cachedQuery(async function getGlobalStats() {
  const [row] = await prisma.$queryRawUnsafe<
    {
      players: number;
      rankedPlayers: number;
      events: number;
      matches: number;
      decks: number;
      stores: number;
    }[]
  >(
    `SELECT (SELECT COUNT(*) FROM "Player")::int AS players,
            (SELECT COUNT(*) FROM "Player" WHERE "gamesPlayed" >= $1)::int AS "rankedPlayers",
            (SELECT COUNT(*) FROM "Event" e WHERE ${VISIBLE_EVENT_SQL})::int AS events,
            (SELECT COUNT(*) FROM "Match")::int AS matches,
            (SELECT COUNT(*) FROM "Deck")::int AS decks,
            (SELECT COUNT(*) FROM "Store")::int AS stores`,
    MIN_RANKED_GAMES,
  );
  return row;
}, ["global-stats"]);

const now = () => new Date();

// `now()` is evaluated inside the cached function, so it is NOT part of the
// cache key — the upcoming/past boundary just moves on each revalidation.
export const getUpcomingEvents = cachedQuery(
  async function getUpcomingEvents(limit = 12, region?: string) {
    return prisma.event.findMany({
      where: { startDatetime: { gte: now() }, ...eventRegion(region), ...visibleEvent },
      orderBy: { startDatetime: "asc" },
      take: limit,
      include: { store: true },
    });
  },
  ["upcoming-events"],
  TTL.short,
);

export const getRecentEvents = cachedQuery(
  async function getRecentEvents(limit = 12, region?: string) {
    return prisma.event.findMany({
      where: { startDatetime: { lt: now() }, ...eventRegion(region), ...visibleEvent },
      orderBy: { startDatetime: "desc" },
      take: limit,
      include: { store: true, _count: { select: { entries: true } } },
    });
  },
  ["recent-events"],
  TTL.short,
);

export const SEARCH_PAGE_SIZE = 25;

/**
 * Free-text search across players and stores (case-insensitive substring).
 * Returns ALL matches, paginated independently per section. `playerPage` and
 * `storePage` are 1-based; out-of-range pages clamp to the last page.
 */
/**
 * Cached despite the unbounded key space (one entry per search term). Every
 * uncached search is 6 queries — and `contains` + `mode: "insensitive"` compiles
 * to `ILIKE '%term%'`, which no btree index can serve, so each one is a seq scan
 * (measured: ~14ms over 33k players — fine on its own). The reason to cache is
 * COST, not speed: an uncached search wakes Neon, and a crawler walking
 * `/search?q=...` URLs would hold the database open indefinitely. See COST.md.
 */
export const searchAll = cachedQuery(async function searchAll(
  query: string,
  { playerPage = 1, storePage = 1, eventPage = 1, pageSize = SEARCH_PAGE_SIZE } = {},
) {
  const term = query.trim();
  if (!term) {
    return {
      term,
      players: [],
      stores: [],
      events: [],
      playersTotal: 0,
      storesTotal: 0,
      eventsTotal: 0,
      playerPage: 1,
      storePage: 1,
      eventPage: 1,
      playerPages: 0,
      storePages: 0,
      eventPages: 0,
      pageSize,
    };
  }

  const playerWhere = {
    OR: [
      { handle: { contains: term, mode: "insensitive" as const } },
      { displayName: { contains: term, mode: "insensitive" as const } },
      { firstName: { contains: term, mode: "insensitive" as const } },
      { lastName: { contains: term, mode: "insensitive" as const } },
    ],
  };
  const storeWhere = {
    OR: [
      { name: { contains: term, mode: "insensitive" as const } },
      { city: { contains: term, mode: "insensitive" as const } },
      { state: { contains: term, mode: "insensitive" as const } },
    ],
  };
  // Match events by their own name or by their host store's name/city.
  const eventWhere = {
    ...visibleEvent,
    OR: [
      { name: { contains: term, mode: "insensitive" as const } },
      { store: { name: { contains: term, mode: "insensitive" as const } } },
      { store: { city: { contains: term, mode: "insensitive" as const } } },
    ],
  };

  const [playersTotal, storesTotal, eventsTotal] = await Promise.all([
    prisma.player.count({ where: playerWhere }),
    prisma.store.count({ where: storeWhere }),
    prisma.event.count({ where: eventWhere }),
  ]);

  const playerPages = Math.max(1, Math.ceil(playersTotal / pageSize));
  const storePages = Math.max(1, Math.ceil(storesTotal / pageSize));
  const eventPages = Math.max(1, Math.ceil(eventsTotal / pageSize));
  const pPage = Math.min(Math.max(1, playerPage), playerPages);
  const sPage = Math.min(Math.max(1, storePage), storePages);
  const ePage = Math.min(Math.max(1, eventPage), eventPages);

  const [players, stores, events] = await Promise.all([
    playersTotal === 0
      ? []
      : prisma.player.findMany({
          where: playerWhere,
          orderBy: [{ rating: "desc" }, { gamesPlayed: "desc" }],
          skip: (pPage - 1) * pageSize,
          take: pageSize,
          include: { _count: { select: { entries: true } } },
        }),
    storesTotal === 0
      ? []
      : prisma.store.findMany({
          where: storeWhere,
          orderBy: { name: "asc" },
          skip: (sPage - 1) * pageSize,
          take: pageSize,
          include: { _count: { select: { events: true } } },
        }),
    eventsTotal === 0
      ? []
      : prisma.event.findMany({
          where: eventWhere,
          orderBy: { startDatetime: "desc" },
          skip: (ePage - 1) * pageSize,
          take: pageSize,
          include: {
            store: { select: { name: true, city: true, state: true } },
            _count: { select: { entries: true } },
          },
        }),
  ]);

  return {
    term,
    players,
    stores,
    events,
    playersTotal,
    storesTotal,
    eventsTotal,
    playerPage: pPage,
    storePage: sPage,
    eventPage: ePage,
    playerPages: playersTotal === 0 ? 0 : playerPages,
    storePages: storesTotal === 0 ? 0 : storePages,
    eventPages: eventsTotal === 0 ? 0 : eventPages,
    pageSize,
  };
}, ["search-all"], TTL.short);

export const getStores = cachedQuery(async function getStores() {
  return prisma.store.findMany({
    orderBy: { name: "asc" },
    // Count only what the store page will actually list, or a store advertises
    // "42 events" and then shows 6.
    include: { _count: { select: { events: { where: { ...visibleEvent } } } } },
  });
}, ["stores"]);

/**
 * The busiest stores, for the home page's short list. Sorts and limits IN the
 * DB — the home page used to call `getStores()` (every ~450 stores, each with a
 * correlated event-count subquery) and then slice 6 off the top in JS.
 */
export const getTopStores = cachedQuery(async function getTopStores(limit = 6) {
  return prisma.store.findMany({
    // Ordering by a *filtered* relation count isn't expressible in Prisma, so
    // rank by total events and report the visible count. Cancelled-empty events
    // are spread across stores, so the ranking is materially the same.
    orderBy: { events: { _count: "desc" } },
    take: limit,
    include: { _count: { select: { events: { where: { ...visibleEvent } } } } },
  });
}, ["top-stores"]);

export async function getStore(id: string) {
  return prisma.store.findUnique({
    where: { id },
    include: {
      events: {
        where: { ...visibleEvent },
        orderBy: { startDatetime: "desc" },
        include: { _count: { select: { entries: true } } },
      },
    },
  });
}

/**
 * Players ranked by event attendance (used when no Elo data exists yet).
 * Ordered and limited in the DB. This previously pulled 1000 full player rows
 * (each with a correlated entry-count subquery) and sorted them in JS, so it
 * both over-fetched and silently truncated: the "top 400 by attendance" were
 * only the top 400 of an arbitrary unordered 1000, not of the whole table.
 */
export const getPlayersByAttendance = cachedQuery(
  async function getPlayersByAttendance(limit = 300, region?: string) {
    return prisma.player.findMany({
      where: { ...playerRegion(region) },
      include: { _count: { select: { entries: true } } },
      orderBy: [{ entries: { _count: "desc" } }, { rating: "desc" }],
      take: limit,
    });
  },
  ["players-by-attendance"],
);

export const hasEloData = cachedQuery(
  async function hasEloData(): Promise<boolean> {
    return (await prisma.match.count()) > 0;
  },
  ["has-elo-data"],
  TTL.long,
);

/**
 * Per-region tallies for the home dashboard. ONE round trip covering every
 * region. This used to fan out to REGION_ORDER.length x 3 counts — with 12
 * regions that is 36 separate HTTPS queries to Neon (each Prisma call is its
 * own fetch, see prisma.ts) on every single home-page render, and they were
 * awaited sequentially inside the map to boot.
 */
export const getRegionSummary = cachedQuery(async function getRegionSummary() {
  const { REGION_ORDER } = await import("@/lib/regions");
  const regions = [...REGION_ORDER];
  // $1 is the ranked-games floor; the regions occupy $2..$N. The ::text cast is
  // required — Postgres can't infer a bare parameter's type inside VALUES.
  const values = regions.map((_, i) => `($${i + 2}::text)`).join(",");
  const rows = await prisma.$queryRawUnsafe<
    { region: string; stores: number; events: number; rankedPlayers: number }[]
  >(
    `SELECT r.region,
            (SELECT COUNT(*) FROM "Store" s WHERE s.region = r.region)::int AS stores,
            (SELECT COUNT(*) FROM "Event" e
               JOIN "Store" s ON s.id = e."storeId"
              WHERE s.region = r.region AND ${VISIBLE_EVENT_SQL})::int AS events,
            (SELECT COUNT(*) FROM "Player" p
              WHERE p.region = r.region AND p."gamesPlayed" >= $1)::int AS "rankedPlayers"
     FROM (VALUES ${values}) AS r(region)`,
    MIN_RANKED_GAMES,
    ...regions,
  );
  // Preserve REGION_ORDER regardless of what order the DB hands rows back.
  const byRegion = new Map(rows.map((r) => [r.region, r]));
  return REGION_ORDER.map(
    (region) =>
      byRegion.get(region) ?? { region, stores: 0, events: 0, rankedPlayers: 0 },
  );
}, ["region-summary"]);

export async function getPlayer(id: string) {
  return prisma.player.findUnique({ where: { id } });
}

export async function getPlayerRatingHistory(id: string) {
  const rows = await prisma.ratingChange.findMany({
    where: { playerId: id },
    select: {
      ratingBefore: true,
      ratingAfter: true,
      delta: true,
      match: {
        select: {
          id: true,
          roundNumber: true,
          playedAt: true,
          event: {
            select: {
              id: true,
              name: true,
              startDatetime: true,
              store: { select: { country: true } },
            },
          },
        },
      },
    },
  });
  // `createdAt` is written in bulk at recompute time and is NOT chronological,
  // so sort by the match's real play date (mirrors recompute's chronoKey order).
  const key = (r: (typeof rows)[number]) => {
    const t =
      r.match.playedAt?.getTime() ??
      r.match.event?.startDatetime?.getTime() ??
      Number.MAX_SAFE_INTEGER;
    return `${String(t).padStart(16, "0")}-${String(r.match.roundNumber ?? 0).padStart(4, "0")}-${r.match.id}`;
  };
  return rows.sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * Global rank among ranked players (>= MIN_RANKED_GAMES) by conservative rating.
 * Returns null below the games floor so the UI can show "Unranked".
 */
export async function getPlayerRank(player: {
  rating: number;
  gamesPlayed: number;
}): Promise<number | null> {
  if (player.gamesPlayed < MIN_RANKED_GAMES) return null;
  const higher = await prisma.player.count({
    where: { gamesPlayed: { gte: MIN_RANKED_GAMES }, rating: { gt: player.rating } },
  });
  return higher + 1;
}

export type PlayerLegendStat = {
  legend: string;
  domains: string | null;
  events: number; // times registered with this Legend
  bestStanding: number | null; // best (lowest) final placing
  wins: number;
  losses: number;
  draws: number;
  netDelta: number; // net Elo change across decklisted matches
};

/**
 * A player's Legend history: which Legends they've piloted, how often, and —
 * for events that published decklists — their actual match record and net Elo
 * swing with each. Event/best-finish counts come from registrations; the record
 * comes from matches whose deck id is known, so it covers only decklisted events
 * (`decklistedGames` < total games for most players). Returns [] if none.
 */
export async function getPlayerLegendStats(
  playerId: string,
  set?: SetCode,
): Promise<PlayerLegendStat[]> {
  const eventSel = {
    startDatetime: true,
    store: { select: { country: true } },
  } as const;
  const [entries, matches] = await Promise.all([
    prisma.eventEntry.findMany({
      where: { playerId, deckId: { not: null } },
      select: {
        deckId: true,
        finalStanding: true,
        deck: { select: { legend: true, name: true, domains: true } },
        event: { select: eventSel },
      },
    }),
    prisma.match.findMany({
      where: { OR: [{ playerOneId: playerId }, { playerTwoId: playerId }], isBye: false },
      select: {
        deckOneId: true,
        deckTwoId: true,
        playerOneId: true,
        playedAt: true,
        winnerId: true,
        changes: { where: { playerId }, select: { delta: true } },
        event: { select: eventSel },
      },
    }),
  ]);

  // Set-era bucketing (locale-aware) for an event-attached row.
  const setOf = (
    ev: { startDatetime: Date | null; store?: { country?: string | null } | null } | null,
    playedAt?: Date | null,
  ): SetCode | null =>
    setForDate(playedAt ?? ev?.startDatetime ?? null, calendarForCountry(ev?.store?.country));

  // deckId -> Legend + domains. Seed from registrations, then backfill any deck
  // id that only appears on a match (recorded mid-event without a registration).
  const deckInfo = new Map<string, { legend: string; domains: string | null }>();
  for (const e of entries) {
    if (e.deckId && e.deck) deckInfo.set(e.deckId, { legend: e.deck.legend ?? e.deck.name, domains: e.deck.domains });
  }
  const myDeckId = (m: (typeof matches)[number]) =>
    m.playerOneId === playerId ? m.deckOneId : m.deckTwoId;
  const missing = [
    ...new Set(matches.map(myDeckId).filter((d): d is string => !!d && !deckInfo.has(d))),
  ];
  if (missing.length) {
    const decks = await prisma.deck.findMany({
      where: { id: { in: missing } },
      select: { id: true, legend: true, name: true, domains: true },
    });
    for (const d of decks) deckInfo.set(d.id, { legend: d.legend ?? d.name, domains: d.domains });
  }

  const byLegend = new Map<string, PlayerLegendStat>();
  const get = (legend: string, domains: string | null) => {
    let a = byLegend.get(legend);
    if (!a) {
      a = { legend, domains, events: 0, bestStanding: null, wins: 0, losses: 0, draws: 0, netDelta: 0 };
      byLegend.set(legend, a);
    }
    if (a.domains == null && domains != null) a.domains = domains;
    return a;
  };

  for (const e of entries) {
    if (set && setOf(e.event) !== set) continue;
    const info = e.deckId ? deckInfo.get(e.deckId) : undefined;
    const legend = info?.legend ?? e.deck?.legend ?? e.deck?.name;
    if (!legend) continue;
    const a = get(legend, info?.domains ?? e.deck?.domains ?? null);
    a.events++;
    if (e.finalStanding != null) {
      a.bestStanding = a.bestStanding == null ? e.finalStanding : Math.min(a.bestStanding, e.finalStanding);
    }
  }

  for (const m of matches) {
    if (set && setOf(m.event, m.playedAt) !== set) continue;
    const did = myDeckId(m);
    const info = did ? deckInfo.get(did) : undefined;
    if (!info) continue; // unknown deck for this match — can't attribute
    const a = get(info.legend, info.domains);
    if (m.winnerId == null) a.draws++;
    else if (m.winnerId === playerId) a.wins++;
    else a.losses++;
    a.netDelta += m.changes[0]?.delta ?? 0;
  }

  return [...byLegend.values()].sort(
    (a, b) =>
      b.events - a.events ||
      b.wins + b.losses + b.draws - (a.wins + a.losses + a.draws) ||
      a.legend.localeCompare(b.legend),
  );
}

export async function getPlayerEvents(playerId: string) {
  return prisma.eventEntry.findMany({
    where: { playerId },
    include: { event: { include: { store: true } } },
    orderBy: { event: { startDatetime: "desc" } },
  });
}

/**
 * Notable competitive results shown as badges on a profile. Scope (constructed
 * 1v1 only, plus the one lucrative team event) and thresholds are the product
 * spec — see `classifyForAccomplishment` and the per-kind rules below.
 */
export type Accomplishment = {
  key: string;
  emoji: string;
  label: string; // compact badge text
  title: string; // full tooltip: event · date · placing
  tier: "gold" | "silver" | "bronze";
  eventId: string;
  date: Date | null;
  prestige: number; // sort key, higher = more impressive
};

type PremierKind =
  | "skirmish"
  | "pre-regional"
  | "regional-rebound"
  | "super-saturday"
  | "main"
  | "champions-2v2";

// Sealed/draft are limited formats and don't count toward accomplishments.
const LIMITED_FORMAT = /\bsealed\b|\bdraft\b/i;

/**
 * Map an event NAME to the accomplishment family it belongs to (or null if it's
 * not an accomplishment-eligible event). Order matters: the specific RQ-week
 * side events are matched before the generic "regional qualifier" main.
 */
function classifyForAccomplishment(name: string): PremierKind | null {
  const n = name.toLowerCase();
  if (n.includes("test event")) return null;
  if (LIMITED_FORMAT.test(n)) return null;
  // 2v2 Champions of the Rift is the only team event with prizing that counts.
  if (n.includes("champions of the rift")) return "champions-2v2";
  if (n.includes("2v2") || n.includes("team challenge")) return null;
  if (n.includes("skirmish")) return "skirmish";
  if (n.includes("pre-regional")) return "pre-regional";
  if (n.includes("regional rebound")) return "regional-rebound";
  if (n.includes("super saturday")) return "super-saturday";
  if (n.includes("super nexus night")) return null; // Friday side event, not a criterion
  if (n.includes("regional qualifier")) return "main";
  return null;
}

/** Tightest standard elimination cut a final standing made, or null if outside top 128. */
function cutBucket(standing: number): number | null {
  for (const c of [8, 16, 32, 64, 128]) if (standing <= c) return c;
  return null;
}
function cutTier(standing: number): "gold" | "silver" | "bronze" {
  return standing <= 8 ? "gold" : standing <= 32 ? "silver" : "bronze";
}

export async function getPlayerAccomplishments(
  playerId: string,
): Promise<Accomplishment[]> {
  const entries = await prisma.eventEntry.findMany({
    where: { playerId },
    select: {
      finalStanding: true,
      matchesWon: true,
      matchesLost: true,
      matchesDrawn: true,
      deck: { select: { legend: true } },
      event: {
        select: { id: true, name: true, startDatetime: true, numPlayers: true },
      },
    },
  });

  const out: Accomplishment[] = [];
  // Main-event entries that missed the top-128 cut but might place top-3 in
  // their Legend — resolved in one batched pass below (needs a per-event query).
  const legendChecks: { e: (typeof entries)[number]; legend: string }[] = [];

  const placing = (s: number, n: number) => `${ordinal(s)} of ${n}`;
  const title = (name: string, date: Date | null, extra: string) =>
    `${name} · ${fmtDate(date)} · ${extra}`;

  for (const e of entries) {
    const kind = classifyForAccomplishment(e.event.name);
    if (!kind) continue;
    const s = e.finalStanding;
    const n = e.event.numPlayers;
    const date = e.event.startDatetime;
    const evId = e.event.id;

    if (kind === "skirmish") {
      if (s === 1)
        out.push({
          key: `${evId}:sk`, emoji: "🥇", label: "1st", tier: "gold",
          title: title(e.event.name, date, "1st place"),
          eventId: evId, date, prestige: 300,
        });
    } else if (kind === "pre-regional" || kind === "regional-rebound") {
      if (e.matchesWon >= 4) {
        const tier = e.matchesWon >= 6 ? "gold" : e.matchesWon >= 5 ? "silver" : "bronze";
        const fam = kind === "pre-regional" ? "Pre-Regional" : "Regional Rebound";
        out.push({
          key: `${evId}:pp`, emoji: "⚔️", label: `${e.matchesWon} wins`, tier,
          title: title(e.event.name, date, `${fam} · ${e.matchesWon}-${e.matchesLost} record`),
          eventId: evId, date, prestige: 400 + e.matchesWon,
        });
      }
    } else if (kind === "super-saturday") {
      const cut = s != null ? cutBucket(s) : null;
      if (cut)
        out.push({
          key: `${evId}:ss`, emoji: "🎖️", label: `Top ${cut}`, tier: cutTier(s!),
          title: title(e.event.name, date, `Super Saturday · ${placing(s!, n)}`),
          eventId: evId, date, prestige: 500 + (200 - cut),
        });
    } else if (kind === "champions-2v2") {
      const cut = s != null ? cutBucket(s) : null;
      if (cut)
        out.push({
          key: `${evId}:c2`, emoji: "🏅", label: `Top ${cut}`, tier: cutTier(s!),
          title: title(e.event.name, date, `2v2 Champions of the Rift · ${placing(s!, n)}`),
          eventId: evId, date, prestige: 600 + (200 - cut),
        });
    } else if (kind === "main") {
      const cut = s != null ? cutBucket(s) : null;
      if (cut) {
        out.push({
          key: `${evId}:mn`, emoji: "🏆", label: `Top ${cut}`, tier: cutTier(s!),
          title: title(e.event.name, date, `Regional Qualifier · ${placing(s!, n)}`),
          eventId: evId, date, prestige: 800 + (200 - cut),
        });
      } else if (e.deck?.legend && s != null) {
        legendChecks.push({ e, legend: e.deck.legend });
      }
    }
  }

  // "Top 3 in your given Legend" at a main event (only for entries outside the
  // top-128 cut — a top-128 finish already earned a badge above).
  if (legendChecks.length) {
    const ranked = await Promise.all(
      legendChecks.map(async ({ e, legend }) => ({
        e,
        legend,
        better: await prisma.eventEntry.count({
          where: {
            eventId: e.event.id,
            deck: { legend },
            finalStanding: { not: null, lt: e.finalStanding! },
          },
        }),
      })),
    );
    for (const { e, legend, better } of ranked) {
      if (better >= 3) continue;
      const place = better + 1;
      out.push({
        key: `${e.event.id}:lg`, emoji: "🃏",
        label: `${ordinal(place)} · ${legend}`,
        tier: place === 1 ? "gold" : "silver",
        title: title(
          e.event.name, e.event.startDatetime,
          `Regional Qualifier · ${ordinal(place)} among ${legend} pilots · ${ordinal(e.finalStanding!)} overall`,
        ),
        eventId: e.event.id, date: e.event.startDatetime, prestige: 700 + (3 - better),
      });
    }
  }

  return out.sort(
    (a, b) => b.prestige - a.prestige || (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0),
  );
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

export const MATCH_PAGE_SIZE = 25;

/** Legend name out of a synthesized deck id ("legend:Norra" -> "Norra"). */
function legendOf(deckId: string | null): string | null {
  if (!deckId) return null;
  return deckId.startsWith("legend:") ? deckId.slice("legend:".length) : null;
}

/**
 * Full, paginated match history for a player — newest first. Each row carries
 * event + store location and the Legend each side piloted (when known) so the
 * UI can show event / location / decklist markers.
 */
export async function getPlayerMatchHistory(
  playerId: string,
  { page = 1, pageSize = MATCH_PAGE_SIZE } = {},
) {
  const where = {
    OR: [{ playerOneId: playerId }, { playerTwoId: playerId }],
    isBye: false,
  };
  const total = await prisma.match.count({ where });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  const matches = await prisma.match.findMany({
    where,
    orderBy: [{ playedAt: "desc" }, { id: "desc" }],
    skip: (p - 1) * pageSize,
    take: pageSize,
    include: {
      playerOne: { select: { id: true, displayName: true, handle: true } },
      playerTwo: { select: { id: true, displayName: true, handle: true } },
      event: {
        select: {
          id: true,
          name: true,
          startDatetime: true,
          store: { select: { name: true, city: true, state: true } },
        },
      },
      changes: { where: { playerId }, select: { delta: true } },
    },
  });
  const rows = matches.map((m) => {
    const isP1 = m.playerOneId === playerId;
    const opp = isP1 ? m.playerTwo : m.playerOne;
    const result =
      m.winnerId == null ? "draw" : m.winnerId === playerId ? "win" : "loss";
    return {
      id: m.id,
      event: m.event,
      roundNumber: m.roundNumber,
      opponent: opp,
      result: result as "win" | "loss" | "draw",
      score: isP1
        ? `${m.playerOneWins}-${m.playerTwoWins}`
        : `${m.playerTwoWins}-${m.playerOneWins}`,
      delta: m.changes[0]?.delta ?? 0,
      playedAt: m.playedAt,
      myLegend: legendOf(isP1 ? m.deckOneId : m.deckTwoId),
      oppLegend: legendOf(isP1 ? m.deckTwoId : m.deckOneId),
    };
  });
  return { matches: rows, total, page: p, pages, pageSize };
}

export const getEvents = cachedQuery(
  async function getEvents(limit = 100) {
    return prisma.event.findMany({
      where: { ...visibleEvent },
      orderBy: { startDatetime: "desc" },
      take: limit,
      include: { store: true, _count: { select: { matches: true, entries: true } } },
    });
  },
  ["events"],
  TTL.short,
);

/**
 * Full roster + pairings for the LIVE tournament companion page.
 *
 * Cached for only 30s (TTL.live): long enough that a venue full of players
 * refreshing between rounds costs ~one query instead of hundreds, short enough
 * that nobody perceives it — rounds run ~50 minutes.
 *
 * Keep the selection EXACTLY as narrow as `RawEntry` / `RawMatch` in
 * src/lib/tournament.ts require. It used to `include: { player: true, deck: true }`,
 * which pulled every Player column (createdAt, updatedAt, firstName, lastName,
 * country, region, peakRating, volatility, gamesPlayed, wins/losses/draws — none
 * of them read here) for every entrant, plus whole Match rows. On the largest
 * event in the database (RQ Utrecht: 1,953 entrants, 7,507 matches) that was a
 * 4.8 MB response taking 1.9s — pulled from Neon again on every refresh, by
 * every player in the venue, during exactly the hours the event is busiest.
 * Widening this back to `include` would quietly restore the worst egress
 * hotspot in the app.
 */
export const getEvent = cachedQuery(async function getEvent(id: string) {
  return prisma.event.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      status: true,
      startDatetime: true,
      numRounds: true,
      topCut: true,
      pointsPerWin: true,
      pointsPerDraw: true,
      pointsPerLoss: true,
      store: { select: { name: true } },
      entries: {
        orderBy: { finalStanding: "asc" },
        select: {
          player: {
            select: {
              id: true,
              displayName: true,
              handle: true,
              rating: true,
              ratingDeviation: true,
            },
          },
          deck: { select: { legend: true, name: true, domains: true } },
        },
      },
      matches: {
        orderBy: [{ roundNumber: "asc" }, { id: "asc" }],
        select: {
          roundNumber: true,
          playerOneId: true,
          playerTwoId: true,
          playerOneWins: true,
          playerTwoWins: true,
          draws: true,
          winnerId: true,
          isBye: true,
          deckOneId: true,
          deckTwoId: true,
          playerOne: { select: { id: true, displayName: true, handle: true } },
          playerTwo: { select: { id: true, displayName: true, handle: true } },
        },
      },
    },
  });
}, ["event-live"], TTL.live);

/** Lightweight event header: metadata + store + counts (no row payloads). */
export const getEventSummary = cachedQuery(async function getEventSummary(id: string) {
  const [event, standingsCount] = await Promise.all([
    prisma.event.findUnique({
      where: { id },
      include: { store: true, _count: { select: { entries: true, matches: true } } },
    }),
    prisma.eventEntry.count({ where: { eventId: id, finalStanding: { not: null } } }),
  ]);
  if (!event) return null;
  return { ...event, hasStandings: standingsCount > 0 };
}, ["event-summary"], TTL.event);

export const EVENT_STANDINGS_PAGE = 100;
export const EVENT_ROUNDS_PAGE = 150;

/** Paginated standings/roster for an event (heavy on 1000+ player events).
 *  `legend` filters to entries whose deck piloted that Legend. */
export const getEventStandings = cachedQuery(async function getEventStandings(
  id: string,
  { page = 1, pageSize = EVENT_STANDINGS_PAGE, legend }: { page?: number; pageSize?: number; legend?: string } = {},
) {
  const where = {
    eventId: id,
    ...(legend
      ? { deck: { OR: [{ legend }, { legend: null, name: legend }] } }
      : {}),
  };
  const total = await prisma.eventEntry.count({ where });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  const entries = await prisma.eventEntry.findMany({
    where,
    orderBy: [{ finalStanding: "asc" }],
    skip: (p - 1) * pageSize,
    take: pageSize,
    include: {
      player: { select: { id: true, displayName: true, handle: true } },
      deck: { select: { legend: true, name: true, domains: true } },
    },
  });
  return { entries, total, page: p, pages, pageSize, offset: (p - 1) * pageSize };
}, ["event-standings"], TTL.event);

/** Paginated pairings for an event; Legend per side derived from deck ids. */
export const getEventRounds = cachedQuery(async function getEventRounds(
  id: string,
  { page = 1, pageSize = EVENT_ROUNDS_PAGE } = {},
) {
  const where = { eventId: id };
  const total = await prisma.match.count({ where });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  const matches = await prisma.match.findMany({
    where,
    orderBy: [{ roundNumber: "asc" }, { id: "asc" }],
    skip: (p - 1) * pageSize,
    take: pageSize,
    include: {
      playerOne: { select: { id: true, displayName: true, handle: true } },
      playerTwo: { select: { id: true, displayName: true, handle: true } },
    },
  });
  const rows = matches.map((m) => ({
    ...m,
    oneLegend: legendOf(m.deckOneId),
    twoLegend: legendOf(m.deckTwoId),
  }));
  return { matches: rows, total, page: p, pages, pageSize };
}, ["event-rounds"], TTL.event);

export type EventDeckStat = {
  legend: string;
  domains: string | null;
  players: number; // entries that ran this Legend
  wins: number;
  losses: number;
  draws: number;
  bestStanding: number | null; // best (lowest) final placing among its pilots
};

/**
 * Per-event deck breakdown: for events that published decklists, every match
 * carries both players' deck ids, so we can compute each Legend's real match
 * record at THIS event (not just who registered it). Returns [] when the event
 * has no deck data.
 */
export const getEventMetagame = cachedQuery(async function getEventMetagame(
  eventId: string,
): Promise<{ stats: EventDeckStat[]; totalPlayers: number }> {
  // Aggregate in SQL (scoped to this event) so a big RQ doesn't stream ~7k
  // match rows into memory. Legend + domains come from the deck; play counts +
  // best finish from entries; win/loss/draw from per-match deck ids.
  const leg = "COALESCE(d.legend, d.name)";
  const matchSql = `
    WITH sides AS (
      SELECT ${leg} AS legend, d.domains AS domains,
        CASE WHEN m."winnerId" IS NULL THEN 0 WHEN m."winnerId" = m."playerOneId" THEN 1 ELSE -1 END AS r
      FROM "Match" m JOIN "Deck" d ON d.id = m."deckOneId"
      WHERE m."eventId" = $1 AND m."isBye" = false AND m."deckOneId" IS NOT NULL
      UNION ALL
      SELECT ${leg}, d.domains,
        CASE WHEN m."winnerId" IS NULL THEN 0 WHEN m."winnerId" = m."playerTwoId" THEN 1 ELSE -1 END
      FROM "Match" m JOIN "Deck" d ON d.id = m."deckTwoId"
      WHERE m."eventId" = $1 AND m."isBye" = false AND m."deckTwoId" IS NOT NULL
    )
    SELECT legend, MAX(domains) AS domains,
      SUM(CASE WHEN r = 1 THEN 1 ELSE 0 END)::int AS wins,
      SUM(CASE WHEN r = -1 THEN 1 ELSE 0 END)::int AS losses,
      SUM(CASE WHEN r = 0 THEN 1 ELSE 0 END)::int AS draws
    FROM sides WHERE legend IS NOT NULL GROUP BY legend`;
  const entrySql = `
    SELECT ${leg} AS legend, MAX(d.domains) AS domains,
      COUNT(*)::int AS players, MIN(ee."finalStanding")::int AS "bestStanding"
    FROM "EventEntry" ee JOIN "Deck" d ON d.id = ee."deckId"
    WHERE ee."eventId" = $1 AND ee."deckId" IS NOT NULL
    GROUP BY ${leg}`;
  const [matchRows, entryRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ legend: string; domains: string | null; wins: number; losses: number; draws: number }[]>(matchSql, eventId),
    prisma.$queryRawUnsafe<{ legend: string; domains: string | null; players: number; bestStanding: number | null }[]>(entrySql, eventId),
  ]);

  const byLegend = new Map<string, EventDeckStat>();
  const get = (legend: string, domains: string | null) => {
    let a = byLegend.get(legend);
    if (!a) {
      a = { legend, domains, players: 0, wins: 0, losses: 0, draws: 0, bestStanding: null };
      byLegend.set(legend, a);
    }
    if (a.domains == null && domains != null) a.domains = domains;
    return a;
  };
  for (const e of entryRows) {
    const a = get(e.legend, e.domains);
    a.players = e.players;
    a.bestStanding = e.bestStanding;
  }
  for (const m of matchRows) {
    const a = get(m.legend, m.domains);
    a.wins = m.wins;
    a.losses = m.losses;
    a.draws = m.draws;
  }

  const wr = (a: EventDeckStat) => {
    const g = a.wins + a.losses + a.draws;
    return g ? (a.wins + 0.5 * a.draws) / g : 0;
  };
  const stats = [...byLegend.values()].sort(
    (a, b) => b.players - a.players || wr(b) - wr(a) || a.legend.localeCompare(b.legend),
  );
  const totalPlayers = stats.reduce((s, a) => s + a.players, 0);
  return { stats, totalPlayers };
}, ["event-metagame"], TTL.event);

/**
 * Metagame: aggregate by Legend across event entries, with win rates. When
 * `set` is given, restricts to matches/entries whose event was played during
 * that set release (locale-aware: China events use the China calendar). Each
 * match is bucketed by its own play date, falling back to the event date.
 */
/**
 * SQL expression that classifies a date column into a SetCode, locale-aware
 * (CN uses the China calendar). Built from SET_DEFS so it stays in sync. Dates
 * before the first release fold into the earliest set (the JS "floor bucket").
 */
function setCaseSql(dateExpr: string, countryExpr: string): string {
  const branch = (cal: ReleaseCalendar) => {
    // Newest-first so the first satisfied threshold wins.
    const whens = [...SET_ORDER]
      .slice(1) // drop the earliest — it's the ELSE/floor
      .reverse()
      .map((c) => `WHEN ${dateExpr} >= '${SET_DEFS[c].release[cal]}' THEN '${c}'`)
      .join(" ");
    return `CASE ${whens} ELSE '${SET_ORDER[0]}' END`;
  };
  return `CASE WHEN UPPER(COALESCE(${countryExpr},'')) = 'CN' THEN ${branch("china")} ELSE ${branch("global")} END`;
}

/**
 * Metagame win/play rates aggregated by Legend. Done entirely in SQL (GROUP BY)
 * — returns ~one row per Legend instead of streaming every match into memory.
 * Optional `set` restricts to games played while that set was live.
 */
// The single most expensive query in the app: it aggregates BOTH sides of every
// non-bye match in the database, joined to Deck/Event/Store. Cached longest.
export const getMetagame = cachedQuery(async function getMetagame(set?: SetCode) {
  const legend = "COALESCE(d.legend, d.name)";
  // Per-side result rows (one match contributes two sides). Legend from the
  // side's deck; win/loss/draw from the winner. Set classification from the
  // match's play date (fallback event date) and the store's locale.
  const matchDate = `COALESCE(m."playedAt", e."startDatetime")`;
  const side = (deckCol: string, playerCol: string) => `
    SELECT ${legend} AS legend,
      CASE WHEN m."winnerId" IS NULL THEN 0 WHEN m."winnerId" = m."${playerCol}" THEN 1 ELSE -1 END AS r
      ${set ? `, ${setCaseSql(matchDate, "s.country")} AS setcode, (${matchDate} IS NOT NULL) AS dated` : ""}
    FROM "Match" m
    JOIN "Deck" d ON d.id = m."${deckCol}"
    JOIN "Event" e ON e.id = m."eventId"
    LEFT JOIN "Store" s ON s.id = e."storeId"
    WHERE m."isBye" = false AND m."${deckCol}" IS NOT NULL`;

  const matchFilter = set ? `WHERE setcode = $1 AND dated` : "";
  const matchSql = `
    WITH sides AS (
      ${side("deckOneId", "playerOneId")}
      UNION ALL
      ${side("deckTwoId", "playerTwoId")}
    )
    SELECT legend,
      SUM(CASE WHEN r = 1 THEN 1 ELSE 0 END)::int AS wins,
      SUM(CASE WHEN r = -1 THEN 1 ELSE 0 END)::int AS losses,
      SUM(CASE WHEN r = 0 THEN 1 ELSE 0 END)::int AS draws
    FROM sides
    WHERE legend IS NOT NULL ${set ? "AND setcode = $1 AND dated" : ""}
    GROUP BY legend`;

  const entrySql = `
    SELECT ${legend} AS legend, COUNT(*)::int AS entries
    FROM "EventEntry" ee
    JOIN "Deck" d ON d.id = ee."deckId"
    JOIN "Event" e ON e.id = ee."eventId"
    LEFT JOIN "Store" s ON s.id = e."storeId"
    WHERE ee."deckId" IS NOT NULL
      ${set ? `AND e."startDatetime" IS NOT NULL AND ${setCaseSql('e."startDatetime"', "s.country")} = $1` : ""}
    GROUP BY ${legend}`;

  const args = set ? [set] : [];
  const [rows, entryRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ legend: string; wins: number; losses: number; draws: number }[]>(matchSql, ...args),
    prisma.$queryRawUnsafe<{ legend: string; entries: number }[]>(entrySql, ...args),
  ]);

  type Agg = { legend: string; entries: number; wins: number; losses: number; draws: number };
  const byLegend = new Map<string, Agg>();
  for (const r of rows) {
    byLegend.set(r.legend, { legend: r.legend, wins: r.wins, losses: r.losses, draws: r.draws, entries: 0 });
  }
  for (const e of entryRows) {
    const a = byLegend.get(e.legend);
    if (a) a.entries = e.entries;
  }

  return [...byLegend.values()]
    .filter((a) => a.wins + a.losses + a.draws > 0)
    .sort((a, b) => b.wins + b.draws + b.losses - (a.wins + a.draws + a.losses));
}, ["metagame"], TTL.long);
