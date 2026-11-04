import { describe, expect, it } from "vitest";
import { bestSeasonLineup, findTradePartners } from "../src/partners.js";
import type { InjuryStatus, Roster, RosterSlot, Team } from "../src/schemas.js";

const ELIGIBLE: Record<string, string[]> = {
  QB: ["QB", "OP"],
  RB: ["RB", "FLEX", "OP"],
  WR: ["WR", "FLEX", "OP"],
  TE: ["TE", "FLEX", "OP"],
};

let nextId = 1;
function p(
  name: string,
  position: string,
  season: number,
  opts: { slot?: string; status?: InjuryStatus } = {},
): RosterSlot {
  return {
    slot: opts.slot ?? "BE",
    locked: false,
    droppable: true,
    player: {
      id: nextId++,
      name,
      position,
      proTeam: "TST",
      injuryStatus: opts.status ?? "ACTIVE",
      byeWeek: 10,
      game: null,
      projectedPoints: season / 17,
      actualPoints: null,
      seasonProjectedPoints: season,
      percentRostered: 50,
      lastNewsDate: null,
      eligibleSlots: ELIGIBLE[position]!,
    },
  };
}

/** Slot assignment doesn't matter to the search: everyone outside IR is in the pool. */
function roster(teamId: number, players: RosterSlot[]): Roster {
  return {
    league: "test",
    teamId,
    teamName: `Team ${teamId}`,
    week: 9,
    starters: [],
    bench: players.filter((s) => s.slot !== "IR"),
    ir: players.filter((s) => s.slot === "IR"),
    projectedTotal: 0,
    actualTotal: 0,
    asOf: "2026-11-04T12:00:00.000Z",
  };
}

function team(id: number, wins = 4, losses = 4): Team {
  return {
    id,
    name: `Team ${id}`,
    abbrev: `T${id}`,
    owners: [],
    wins,
    losses,
    ties: 0,
    pointsFor: 800,
    pointsAgainst: 800,
    playoffSeed: id,
    waiverRank: id,
    faabRemaining: null,
    isMine: id === 1,
  };
}

const ONE_QB = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 };
const SUPERFLEX = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, OP: 1 };

/** A filler team: two of each, all middling. */
const filler = (id: number) =>
  roster(id, [
    p(`QB${id}a`, "QB", 250),
    p(`QB${id}b`, "QB", 200),
    p(`RB${id}a`, "RB", 160),
    p(`RB${id}b`, "RB", 140),
    p(`RB${id}c`, "RB", 90),
    p(`WR${id}a`, "WR", 160),
    p(`WR${id}b`, "WR", 140),
    p(`WR${id}c`, "WR", 110),
    p(`TE${id}a`, "TE", 100),
  ]);

describe("bestSeasonLineup", () => {
  it("fills FLEX and OP with the best leftover players", () => {
    const pool = [
      p("Q1", "QB", 300),
      p("Q2", "QB", 250),
      p("R1", "RB", 200),
      p("R2", "RB", 150),
      p("R3", "RB", 120),
      p("W1", "WR", 180),
      p("W2", "WR", 100),
      p("T1", "TE", 90),
    ].map((s) => s.player);
    const { total, starters } = bestSeasonLineup(
      pool,
      Object.entries(SUPERFLEX).flatMap(([slot, n]) => Array(n).fill(slot) as string[]),
    );
    // Q2 takes OP over R3; R3 takes FLEX.
    expect(total).toBe(300 + 250 + 200 + 150 + 120 + 180 + 100 + 90);
    expect(starters.size).toBe(8);
  });
});

describe("findTradePartners", () => {
  it("finds a superflex QB from a team with three, and offers WR depth they lack", () => {
    const me = roster(1, [
      p("My QB", "QB", 260),
      p("My RB1", "RB", 170),
      p("My RB2", "RB", 150),
      p("My WR1", "WR", 190),
      p("My WR2", "WR", 170),
      p("My WR3", "WR", 160),
      p("My WR4", "WR", 150),
      p("My WR5", "WR", 140),
      p("My TE", "TE", 110),
    ]);
    const qbRich = roster(2, [
      p("Their QB1", "QB", 280),
      p("Their QB2", "QB", 240),
      p("Their QB3", "QB", 220),
      p("Their RB1", "RB", 170),
      p("Their RB2", "RB", 150),
      p("Their RB3", "RB", 130),
      p("Their WR1", "WR", 150),
      p("Their WR2", "WR", 60),
      p("Their TE", "TE", 100),
    ]);
    const out = findTradePartners({
      rosters: [me, qbRich, filler(3), filler(4)],
      teams: [team(1), team(2, 6, 2), team(3), team(4)],
      myTeamId: 1,
      slots: SUPERFLEX,
      need: "QB",
    });
    // Only one startable QB: My WR3 fills OP, so the user ranks last at QB.
    expect(out.mine.atNeed).toMatchObject({ weakestStarter: null, rank: 4, short: true });
    expect(out.offer).toEqual(["WR"]);
    expect(out.offerInferred).toBe(true);
    const [top] = out.partners;
    expect(top).toMatchObject({ teamId: 2, team: "Team 2", record: "6-2" });
    // QB3 sits on their bench (OP goes to QB2), so he costs them nothing; QB1
    // has QB3 behind him, so he's spare too.
    const qb3 = top!.theirSurplus.find((s) => s.name === "Their QB3");
    expect(qb3).toMatchObject({ costToThem: 0 });
    expect(qb3!.gainForMe).toBeGreaterThan(50);
    expect(top!.theirSurplus.map((s) => s.name)).toContain("Their QB1");
    // Typical lineups here start three WRs, and they have two.
    expect(top!.theirShortage).toEqual([
      { position: "WR", weakestStarter: null, seasonProjectedPoints: 0, rank: 4, short: true },
    ]);
    expect(top!.bestSwap!.get).toMatch(/^Their QB/);
    expect(top!.bestSwap!.give).toMatch(/^My WR/);
    expect(top!.bestSwap!.myGain).toBeGreaterThan(0);
    expect(top!.bestSwap!.theirGain).toBeGreaterThan(0);
    expect(top!.fit).toBe(Math.min(top!.bestSwap!.myGain, top!.bestSwap!.theirGain));
    // The user's spare WRs are bench players or have depth behind them.
    for (const s of out.mine.spare)
      expect(s.costToMe).toBeLessThan(0.25 * s.seasonProjectedPoints!);
    expect(out.mine.spare.map((s) => s.name)).toContain("My WR5");
  });

  it("finds a team with RB surplus and a WR shortage, and lists teams with nothing to spare", () => {
    const me = roster(1, [
      p("My QB", "QB", 250),
      p("My RB1", "RB", 170),
      p("My RB2", "RB", 60),
      p("My WR1", "WR", 180),
      p("My WR2", "WR", 160),
      p("My WR3", "WR", 150),
      p("My WR4", "WR", 140),
      p("My TE", "TE", 100),
    ]);
    const rbRich = roster(2, [
      p("Their QB", "QB", 240),
      p("Their RB1", "RB", 190),
      p("Their RB2", "RB", 170),
      p("Their RB3", "RB", 160),
      p("Their RB4", "RB", 150),
      p("Their WR1", "WR", 150),
      p("Their WR2", "WR", 70),
      p("Their TE", "TE", 100),
    ]);
    const thin = roster(3, [
      p("Thin QB", "QB", 240),
      p("Thin RB1", "RB", 150),
      p("Thin RB2", "RB", 60),
      p("Thin WR1", "WR", 160),
      p("Thin WR2", "WR", 140),
      p("Thin WR3", "WR", 120),
      p("Thin TE", "TE", 90),
    ]);
    const out = findTradePartners({
      rosters: [me, rbRich, thin, filler(4)],
      teams: [team(1), team(2), team(3), team(4)],
      myTeamId: 1,
      slots: ONE_QB,
      need: "RB",
      offer: ["WR"],
    });
    expect(out.offerInferred).toBe(false);
    // Team 4's bench RB would start for the user too, for a smaller gain.
    expect(out.partners.map((x) => x.teamId)).toEqual([2, 4]);
    expect(out.partners[0]!.fit).toBeGreaterThan(out.partners[1]!.fit);
    const [top] = out.partners;
    // With four good RBs, losing any one costs them little: the next steps in.
    expect(top!.theirSurplus).toHaveLength(3);
    for (const s of top!.theirSurplus) {
      expect(s.position).toBe("RB");
      expect(s.costToThem).toBeLessThan(0.25 * s.seasonProjectedPoints!);
      expect(s.gainForMe).toBeGreaterThanOrEqual(s.costToThem);
    }
    expect(top!.theirShortage[0]).toMatchObject({ position: "WR", short: true });
    expect(top!.forThem.map((f) => f.name)).toContain("My WR4");
    expect(top!.fit).toBeGreaterThan(0);
    // A team whose depth wouldn't start for the user, and one whose only RBs start for it.
    expect(out.noSurplus).toEqual(expect.arrayContaining(["Team 3"]));
  });

  it("returns no partners when nobody can spare the need", () => {
    const me = roster(1, [
      p("My QB", "QB", 300),
      p("My RB1", "RB", 220),
      p("My RB2", "RB", 210),
      p("My WR1", "WR", 220),
      p("My WR2", "WR", 210),
      p("My WR3", "WR", 200),
      p("My TE", "TE", 150),
      p("My TE2", "TE", 140),
    ]);
    const out = findTradePartners({
      rosters: [me, filler(2), filler(3)],
      teams: [team(1), team(2), team(3)],
      myTeamId: 1,
      slots: ONE_QB,
      need: "RB",
    });
    expect(out.partners).toEqual([]);
    expect(out.noSurplus).toEqual(["Team 2", "Team 3"]);
  });

  it("leaves OUT and IR players out of lineups and surplus, and names them", () => {
    const me = roster(1, [
      p("My QB", "QB", 250),
      p("My RB1", "RB", 200, { status: "OUT" }),
      p("My RB2", "RB", 120),
      p("My RB3", "RB", 100),
      p("My WR1", "WR", 180),
      p("My WR2", "WR", 160),
      p("My WR3", "WR", 150),
      p("My TE", "TE", 100),
    ]);
    const other = roster(2, [
      p("Their QB", "QB", 240),
      p("Their RB1", "RB", 190),
      p("Their RB2", "RB", 170),
      p("Their RB3", "RB", 165),
      p("Their RB4", "RB", 150),
      p("Hurt RB", "RB", 200, { slot: "IR", status: "IR" }),
      p("Their WR1", "WR", 150),
      p("Their WR2", "WR", 80, { status: "QUESTIONABLE" }),
      p("Their WR3", "WR", 60),
      p("Their TE", "TE", 100),
    ]);
    const out = findTradePartners({
      rosters: [me, other],
      teams: [team(1), team(2)],
      myTeamId: 1,
      slots: ONE_QB,
      need: "RB",
      offer: ["WR"],
    });
    // My OUT RB1 doesn't start, so the hole shows.
    expect(out.mine.needPlayers[0]).toMatchObject({
      name: "My RB1",
      injuryStatus: "OUT",
      starting: false,
    });
    const [top] = out.partners;
    expect(top!.theirSurplus.map((s) => s.name)).not.toContain("Hurt RB");
    expect(top!.theirShortage[0]).toMatchObject({ position: "WR" });
    expect(out.mine.atNeed.out).toEqual(["My RB1"]);
  });

  it("refuses a position the league doesn't start", () => {
    expect(() =>
      findTradePartners({
        rosters: [filler(1), filler(2)],
        teams: [team(1), team(2)],
        myTeamId: 1,
        slots: ONE_QB,
        need: "K",
      }),
    ).toThrow(/no starting slot for K/);
  });
});
