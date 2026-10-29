import { describe, expect, it } from "vitest";
import type { EspnTransaction } from "@nscaamano/espn-fantasy-client";
import { lockAtKickoff, toWaiverResults } from "../src/map.js";
import type { RosterSlot } from "../src/schemas.js";

const slot = (kickoff: string | null, locked = false): RosterSlot => ({
  slot: "WR",
  locked,
  droppable: !locked,
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
    seasonProjectedPoints: 120,
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

  it("makes a player undroppable once his game kicks off", () => {
    const s = lockAtKickoff(slot("2026-10-25T17:00:00.000Z"), now);
    expect(s).toMatchObject({ locked: true, droppable: false });
  });
});

describe("toWaiverResults", () => {
  const RUN = Date.parse("2026-10-28T07:20:00.000Z");
  const player = (playerId: number) => ({
    playerId,
    playerName: `Player ${playerId}`,
    position: "WR",
    proTeam: "TST",
    fromSlot: null,
  });
  const tx = (over: Partial<EspnTransaction> & { teamId: number }): EspnTransaction => ({
    id: null,
    type: "WAIVER",
    bid: 0,
    proposedDate: RUN,
    processDate: RUN,
    add: null,
    drop: null,
    status: "EXECUTED",
    executionType: "PROCESS",
    relatedId: null,
    ...over,
  });
  const names = (id: number) => `Team ${id}`;

  it("names who got a lost player and their winning bid in a FAAB league", () => {
    const { processedAt, claims } = toWaiverResults(
      [
        tx({ teamId: 8, bid: 40, add: player(1) }),
        tx({
          teamId: 1,
          bid: 8,
          add: player(1),
          drop: player(9),
          status: "FAILED_INVALIDPLAYERSOURCE",
        }),
        tx({ teamId: 1, bid: 5, add: player(2), processDate: RUN + 30_000 }),
      ],
      1,
      true,
      names,
    );
    expect(processedAt).toBe("2026-10-28T07:20:30.000Z");
    expect(claims).toEqual([
      {
        result: "WON",
        add: expect.objectContaining({ name: "Player 2" }),
        drop: null,
        bid: 5,
        wonBy: null,
        reason: null,
      },
      {
        result: "LOST",
        add: expect.objectContaining({ name: "Player 1" }),
        drop: expect.objectContaining({ name: "Player 9" }),
        bid: 8,
        wonBy: { team: "Team 8", bid: 40 },
        reason: null,
      },
    ]);
  });

  it("drops the $0 bids of a priority league", () => {
    const { claims } = toWaiverResults(
      [
        tx({ teamId: 8, add: player(1) }),
        tx({ teamId: 1, add: player(1), status: "FAILED_INVALIDPLAYERSOURCE" }),
      ],
      1,
      false,
      names,
    );
    expect(claims[0]).toMatchObject({
      result: "LOST",
      bid: null,
      wonBy: { team: "Team 8", bid: null },
    });
  });

  it("explains a claim that lost to another of the user's own claims", () => {
    const { claims } = toWaiverResults(
      [
        tx({ teamId: 1, add: player(1), drop: player(9) }),
        tx({ teamId: 1, add: player(1), drop: player(10), status: "FAILED_INVALIDPLAYERSOURCE" }),
      ],
      1,
      true,
      names,
    );
    expect(claims[1]).toMatchObject({
      result: "FAILED",
      reason: "another of your claims added him first",
    });
  });

  it("takes a canceled claim's bid from the proposal it canceled", () => {
    const { claims } = toWaiverResults(
      [
        tx({ teamId: 8, add: player(5) }),
        tx({
          id: "p1",
          teamId: 1,
          bid: 3,
          add: player(1),
          status: "PENDING",
          executionType: "EXECUTE",
          processDate: null,
        }),
        tx({
          teamId: 1,
          add: player(1),
          status: "CANCELED",
          executionType: "CANCEL",
          processDate: null,
          relatedId: "p1",
          proposedDate: RUN - 1000,
        }),
      ],
      1,
      true,
      names,
    );
    expect(claims).toEqual([expect.objectContaining({ result: "CANCELED", bid: 3 })]);
  });

  it("reports the user's latest run when a later daily run had none of their claims", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const { processedAt, claims } = toWaiverResults(
      [
        tx({ teamId: 1, bid: 5, add: player(1) }),
        tx({ teamId: 8, bid: 2, add: player(2), processDate: RUN + DAY }),
      ],
      1,
      true,
      names,
    );
    expect(processedAt).toBe("2026-10-28T07:20:00.000Z");
    expect(claims).toEqual([expect.objectContaining({ result: "WON", bid: 5 })]);
  });

  it("gives the latest run's time when the user had no claims this week", () => {
    expect(toWaiverResults([tx({ teamId: 8, add: player(2) })], 1, true, names)).toEqual({
      processedAt: "2026-10-28T07:20:00.000Z",
      claims: [],
    });
  });

  it("is empty before any run", () => {
    expect(
      toWaiverResults(
        [tx({ teamId: 1, status: "PENDING", executionType: "EXECUTE", processDate: null })],
        1,
        true,
        names,
      ),
    ).toEqual({ processedAt: null, claims: [] });
  });
});
