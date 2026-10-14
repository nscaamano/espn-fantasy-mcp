import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FantasyService, loadConfig } from "@espn-fantasy-mcp/core";
import { EspnClient } from "@espn-fantasy-mcp/espn-client";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../../../packages/espn-client/test/fixtures.js";
import { createServer } from "../src/server.js";
import { loadSkills, parseSkill, promptText } from "../src/skills.js";

const skills = loadSkills();

async function connect() {
  const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
  const path = join(dir, "leagues.json");
  writeFileSync(
    path,
    JSON.stringify({ leagues: [{ alias: "test", leagueId: 1234, year: 2018, myTeamId: 1 }] }),
  );
  const svc = new FantasyService(new EspnClient({ fetch: fixtureFetch().fetch }), loadConfig(path));
  const server = createServer(() => svc, { now: () => new Date("2026-10-13T18:00:00Z") });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

describe("skills/", () => {
  it("has the weekly-check and waivers workflows", () => {
    expect(skills.map((s) => s.name)).toEqual(["waivers", "weekly-check"]);
    for (const s of skills) {
      expect(s.description.length).toBeGreaterThan(50);
      expect(s.body).not.toMatch(/^---/);
    }
  });

  it("only names tools the server actually has", async () => {
    const { tools } = await (await connect()).listTools();
    const real = new Set(tools.map((t) => t.name));
    for (const s of skills) {
      const named = [...s.body.matchAll(/`((?:get|list|set)_[a-z_]+)`/g)].map((m) => m[1]!);
      expect(named.length).toBeGreaterThan(0);
      for (const name of named) expect(real, `${s.name} names ${name}`).toContain(name);
    }
  });
});

describe("parseSkill", () => {
  it("reads frontmatter, title and body", () => {
    const s = parseSkill("---\nname: x\ndescription: Does a thing: well.\n---\n\n# Title\n\nBody.");
    expect(s).toEqual({
      name: "x",
      description: "Does a thing: well.",
      title: "Title",
      body: "# Title\n\nBody.",
    });
  });

  it("rejects a file without frontmatter or a description", () => {
    expect(() => parseSkill("# No frontmatter")).toThrow(/frontmatter/);
    expect(() => parseSkill("---\nname: x\n---\nBody")).toThrow(/description/);
  });

  it("rejects a skill whose name doesn't match its folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(dir, "right"));
    writeFileSync(join(dir, "right", "SKILL.md"), "---\nname: wrong\ndescription: d\n---\nBody");
    expect(() => loadSkills(dir)).toThrow(/declares name "wrong"/);
  });
});

describe("MCP prompts", () => {
  it("serves each skill as a prompt with an optional league argument", async () => {
    const { prompts } = await (await connect()).listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["waivers", "weekly_check"]);
    const weekly = prompts.find((p) => p.name === "weekly_check")!;
    expect(weekly.title).toBe("Weekly lineup check");
    expect(weekly.arguments).toEqual([
      expect.objectContaining({ name: "league", required: false }),
    ]);
  });

  it("puts the scope, the current time and the workflow in the message", async () => {
    const client = await connect();
    const one = await client.getPrompt({ name: "waivers", arguments: { league: "test" } });
    const text = (one.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(
      /^Follow the waivers workflow below for the league "test"\. It's now Tuesday, Oct 13, 2:00 PM ET/,
    );
    expect(text).toContain("# Waiver and free-agent run");
    expect(text).not.toContain("description:");

    const all = await client.getPrompt({ name: "weekly_check", arguments: {} });
    expect((all.messages[0]!.content as { text: string }).text).toContain(
      "for every league from list_leagues",
    );
  });

  it("matches promptText", () => {
    const s = skills[0]!;
    expect(promptText(s, undefined, new Date(0))).toContain(s.body);
  });
});
