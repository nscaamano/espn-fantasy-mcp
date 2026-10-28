import { describe, expect, it } from "vitest";
import {
  parseActivity,
  parseFreeAgents,
  parseLeagueSettings,
  parseMatchups,
  parsePendingClaims,
  parseProTeams,
  parseRosters,
} from "../src/parse.js";
import type { RawCommunication, RawLeague, RawProSchedule } from "../src/raw.js";
import { fixture } from "./fixtures.js";

const league = fixture<RawLeague>("league.json");

describe("parseLeagueSettings", () => {
  const s = parseLeagueSettings(league, 1234, 2018);

  it("caps the current week at the final scoring period", () => {
    expect(s.currentWeek).toBe(16);
    expect(s.currentMatchupPeriod).toBe(16);
  });

  it("maps lineup slot counts by slot id, dropping empty slots", () => {
    expect(s.lineupSlotCounts).toEqual({
      QB: 1,
      RB: 2,
      WR: 2,
      TE: 1,
      "D/ST": 1,
      K: 1,
      BE: 6,
      FLEX: 1,
    });
  });

  it("maps position limits by default position id", () => {
    expect(s.positionLimits).toEqual({ QB: 4, RB: 8, WR: 8, TE: 3, K: 3, "D/ST": 3 });
  });

  it("reads waiver and trade settings", () => {
    expect(s.acquisition).toMatchObject({
      type: "WAIVERS_TRADITIONAL",
      usesFaab: false,
      waiverHours: 24,
      waiverOrderReset: true,
      seasonLimit: null,
    });
    expect(s.trade).toEqual({ deadline: 1543395600000, vetoVotesRequired: 5, reviewHours: 24 });
    expect(s.lineupLockType).toBe("INDIVIDUAL_GAME");
  });

  it("labels scoring items and keeps per-slot overrides", () => {
    expect(s.scoringItems.find((i) => i.statId === 53)).toMatchObject({ abbr: "REC", points: 1 });
    expect(s.scoringItems.find((i) => i.statId === 121)).toMatchObject({
      abbr: "PA18",
      points: 0,
      overrides: { "D/ST": 4 },
    });
  });

  it("collapses stray whitespace in team names", () => {
    const raw = { ...league, teams: [{ ...league.teams![0]!, name: " Tuna  Can " }] };
    expect(parseLeagueSettings(raw, 1, 2018).teams[0]!.name).toBe("Tuna Can");
  });

  it("names teams and owners", () => {
    expect(s.teams).toHaveLength(10);
    expect(s.teams[0]).toMatchObject({
      id: 1,
      name: "Goin' HAM Newton",
      owners: [expect.any(String)],
    });
  });
});

describe("parseRosters", () => {
  const [team] = parseRosters(league, 2018, 1);

  it("labels slots and maps players", () => {
    expect(team!.teamId).toBe(1);
    expect(team!.entries).toHaveLength(15);
    const brown = team!.entries[0]!;
    expect(brown.slot).toBe("WR");
    expect(brown.player).toMatchObject({
      name: "Antonio Brown",
      position: "WR",
      proTeam: "PIT",
      injuryStatus: "ACTIVE",
      season: { actual: 323.7, projected: 321.88 },
    });
    expect(brown.player.eligibleSlots).toContain("FLEX");
  });

  it("gives D/ST its position from defaultPositionId", () => {
    const dst = team!.entries.find((e) => e.player.name === "Bears D/ST")!;
    expect(dst.player.position).toBe("D/ST");
    // No player-level status; falls back to the roster entry's.
    expect(dst.player.injuryStatus).toBe("NORMAL");
  });
});

describe("parseMatchups", () => {
  const matchups = parseMatchups(fixture<RawLeague>("boxscore.json"), 2018, 13);

  it("reads scores, lineups and weekly points", () => {
    const m = matchups[0]!;
    expect(m.matchupPeriod).toBe(13);
    expect(m.home).toMatchObject({ teamId: 2, score: 151.8 });
    expect(m.away).toMatchObject({ teamId: 11, score: 128 });
    const thomas = m.home!.lineup.find((e) => e.player.name === "Michael Thomas")!;
    expect(thomas.player.week).toEqual({ actual: 9, projected: 18.87 });
  });

  it("sums starter projections when ESPN has no live projection", () => {
    const home = matchups[0]!.home!;
    const expected = home.lineup
      .filter((e) => e.slot !== "BE" && e.slot !== "IR")
      .reduce((t, e) => t + (e.player.week.projected ?? 0), 0);
    expect(home.projected).toBeCloseTo(expected, 2);
  });

  it("reads ESPN's win probability, which only the current matchup period has", () => {
    expect(matchups[0]!.home!.winProbability).toBeNull();
    const [live] = parseMatchups(
      {
        schedule: [
          {
            matchupPeriodId: 8,
            home: { teamId: 1, totalPoints: 0, winProbability: 0.59 },
            away: { teamId: 2, totalPoints: 0, winProbability: 0.41 },
          },
        ],
      },
      2026,
      8,
    );
    expect(live!.home!.winProbability).toBe(0.59);
    expect(live!.away!.winProbability).toBe(0.41);
  });
});

describe("parseFreeAgents", () => {
  it("reads status, ownership and injury", () => {
    const [gordon] = parseFreeAgents(fixture<RawLeague>("free_agents.json"), 2018, 1);
    expect(gordon).toMatchObject({
      status: "FREEAGENT",
      player: { name: "Josh Gordon", injuryStatus: "OUT", percentOwned: 76.5 },
    });
  });

  it("reads the waiver clear time and the undroppable flag", () => {
    const [onWaivers, free] = parseFreeAgents(
      {
        players: [
          {
            status: "WAIVERS",
            waiverProcessDate: 1793170800000,
            player: { id: 1, fullName: "Waiver WR", droppable: false },
          },
          { status: "FREEAGENT", player: { id: 2, fullName: "Free WR" } },
        ],
      } as RawLeague,
      2026,
      8,
    );
    expect(onWaivers).toMatchObject({
      status: "WAIVERS",
      waiverProcessDate: "2026-10-28T07:00:00.000Z",
      player: { droppable: false },
    });
    expect(free).toMatchObject({ waiverProcessDate: null, player: { droppable: null } });
  });

  it("converts lastNewsDate from epoch ms to ISO", () => {
    const players = parseFreeAgents(fixture<RawLeague>("free_agents.json"), 2018, 1);
    const dated = players.filter((p) => p.player.lastNewsDate !== null);
    expect(dated.length).toBeGreaterThan(0);
    for (const p of dated) expect(p.player.lastNewsDate).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe("parseActivity", () => {
  const activity = parseActivity(fixture<RawCommunication>("recent_activity.json"));

  it("splits topics into add/drop items", () => {
    expect(activity).toHaveLength(6);
    expect(activity[0]!.items).toEqual([
      expect.objectContaining({ action: "FA ADDED", teamId: 11, playerId: -16001 }),
      expect.objectContaining({ action: "DROPPED", teamId: 11, playerId: -16021 }),
    ]);
  });

  it("reads waiver bids and trade legs", () => {
    expect(activity[5]!.items[0]).toMatchObject({ action: "WAIVER ADDED", teamId: 1, bid: 0 });
    expect(activity[4]!.items.map((i) => i.action)).toEqual([
      "TRADE SENT",
      "TRADE RECEIVED",
      "DROPPED",
    ]);
    // ESPN's team 0 means "no team".
    expect(activity[4]!.items[0]!.teamId).toBeNull();
  });
});

describe("parseProTeams", () => {
  it("reads bye weeks and skips the free-agent team", () => {
    const teams = parseProTeams(fixture<RawProSchedule>("pro_schedule.json"));
    expect(teams.find((t) => t.id === 0)).toBeUndefined();
    expect(teams.find((t) => t.id === 12)).toEqual({
      id: 12,
      abbrev: "KC",
      byeWeek: 6,
      games: { 1: { opponent: "BAL", home: true, kickoff: 1725582000000 } },
    });
    expect(teams.find((t) => t.id === 23)!.games[1]).toMatchObject({
      opponent: "ATL",
      home: false,
    });
    expect(teams.find((t) => t.id === 11)!.abbrev).toBe("IND");
  });
});

describe("parsePendingClaims", () => {
  const raw = fixture<RawLeague>("pending_transactions.json");

  it("pairs each claim's add with its drop and the slot the drop leaves", () => {
    const claims = parsePendingClaims(raw);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      type: "WAIVER",
      teamId: 1,
      bid: 0,
      proposedDate: 1791914838126,
      processDate: 1791961200000,
      add: { playerId: 4571557, fromSlot: null, playerName: null },
      drop: { playerId: 4034949, fromSlot: "K" },
    });
    expect(claims[1]!.add!.playerId).toBe(-16012);
    expect(claims[1]!.drop!.fromSlot).toBe("BE");
  });

  it("returns nothing when no claims are queued", () => {
    expect(parsePendingClaims({ ...raw, pendingTransactions: [] })).toEqual([]);
    expect(parsePendingClaims({ id: 1234 })).toEqual([]);
  });

  it("skips anything no longer pending", () => {
    const done = raw.pendingTransactions!.map((t) => ({ ...t, status: "EXECUTED" }));
    expect(parsePendingClaims({ ...raw, pendingTransactions: done })).toEqual([]);
  });
});
