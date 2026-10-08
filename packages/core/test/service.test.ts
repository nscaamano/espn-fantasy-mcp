import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EspnClient } from "@espn-fantasy-mcp/espn-client";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../../espn-client/test/fixtures.js";
import { loadConfig, type LeaguesConfig } from "../src/config.js";
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
      byeWeek: expect.any(Number),
    });
    expect(brown.player.eligibleSlots).not.toContain("BE");
  });

  it("returns my matchup with both starting lineups", async () => {
    const m = await service(11).svc.getMatchup("test", 13);
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

describe("loadConfig", () => {
  it("rejects placeholder ids with a hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
    const path = join(dir, "leagues.json");
    writeFileSync(path, readFileSync(join(import.meta.dirname, "../../../leagues.example.json")));
    expect(() => loadConfig(path)).toThrow(/set leagueId/);
  });
});
