import type { Prisma } from "@prisma/client";
import type { RbPlayer, RbSearchResult, RbStanding, RbTournament } from "./playriftbound";
import { officialEventUrl, playRiftboundId } from "./event-source";
import { regionForStore } from "./regions";
import { isPreRiftEvent } from "./prerift";
import { canonicalPlayerId } from "./player-identity";

export function isTrackedState(state?: string | null): boolean {
  return ["mi", "michigan", "ca", "california"].includes(state?.trim().toLowerCase() ?? "");
}

export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const h = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2
    + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cover the tracked stores with overlapping 100km searches. Clustering at 70km
 * leaves room to discover replacement/new stores near the existing locations.
 */
export function searchCenters(stores: { latitude: number | null; longitude: number | null; state: string | null }[]) {
  const centers: { latitude: number; longitude: number }[] = [];
  for (const store of stores) {
    if (!isTrackedState(store.state) || store.latitude == null || store.longitude == null) continue;
    const point = { latitude: store.latitude, longitude: store.longitude };
    if (!centers.some(c => distanceKm(c, point) <= 70)) centers.push(point);
  }
  return centers;
}

function date(value: string | null | undefined): Date | null {
  if (!value) return null;
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(`Invalid source date: ${value}`);
  return result;
}
function percent(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
const label = (value?: string) => value ? value.toLowerCase().replaceAll("_", " ") : null;

export function normalizePlayRiftbound(result: RbSearchResult, detail: RbTournament, now = new Date()) {
  if (result.tournament.id !== detail.id || result.organizer.id !== detail.organizerId) {
    throw new Error("PlayRiftbound event/organizer mismatch");
  }
  const id = playRiftboundId(detail.id);
  const location = detail.tournamentLocation;
  if (!isTrackedState(location?.adminArea1) || (location?.countryCode && location.countryCode !== "US")) {
    throw new Error(`PlayRiftbound event ${detail.id} is outside the tracked states`);
  }
  const region = regionForStore(location?.city, location?.latitude, location?.longitude);
  const store: Prisma.StoreCreateManyInput = {
    id: playRiftboundId(result.organizer.id), name: result.organizer.name,
    country: location?.countryCode ?? "US", state: location?.adminArea1 ?? null,
    city: location?.city ?? null, address: location?.formattedAddress ?? null,
    latitude: location?.latitude ?? null, longitude: location?.longitude ?? null, region,
  };
  const stages = detail.stages ?? [];
  const completed = stages.length > 0 && stages.every(s => s.status === "COMPLETED");
  const startsAt = date(detail.startsAt);
  const endsAt = date(detail.endsAt);
  const status = completed || (endsAt && endsAt <= now) ? "completed"
    : startsAt && startsAt > now ? "upcoming" : "inprogress";
  const event: Prisma.EventCreateManyInput = {
    // The existing rating exclusion intentionally keys off the event name.
    // Carry the explicit source category into names that omit "Pre-Rift".
    id, name: /PRE_?RIFT/.test(detail.config.tournamentType) && !isPreRiftEvent(detail.name)
      ? `${detail.name} (Pre-Rift)` : detail.name, storeId: store.id,
    format: label(detail.config.format), gameplayFormat: label(detail.config.tournamentType),
    gameType: label(detail.config.structure), eventType: label(detail.config.tournamentType),
    startDatetime: startsAt, endDatetime: endsAt, status,
    numPlayers: Math.max(detail.tournamentParticipants?.length ?? 0,
      detail.registrantCounts.filter(c => c.status === "REGISTERED").reduce((n, c) => n + c.count, 0)),
    capacity: detail.config.participantCapacity, description: detail.description ?? null,
    costCents: detail.pricing === "FREE" ? 0 : detail.entryFee?.minorUnits ?? null,
    currency: detail.entryFee?.currency ?? null, url: officialEventUrl(id),
    numRounds: detail.config.roundCount ?? null, topCut: detail.config.finalBracketStage?.participantCount ?? null,
    sourceUpdatedAt: date(detail.updatedAt), resultsComplete: completed,
  };
  const players = new Map<string, Prisma.PlayerCreateManyInput>();
  const entries = new Map<string, Prisma.EventEntryCreateManyInput>();
  const teams = new Map<string, RbPlayer[]>();
  const addPlayer = (player: RbPlayer) => {
    const pid = canonicalPlayerId(playRiftboundId(player.id));
    players.set(pid, { id: pid, displayName: player.displayName,
      handle: player.tagLine ? `${player.displayName}#${player.tagLine}` : player.displayName,
      country: "US", region });
    if (!entries.has(pid)) entries.set(pid, {
      id: `${id}:${player.id}`, eventId: id, playerId: pid,
      finalStanding: null, matchPoints: null, matchesWon: 0, matchesLost: 0, matchesDrawn: 0,
      omwPct: null, gwPct: null, ogwPct: null,
    });
    return pid;
  };
  for (const reg of detail.tournamentRegistrants ?? []) {
    if (reg.status === "REGISTERED" && reg.player) addPlayer(reg.player);
  }
  for (const participant of detail.tournamentParticipants ?? []) {
    if (!participant.player) continue;
    addPlayer(participant.player);
    const roster = teams.get(participant.esportsTeamId) ?? [];
    if (!roster.some(p => p.id === participant.player!.id)) roster.push(participant.player);
    teams.set(participant.esportsTeamId, roster);
  }
  for (const stage of stages) for (const section of stage.sections) for (const round of section.rounds) {
    for (const match of round.matches) for (const team of match.teams) {
      teams.set(team.esportsTeamId, team.players);
      team.players.forEach(addPlayer);
    }
  }

  const matches: Prisma.MatchCreateManyInput[] = [];
  let roundOffset = 0;
  for (const stage of stages) {
    let stageRounds = 0;
    for (const section of stage.sections) {
      const rounds = [...section.rounds].sort((a, b) => a.roundNumber - b.roundNumber);
      let lastStandings: RbStanding[] = [];
      for (const round of rounds) {
        stageRounds = Math.max(stageRounds, round.roundNumber);
        const roundNumber = roundOffset + round.roundNumber;
        const playedAt = date(round.startedAt) ?? startsAt;
        if (round.endOfRoundStandings?.length) lastStandings = round.endOfRoundStandings;
        for (const match of round.matches) {
          // A finalized round can contain matches still marked IN_PROGRESS by
          // the source. Require actual reciprocal outcomes, never rate pairings.
          if (round.status !== "FINALIZED" && !["COMPLETED", "FINALIZED"].includes(match.status)) continue;
          if (match.teams.length !== 2 || match.teams.some(t => t.players.length !== 1)) continue;
          const [one, two] = match.teams;
          const o1 = match.teamOutcomes?.find(o => o.esportsTeamId === one.esportsTeamId)?.outcome;
          const o2 = match.teamOutcomes?.find(o => o.esportsTeamId === two.esportsTeamId)?.outcome;
          if (!((o1 === "WIN" && o2 === "LOSS") || (o1 === "LOSS" && o2 === "WIN") || (o1 === "TIE" && o2 === "TIE"))) continue;
          const playerOneId = addPlayer(one.players[0]);
          const playerTwoId = addPlayer(two.players[0]);
          if (playerOneId === playerTwoId) throw new Error("PlayRiftbound paired a player against themself");
          matches.push({
            id: playRiftboundId(match.esportsMatchId), eventId: id, roundNumber, playedAt,
            playerOneId, playerTwoId, winnerId: o1 === "WIN" ? playerOneId : o2 === "WIN" ? playerTwoId : null,
            playerOneWins: match.games.filter(g => g.teamOutcomes?.some(o => o.esportsTeamId === one.esportsTeamId && o.outcome === "WIN")).length,
            playerTwoWins: match.games.filter(g => g.teamOutcomes?.some(o => o.esportsTeamId === two.esportsTeamId && o.outcome === "WIN")).length,
            draws: match.games.filter(g => g.teamOutcomes?.length === 2 && g.teamOutcomes.every(o => o.outcome === "TIE")).length,
            isBye: false,
          });
        }
        if (round.status === "FINALIZED") for (const teamId of round.byeTeamIds ?? []) {
          const team = teams.get(teamId);
          if (team?.length !== 1) continue;
          const pid = addPlayer(team[0]);
          matches.push({ id: `${id}:bye:${section.esportsSectionId}:${round.roundNumber}:${teamId}`,
            eventId: id, roundNumber, playedAt, playerOneId: pid, playerTwoId: pid,
            winnerId: pid, playerOneWins: 0, playerTwoWins: 0, draws: 0, isBye: true });
        }
      }
      for (const standing of lastStandings) for (const player of teams.get(standing.esportsTeamId) ?? []) {
        const pid = addPlayer(player);
        Object.assign(entries.get(pid)!, {
          finalStanding: standing.rank, matchPoints: standing.matchPoints,
          matchesWon: standing.matchWins, matchesLost: standing.matchLosses, matchesDrawn: standing.matchDraws,
          omwPct: percent(standing.opponentMatchWinPercentage), gwPct: percent(standing.gameWinPercentage),
          ogwPct: percent(standing.opponentGameWinPercentage),
        });
      }
    }
    roundOffset += stageRounds;
  }
  return { store, event, players: [...players.values()], entries: [...entries.values()], matches };
}
