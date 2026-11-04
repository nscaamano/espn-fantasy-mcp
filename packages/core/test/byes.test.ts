import { describe, expect, it } from "vitest";
import { byeCoverage, fullStrength, slotList, unfilledSlots } from "../src/byes.js";
import type { InjuryStatus, Player, Roster, RosterSlot } from "../src/schemas.js";

const ELIGIBLE: Record<string, string[]> = {
  QB: ["QB", "OP"],
  RB: ["RB", "RB/WR", "FLEX", "OP"],
  WR: ["WR", "RB/WR", "WR/TE", "FLEX", "OP"],
  TE: ["TE", "WR/TE", "FLEX", "OP"],
  K: ["K"],
  "D/ST": ["D/ST"],
};

let nextId = 1;
function p(
  slot: string,
  name: string,
  position: string,
  season: number,
  opts: { bye?: number | null; status?: InjuryStatus } = {},
): RosterSlot {
  return {
    slot,
    locked: false,
    droppable: true,
    player: {
      id: nextId++,
      name,
      position,
      proTeam: "TST",
      injuryStatus: opts.status ?? "ACTIVE",
      byeWeek: opts.bye === undefined ? 14 : opts.bye,
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

function roster(starters: RosterSlot[], bench: RosterSlot[], ir: RosterSlot[] = []): Roster {
  return {
    league: "test",
    teamId: 1,
    teamName: "Test",
    week: 9,
    starters,
    bench,
    ir,
    projectedTotal: 0,
    actualTotal: 0,
    asOf: "2026-11-04T12:00:00.000Z",
  };
}

const players = (...slots: RosterSlot[]): Player[] => slots.map((s) => s.player);

const SUPERFLEX = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, OP: 1, "D/ST": 1, K: 1 };
const STANDARD = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, "D/ST": 1, K: 1 };

/** A superflex roster with two QBs (byes 10 and 12) and spare skill players. */
function superflexRoster(opts: { qb2Status?: InjuryStatus; qb2Bye?: number } = {}) {
  return roster(
    [
      p("QB", "Quarterback One", "QB", 330, { bye: 10 }),
      p("RB", "Runner One", "RB", 250, { bye: 11 }),
      p("RB", "Runner Two", "RB", 220, { bye: 12 }),
      p("WR", "Receiver One", "WR", 260, { bye: 9 }),
      p("WR", "Receiver Two", "WR", 230, { bye: 13 }),
      p("TE", "Tight End One", "TE", 160, { bye: 14 }),
      p("FLEX", "Receiver Three", "WR", 190, { bye: 9 }),
      p("OP", "Quarterback Two", "QB", 300, {
        bye: opts.qb2Bye ?? 12,
        status: opts.qb2Status,
      }),
      p("D/ST", "Test D/ST", "D/ST", 110, { bye: 13 }),
      p("K", "Kicker One", "K", 140, { bye: 11 }),
    ],
    [
      p("BE", "Runner Three", "RB", 150, { bye: 10 }),
      p("BE", "Receiver Four", "WR", 140, { bye: 14 }),
      p("BE", "Other D/ST", "D/ST", 90, { bye: 10 }),
    ],
  );
}

describe("slotList", () => {
  it("expands counts in lineup order", () => {
    expect(slotList({ K: 1, FLEX: 1, QB: 1, RB: 2 })).toEqual(["QB", "RB", "RB", "FLEX", "K"]);
  });
});

describe("unfilledSlots", () => {
  it("returns nothing when every slot can be filled", () => {
    const pool = players(p("QB", "Q", "QB", 1), p("RB", "R", "RB", 1), p("WR", "W", "WR", 1));
    expect(unfilledSlots(pool, ["QB", "RB", "FLEX"])).toEqual([]);
  });

  it("names a slot only one position can fill", () => {
    const pool = players(p("RB", "R1", "RB", 1), p("WR", "W1", "WR", 1), p("WR", "W2", "WR", 1));
    expect(unfilledSlots(pool, ["QB", "RB", "WR", "OP"])).toEqual(["QB"]);
  });

  it("reports the broadest slot open when several could be", () => {
    // Three players for RB, RB, WR and FLEX: one slot stays open, and FLEX takes the blame.
    const pool = players(p("RB", "R1", "RB", 1), p("RB", "R2", "RB", 1), p("WR", "W1", "WR", 1));
    expect(unfilledSlots(pool, ["RB", "RB", "WR", "FLEX"])).toEqual(["FLEX"]);
  });

  it("returns every slot for an empty pool", () => {
    expect(unfilledSlots([], ["QB", "K"])).toEqual(["QB", "K"]);
  });
});

describe("fullStrength", () => {
  it("counts the positions the best lineup by season projection starts", () => {
    const r = superflexRoster();
    const pool = players(...r.starters, ...r.bench);
    expect(fullStrength(pool, slotList(SUPERFLEX))).toEqual({
      QB: 2,
      RB: 2,
      WR: 3,
      TE: 1,
      "D/ST": 1,
      K: 1,
    });
  });

  it("starts a skill player at OP when the second QB is worse", () => {
    const pool = players(
      p("QB", "Q1", "QB", 300),
      p("BE", "Q2", "QB", 40),
      p("RB", "R1", "RB", 200),
      p("BE", "W1", "WR", 150),
    );
    expect(fullStrength(pool, ["QB", "RB", "OP"])).toEqual({ QB: 1, RB: 1, WR: 1 });
  });
});

describe("byeCoverage", () => {
  it("flags the superflex QB conflict: one QB available, two needed", () => {
    const out = byeCoverage(superflexRoster(), SUPERFLEX, 9, 13);
    const week10 = out.weeks.find((w) => w.week === 10)!;
    expect(week10.byes).toEqual(["Quarterback One", "Runner Three", "Other D/ST"]);
    // OP can still take a spare receiver, so no slot is open, but QB runs short.
    expect(week10.openSlots).toBeUndefined();
    expect(week10.short).toEqual([{ position: "QB", available: 1, needed: 2 }]);
    expect(out.weeks.find((w) => w.week === 12)!.short).toContainEqual({
      position: "QB",
      available: 1,
      needed: 2,
    });
    expect(out).toMatchObject({ league: "test", fromWeek: 9, toWeek: 13, injured: [] });
    expect(out.asOf).toBe("2026-11-04T12:00:00.000Z");
  });

  it("opens the QB slot when both QBs are on bye the same week", () => {
    const out = byeCoverage(superflexRoster({ qb2Bye: 10 }), SUPERFLEX, 10, 10);
    expect(out.weeks[0]).toMatchObject({
      week: 10,
      openSlots: ["QB"],
      short: [{ position: "QB", available: 0, needed: 2 }],
    });
  });

  it("lets FLEX absorb a bye: a short position but no open slot", () => {
    // Week 9: both FLEX-eligible receivers starting at WR and FLEX are out; the bench WR
    // covers one, so WR is short by one and FLEX falls back to the bench RB.
    const out = byeCoverage(superflexRoster(), SUPERFLEX, 9, 9);
    expect(out.weeks[0]).toEqual({
      week: 9,
      byes: ["Receiver One", "Receiver Three"],
      short: [{ position: "WR", available: 2, needed: 3 }],
    });
  });

  it("keeps a week with no byes tiny", () => {
    const out = byeCoverage(superflexRoster(), SUPERFLEX, 15, 15);
    expect(out.weeks).toEqual([{ week: 15, byes: [] }]);
  });

  it("flags a kicker bye with no backup, and not a D/ST bye with one", () => {
    const out = byeCoverage(superflexRoster(), SUPERFLEX, 11, 13);
    const [w11, , w13] = out.weeks;
    expect(w11!.openSlots).toEqual(["K"]);
    expect(w11!.short).toContainEqual({ position: "K", available: 0, needed: 1 });
    // Week 13: the starting D/ST is on bye, the other one isn't.
    expect(w13!.byes).toContain("Test D/ST");
    expect(w13!.openSlots).toBeUndefined();
    expect(w13!.short?.some((s) => s.position === "D/ST")).toBeFalsy();
  });

  it("reports an injured player apart: not available, but counted if healthy", () => {
    const out = byeCoverage(superflexRoster({ qb2Status: "OUT" }), SUPERFLEX, 9, 10);
    expect(out.injured).toEqual([{ name: "Quarterback Two", position: "QB", injuryStatus: "OUT" }]);
    const [w9, w10] = out.weeks;
    // Week 9: only the injury makes QB short; he'd cover it if back. With two
    // receivers on bye too, there's one skill player too few, so OP (the
    // broadest slot) is open unless he's back.
    expect(w9!.short).toContainEqual({ position: "QB", available: 1, needed: 2, ifHealthy: 2 });
    expect(w9!.openSlots).toEqual(["OP"]);
    expect(w9!.openSlotsIfHealthy).toEqual([]);
    // Week 10: QB1 is on bye too, so the QB slot is open unless QB2 is back.
    expect(w10!.openSlots).toEqual(["QB"]);
    expect(w10!.openSlotsIfHealthy).toEqual([]);
    expect(w10!.short).toContainEqual({ position: "QB", available: 0, needed: 2, ifHealthy: 1 });
  });

  it("doesn't count a player ESPN projects for 0 this season, unless no projections loaded", () => {
    const base = superflexRoster();
    const benched = p("BE", "Benched QB", "QB", 0, { bye: 14, status: "OUT" });
    const out = byeCoverage(roster(base.starters, [...base.bench, benched]), SUPERFLEX, 10, 10);
    expect(out.zeroProjection).toEqual(["Benched QB"]);
    // Not injured-and-maybe-back either: he's left out of ifHealthy too.
    expect(out.injured).toEqual([]);
    expect(out.weeks[0]!.short).toEqual([{ position: "QB", available: 1, needed: 2 }]);
    expect(out.fullStrength.QB).toBe(2);

    const unloaded = roster(
      [p("QB", "Q1", "QB", 0, { bye: 9 }), p("OP", "Q2", "QB", 0, { bye: 10 })],
      [p("BE", "W1", "WR", 0)],
    );
    const raw = byeCoverage(unloaded, { QB: 1, OP: 1 }, 9, 9);
    expect(raw.zeroProjection).toEqual([]);
    expect(raw.weeks[0]).toMatchObject({ byes: ["Q1"] });
    expect(raw.weeks[0]!.openSlots).toBeUndefined();
  });

  it("counts a questionable player as available", () => {
    const out = byeCoverage(superflexRoster({ qb2Status: "QUESTIONABLE" }), SUPERFLEX, 11, 11);
    expect(out.injured).toEqual([]);
    expect(out.weeks[0]!.short?.some((s) => s.position === "QB")).toBeFalsy();
  });

  it("ignores players in IR slots, healthy or not", () => {
    const base = superflexRoster();
    const r = roster(base.starters, base.bench, [p("IR", "Stashed QB", "QB", 280, { bye: 9 })]);
    const out = byeCoverage(r, SUPERFLEX, 10, 10);
    expect(out.weeks[0]!.byes).not.toContain("Stashed QB");
    expect(out.weeks[0]!.short).toEqual([{ position: "QB", available: 1, needed: 2 }]);
    expect(out.fullStrength.QB).toBe(2);
  });

  it("treats a player with no known bye week as available every week", () => {
    const r = roster(
      [p("QB", "Q1", "QB", 300, { bye: null }), p("K", "K1", "K", 100, { bye: 10 })],
      [],
    );
    const out = byeCoverage(r, { QB: 1, K: 1 }, 10, 10);
    expect(out.weeks[0]).toEqual({
      week: 10,
      byes: ["K1"],
      openSlots: ["K"],
      short: [{ position: "K", available: 0, needed: 1 }],
    });
  });

  it("reports a slot the roster can never fill in every week", () => {
    const base = superflexRoster();
    const out = byeCoverage(base, { ...STANDARD, TE: 2 }, 15, 16);
    for (const w of out.weeks) expect(w.openSlots).toEqual(["TE"]);
    expect(out.fullStrength.TE).toBe(1);
  });
});
