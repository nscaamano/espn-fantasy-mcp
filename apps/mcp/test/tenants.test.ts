import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FantasyService, loadConfig } from "@nscaamano/espn-fantasy-core";
import { EspnClient } from "@nscaamano/espn-fantasy-client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureFetch } from "../../../packages/espn-client/test/fixtures.js";
import { createHttpServer } from "../src/http.js";
import { folderTenantEnv, parseTokens, staticTenants, tenantSource } from "../src/tenants.js";

const OWNER = "owner-token-0123456789abcdefghijklmnopqrstuv";
const FRIEND = "friend-token-0123456789abcdefghijklmnopqrstu";
const league = (myTeamId: number) => ({
  leagues: [{ alias: "test", leagueId: 1234, year: 2018, myTeamId }],
});

/** A temp layout: the owner's leagues.json, and MCP_TENANTS_DIR with one folder per extra person. */
function layout() {
  const root = mkdtempSync(join(tmpdir(), "tenants-"));
  const ownerConfig = join(root, "leagues.json");
  writeFileSync(ownerConfig, JSON.stringify(league(1)));
  const tenantsDir = join(root, "tenants");
  mkdirSync(tenantsDir);
  const addTenant = (name: string, dotenv: string, myTeamId = 2) => {
    mkdirSync(join(tenantsDir, name), { recursive: true });
    writeFileSync(join(tenantsDir, name, "leagues.json"), JSON.stringify(league(myTeamId)));
    writeFileSync(join(tenantsDir, name, ".env"), dotenv);
  };
  const env = {
    MCP_AUTH_TOKEN: OWNER,
    LEAGUES_CONFIG: ownerConfig,
    ESPN_S2: "owner-s2",
    SWID: "{OWNER}",
    MCP_TENANTS_DIR: tenantsDir,
  };
  return { env, addTenant, tenantsDir };
}

afterEach(() => vi.unstubAllGlobals());

describe("tenantSource", () => {
  it("serves the environment's person plus one per folder", () => {
    const { env, addTenant } = layout();
    addTenant("friend", `ESPN_S2=friend-s2\nSWID={FRIEND}\nMCP_AUTH_TOKEN=${FRIEND}\n`);
    const { tenants, errors } = tenantSource(env)();
    expect(errors).toEqual([]);
    expect(tenants.map((t) => [t.name, t.tokens])).toEqual([
      ["default", [OWNER]],
      ["friend", [FRIEND]],
    ]);
  });

  it("sends each person's own cookies to ESPN, never the server owner's", async () => {
    const { fetch, calls } = fixtureFetch();
    vi.stubGlobal("fetch", fetch);
    const { env, addTenant } = layout();
    addTenant("friend", `ESPN_S2=friend-s2\nSWID={FRIEND}\nMCP_AUTH_TOKEN=${FRIEND}\n`);
    const { tenants } = tenantSource(env)();

    await tenants
      .find((t) => t.name === "friend")!
      .service()
      .getLeagueSettings("test");
    expect(calls.at(-1)!.headers.Cookie).toBe("espn_s2=friend-s2; SWID={FRIEND}");

    await tenants
      .find((t) => t.name === "default")!
      .service()
      .getLeagueSettings("test");
    expect(calls.at(-1)!.headers.Cookie).toBe("espn_s2=owner-s2; SWID={OWNER}");
  });

  it("never passes the server's cookies into a folder tenant's environment", () => {
    const scoped = folderTenantEnv("/data/tenants/friend", {
      ESPN_S2: "owner",
      SWID: "{OWNER}",
      MCP_AUTH_TOKEN: OWNER,
      ESPN_BASE_URL: "https://example.test/v3",
    });
    expect(scoped).toEqual({
      LEAGUES_CONFIG: "/data/tenants/friend/leagues.json",
      ESPN_BASE_URL: "https://example.test/v3",
    });
  });

  it("picks up a new folder without a restart", () => {
    const { env, addTenant } = layout();
    const source = tenantSource(env);
    expect(source().tenants.map((t) => t.name)).toEqual(["default"]);
    addTenant("friend", `MCP_AUTH_TOKEN=${FRIEND}\n`);
    expect(source().tenants.map((t) => t.name)).toEqual(["default", "friend"]);
  });

  it("accepts several comma-separated tokens per person", () => {
    const other = "second-token-0123456789abcdefghijklmnopqrstu";
    const { tenants } = tenantSource({ ...layout().env, MCP_AUTH_TOKEN: `${OWNER}, ${other}` })();
    expect(tenants[0]!.tokens).toEqual([OWNER, other]);
  });

  it("reports folders without a usable token, short tokens, and shared tokens", () => {
    const { env, addTenant } = layout();
    addTenant("notoken", "ESPN_S2=x\n");
    addTenant("short", "MCP_AUTH_TOKEN=tooshort\n");
    addTenant("copycat", `MCP_AUTH_TOKEN=${OWNER}\n`);
    const { tenants, errors } = tenantSource(env)();
    expect(errors).toEqual(
      expect.arrayContaining([
        "notoken: no MCP_AUTH_TOKEN in .env",
        "short: 1 token(s) shorter than 32 ignored",
        "short: no MCP_AUTH_TOKEN in .env",
        "a token is shared by default and copycat; it's disabled for both",
      ]),
    );
    expect(tenants.flatMap((t) => t.tokens)).not.toContain(OWNER);
  });

  it("parses tokens", () => {
    expect(parseTokens(` ${OWNER} ,, short `)).toEqual({ tokens: [OWNER], short: 1 });
    expect(parseTokens(undefined)).toEqual({ tokens: [], short: 0 });
  });
});

describe("HTTP server with several people", () => {
  it("routes each token to its own person's leagues", async () => {
    const service = (myTeamId: number) => {
      const dir = mkdtempSync(join(tmpdir(), "tenant-svc-"));
      writeFileSync(join(dir, "leagues.json"), JSON.stringify(league(myTeamId)));
      const svc = new FantasyService(
        new EspnClient({ fetch: fixtureFetch().fetch }),
        loadConfig(join(dir, "leagues.json")),
      );
      return () => svc;
    };
    const server = createHttpServer(
      staticTenants([
        { name: "default", tokens: [OWNER], service: service(1) },
        { name: "friend", tokens: [FRIEND], service: service(2) },
      ]),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const myTeam = async (token: string) => {
        const client = new Client({ name: "test", version: "0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`)));
        const res = await client.callTool({ name: "list_leagues", arguments: {} });
        await client.close();
        return (res.structuredContent as { leagues: { myTeamId: number }[] }).leagues[0]!.myTeamId;
      };
      expect(await myTeam(OWNER)).toBe(1);
      expect(await myTeam(FRIEND)).toBe(2);
    } finally {
      server.close();
    }
  });
});
