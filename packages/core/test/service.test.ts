import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EspnClient } from "@nscaamano/espn-fantasy-client";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../../espn-client/test/fixtures.js";
import { loadConfig, type LeaguesConfig } from "../src/config.js";
import { toPendingClaim } from "../src/map.js";
import { FantasyService } from "../src/service.js";

const config = (myTeamId = 2): LeaguesConfig => ({
  leagues: [{ alias: "test", leagueId: 1234, year: 2018, myTeamId, rules: {} }],
});

function service(myTeamId = 2) {
  const { fetch, calls } = fixtureFetch();
  return { svc: new FantasyService(new EspnClient({ fetch }), config(myTeamId)), calls };
}

describe("FantasyService", () => {
  it("lists leagues with format and roster shape", async () => {
    const [league] = await service().svc.listLeagues();
    expect(league).toMatchObject({
      alias: "test",
      myTeamId: 2,
      size: 10,
      scoringFormat: "PPR",
      waiverType: "PRIORITY",
      superflex: false,
      hasDst: true,
      hasK: true,
    });
  });

  it("resolves leagues by alias case-insensitively, and explains unknown ones", async () => {
    const { svc } = service();
    await expect(svc.getLeagueSettings("TEST")).resolves.toMatchObject({ league: "test" });
    await expect(svc.getLeagueSettings("nope")).rejects.toThrow(/Known leagues: test/);
  });

  it("returns settings with rules sources and my waiver rank", async () => {
    const s = await service().svc.getLeagueSettings("test");
    expect(s.roster).toMatchObject({ benchSize: 6, irSlots: 0, slots: { QB: 1, FLEX: 1 } });
    expect(s.waivers).toMatchObject({ type: "PRIORITY", myWaiverRank: 5, faabRemaining: null });
    expect(s.ruleSources["scoring.receptionPoints"]).toBe("espn");
    expect(s.teams.filter((t) => t.isMine).map((t) => t.id)).toEqual([2]);
  });

  it("rejects a myTeamId that isn't in the league", async () => {
    await expect(service(99).svc.getLeagueSettings("test")).rejects.toThrow(
      /myTeamId 99 isn't in test/,
    );
  });

  it("splits my roster into starters, bench and IR with bye weeks", async () => {
    const roster = await service(1).svc.getMyRoster("test", 1);
    expect(roster.teamName).toBe("Goin' HAM Newton");
    expect(roster.starters.map((s) => s.slot)).toEqual([
      "QB",
      "RB",
      "RB",
      "WR",
      "WR",
      "TE",
      "FLEX",
      "D/ST",
      "K",
    ]);
    expect(roster.bench).toHaveLength(6);
    const brown = roster.starters.find((s) => s.player.name === "Antonio Brown")!;
    expect(brown.player).toMatchObject({
      proTeam: "PIT",
      injuryStatus: "ACTIVE",
      byeWeek: 9,
      // Fixture schedule is the 2024 one: PIT at ATL, week 1.
      game: { opponent: "ATL", home: false, kickoff: "2024-09-08T17:00:00.000Z" },
    });
    expect(brown.player.eligibleSlots).not.toContain("BE");
  });

  it("gives players no game in a week the schedule doesn't cover", async () => {
    const roster = await service(1).svc.getMyRoster("test", 2);
    expect(roster.starters.every((s) => s.player.game === null)).toBe(true);
  });

  it("returns my matchup with both starting lineups", async () => {
    const m = await service(11).svc.getMatchup("test", 13);
    expect(m.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.week).toBe(13);
    expect(m.me).toMatchObject({ teamId: 11, score: 128 });
    expect(m.opponent).toMatchObject({ teamId: 2, score: 151.8 });
    expect(m.me.starters.every((s) => s.slot !== "BE")).toBe(true);
  });

  it("sorts free agents by projection and trims to the limit", async () => {
    const { svc, calls } = service();
    const fas = await svc.getFreeAgents("test", "WR", 5, 1);
    expect(fas).toHaveLength(5);
    const proj = fas.map((f) => f.projectedPoints ?? -1);
    expect(proj).toEqual([...proj].sort((a, b) => b - a));
    expect(fas[0]).toMatchObject({ status: "FREE_AGENT" });
    // Asks ESPN for a wider pool than the limit, to re-sort by projection.
    const req = calls.find((c) => c.url.searchParams.getAll("view").includes("kona_player_info"))!;
    expect(JSON.parse(req.headers["x-fantasy-filter"]!).players.limit).toBe(50);
  });

  it("looks up a rostered player with his team and slot", async () => {
    const { svc, calls } = service();
    const found = await svc.getPlayer("test", "Antonio Brown", 5, 1);
    expect(found).toMatchObject({
      league: "test",
      query: "Antonio Brown",
      week: 1,
      totalMatches: 1,
    });
    expect(found.players[0]).toMatchObject({
      name: "Antonio Brown",
      status: "ROSTERED",
      team: { id: 1, name: "Goin' HAM Newton", slot: "WR", isMine: false },
      projectedPoints: 18.5,
      actualPoints: 22.4,
      seasonPoints: 323.7,
      positionalRank: 3,
      waiverClears: null,
      game: { opponent: "ATL" },
    });
    // The slot comes from the owner's roster alone.
    const rosterReqs = calls.filter((c) => c.url.searchParams.getAll("view").includes("mRoster"));
    expect(rosterReqs.map((c) => c.url.searchParams.get("forTeamId"))).toEqual(["1"]);
  });

  it("returns every player sharing a name, marking the user's", async () => {
    const found = await service(2).svc.getPlayer("test", "pat sample", 5, 1);
    expect(found.totalMatches).toBe(2);
    expect(found.players.map((p) => [p.position, p.status, p.team])).toEqual([
      ["RB", "FREE_AGENT", null],
      // Not on team 2's fixture roster, so the slot is unknown.
      ["TE", "ROSTERED", { id: 2, name: expect.any(String), slot: null, isMine: true }],
    ]);
  });

  it("reports when a waiver player clears, and trims a partial name's matches", async () => {
    const svc = service().svc;
    const [tester] = (await svc.getPlayer("test", "AJ Tester", 5, 1)).players;
    expect(tester).toMatchObject({
      status: "WAIVERS",
      team: null,
      waiverClears: "2018-09-11T08:00:00.000Z",
      injuryStatus: "QUESTIONABLE",
    });
    const pat = await svc.getPlayer("test", "Pat", 2, 1);
    expect(pat.players).toHaveLength(2);
    expect(pat.totalMatches).toBe(3);
  });

  it("returns no players for an unknown name", async () => {
    const found = await service().svc.getPlayer("test", "Nobody Atall", 5, 1);
    expect(found).toMatchObject({ players: [], totalMatches: 0 });
  });

  it("maps injury statuses to the schema's enum", async () => {
    const fas = await service().svc.getFreeAgents("test", "WR", 8, 1);
    const statuses = new Set(fas.map((f) => f.injuryStatus));
    expect(statuses.has("IR")).toBe(true);
    expect([...statuses].every((s) => ["ACTIVE", "QUESTIONABLE", "OUT", "IR"].includes(s))).toBe(
      true,
    );
  });

  it("names teams in recent activity", async () => {
    const tx = await service().svc.getRecentActivity("test", 6);
    expect(tx).toHaveLength(6);
    expect(tx[0]!.items[0]).toMatchObject({ action: "ADD", team: expect.any(String) });
    expect(tx[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops ESPN's placeholder $0 bids in a priority-waiver league", async () => {
    const tx = await service().svc.getRecentActivity("test", 6);
    expect(tx[5]!.items[0]).toMatchObject({ action: "WAIVER_ADD", bid: null });
  });

  it("caches league settings between calls", async () => {
    const { svc, calls } = service();
    await svc.getLeagueSettings("test");
    await svc.getLeagueSettings("test");
    expect(
      calls.filter((c) => c.url.searchParams.getAll("view").includes("mSettings")),
    ).toHaveLength(1);
  });

  it("saves a confirmed rule to leagues.json and applies it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
    const path = join(dir, "leagues.json");
    writeFileSync(path, JSON.stringify(config()));
    const { fetch } = fixtureFetch();
    const svc = new FantasyService(new EspnClient({ fetch }), loadConfig(path), {
      configPath: path,
      now: () => new Date("2026-10-07T12:00:00Z"),
    });

    svc.setLeagueRule("test", "waivers.type", "FAAB", "user");

    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.leagues[0].rules["waivers.type"]).toEqual({
      value: "FAAB",
      source: "user",
      confirmed: "2026-10-07",
    });
    const s = await svc.getLeagueSettings("test");
    expect(s.waivers.type).toBe("FAAB");
    expect(s.conflicts).toHaveLength(1);
  });

  it("rejects a rule value that doesn't fit the settings schema, without saving it", () => {
    const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
    const path = join(dir, "leagues.json");
    writeFileSync(path, JSON.stringify(config()));
    const { fetch } = fixtureFetch();
    const svc = new FantasyService(new EspnClient({ fetch }), loadConfig(path), {
      configPath: path,
    });

    expect(() => svc.setLeagueRule("test", "waivers.type", "faab", "user")).toThrow(
      /Invalid value for waivers.type/,
    );
    expect(() => svc.setLeagueRule("test", "waivers.faabBudget", null, "user")).toThrow(
      /Invalid value/,
    );
    expect(svc.setLeagueRule("test", "roster.slots", { QB: 1, OP: 1 }, "upload")).toMatchObject({
      value: { QB: 1, OP: 1 },
      source: "upload",
    });
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).leagues[0].rules)).toEqual([
      "roster.slots",
    ]);
  });
});

describe("FantasyService.getWaiverResults", () => {
  it("reports my claims in the latest run, in a priority league, with my waiver rank", async () => {
    const { svc, calls } = service(2);
    const r = await svc.getWaiverResults("test", 8);
    expect(calls.some((c) => c.url.searchParams.get("scoringPeriodId") === "8")).toBe(true);
    expect(r).toMatchObject({
      league: "test",
      week: 8,
      processedAt: "2026-10-28T07:20:36.575Z",
      usesFaab: false,
      waiverRank: 5,
    });
    expect(r.claims.map((c) => [c.result, c.add?.name, c.wonBy?.team ?? c.reason])).toEqual([
      ["WON", "James Conner", null],
      ["LOST", "Player 101", "Watch What You Saquon"],
      ["FAILED", "Player 102", "FAILED_ROSTERLIMIT"],
      ["CANCELED", "Player 103", null],
    ]);
    // Priority league: no bids, not even the winner's.
    expect(r.claims.every((c) => c.bid === null && (c.wonBy?.bid ?? null) === null)).toBe(true);
  });
});

describe("FantasyService.getPendingClaims", () => {
  it("returns my queued claims with ISO times and no bid in a priority league", async () => {
    const claims = await service(1).svc.getPendingClaims("test");
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual({
      type: "WAIVER",
      add: { name: "Player 4571557", position: null, proTeam: null },
      drop: { name: "Player 4034949", position: null, proTeam: null, slot: "K" },
      bid: null,
      proposedAt: "2026-10-13T18:07:18.126Z",
      processesAt: "2026-10-14T07:00:00.000Z",
    });
  });

  it("returns an empty list when only other teams have claims", async () => {
    await expect(service(2).svc.getPendingClaims("test")).resolves.toEqual([]);
  });

  it("keeps the bid in a FAAB league", () => {
    const claim = toPendingClaim(
      {
        id: null,
        type: "WAIVER",
        teamId: 1,
        bid: 5,
        proposedDate: null,
        processDate: null,
        add: null,
        drop: null,
      },
      true,
    );
    expect(claim).toMatchObject({ bid: 5, add: null, drop: null, processesAt: null });
  });
});

describe("FantasyService across leagues and teams", () => {
  it("returns every league's matchup, and lists a league that fails instead of throwing", async () => {
    const { fetch } = fixtureFetch();
    const svc = new FantasyService(new EspnClient({ fetch }), {
      leagues: [
        { alias: "one", leagueId: 1, year: 2018, myTeamId: 11, rules: {} },
        // Team 99 has no matchup in the fixture, like a bye week.
        { alias: "two", leagueId: 2, year: 2018, myTeamId: 99, rules: {} },
      ],
    });
    const board = await svc.getScoreboard(13);
    expect(board.matchups.map((m) => m.league)).toEqual(["one"]);
    expect(board.matchups[0]!.me.teamId).toBe(11);
    expect(board.errors).toEqual([{ league: "two", error: expect.stringMatching(/No matchup/) }]);
  });

  it("suggests free agents for a slot the roster can't fill", async () => {
    const { fetch } = fixtureFetch();
    // A stored rule asking for more RBs than the roster has forces an empty slot.
    const slots = { QB: 1, RB: 8, WR: 2, TE: 1, FLEX: 1, "D/ST": 1, K: 1 };
    const svc = new FantasyService(new EspnClient({ fetch }), {
      leagues: [
        {
          alias: "test",
          leagueId: 1234,
          year: 2018,
          myTeamId: 1,
          rules: { "roster.slots": { value: slots, source: "user", confirmed: "2026-10-25" } },
        },
      ],
    });
    const lineup = await svc.getOptimalLineup("test", 1);
    const empty = lineup.risks.filter((r) => r.type === "EMPTY_SLOT");
    expect(empty.length).toBeGreaterThan(0);
    for (const r of empty) {
      expect(r.slot).toBe("RB");
      expect(r.freeAgents!.length).toBeGreaterThan(0);
      expect(r.freeAgents!.length).toBeLessThanOrEqual(3);
      expect(r.freeAgents![0]).toMatchObject({
        name: expect.any(String),
        status: expect.any(String),
      });
    }
    // Risks that aren't holes get no suggestions.
    for (const r of lineup.risks.filter((x) => x.type === "GAME_TIME")) {
      expect(r.freeAgents).toBeUndefined();
    }
  });

  it("lists the league's teams with mine marked", async () => {
    const teams = await service(2).svc.getTeams("test");
    expect(teams).toHaveLength(10);
    expect(teams.filter((t) => t.isMine).map((t) => t.id)).toEqual([2]);
  });

  it("sorts free agents by season projection when asked", async () => {
    const fas = await service().svc.getFreeAgents("test", "WR", 8, 1, "season");
    const season = fas.map((f) => f.seasonProjectedPoints ?? -1);
    expect(season).toEqual([...season].sort((a, b) => b - a));
  });

  it("carries lastNewsDate and a read time on rosters", async () => {
    const roster = await service(1).svc.getMyRoster("test", 1);
    expect(roster.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const all = [...roster.starters, ...roster.bench];
    expect(all.some((s) => s.player.lastNewsDate !== null)).toBe(true);
  });
});

describe("loadConfig", () => {
  it("rejects placeholder ids with a hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
    const path = join(dir, "leagues.json");
    writeFileSync(path, readFileSync(join(import.meta.dirname, "../../../leagues.example.json")));
    expect(() => loadConfig(path)).toThrow(/set leagueId/);
  });
});
