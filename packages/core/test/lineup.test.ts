import { describe, expect, it } from "vitest";
import { assign, optimizeLineup } from "../src/lineup.js";
import type { InjuryStatus, Roster, RosterSlot } from "../src/schemas.js";

const WEEK = 8;
const KICK = {
  early: "2026-10-25T17:00:00.000Z",
  late: "2026-10-25T20:25:00.000Z",
  night: "2026-10-26T00:20:00.000Z",
};
const ELIGIBLE: Record<string, string[]> = {
  QB: ["QB", "OP"],
  RB: ["RB", "RB/WR", "FLEX", "OP"],
  WR: ["WR", "RB/WR", "WR/TE", "FLEX", "OP"],
  TE: ["TE", "WR/TE", "FLEX", "OP"],
  K: ["K"],
};

let nextId = 1;
function p(
  slot: string,
  name: string,
  position: string,
  proj: number | null,
  opts: { status?: InjuryStatus; bye?: boolean; kickoff?: string; locked?: boolean } = {},
): RosterSlot {
  return {
    slot,
    locked: opts.locked ?? false,
    player: {
      id: nextId++,
      name,
      position,
      proTeam: "TST",
      injuryStatus: opts.status ?? "ACTIVE",
      byeWeek: opts.bye ? WEEK : 14,
      game: opts.bye ? null : { opponent: "OPP", home: true, kickoff: opts.kickoff ?? KICK.early },
      projectedPoints: proj,
      actualPoints: null,
      percentRostered: 50,
      lastNewsDate: null,
      eligibleSlots: ELIGIBLE[position]!,
    },
  };
}

function roster(starters: RosterSlot[], bench: RosterSlot[]): Roster {
  const projectedTotal = starters.reduce((t, s) => t + (s.player.projectedPoints ?? 0), 0);
  return {
    league: "test",
    teamId: 1,
    teamName: "Test",
    week: WEEK,
    starters,
    bench,
    ir: [],
    projectedTotal,
    actualTotal: 0,
    asOf: "2026-10-25T12:00:00.000Z",
  };
}

const SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 };
const slotOf = (r: ReturnType<typeof optimizeLineup>, name: string) =>
  r.starters.find((s) => s.player?.name === name)?.slot ?? "BE";

describe("assign", () => {
  it("finds the minimum-cost assignment", () => {
    // Best: row0→col1 (1), row1→col0 (2), row2→col2 (2) = 5.
    expect(
      assign([
        [4, 1, 3],
        [2, 0, 5],
        [3, 2, 2],
      ]),
    ).toEqual([1, 0, 2]);
  });

  it("handles more columns than rows", () => {
    expect(assign([[5, 1, 9]])).toEqual([1]);
  });
});

describe("optimizeLineup", () => {
  const base = () => ({
    starters: [
      p("QB", "Quarterback", "QB", 20),
      p("RB", "Runner One", "RB", 15),
      p("RB", "Runner Two", "RB", 12),
      p("WR", "Wideout One", "WR", 14),
      p("WR", "Wideout Two", "WR", 13, { bye: true }),
      p("TE", "Tight End", "TE", 9, { status: "OUT" }),
      p("FLEX", "Flex Back", "RB", 8),
    ],
    bench: [
      p("BE", "Bench Wideout", "WR", 11),
      p("BE", "Bench Tight End", "TE", 7),
      p("BE", "Bench Back", "RB", 10),
    ],
  });

  it("benches bye and OUT starters and fills every slot by projection", () => {
    const b = base();
    const r = optimizeLineup(roster(b.starters, b.bench), SLOTS);
    expect(slotOf(r, "Wideout Two")).toBe("BE");
    expect(slotOf(r, "Tight End")).toBe("BE");
    expect(slotOf(r, "Bench Wideout")).toBe("WR");
    expect(slotOf(r, "Bench Tight End")).toBe("TE");
    // FLEX goes to the better of the leftover backs.
    expect(slotOf(r, "Bench Back")).toBe("FLEX");
    expect(slotOf(r, "Flex Back")).toBe("BE");
    expect(r.projectedTotal).toBe(20 + 15 + 12 + 14 + 11 + 7 + 10);
    expect(r.moves).toEqual(
      expect.arrayContaining([
        { player: "Wideout Two", from: "WR", to: "BE", reason: "bye" },
        { player: "Tight End", from: "TE", to: "BE", reason: "OUT" },
        { player: "Flex Back", from: "FLEX", to: "BE", reason: "lower projection" },
        { player: "Bench Wideout", from: "BE", to: "WR", reason: "replaces Wideout Two" },
        { player: "Bench Tight End", from: "BE", to: "TE", reason: "replaces Tight End" },
        { player: "Bench Back", from: "BE", to: "FLEX", reason: "replaces Flex Back" },
      ]),
    );
    // Benchings come first.
    expect(r.moves[0]!.to).toBe("BE");
  });

  it("leaves a set lineup alone, including on ties", () => {
    const r = optimizeLineup(
      roster(
        [p("QB", "QB A", "QB", 18), p("RB", "Back A", "RB", 10), p("RB", "Back B", "RB", 10)],
        [p("BE", "Back C", "RB", 10)],
      ),
      { QB: 1, RB: 2 },
    );
    expect(r.moves).toEqual([]);
  });

  it("keeps locked starters in place and never starts a locked bench player", () => {
    const r = optimizeLineup(
      roster(
        [p("QB", "QB A", "QB", 18), p("RB", "Locked Back", "RB", 3, { locked: true })],
        [p("BE", "Locked Bench", "RB", 30, { locked: true }), p("BE", "Healthy Back", "RB", 9)],
      ),
      { QB: 1, RB: 2 },
    );
    expect(slotOf(r, "Locked Back")).toBe("RB");
    expect(slotOf(r, "Locked Bench")).toBe("BE");
    expect(slotOf(r, "Healthy Back")).toBe("RB");
  });

  it("starts two quarterbacks in superflex when they project higher", () => {
    const r = optimizeLineup(
      roster(
        [p("QB", "QB A", "QB", 20), p("RB", "Back A", "RB", 12), p("OP", "Back B", "RB", 11)],
        [p("BE", "QB B", "QB", 17)],
      ),
      { QB: 1, RB: 1, OP: 1 },
    );
    expect(slotOf(r, "QB B")).toBe("OP");
    expect(slotOf(r, "Back B")).toBe("BE");
  });

  it("flags a questionable starter without a same-time-or-later backup", () => {
    const r = optimizeLineup(
      roster(
        [p("WR", "Night Receiver", "WR", 16, { status: "QUESTIONABLE", kickoff: KICK.night })],
        [p("BE", "Early Receiver", "WR", 8, { kickoff: KICK.early })],
      ),
      { WR: 1 },
    );
    expect(r.risks).toEqual([
      expect.objectContaining({
        type: "GAME_TIME",
        player: "Night Receiver",
        detail: expect.stringMatching(/no healthy bench backup/),
      }),
    ]);
  });

  it("names backups who play at the same time or later", () => {
    const r = optimizeLineup(
      roster(
        [p("WR", "Early Receiver", "WR", 16, { status: "QUESTIONABLE", kickoff: KICK.early })],
        [p("BE", "Late Receiver", "WR", 8, { kickoff: KICK.late })],
      ),
      { WR: 1 },
    );
    expect(r.risks[0]!.detail).toMatch(/Late Receiver/);
  });

  it("reports a slot nobody can fill, and a zero projection", () => {
    const r = optimizeLineup(
      roster([p("QB", "QB A", "QB", 0), p("K", "Kicker", "K", 8, { status: "OUT" })], []),
      { QB: 1, K: 1 },
    );
    expect(r.starters.find((s) => s.slot === "K")!.player).toBeNull();
    expect(r.risks.map((x) => x.type).sort()).toEqual(["EMPTY_SLOT", "NO_PROJECTION"]);
  });
});
