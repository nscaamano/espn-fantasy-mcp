import type { EspnTransaction } from "@nscaamano/espn-fantasy-client";
import { describe, expect, it } from "vitest";
import {
  bidCompetition,
  bidMarket,
  bidProfile,
  claimBids,
  marketWins,
  perGame,
  quantile,
  restOfSeasonValue,
  suggestBid,
  type BidInput,
} from "../src/bids.js";
import type { WinningClaim } from "../src/faab.js";
import type { BidMarket, Player, Roster, Team } from "../src/schemas.js";

const ELIGIBLE: Record<string, string[]> = {
  QB: ["QB", "OP"],
  RB: ["RB", "FLEX", "OP"],
  WR: ["WR", "FLEX", "OP"],
};

let nextId = 1;
function player(
  name: string,
  position: string,
  season: number,
  byeWeek: number | null = 14,
): Player {
  return {
    id: nextId++,
    name,
    position,
    proTeam: "TST",
    injuryStatus: "ACTIVE",
    byeWeek,
    game: null,
    projectedPoints: null,
    actualPoints: null,
    seasonProjectedPoints: season,
    percentRostered: 50,
    lastNewsDate: null,
    eligibleSlots: ELIGIBLE[position]!,
  };
}

function roster(teamId: number, players: Player[], ir: Player[] = []): Roster {
  const slot = (p: Player, s: string) => ({ slot: s, locked: false, droppable: true, player: p });
  return {
    league: "test",
    teamId,
    teamName: `Team ${teamId}`,
    week: 10,
    starters: [],
    bench: players.map((p) => slot(p, "BE")),
    ir: ir.map((p) => slot(p, "IR")),
    projectedTotal: 0,
    actualTotal: 0,
    asOf: "2026-11-04T12:00:00.000Z",
  };
}

function team(id: number, faabRemaining: number | null, waiverRank: number): Team {
  return {
    id,
    name: `Team ${id}`,
    abbrev: `T${id}`,
    owners: [],
    wins: 4,
    losses: 4,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    playoffSeed: null,
    waiverRank,
    faabRemaining,
    isMine: id === 1,
  };
}

const RUN = Date.parse("2026-10-28T07:20:00Z");

function claim(
  teamId: number,
  playerId: number,
  position: string,
  bid: number,
  status = "EXECUTED",
  id = `tx-${nextId++}`,
): EspnTransaction {
  return {
    id,
    type: "WAIVER",
    teamId,
    bid,
    proposedDate: RUN - 86_400_000,
    processDate: RUN,
    add: { playerId, playerName: `Player ${playerId}`, position, proTeam: "TST", fromSlot: null },
    drop: null,
    status,
    executionType: "PROCESS",
    relatedId: null,
  };
}

function win(playerId: number, position: string, bid: number, extra: Partial<WinningClaim> = {}) {
  return {
    playerId,
    player: `Player ${playerId}`,
    position,
    proTeam: "TST",
    week: 8,
    teamId: 2,
    bid,
    runnerUp: null,
    bidders: 1,
    processDate: RUN + playerId,
    ...extra,
  } satisfies WinningClaim;
}

describe("restOfSeasonValue", () => {
  it("counts byes week by week, so a third QB is worth what he covers", () => {
    const weeks = [10, 11, 12];
    const slots = ["QB", "OP"];
    const qbs = [player("QB A", "QB", 60, 10), player("QB B", "QB", 60, 11)];
    // Each starter plays 2 of the 3 weeks: 30 a game.
    expect(perGame(qbs[0]!, weeks)).toBe(30);
    expect(restOfSeasonValue(qbs, slots, weeks)).toBe(30 + 30 + 60);
    // A 45-point third QB (15 a game) fills the bye weeks.
    const third = player("QB C", "QB", 45, 14);
    expect(restOfSeasonValue([...qbs, third], slots, weeks)).toBe(120 + 15 + 15);
  });
});

describe("claimBids and bidProfile", () => {
  it("keeps wins and outbid claims once each, and profiles a team", () => {
    const dup = claim(3, 50, "QB", 12, "EXECUTED", "dup");
    const bids = claimBids([
      {
        week: 8,
        transactions: [
          dup,
          claim(3, 51, "RB", 4, "FAILED_INVALIDPLAYERSOURCE"),
          claim(3, 52, "RB", 30, "FAILED_ROSTERLIMIT"),
          { ...claim(3, 53, "RB", 9), executionType: "EXECUTE", status: "PENDING" },
        ],
      },
      { week: 9, transactions: [dup, claim(4, 54, "QB", 2)] },
    ]);
    expect(bids.map((b) => [b.teamId, b.bid, b.won, b.week])).toEqual([
      [3, 12, true, 8],
      [3, 4, false, 8],
      [4, 2, true, 9],
    ]);
    expect(bidProfile(bids, 3, "RB")).toEqual({
      claims: 2,
      wins: 1,
      spent: 12,
      maxBid: 12,
      claimsAtPosition: 1,
      maxBidAtPosition: 4,
      lastWeek: 8,
    });
    expect(bidProfile(bids, 9, "RB")).toMatchObject({ claims: 0, maxBid: null, lastWeek: null });
  });
});

describe("marketWins and bidMarket", () => {
  const wins = [
    win(1, "RB", 5),
    win(2, "RB", 18, { bidders: 4, runnerUp: 15 }),
    win(3, "RB", 51, { bidders: 4, runnerUp: 30 }),
    win(4, "WR", 10),
  ];
  // Per-game values now: 1 and 2 are backups like an 8-a-game target, 3 is a star.
  const values = new Map([
    [1, 8.3],
    [2, 7.9],
    [3, 16],
  ]);

  it("prices against similar-value wins first, then the position, then everything", () => {
    expect(marketWins(wins, "RB", 8, values)).toMatchObject({ scope: "SIMILAR" });
    expect(marketWins(wins, "RB", 8, values).list.map((w) => w.playerId)).toEqual([2, 1]);
    expect(marketWins(wins, "RB", 30, values).scope).toBe("RB");
    expect(marketWins(wins, "TE", 8, values).scope).toBe("ALL");
  });

  it("summarizes the bids, with nothing to price in a priority league", () => {
    const { scope, list } = marketWins(wins, "RB", 30, values);
    expect(bidMarket(scope, list, true)).toEqual({
      scope: "RB",
      wins: 3,
      contested: 2,
      median: 18,
      upperQuartile: 34.5,
      contestedMedian: 34.5,
      max: 51,
      topRunnerUp: 30,
    });
    expect(bidMarket(scope, list, false)).toMatchObject({ wins: 3, median: null, max: null });
  });

  it("interpolates quantiles", () => {
    expect(quantile([5, 5, 7, 8, 10, 18], 0.75)).toBe(9.5);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("suggestBid", () => {
  const market: BidMarket = {
    scope: "SIMILAR",
    wins: 6,
    contested: 2,
    median: 8,
    upperQuartile: 12,
    contestedMedian: 15,
    max: 20,
    topRunnerUp: 9,
  };
  const rival = (gain: number, faabRemaining: number | null) => ({
    team: "Rival",
    gain,
    faabRemaining,
  });

  it("bids the minimum when no rival with budget wants him", () => {
    expect(suggestBid(market, [], 1, 40)).toMatchObject({ low: 1, high: 1 });
    expect(suggestBid(market, [rival(30, 0)], 1, 40)).toMatchObject({ low: 1, high: 1 });
  });

  it("goes from the median to the upper quartile with one rival, naming him", () => {
    expect(suggestBid(market, [rival(30, 50)], 1, 40)).toEqual({
      low: 8,
      high: 12,
      basis:
        "one rival with budget (strongest: Rival, +30 points, 50 left); for players like him, median to upper quartile",
    });
  });

  it("goes from the upper quartile to the highest win with two or more", () => {
    expect(suggestBid(market, [rival(30, 50), rival(10, 70)], 1, 40)).toMatchObject({
      low: 12,
      high: 20,
    });
  });

  it("never asks for more than beats the richest rival, or more than the user has", () => {
    expect(suggestBid(market, [rival(30, 6), rival(10, 4)], 1, 40)).toMatchObject({
      low: 7,
      high: 7,
    });
    expect(suggestBid(market, [rival(30, 50), rival(10, 70)], 1, 15)).toMatchObject({
      low: 12,
      high: 15,
    });
  });
});

describe("bidCompetition", () => {
  const weeks = [10, 11, 12];
  const slots = ["QB", "OP"];
  // Team 1 (the user) and team 2 each have one QB for two slots; team 3 is full.
  const rosters = [
    roster(1, [player("Mine", "QB", 60, 14)]),
    roster(2, [player("Theirs", "QB", 60, 14)]),
    roster(3, [player("Deep A", "QB", 90, 14), player("Deep B", "QB", 90, 14)]),
  ];
  const teams = [team(1, 40, 3), team(2, 77, 1), team(3, 10, 2)];
  const base = new Map(
    rosters.map((r) => [r.teamId, restOfSeasonValue(playable(r), slots, weeks)]),
  );
  const input = (usesFaab: boolean): BidInput => ({
    target: player("Target", "QB", 45, 14),
    rosters,
    teams,
    myTeamId: 1,
    slots,
    weeks,
    bids: [],
    wins: [win(70, "QB", 17), win(71, "QB", 10)],
    usesFaab,
    minimumBid: 1,
    base,
    values: new Map([
      [70, 15],
      [71, 14],
    ]),
  });

  it("finds the rivals he'd help, with budgets, the market and a range", () => {
    const out = bidCompetition(input(true));
    expect(out).toMatchObject({
      available: true,
      perGame: 15,
      gainForMe: 45,
      interested: 1,
      aheadOfMe: 1,
    });
    // Team 3's lineup is full of better QBs: he adds nothing there.
    expect(out.rivals.map((r) => [r.teamId, r.gain, r.faabRemaining, r.waiverRank])).toEqual([
      [2, 45, 77, 1],
    ]);
    expect(out.market).toMatchObject({ scope: "SIMILAR", wins: 2, median: 13.5, max: 17 });
    expect(out.comparables.map((c) => [c.bid, c.perGame])).toEqual([
      [17, 15],
      [10, 14],
    ]);
    expect(out.suggestedBid).toMatchObject({ low: 14, high: 15 });
  });

  it("has no bids to suggest in a priority league, only who's ahead", () => {
    const out = bidCompetition(input(false));
    expect(out.suggestedBid).toBeNull();
    expect(out.rivals[0]!.faabRemaining).toBeNull();
    expect(out.comparables[0]!.bid).toBeNull();
    expect(out.aheadOfMe).toBe(1);
  });
});

function playable(r: Roster): Player[] {
  return [...r.starters, ...r.bench].map((s) => s.player);
}
