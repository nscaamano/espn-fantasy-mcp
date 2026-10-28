import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FantasyService, loadConfig } from "@nscaamano/espn-fantasy-core";
import { EspnClient } from "@nscaamano/espn-fantasy-client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureFetch } from "../../../packages/espn-client/test/fixtures.js";
import { createHttpServer, presentedToken } from "../src/http.js";
import { seedConfig } from "../src/load.js";
import { staticTenants } from "../src/tenants.js";

const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuvwxyz";
const config = { leagues: [{ alias: "test", leagueId: 1234, year: 2018, myTeamId: 1 }] };

const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
  const path = join(dir, "leagues.json");
  writeFileSync(path, JSON.stringify(config));
  const svc = new FantasyService(new EspnClient({ fetch: fixtureFetch().fetch }), loadConfig(path));
  const server = createHttpServer(
    staticTenants([{ name: "default", tokens: [TOKEN], service: () => svc }]),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function connect(url: string, headers?: Record<string, string>) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : {}),
  );
  return client;
}

describe("HTTP server", () => {
  it("answers /health without a token", async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("serves MCP with the token in the path", async () => {
    const client = await connect(`${await start()}/mcp/${TOKEN}`);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_pending_claims");
    const res = await client.callTool({ name: "list_leagues", arguments: {} });
    expect(res.structuredContent).toMatchObject({ leagues: [{ alias: "test" }] });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("weekly_check");
  });

  it("serves MCP with a bearer token", async () => {
    const client = await connect(`${await start()}/mcp`, { Authorization: `Bearer ${TOKEN}` });
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
  });

  it("gives a bare 404 for a missing or wrong token, and for other paths", async () => {
    const base = await start();
    const post = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    for (const res of [
      await post("/mcp"),
      await post(`/mcp/${TOKEN}x`),
      await post("/mcp", { Authorization: "Bearer nope" }),
      await post(`/other/${TOKEN}`),
      await fetch(`${base}/`),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });
});

describe("presentedToken", () => {
  it("reads the path first, then a bearer header on /mcp only", () => {
    expect(presentedToken("/mcp/abc", undefined)).toBe("abc");
    expect(presentedToken("/mcp/abc/", "Bearer other")).toBe("abc");
    expect(presentedToken("/mcp", "Bearer xyz")).toBe("xyz");
    expect(presentedToken("/mcp", "Basic xyz")).toBeNull();
    expect(presentedToken("/elsewhere", "Bearer xyz")).toBeNull();
  });
});

describe("seedConfig", () => {
  it("writes LEAGUES_JSON to LEAGUES_CONFIG once, then leaves it alone", () => {
    const path = join(mkdtempSync(join(tmpdir(), "seed-")), "data", "leagues.json");
    const env = { LEAGUES_CONFIG: path, LEAGUES_JSON: JSON.stringify(config) };
    expect(seedConfig(env)).toBe(path);
    expect(JSON.parse(readFileSync(path, "utf8")).leagues[0].alias).toBe("test");

    writeFileSync(path, JSON.stringify({ leagues: [{ ...config.leagues[0], alias: "edited" }] }));
    expect(seedConfig(env)).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).leagues[0].alias).toBe("edited");
  });

  it("does nothing without both variables, and rejects invalid JSON or config", () => {
    const path = join(mkdtempSync(join(tmpdir(), "seed-")), "leagues.json");
    expect(seedConfig({ LEAGUES_CONFIG: path })).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(() => seedConfig({ LEAGUES_CONFIG: path, LEAGUES_JSON: "{" })).toThrow(/valid JSON/);
    expect(() =>
      seedConfig({ LEAGUES_CONFIG: path, LEAGUES_JSON: JSON.stringify({ leagues: [] }) }),
    ).toThrow(/Invalid LEAGUES_JSON/);
  });
});
