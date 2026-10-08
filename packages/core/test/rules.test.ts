import { describe, expect, it } from "vitest";
import type { LeagueSettings } from "../src/schemas.js";
import { applyRules } from "../src/rules.js";

type Base = Omit<LeagueSettings, "ruleSources" | "missingRules" | "conflicts">;

const base: Base = {
  league: "ppr",
  leagueId: 1,
  year: 2026,
  name: "Test League",
  size: 10,
  currentWeek: 5,
  myTeamId: 3,
  scoring: { type: "H2H_POINTS", format: "PPR", receptionPoints: 1, items: [] },
  roster: {
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, "D/ST": 1, K: 1 },
    benchSize: 7,
    benchUnlimited: false,
    irSlots: 1,
    superflex: false,
    hasDst: true,
    hasK: true,
    positionLimits: {},
  },
  waivers: {
    type: "PRIORITY",
    faabBudget: null,
    faabRemaining: null,
    minimumBid: null,
    myWaiverRank: 4,
    waiverHours: 24,
    processDays: ["WEDNESDAY"],
    processHour: 3,
    priorityResets: true,
    seasonAcquisitionLimit: null,
  },
  lineupLock: "INDIVIDUAL_GAME",
  trades: { deadline: null, vetoVotesRequired: 4, reviewHours: 48 },
  schedule: {
    regularSeasonWeeks: 14,
    playoffTeams: 4,
    playoffStartWeek: 15,
    playoffMatchupLength: 1,
  },
  teams: [],
};

describe("applyRules", () => {
  it("tags ESPN values and lists what's missing", () => {
    const s = applyRules(base, {});
    expect(s.ruleSources["waivers.type"]).toBe("espn");
    expect(s.missingRules).toEqual(["trades.deadline"]);
    expect(s.conflicts).toEqual([]);
  });

  it("doesn't ask for FAAB rules in a priority-waiver league", () => {
    expect(applyRules(base, {}).missingRules).not.toContain("waivers.faabBudget");
  });

  it("asks for FAAB budget in a FAAB league when ESPN omits it", () => {
    const faab = {
      ...base,
      waivers: { ...base.waivers, type: "FAAB" as const, priorityResets: null },
    };
    const s = applyRules(faab, {});
    expect(s.missingRules).toContain("waivers.faabBudget");
    expect(s.missingRules).not.toContain("waivers.priorityResets");
  });

  it("lets a stored value fill a gap", () => {
    const s = applyRules(base, {
      "trades.deadline": {
        value: "2026-11-25T17:00:00.000Z",
        source: "upload",
        confirmed: "2026-10-07",
      },
    });
    expect(s.trades.deadline).toBe("2026-11-25T17:00:00.000Z");
    expect(s.ruleSources["trades.deadline"]).toBe("upload");
    expect(s.missingRules).toEqual([]);
  });

  it("lets a stored null confirm that a rule doesn't exist", () => {
    const s = applyRules(base, {
      "trades.deadline": { value: null, source: "user", confirmed: "2026-10-07" },
    });
    expect(s.missingRules).toEqual([]);
  });

  it("overrides ESPN with a stored value and reports the disagreement", () => {
    const s = applyRules(base, {
      "waivers.type": { value: "FAAB", source: "user", confirmed: "2026-10-07" },
    });
    expect(s.waivers.type).toBe("FAAB");
    expect(s.ruleSources["waivers.type"]).toBe("user");
    expect(s.conflicts).toEqual([
      { rule: "waivers.type", espn: "PRIORITY", stored: "FAAB", storedSource: "user" },
    ]);
  });

  it("treats objects with the same keys in a different order as equal", () => {
    const s = applyRules(base, {
      "roster.slots": {
        value: { K: 1, "D/ST": 1, FLEX: 1, TE: 1, WR: 2, RB: 2, QB: 1 },
        source: "upload",
        confirmed: "2026-10-07",
      },
    });
    expect(s.conflicts).toEqual([]);
  });

  it("doesn't mutate its input", () => {
    const copy = structuredClone(base);
    applyRules(base, {
      "waivers.type": { value: "FAAB", source: "user", confirmed: "2026-10-07" },
    });
    expect(base).toEqual(copy);
  });
});
