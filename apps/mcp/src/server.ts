// MCP adapter over FantasyService: one tool per domain function, with the core
// zod schemas as output schemas. Read-only toward ESPN; set_league_rule writes
// leagues.json only. Every result carries structuredContent plus the same JSON
// as text, for clients that only read text.

import { readFileSync } from "node:fs";
import {
  FreeAgent,
  League,
  LeagueSettings,
  Matchup,
  Roster,
  RuleKey,
  StoredRule,
  Transaction,
  type FantasyService,
} from "@espn-fantasy-mcp/core";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const POSITIONS = ["QB", "RB", "WR", "TE", "FLEX", "OP", "D/ST", "K"] as const;

const INSTRUCTIONS = `Read-only access to the user's ESPN fantasy football leagues. Start with list_leagues for the league aliases. Leagues can have different rules (PPR vs half-PPR, FAAB vs priority waivers, superflex), so call get_league_settings before advising on a league, and never carry one league's rules over to another. If its missingRules or conflicts are non-empty, ask the user and save the answer with set_league_rule. This server can't make moves: recommend lineup changes, claims, bids and drops for the user to make in the ESPN app.`;

const league = z
  .string()
  .describe('League alias from list_leagues (e.g. "superflex"), or the ESPN league id.');
const week = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("NFL week (ESPN scoring period). Defaults to the league's current week.");

const READ = { readOnlyHint: true, openWorldHint: true } as const;

function result<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/**
 * `service` is called on every tool call, so the entry point can build it lazily
 * and rebuild it when leagues.json or .env change.
 */
export function createServer(service: () => FantasyService): McpServer {
  const server = new McpServer(
    { name: "espn-fantasy-mcp", version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_leagues",
    {
      title: "List leagues",
      description:
        "The user's configured ESPN fantasy football leagues: alias (pass it as `league` to the other tools), name, the user's team, current week, scoring format (PPR, HALF_PPR, STANDARD), waiver type (FAAB or PRIORITY), and roster shape (superflex, D/ST, K). Call this first.",
      outputSchema: z.object({ leagues: z.array(League) }),
      annotations: READ,
    },
    async () => result({ leagues: await service().listLeagues() }),
  );

  server.registerTool(
    "get_league_settings",
    {
      title: "League settings and rules",
      description:
        "One league's rules: scoring, starting slots, bench and IR size, position limits, waiver system (FAAB budget and amount left, or the user's waiver priority), when waivers process, lineup lock, trade deadline, playoffs, and every team's record. `ruleSources` says where each rule came from. `missingRules` lists rules ESPN didn't provide: ask the user before advising on them, then save the answer with set_league_rule. `conflicts` lists saved values that ESPN now disagrees with: re-confirm them with the user.",
      inputSchema: z.object({ league }),
      outputSchema: LeagueSettings,
      annotations: READ,
    },
    async (args) => result(await service().getLeagueSettings(args.league)),
  );

  server.registerTool(
    "get_my_roster",
    {
      title: "My roster",
      description:
        "The user's roster for a week: starters by lineup slot, bench, and IR. Each player has position, NFL team, injury status, bye week, projected and actual points for the week, the slots they're eligible for, and `locked` (their game has started, so they can't be moved).",
      inputSchema: z.object({ league, week }),
      outputSchema: Roster,
      annotations: READ,
    },
    async (args) => result(await service().getMyRoster(args.league, args.week)),
  );

  server.registerTool(
    "get_matchup",
    {
      title: "My matchup",
      description:
        "The user's head-to-head matchup for a week: both teams' starting lineups with per-player projections, injury status and lock state, plus scores and projected totals. `opponent` is null on a bye.",
      inputSchema: z.object({ league, week }),
      outputSchema: Matchup,
      annotations: READ,
    },
    async (args) => result(await service().getMatchup(args.league, args.week)),
  );

  server.registerTool(
    "get_free_agents",
    {
      title: "Free agents",
      description:
        "The best available players in a league, sorted by projected points for the week. `status` is FREE_AGENT (can be added now) or WAIVERS (needs a waiver claim). Each player also has % rostered and its recent change, injury status, bye week, and season points. The pool is the most-rostered available players (at least 50), so a barely rostered breakout can be missing.",
      inputSchema: z.object({
        league,
        position: z
          .enum(POSITIONS)
          .optional()
          .describe(
            "Lineup position to search. FLEX = RB/WR/TE, OP = superflex (QB/RB/WR/TE). Omit for all positions.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(15)
          .describe("How many players to return (1–50, default 15)."),
        week,
      }),
      outputSchema: z.object({
        league: z.string(),
        position: z.string().nullable(),
        freeAgents: z.array(FreeAgent),
      }),
      annotations: READ,
    },
    async (args) =>
      result({
        league: args.league,
        position: args.position ?? null,
        freeAgents: await service().getFreeAgents(
          args.league,
          args.position,
          args.limit,
          args.week,
        ),
      }),
  );

  server.registerTool(
    "get_recent_activity",
    {
      title: "Recent activity",
      description:
        "Recent transactions in a league, newest first: adds, drops, waiver claims (with the winning FAAB bid in FAAB leagues) and trades, each with the team that made it.",
      inputSchema: z.object({
        league,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe("How many transactions to return (1–100, default 25)."),
      }),
      outputSchema: z.object({ league: z.string(), transactions: z.array(Transaction) }),
      annotations: READ,
    },
    async (args) =>
      result({
        league: args.league,
        transactions: await service().getRecentActivity(args.league, args.limit),
      }),
  );

  server.registerTool(
    "set_league_rule",
    {
      title: "Save a league rule",
      description:
        'Save a league rule the user confirmed, either from their league\'s settings page (source "upload") or by answering a question (source "user"). The saved value overrides ESPN\'s from then on. It\'s stored in the local leagues.json and never changes anything on ESPN. `rule` is a path into the get_league_settings output, and `value` must have that field\'s type, e.g. waivers.type = "FAAB", waivers.faabBudget = 100, roster.slots = {"QB": 1, "RB": 2, "OP": 1}.',
      inputSchema: z.object({
        league,
        rule: RuleKey.describe("Dotted path into get_league_settings, e.g. waivers.type."),
        value: z.unknown().describe("The confirmed value, with the same type as that field."),
        source: z
          .enum(["upload", "user"])
          .describe('"upload" if read from the settings page, "user" if the user answered.'),
      }),
      outputSchema: z.object({ league: z.string(), rule: RuleKey, stored: StoredRule }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      result({
        league: args.league,
        rule: args.rule,
        stored: service().setLeagueRule(args.league, args.rule, args.value, args.source),
      }),
  );

  return server;
}
