import { describe, expect, it } from "vitest";
import { assign, latestPracticeReport, optimizeLineup, staleTag } from "../src/lineup.js";
import type { InjuryStatus, PendingClaim, Roster, RosterSlot } from "../src/schemas.js";

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
  "D/ST": ["D/ST"],
};

let nextId = 1;
function p(
  slot: string,
  name: string,
  position: string,
  proj: number | null,
  opts: {
    status?: InjuryStatus;
    bye?: boolean;
    kickoff?: string;
    locked?: boolean;
    season?: number | null;
    undroppable?: boolean;
    news?: string;
  } = {},
): RosterSlot {
  const locked = opts.locked ?? false;
  return {
    slot,
    locked,
    droppable: !opts.undroppable && !locked,
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
      seasonProjectedPoints: opts.season === undefined ? 100 : opts.season,
      percentRostered: 50,
      lastNewsDate: opts.news ?? null,
      eligibleSlots: ELIGIBLE[position]!,
    },
  };
}

function roster(starters: RosterSlot[], bench: RosterSlot[], ir: RosterSlot[] = []): Roster {
  const projectedTotal = starters.reduce((t, s) => t + (s.player.projectedPoints ?? 0), 0);
  return {
    league: "test",
    teamId: 1,
    teamName: "Test",
    week: WEEK,
    starters,
    bench,
    ir,
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

  it("reports a slot nobody can fill", () => {
    const r = optimizeLineup(
      roster([p("QB", "QB A", "QB", 18), p("K", "Kicker", "K", 8, { status: "OUT" })], []),
      { QB: 1, K: 1 },
    );
    expect(r.starters.find((s) => s.slot === "K")!.player).toBeNull();
    expect(r.risks.map((x) => x.type)).toEqual(["EMPTY_SLOT"]);
  });
});

describe("optimizeLineup: fixes from real use", () => {
  // Fri Oct 30, 4 PM ET; the game is Sun Nov 1, 1 PM ET.
  const NOW = new Date("2026-10-30T20:00:00.000Z");
  const SUNDAY = "2026-11-01T18:00:00.000Z";
  const claim = (add: string | null, drop: string | null, position = "RB"): PendingClaim => ({
    type: "WAIVER",
    add: add ? { name: add, position, proTeam: "TST" } : null,
    drop: drop ? { name: drop, position, proTeam: "TST", slot: "BE" } : null,
    bid: 3,
    proposedAt: "2026-10-27T20:00:00.000Z",
    processesAt: "2026-10-28T07:00:00.000Z",
  });

  it("leaves a slot empty rather than start a zero projection, without benching him", () => {
    const r = optimizeLineup(
      roster([p("RB", "Healthy RB", "RB", 12), p("RB", "Zero-projection RB2", "RB", 0)], []),
      { RB: 2 },
    );
    expect(r.starters.filter((s) => s.player === null)).toHaveLength(1);
    expect(r.risks).toEqual([
      expect.objectContaining({
        type: "EMPTY_SLOT",
        slot: "RB",
        player: "Zero-projection RB2",
        detail: expect.stringMatching(/projects 0/),
      }),
    ]);
    expect(r.moves).toEqual([]);
  });

  it("still starts a negative-projection D/ST, and ignores the rule before projections load", () => {
    const dst = optimizeLineup(roster([p("D/ST", "Defense", "D/ST", -1.5)], []), { "D/ST": 1 });
    expect(dst.risks).toEqual([]);
    const unknown = optimizeLineup(
      roster([p("RB", "RB A", "RB", null), p("RB", "RB B", "RB", null)], []),
      { RB: 2 },
    );
    expect(unknown.risks).toEqual([]);
  });

  it("flags a questionable player left in an IR slot, unless the league allows it", () => {
    const ir = [
      p("IR", "Questionable RB on IR", "RB", 0, { status: "QUESTIONABLE" }),
      p("IR", "Out WR on IR", "WR", 0, { status: "OUT" }),
    ];
    const r = optimizeLineup(roster([p("RB", "RB A", "RB", 10)], [], ir), { RB: 1 });
    expect(r.risks).toEqual([
      expect.objectContaining({
        type: "IR_INELIGIBLE",
        player: "Questionable RB on IR",
        detail: expect.stringMatching(/blocks adds and claims/),
      }),
    ]);
    const lenient = optimizeLineup(
      roster([p("RB", "RB A", "RB", 10)], [], ir),
      { RB: 1 },
      {
        irEligible: ["OUT", "IR", "SUSPENDED", "QUESTIONABLE"],
      },
    );
    expect(lenient.risks).toEqual([]);
  });

  it("names a droppable, low-value bench player when a pickup needs room", () => {
    const starters = [
      p("WR", "Questionable WR", "WR", 14, { status: "QUESTIONABLE", kickoff: SUNDAY }),
      p("TE", "Hurt TE", "TE", 9, { status: "OUT" }),
    ];
    const bench = [
      p("BE", "Locked TE", "TE", 5, { season: 10, locked: true }),
      p("BE", "Only late backup", "WR", 6, { season: 20, kickoff: SUNDAY }),
      p("BE", "Undroppable star", "WR", 8, { season: 5, undroppable: true, kickoff: KICK.early }),
      p("BE", "Low-value QB", "QB", 9, { season: 31.2 }),
      p("BE", "Valuable QB", "QB", 12, { season: 250 }),
    ];
    const r = optimizeLineup(roster(starters, bench), { WR: 1, TE: 1 }, { rosterMax: 7, now: NOW });
    // The locked TE can't come in, so TE is empty; the WR's only late backup is protected.
    expect(r.risks.find((x) => x.type === "GAME_TIME")?.detail).toMatch(/: Only late backup$/);
    expect(r.risks.find((x) => x.type === "EMPTY_SLOT")?.drop).toEqual({
      player: "Low-value QB",
      reason: "lowest season projection on the bench (31.2), droppable",
    });
  });

  it("doesn't suggest a drop when the roster has room", () => {
    const r = optimizeLineup(
      roster(
        [p("RB", "Hurt RB", "RB", 9, { status: "OUT" })],
        [p("BE", "Low-value QB", "QB", 9, { season: 3 })],
      ),
      { RB: 1 },
      { rosterMax: 16 },
    );
    expect(r.risks[0]?.drop).toBeUndefined();
  });

  it("accounts for pending claims: drops leave the pool, and an add covers the empty slot", () => {
    const r = optimizeLineup(
      roster(
        [p("RB", "RB A", "RB", 12), p("RB", "Hurt RB", "RB", 0, { status: "OUT" })],
        [p("BE", "Claim drop", "RB", 11)],
      ),
      { RB: 2 },
      { rosterMax: 3, pendingClaims: [claim("Claimed RB", "Claim drop")] },
    );
    // Claim drop would otherwise start at RB2; he's on his way out.
    expect(slotOf(r, "Claim drop")).toBe("BE");
    expect(r.risks).toEqual([
      expect.objectContaining({
        type: "EMPTY_SLOT",
        pendingClaim: {
          add: "Claimed RB",
          drop: "Claim drop",
          processesAt: "2026-10-28T07:00:00.000Z",
        },
      }),
    ]);
    // The claim already makes room, so no extra drop.
    expect(r.risks[0]?.drop).toBeUndefined();
  });

  it("marks a game-time tag stale when the news predates this week's reports", () => {
    const starter = (news: string) =>
      optimizeLineup(
        roster(
          [p("WR", "Questionable WR", "WR", 13, { status: "QUESTIONABLE", kickoff: SUNDAY, news })],
          [],
        ),
        { WR: 1 },
        { now: NOW },
      ).risks[0];
    expect(starter("2026-10-18T15:00:00.000Z")?.staleTag).toEqual({
      lastNews: "2026-10-18T15:00:00.000Z",
      reason: "last news Oct 18, before his previous game; the tag may be stale",
    });
    expect(starter("2026-10-29T15:00:00.000Z")?.staleTag?.reason).toBe(
      "last news Oct 29, before Friday's practice report; the tag may be stale",
    );
    // Friday 2 PM ET is before Friday's report (4 PM); 5 PM ET is after it.
    expect(starter("2026-10-30T18:00:00.000Z")?.staleTag?.reason).toMatch(/Friday's/);
    expect(starter("2026-10-30T21:00:00.000Z")?.staleTag).toBeUndefined();
  });

  it("counts a practice report from 4 PM ET on its day", () => {
    const kickoff = Date.parse(SUNDAY);
    // Wednesday 1 AM and 2 PM ET: Wednesday's report isn't out yet.
    expect(latestPracticeReport(kickoff, Date.parse("2026-10-28T05:00:00.000Z"))).toBeUndefined();
    expect(latestPracticeReport(kickoff, Date.parse("2026-10-28T18:00:00.000Z"))).toBeUndefined();
    // Wednesday 6 PM ET: it is, from 4 PM ET (20:00 UTC in daylight time).
    expect(latestPracticeReport(kickoff, Date.parse("2026-10-28T22:00:00.000Z"))).toBe(
      Date.parse("2026-10-28T20:00:00.000Z"),
    );
  });

  it("skips stale checks without a game or news date", () => {
    const [s] = [p("WR", "No news", "WR", 10, { status: "QUESTIONABLE" })];
    expect(staleTag(s!.player, NOW.getTime())).toBeUndefined();
  });

  it("gives every promotion a reason", () => {
    const r = optimizeLineup(
      roster([p("RB", "Hurt RB", "RB", 9, { status: "OUT" })], [p("BE", "Bench RB", "RB", 8)]),
      { RB: 1, FLEX: 1 },
    );
    expect(r.moves.every((m) => m.reason.length > 0)).toBe(true);
  });
});
