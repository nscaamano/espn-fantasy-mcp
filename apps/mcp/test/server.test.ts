import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FantasyService, loadConfig, type LeaguesConfig } from "@espn-fantasy-mcp/core";
import { EspnClient } from "@espn-fantasy-mcp/espn-client";
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
      "get_recent_activity",
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

  it("wraps free agents and applies the default limit", async () => {
    const { call } = await connect();
    const res = await call("get_free_agents", { league: "test", position: "WR", limit: 3 });
    const out = res.structuredContent as { position: string; freeAgents: unknown[] };
    expect(out.position).toBe("WR");
    expect(out.freeAgents).toHaveLength(3);
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
