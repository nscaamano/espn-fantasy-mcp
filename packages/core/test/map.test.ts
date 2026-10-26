import { describe, expect, it } from "vitest";
import { lockAtKickoff } from "../src/map.js";
import type { RosterSlot } from "../src/schemas.js";

const slot = (kickoff: string | null, locked = false): RosterSlot => ({
  slot: "WR",
  locked,
  player: {
    id: 1,
    name: "Test Receiver",
    position: "WR",
    proTeam: "TST",
    injuryStatus: "ACTIVE",
    byeWeek: 14,
    game: kickoff ? { opponent: "OPP", home: true, kickoff } : null,
    projectedPoints: 10,
    actualPoints: null,
    percentRostered: 50,
    lastNewsDate: null,
    eligibleSlots: ["WR", "FLEX"],
  },
});

describe("lockAtKickoff", () => {
  const now = new Date("2026-10-25T18:00:00Z");

  it("locks a player whose game has kicked off", () => {
    expect(lockAtKickoff(slot("2026-10-25T17:00:00.000Z"), now).locked).toBe(true);
  });

  it("leaves a later game unlocked, and a bye alone", () => {
    expect(lockAtKickoff(slot("2026-10-26T00:20:00.000Z"), now).locked).toBe(false);
    expect(lockAtKickoff(slot(null), now).locked).toBe(false);
  });

  it("never unlocks what ESPN already locked", () => {
    expect(lockAtKickoff(slot("2026-10-26T00:20:00.000Z", true), now).locked).toBe(true);
  });
});
