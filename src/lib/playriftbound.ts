/** Anonymous, read-only operations used by PlayRiftbound's public event finder.
 * Operation IDs come from its Apollo persisted-query manifest (2026-11-07).
 * Fail closed on API/schema errors; never interpret an error as an empty roster.
 */
const OPERATIONS = {
  CompeteTournamentSearch: "868030f676276bec926c740aada7129713d4097f6e2dd7c3a0451c4fb43852eb",
  GetCompeteTournamentForRiftboundPlayer: "069d7e35d370b9005d014af7d31f8e3fb58eaf95efcf70829d345011dd4d01ec",
} as const;

export interface RbLocation {
  city?: string | null;
  adminArea1?: string | null;
  countryCode?: string | null;
  formattedAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}
export interface RbPlayer { id: string; displayName: string; tagLine?: string | null }
export interface RbTeam { esportsTeamId: string; players: RbPlayer[] }
export interface RbOutcome { esportsTeamId: string; outcome: string }
export interface RbMatch {
  esportsMatchId: string;
  status: string;
  teams: RbTeam[];
  teamOutcomes: RbOutcome[] | null;
  games: { number: number; teamOutcomes: RbOutcome[] | null }[];
}
export interface RbStanding {
  esportsTeamId: string;
  rank: number;
  matchPoints: number;
  matchWins: number;
  matchLosses: number;
  matchDraws: number;
  opponentMatchWinPercentage: string | null;
  gameWinPercentage: string | null;
  opponentGameWinPercentage: string | null;
}
export interface RbRound {
  roundNumber: number;
  status: string;
  startedAt: string | null;
  byeTeamIds: string[];
  matches: RbMatch[];
  endOfRoundStandings: RbStanding[] | null;
}
export interface RbTournament {
  id: string;
  name: string;
  organizerId?: string;
  startsAt: string;
  endsAt?: string | null;
  updatedAt?: string;
  description?: string | null;
  pricing: string;
  entryFee: { currency: string; minorUnits: number } | null;
  tournamentLocation: RbLocation | null;
  registrantCounts: { status: string; count: number }[];
  config: {
    format: string;
    playerFormat: string;
    tournamentType: string;
    participantCapacity: number;
    structure?: string;
    roundCount?: number;
    finalBracketStage?: { participantCount: number } | null;
  };
  stages?: {
    status: string;
    sections: { esportsSectionId: string; rounds: RbRound[] }[];
  }[];
  tournamentParticipants?: { player: RbPlayer | null; esportsTeamId: string; status: string }[];
  tournamentRegistrants?: { player: RbPlayer | null; status: string }[];
}
export interface RbSearchResult {
  organizer: { id: string; name: string };
  tournament: RbTournament;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let nextRequestAt = 0;
async function request<T>(operation: keyof typeof OPERATIONS, variables: Record<string, unknown>): Promise<T> {
  const slot = Math.max(nextRequestAt, Date.now());
  nextRequestAt = slot + 250; // At most four request starts per second.
  await sleep(Math.max(0, slot - Date.now()));
  for (let attempt = 0; ; attempt++) {
    const response = await fetch("https://events.playriftbound.com/api/gql", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json",
        "apollographql-client-name": "Esports Web",
        "apollographql-client-version": "1",
      },
      body: JSON.stringify({
        operationName: operation,
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: OPERATIONS[operation] } },
      }),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retry = response.headers.get("retry-after");
      const wait = retry ? (Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 1000 * 2 ** attempt;
      await response.text();
      await sleep(Number.isFinite(wait) ? Math.max(0, wait) : 1000 * 2 ** attempt);
      continue;
    }
    const payload = await response.json() as { data?: T; errors?: { message: string }[] };
    if (!response.ok || payload.errors?.length || !payload.data) {
      throw new Error(`PlayRiftbound ${operation} (${response.status}): ${payload.errors?.map(e => e.message).join("; ") ?? "missing data"}`);
    }
    return payload.data;
  }
}

/** The API clamps radius to 100 km and has no endDate filter. Use DATE order,
 * stop at the explicit upper bound, and reject broken/cyclic pagination.
 */
export async function searchPlayRiftbound(
  latitude: number, longitude: number, since: Date, until: Date,
): Promise<RbSearchResult[]> {
  const found: RbSearchResult[] = [];
  let after: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const data = await request<{
      competeTournamentSearch: {
        edges: { node: RbSearchResult }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>("CompeteTournamentSearch", {
      sport: "rb", first: 100, after, sortBy: { rb: "DATE" },
      filter: { rb: { coords: { latitude, longitude }, distanceMeters: 100_000, startDate: since.toISOString() } },
    });
    const result = data.competeTournamentSearch;
    if (!Array.isArray(result?.edges) || !result.pageInfo) throw new Error("Invalid PlayRiftbound search response");
    for (const { node } of result.edges) {
      const start = Date.parse(node.tournament.startsAt);
      if (!Number.isFinite(start)) throw new Error("Invalid PlayRiftbound event date");
      if (start >= until.getTime()) return found;
      if (start >= since.getTime()) found.push(node);
    }
    if (!result.pageInfo.hasNextPage) return found;
    const cursor = result.pageInfo.endCursor;
    if (!result.edges.length || !cursor || cursors.has(cursor)) throw new Error("PlayRiftbound pagination did not advance");
    cursors.add(cursor);
    after = cursor;
  }
  throw new Error("PlayRiftbound search exceeded the scoped page limit");
}

export async function getPlayRiftboundEvent(id: string): Promise<RbTournament> {
  const data = await request<{ competeTournaments: RbTournament[] }>("GetCompeteTournamentForRiftboundPlayer", {
    tournamentId: id, includeAdminFields: false,
  });
  const event = data.competeTournaments?.find(e => e.id === id);
  if (!event || !Array.isArray(event.stages) || !Array.isArray(event.tournamentParticipants) || !Array.isArray(event.tournamentRegistrants)) {
    throw new Error(`Incomplete PlayRiftbound event ${id}; keeping existing data`);
  }
  return event;
}
