import { describe, expect, it } from "vitest";
import type { EspnTransaction } from "@nscaamano/espn-fantasy-client";
import { faabPrices, median, winningClaims, type WeekLog } from "../src/faab.js";

const RUN = Date.parse("2026-10-28T07:20:00Z");
let nextId = 0;

/** A waiver run's PROCESS record for one claim. */
function claim(
  teamId: number,
  playerId: number,
  position: string | null,
  bid: number,
  status = "EXECUTED",
  processDate = RUN,
): EspnTransaction {
  return {
    id: `tx-${++nextId}`,
    type: "WAIVER",
    teamId,
    bid,
    proposedDate: processDate - 86_400_000,
    processDate,
    add: {
      playerId,
      playerName: `Player ${playerId}`,
      position,
      proTeam: "TST",
      fromSlot: null,
    },
    drop: null,
    status,
    executionType: "PROCESS",
    relatedId: `proposal-${nextId}`,
  };
}

const teamName = (id: number) => `Team ${id}`;
const opts = { usesFaab: true, bidsPerPosition: 5, teamName };

describe("winningClaims", () => {
  it("pairs each win with the bids other teams lost with in the same run", () => {
    const [win] = winningClaims([
      {
        week: 8,
        transactions: [
          claim(1, 10, "WR", 40),
          claim(2, 10, "WR", 26, "FAILED_INVALIDPLAYERSOURCE"),
          claim(3, 10, "WR", 8, "FAILED_INVALIDPLAYERSOURCE"),
          // Not competition: the same team's backup claim, a claim that failed
          // on its own, and another run's claim.
          claim(1, 10, "WR", 30, "FAILED_INVALIDPLAYERSOURCE"),
          claim(4, 10, "WR", 45, "FAILED_ROSTERLIMIT"),
          claim(5, 10, "WR", 50, "FAILED_INVALIDPLAYERSOURCE", RUN - 2 * 86_400_000),
        ],
      },
    ]);
    expect(win).toMatchObject({ teamId: 1, bid: 40, runnerUp: 26, bidders: 3, week: 8 });
  });

  it("ignores proposals, cancellations, free-agent adds and failures", () => {
    const proposal = { ...claim(1, 11, "RB", 9), executionType: "EXECUTE", status: "PENDING" };
    const freeAgent = { ...claim(1, 12, "RB", 0), type: "FREEAGENT", executionType: "EXECUTE" };
    const lost = claim(2, 13, "RB", 5, "FAILED_INVALIDPLAYERSOURCE");
    expect(winningClaims([{ week: 3, transactions: [proposal, freeAgent, lost] }])).toEqual([]);
  });

  it("counts a record that shows up in two weeks' logs once, under the earlier week", () => {
    const win = claim(1, 14, "TE", 6);
    const wins = winningClaims([
      { week: 5, transactions: [win] },
      { week: 4, transactions: [win] },
    ]);
    expect(wins.map((w) => w.week)).toEqual([4]);
  });
});

describe("median", () => {
  it("takes the middle value, or the mean of the middle two", () => {
    expect(median([])).toBeNull();
    expect(median([7, 1, 3])).toBe(3);
    expect(median([10, 1, 4, 20])).toBe(7);
  });
});

describe("faabPrices", () => {
  const logs: WeekLog[] = [
    {
      week: 7,
      transactions: [
        claim(1, 20, "QB", 20, "EXECUTED", RUN - 7 * 86_400_000),
        claim(2, 20, "QB", 3, "FAILED_INVALIDPLAYERSOURCE", RUN - 7 * 86_400_000),
        claim(3, 21, "D/ST", 1, "EXECUTED", RUN - 7 * 86_400_000),
      ],
    },
    {
      week: 8,
      transactions: [
        claim(2, 22, "QB", 5),
        claim(4, 23, "QB", 9),
        claim(1, 24, "RB", 12),
        claim(5, 25, "WR", 2),
        claim(6, 26, null, 30),
      ],
    },
  ];

  it("groups wins by position in roster order, with stats and the top bids", () => {
    const { all, positions } = faabPrices(winningClaims(logs), opts);
    expect(positions.map((p) => p.position)).toEqual(["QB", "RB", "WR", "D/ST"]);
    expect(positions[0]).toEqual({
      position: "QB",
      wins: 3,
      contested: 1,
      median: 9,
      min: 5,
      max: 20,
      bids: [
        {
          player: "Player 20",
          proTeam: "TST",
          week: 7,
          bid: 20,
          runnerUp: 3,
          bidders: 2,
          team: "Team 1",
        },
        expect.objectContaining({ bid: 9, runnerUp: null, bidders: 1, team: "Team 4" }),
        expect.objectContaining({ bid: 5 }),
      ],
    });
    // The unnamed player (no position) is left out everywhere.
    expect(all).toEqual({ wins: 6, contested: 1, median: 7, min: 1, max: 20 });
  });

  it("caps the bid list, highest first, the most recent on ties", () => {
    const tie = [
      { week: 6, transactions: [claim(1, 30, "WR", 4, "EXECUTED", RUN - 14 * 86_400_000)] },
      { week: 8, transactions: [claim(2, 31, "WR", 4), claim(3, 32, "WR", 1)] },
    ];
    const [wr] = faabPrices(winningClaims(tie), { ...opts, bidsPerPosition: 2 }).positions;
    expect(wr!.wins).toBe(3);
    expect(wr!.bids.map((b) => [b.player, b.week])).toEqual([
      ["Player 31", 8],
      ["Player 30", 6],
    ]);
  });

  it("filters to one position", () => {
    const { all, positions } = faabPrices(winningClaims(logs), { ...opts, position: "RB" });
    expect(positions.map((p) => p.position)).toEqual(["RB"]);
    expect(all).toMatchObject({ wins: 1, median: 12 });
  });

  it("gives counts only in a priority league", () => {
    const { all, positions } = faabPrices(winningClaims(logs), { ...opts, usesFaab: false });
    expect(all).toEqual({ wins: 6, contested: 1, median: null, min: null, max: null });
    expect(positions[0]).toMatchObject({ position: "QB", wins: 3, median: null, bids: [] });
  });
});
