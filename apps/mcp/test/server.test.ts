import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FantasyService, loadConfig, type LeaguesConfig } from "@nscaamano/espn-fantasy-core";
import { EspnClient } from "@nscaamano/espn-fantasy-client";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../../../packages/espn-client/test/fixtures.js";
import { envWithDotenv, serviceLoader } from "../src/load.js";
import { createServer } from "../src/server.js";

const config = (myTeamId = 1): LeaguesConfig => ({
  leagues: [{ alias: "test", leagueId: 1234, year: 2018, myTeamId, rules: {} }],
});

function tempConfig(myTeamId = 1) {
  const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
  const path = join(dir, "leagues.json");
  writeFileSync(path, JSON.stringify(config(myTeamId)));
  return { dir, path };
}

async function connect(myTeamId = 1) {
  const { path } = tempConfig(myTeamId);
  const { fetch } = fixtureFetch();
  const svc = new FantasyService(new EspnClient({ fetch }), loadConfig(path), {
    configPath: path,
  });
  const server = createServer(() => svc);
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.find((c) => c.type === "text");
    return { ...res, text: text?.type === "text" ? text.text : undefined };
  };
  return { client, call, path };
}

describe("MCP server", () => {
  it("lists the tools with input and output schemas, reads marked read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_free_agents",
      "get_league_settings",
      "get_matchup",
      "get_my_roster",
      "get_optimal_lineup",
      "get_pending_claims",
      "get_recent_activity",
      "get_scoreboard",
      "get_team_roster",
      "get_teams",
      "get_waiver_results",
      "list_leagues",
      "set_league_rule",
    ]);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.outputSchema?.type).toBe("object");
      expect(t.annotations?.readOnlyHint).toBe(t.name !== "set_league_rule");
    }
    const fa = tools.find((t) => t.name === "get_free_agents")!;
    expect(fa.inputSchema.required).toEqual(["league"]);
  });

  it("returns structured content and the same JSON as text", async () => {
    const { call } = await connect();
    const res = await call("list_leagues");
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      leagues: [{ alias: "test", scoringFormat: "PPR", waiverType: "PRIORITY" }],
    });
    expect(JSON.parse(res.text!)).toEqual(res.structuredContent);
  });

  it("returns my roster for a week", async () => {
    const { call } = await connect();
    const res = await call("get_my_roster", { league: "test", week: 1 });
    expect(res.structuredContent).toMatchObject({ teamId: 1, teamName: "Goin' HAM Newton" });
  });

  it("returns every league in get_scoreboard, with unreadable leagues as errors", async () => {
    const { call } = await connect();
    // Team 1 has no matchup in the week 13 fixture.
    const res = await call("get_scoreboard", { week: 13 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      matchups: [],
      errors: [{ league: "test", error: expect.stringMatching(/No matchup/) }],
    });
  });

  it("returns an optimal lineup that fills the league's starting slots", async () => {
    const { call } = await connect();
    const res = await call("get_optimal_lineup", { league: "test", week: 1 });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {
      starters: { slot: string }[];
      projectedTotal: number;
      currentProjectedTotal: number;
    };
    // The fixture league starts QB, 2 RB, 2 WR, TE, FLEX, D/ST and K.
    expect(out.starters).toHaveLength(9);
    expect(out.projectedTotal).toBeGreaterThanOrEqual(out.currentProjectedTotal - 0.01);
  });

  it("lists teams and returns another team's roster", async () => {
    const { call } = await connect();
    const teams = await call("get_teams", { league: "test" });
    const list = (teams.structuredContent as { teams: { id: number; isMine: boolean }[] }).teams;
    const other = list.find((t) => !t.isMine)!;
    const roster = await call("get_team_roster", { league: "test", teamId: other.id, week: 1 });
    expect(roster.isError).toBeFalsy();
    expect(roster.structuredContent).toMatchObject({ teamId: other.id, asOf: expect.any(String) });
  });

  it("accepts a season sort for free agents and rejects an unknown one", async () => {
    const { call } = await connect();
    const ok = await call("get_free_agents", { league: "test", position: "WR", sort: "season" });
    expect(ok.isError).toBeFalsy();
    const bad = await call("get_free_agents", { league: "test", sort: "vibes" });
    expect(bad.isError).toBe(true);
  });

  it("wraps free agents and applies the default limit", async () => {
    const { call } = await connect();
    const res = await call("get_free_agents", { league: "test", position: "WR", limit: 3 });
    const out = res.structuredContent as { position: string; freeAgents: unknown[] };
    expect(out.position).toBe("WR");
    expect(out.freeAgents).toHaveLength(3);
  });

  it("returns my pending claims, and an empty list when none are queued", async () => {
    const mine = await (await connect(1)).call("get_pending_claims", { league: "test" });
    expect(mine.isError).toBeFalsy();
    const out = mine.structuredContent as { league: string; claims: { bid: unknown }[] };
    expect(out.league).toBe("test");
    expect(out.claims).toHaveLength(2);
    expect(out.claims[0]).toMatchObject({ type: "WAIVER", bid: null, drop: { slot: "K" } });

    const none = await (await connect(2)).call("get_pending_claims", { league: "test" });
    expect(none.structuredContent).toEqual({ league: "test", claims: [] });
  });

  it("returns my waiver results for a week", async () => {
    const res = await (await connect(2)).call("get_waiver_results", { league: "test", week: 8 });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { processedAt: string; claims: { result: string }[] };
    expect(out.processedAt).toBe("2026-10-28T07:20:36.575Z");
    expect(out.claims.map((c) => c.result)).toEqual(["WON", "LOST", "FAILED", "CANCELED"]);
  });

  it("rejects an unknown position before calling ESPN", async () => {
    const { call } = await connect();
    const res = await call("get_free_agents", { league: "test", position: "LB" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/position/);
  });

  it("turns service errors into tool errors with the message", async () => {
    const { call } = await connect();
    const res = await call("get_league_settings", { league: "nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Known leagues: test/);
  });

  it("saves a rule to leagues.json and rejects one of the wrong type", async () => {
    const { call, path } = await connect();
    const ok = await call("set_league_rule", {
      league: "test",
      rule: "waivers.type",
      value: "FAAB",
      source: "user",
    });
    expect(ok.structuredContent).toMatchObject({ stored: { value: "FAAB", source: "user" } });
    expect(JSON.parse(readFileSync(path, "utf8")).leagues[0].rules["waivers.type"].value).toBe(
      "FAAB",
    );

    const bad = await call("set_league_rule", {
      league: "test",
      rule: "waivers.faabBudget",
      value: "lots",
      source: "user",
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Invalid value for waivers.faabBudget/);
  });
});

describe("serviceLoader", () => {
  it("reads .env beside leagues.json, with the real environment winning", () => {
    const { dir, path } = tempConfig();
    writeFileSync(join(dir, ".env"), "ESPN_S2=from-file\nSWID={file}\n");
    const env = envWithDotenv(path, { SWID: "{env}" });
    expect(env).toMatchObject({ ESPN_S2: "from-file", SWID: "{env}" });
  });

  it("rebuilds the service when leagues.json changes", () => {
    const { path } = tempConfig();
    const load = serviceLoader({ LEAGUES_CONFIG: path });
    const first = load();
    expect(load()).toBe(first);
    writeFileSync(path, JSON.stringify(config(2)));
    const second = load();
    expect(second).not.toBe(first);
    expect(second.leagues[0]!.myTeamId).toBe(2);
  });
});
