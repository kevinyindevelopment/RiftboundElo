import assert from "node:assert/strict";
import { test } from "node:test";
import { eventSource, officialEventUrl, playRiftboundId } from "./event-source";
import { canonicalPlayerId } from "./player-identity";
import { normalizePlayRiftbound, searchCenters } from "./playriftbound-normalize";
import { getPlayRiftboundEvent, searchPlayRiftbound, PlayRiftboundEventUnavailableError, type RbSearchResult, type RbTournament } from "./playriftbound";

function fixture() {
  const one = { id: "riot-a", displayName: "Alpha", tagLine: "NA1" };
  const two = { id: "riot-b", displayName: "Beta", tagLine: "NA1" };
  const tournament: RbTournament = {
    id: "117367854865012251", name: "Nexus Night", organizerId: "organizer-a",
    startsAt: "2026-11-01T19:00:00Z", endsAt: "2026-11-02T19:00:00Z", updatedAt: "2026-11-01T22:00:00Z",
    pricing: "FREE", entryFee: null,
    tournamentLocation: { city: "Midland", adminArea1: "MI", countryCode: "US", latitude: 43.6, longitude: -84.2 },
    config: { format: "CONSTRUCTED", playerFormat: "ONE_V_ONE", tournamentType: "NEXUS_NIGHT", participantCapacity: 16 },
    registrantCounts: [{ status: "REGISTERED", count: 2 }, { status: "WAITLISTED", count: 10 }],
    tournamentRegistrants: [{ player: one, status: "REGISTERED" }, { player: two, status: "WITHDRAWN" }],
    tournamentParticipants: [
      { player: one, esportsTeamId: "team-a", status: "ACTIVE" },
      { player: two, esportsTeamId: "team-b", status: "ACTIVE" },
    ],
    stages: [{ status: "COMPLETED", sections: [{ esportsSectionId: "section", rounds: [{
      roundNumber: 1, status: "FINALIZED", startedAt: null, byeTeamIds: [],
      endOfRoundStandings: [{ esportsTeamId: "team-a", rank: 1, matchPoints: 3, matchWins: 1, matchLosses: 0, matchDraws: 0,
        opponentMatchWinPercentage: "0.33", gameWinPercentage: "1", opponentGameWinPercentage: "0.33" }],
      matches: [{ esportsMatchId: "117368211352857437", status: "IN_PROGRESS",
        teams: [{ esportsTeamId: "team-a", players: [one] }, { esportsTeamId: "team-b", players: [two] }],
        teamOutcomes: [{ esportsTeamId: "team-a", outcome: "WIN" }, { esportsTeamId: "team-b", outcome: "LOSS" }],
        games: [{ number: 1, teamOutcomes: [{ esportsTeamId: "team-a", outcome: "WIN" }, { esportsTeamId: "team-b", outcome: "LOSS" }] }],
      }],
    }] }] }],
  };
  const listing: RbSearchResult = { organizer: { id: "organizer-a", name: "Test store" }, tournament };
  return { tournament, listing, round: tournament.stages![0].sections[0].rounds[0] };
}

test("source IDs preserve large integers and never collide with UVS", () => {
  assert.equal(playRiftboundId("117367854865012251"), "playriftbound:117367854865012251");
  assert.equal(eventSource("123"), "UVS (legacy)");
  assert.equal(eventSource(playRiftboundId("123")), "PlayRiftbound");
  assert.match(officialEventUrl(playRiftboundId("117367854865012251")), /\/117367854865012251$/);
  assert.throws(() => playRiftboundId(117367854865012251 as unknown as string));
});

test("verified identities retain the legacy profile across imports", () => {
  const { listing, tournament, round } = fixture();
  const player = round.matches[0].teams[0].players[0];
  player.id = "01a0a1d7-e1d7-771a-85b5-d96837e2d893";
  const result = normalizePlayRiftbound(listing, tournament);
  assert.equal(result.players[0].id, "411127");
  assert.equal(result.entries[0].playerId, "411127");
  assert.equal(result.matches[0].playerOneId, "411127");
  assert.equal(result.matches[0].winnerId, "411127");
  assert.equal(canonicalPlayerId(playRiftboundId(player.id)), "411127");
  assert.equal(canonicalPlayerId("playriftbound:unverified"), "playriftbound:unverified");
});

test("published finalized rounds import even when upstream match status lags", () => {
  const { listing, tournament } = fixture();
  const result = normalizePlayRiftbound(listing, tournament, new Date("2026-11-07"));
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].winnerId, "playriftbound:riot-a");
  assert.equal(result.matches[0].playerOneWins, 1);
  assert.equal(result.entries[0].omwPct, 0.33);
  assert.equal(result.event.numPlayers, 2);
  assert.equal(result.store.region, "tri-cities");
});

test("finalized rounds can omit byes", () => {
  const { listing, tournament, round } = fixture();
  round.byeTeamIds = null;
  assert.equal(normalizePlayRiftbound(listing, tournament).matches.length, 1);
});

test("unfinished or missing outcomes are never rated as draws", () => {
  const { listing, tournament, round } = fixture();
  round.status = "IN_PROGRESS";
  assert.equal(normalizePlayRiftbound(listing, tournament).matches.length, 0);
  round.status = "FINALIZED";
  round.matches[0].teamOutcomes = [];
  assert.equal(normalizePlayRiftbound(listing, tournament).matches.length, 0);
});

test("ties, byes, and multi-player teams are handled explicitly", () => {
  const { listing, tournament, round } = fixture();
  round.matches[0].teamOutcomes!.forEach(o => { o.outcome = "TIE"; });
  round.matches[0].games[0].teamOutcomes!.forEach(o => { o.outcome = "TIE"; });
  round.byeTeamIds = ["team-a"];
  const result = normalizePlayRiftbound(listing, tournament);
  assert.equal(result.matches[0].winnerId, null);
  assert.equal(result.matches[0].draws, 1);
  assert.equal(result.matches[1].isBye, true);
  round.matches[0].teams[0].players.push({ id: "teammate", displayName: "Teammate" });
  assert.equal(normalizePlayRiftbound(listing, tournament).matches.length, 0);
});

test("unplayed games in a completed best-of match may have null outcomes", () => {
  const { listing, tournament, round } = fixture();
  round.matches[0].games.push({ number: 2, teamOutcomes: null });
  const result = normalizePlayRiftbound(listing, tournament);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].playerOneWins, 1);
  round.matches[0].teamOutcomes = null;
  assert.equal(normalizePlayRiftbound(listing, tournament).matches.length, 0);
});

test("roster excludes waitlist/withdrawals and explicit Pre-Rift remains excluded from ratings", () => {
  const { listing, tournament } = fixture();
  tournament.stages = [];
  tournament.tournamentParticipants = [];
  tournament.config.tournamentType = "PRE_RIFT";
  const result = normalizePlayRiftbound(listing, tournament);
  assert.equal(result.entries.length, 1);
  assert.match(result.event.name, /Pre-Rift/);
  tournament.tournamentLocation!.adminArea1 = "NY";
  assert.throws(() => normalizePlayRiftbound(listing, tournament), /outside/);
});

test("search centers cover tracked stores while excluding other states", () => {
  const stores = [
    { state: "MI", latitude: 43.6, longitude: -84.2 },
    { state: "Michigan", latitude: 43.61, longitude: -84.21 },
    { state: "CA", latitude: 34, longitude: -118 },
    { state: "NY", latitude: 40, longitude: -74 },
    { state: "CA", latitude: null, longitude: null },
  ];
  assert.equal(searchCenters(stores).length, 2);
});

test("public API pagination stops at upper bound and fails closed on errors", async () => {
  const original = globalThis.fetch;
  const { listing } = fixture();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.equal(body.variables.sortBy.rb, "DATE");
    assert.equal(body.variables.filter.rb.distanceMeters, 100000);
    calls++;
    return Response.json({ data: { competeTournamentSearch: {
      edges: [{ node: listing }], pageInfo: { hasNextPage: true, endCursor: "next" },
    } } });
  };
  try {
    assert.deepEqual(await searchPlayRiftbound(43, -84, new Date("2026-10-01"), new Date("2026-11-01")), []);
    assert.equal(calls, 1);
    await assert.rejects(searchPlayRiftbound(43, -84, new Date("2026-10-01"), new Date("2026-12-01")), /pagination/);
    globalThis.fetch = async () => Response.json({ errors: [{ message: "Query changed" }], data: { competeTournaments: [] } });
    await assert.rejects(getPlayRiftboundEvent("123"), /Query changed/);
    globalThis.fetch = async () => Response.json({ data: { competeTournaments: [{ id: "123" }] } });
    await assert.rejects(getPlayRiftboundEvent("123"), /Incomplete/);
    globalThis.fetch = async () => Response.json({ errors: [{ message: 'upstream: {"errorCode":"RESOURCE_NOT_FOUND"}' }] });
    await assert.rejects(getPlayRiftboundEvent("123"), PlayRiftboundEventUnavailableError);
    globalThis.fetch = async () => Response.json({ errors: [{ message: "Unauthorized" }] });
    await assert.rejects(getPlayRiftboundEvent("123"), error => !(error instanceof PlayRiftboundEventUnavailableError));
  } finally { globalThis.fetch = original; }
});
