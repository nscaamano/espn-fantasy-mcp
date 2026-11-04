// MCP adapter over FantasyService: one tool per domain function, with the core
// zod schemas as output schemas. Read-only toward ESPN; set_league_rule writes
// leagues.json only. Every result carries structuredContent plus the same JSON
// as text, for clients that only read text.

import { readFileSync } from "node:fs";
import {
  ByeCoverage,
  FaabPrices,
  FreeAgent,
  FreeAgentSort,
  League,
  LeagueSettings,
  Matchup,
  OptimalLineup,
  PendingClaim,
  PlayerNews,
  PlayerSearch,
  WaiverResults,
  Roster,
  RuleKey,
  Scoreboard,
  StoredRule,
  Team,
  Transaction,
  type FantasyService,
} from "@nscaamano/espn-fantasy-core";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadSkills, promptName, promptText, type Skill } from "./skills.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const POSITIONS = ["QB", "RB", "WR", "TE", "FLEX", "OP", "D/ST", "K"] as const;

const INSTRUCTIONS = `Read-only access to the user's ESPN fantasy football leagues. Start with list_leagues for the league aliases. Leagues can have different rules (PPR vs half-PPR, FAAB vs priority waivers, superflex), so call get_league_settings before advising on a league, and never carry one league's rules over to another. If its missingRules or conflicts are non-empty, ask the user and save the answer with set_league_rule. Before recommending waiver claims, call get_pending_claims to see what the user already has queued, so you don't repeat a claim or plan a drop that's already committed. For a named player ("who has X", "is X available", "how's X doing"), use get_player rather than scanning rosters. Lineup risks and get_player results carry the player's latest ESPN news blurb (\`news\`); for anyone else, or more history, call get_player_news before searching the web. This server can't make moves: recommend lineup changes, claims, bids and drops for the user to make in the ESPN app.`;

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

const AS_OF = "`asOf` is when the data was read; call again rather than reuse an old result.";
const FRESHNESS = `Each player has \`lastNewsDate\`, when ESPN last posted news on him: a tag older than the latest practice report or inactives may be stale, so check the news. ${AS_OF}`;
const MATCHUP_FRESHNESS = `ESPN's matchup data has no \`lastNewsDate\` (it's null here); use get_my_roster when injury freshness matters. ${AS_OF}`;

function result<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export interface ServerOptions {
  /** Workflows to serve as prompts. Defaults to the repo's skills/ folder. */
  skills?: Skill[];
  now?: () => Date;
}

/**
 * `service` is called on every tool call, so the entry point can build it lazily
 * and rebuild it when leagues.json or .env change.
 */
export function createServer(
  service: () => FantasyService,
  options: ServerOptions = {},
): McpServer {
  const now = options.now ?? (() => new Date());
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
      description: `The user's roster for a week: starters by lineup slot, bench, and IR. Each player has position, NFL team, injury status, bye week, this week's game and kickoff, projected and actual points for the week, the slots they're eligible for, \`locked\` (their game has started, so they can't be moved), and \`droppable\` (false for players on the league's undroppable list or whose game has started). ${FRESHNESS}`,
      inputSchema: z.object({ league, week }),
      outputSchema: Roster,
      annotations: READ,
    },
    async (args) => result(await service().getMyRoster(args.league, args.week)),
  );

  server.registerTool(
    "get_optimal_lineup",
    {
      title: "Best lineup by projection",
      description:
        "The user's highest-projected legal lineup for a week in one league, computed from the league's starting slots and each player's eligible slots. Players on a bye or OUT, IR or SUSPENDED don't start. Locked players (game started) stay where they are, and IR slots are left alone. A player projecting 0 doesn't start: if he's the best option, the slot stays empty and the EMPTY_SLOT risk names him. The user's pending waiver claims are accounted for: players a claim drops leave the pool. Returns `starters`, the `moves` to get there (`to: \"BE\"` means bench; every move has a `reason`: why a starter sits, or whom an incoming player replaces), projected totals before and after, and `risks`. GAME_TIME: a QUESTIONABLE or DOUBTFUL starter, with any bench backups whose games start after his inactives come out, about 90 minutes before his kickoff (pivots: a 4:05 PM backup counts for a 4:25 PM starter); `staleTag` is set when his latest news predates this week's practice reports. EMPTY_SLOT: nobody healthy with a projection can fill it; `pendingClaim` is set when a queued claim would fill it, otherwise `freeAgents` lists the top options (a WAIVERS player must be claimed by `waiverClears`; a free agent can be added until `kickoff`). IR_INELIGIBLE: a player in an IR slot whose status the league doesn't allow on IR (default: only OUT, IR or SUSPENDED; see the `roster.irEligibleStatuses` rule), which blocks all adds and claims until he moves to the bench. When the roster is full, EMPTY_SLOT and IR_INELIGIBLE risks also carry `drop`: a droppable bench player with the lowest season projection. NO_PROJECTION is no longer emitted. Each risk about a player carries `news`: his latest ESPN news blurb (headline, story, published), which usually says why he's flagged. If it predates the latest practice report or inactives, or his game is close, look for newer news before acting. Don't churn over a point or two.",
      inputSchema: z.object({ league, week }),
      outputSchema: OptimalLineup,
      annotations: READ,
    },
    async (args) => result(await service().getOptimalLineup(args.league, args.week)),
  );

  server.registerTool(
    "get_bye_coverage",
    {
      title: "Bye-week holes ahead",
      description:
        "For each upcoming week in one league, whether the user's roster can field a full lineup through bye weeks and current injuries: the planning view for trades and waiver claims (a QB bye in a superflex league, a kicker or D/ST bye with no backup). Uses the roster as it is now (starters and bench; players in IR slots don't count) and the league's starting slots, by slot eligibility only, so FLEX, OP (superflex) and other combo slots count; no weekly projections. A player is available in a week unless his NFL team is on bye then, he's OUT, IR or SUSPENDED now, or ESPN projects him for 0 points this season (it zeroes players it expects to sit, such as a benched backup; listed in `zeroProjection`). Injury status is only known for now, so injured players aren't counted in any week, and the figures that would change if they were back come as `ifHealthy` and `openSlotsIfHealthy`: judge from the news whether he'll be back by then. Returns `fullStrength` (how many players of each position the best lineup by season projection starts with everyone healthy and nobody on bye; in superflex usually 2 QBs), `injured`, `zeroProjection`, and per week `byes` (players on bye), `openSlots` (starting slots nobody available is eligible for: a sure zero unless the user adds someone), and `short` (positions with fewer available players than fullStrength starts, with `available` and `needed`: a flex slot falls back to another position, or a slot goes empty if `openSlots` says so). `openSlots` and `short` are omitted in weeks with no problem. Defaults to the current week and the five after it, capped at the league's last scoring week.",
      inputSchema: z.object({
        league,
        fromWeek: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("First NFL week to check. Defaults to the league's current week."),
        toWeek: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Last NFL week to check. Defaults to five weeks after fromWeek; capped at the league's last scoring week.",
          ),
      }),
      outputSchema: ByeCoverage,
      annotations: READ,
    },
    async (args) => result(await service().getByeCoverage(args.league, args.fromWeek, args.toWeek)),
  );

  server.registerTool(
    "get_matchup",
    {
      title: "My matchup",
      description: `The user's head-to-head matchup in one league for a week: both teams' starting lineups with per-player points, projections, injury status and lock state, plus scores, projected totals and ESPN's win probability (\`winProbability\`, 0–1; null outside the current week). \`opponent\` is null on a bye. For every league at once, use get_scoreboard. ${MATCHUP_FRESHNESS}`,
      inputSchema: z.object({ league, week }),
      outputSchema: Matchup,
      annotations: READ,
    },
    async (args) => result(await service().getMatchup(args.league, args.week)),
  );

  server.registerTool(
    "get_scoreboard",
    {
      title: "All my matchups",
      description: `The user's matchup in every league at once, in one call: the same shape as get_matchup, one entry per league. A league that can't be read (a bye week, an ESPN error) is listed in \`errors\` while the rest still return. ${MATCHUP_FRESHNESS}`,
      inputSchema: z.object({
        week: week.describe("NFL week. Defaults to each league's current week."),
      }),
      outputSchema: Scoreboard,
      annotations: READ,
    },
    async (args) => result(await service().getScoreboard(args.week)),
  );

  server.registerTool(
    "get_teams",
    {
      title: "League teams",
      description:
        "Every team in a league: id, name, managers, record, points for and against, playoff seed, waiver rank and FAAB left. `isMine` marks the user's team. Pass a team's `id` to get_team_roster.",
      inputSchema: z.object({ league }),
      outputSchema: z.object({ league: z.string(), teams: z.array(Team) }),
      annotations: READ,
    },
    async (args) => result({ league: args.league, teams: await service().getTeams(args.league) }),
  );

  server.registerTool(
    "get_team_roster",
    {
      title: "Another team's roster",
      description: `Any team's roster for a week, in the same shape as get_my_roster. Use it to scout trade partners or teams that may compete for a waiver claim. ${FRESHNESS}`,
      inputSchema: z.object({
        league,
        teamId: z.number().int().positive().describe("Team id from get_teams."),
        week,
      }),
      outputSchema: Roster,
      annotations: READ,
    },
    async (args) => result(await service().getTeamRoster(args.league, args.teamId, args.week)),
  );

  server.registerTool(
    "get_player",
    {
      title: "Look up a player",
      description: `Find any player in a league by name, whoever has him: \`status\` is ROSTERED (\`team\` gives the team, his lineup slot there such as QB, FLEX, BE or IR, and \`isMine\` for the user's team), FREE_AGENT (can be added now) or WAIVERS (needs a claim; he clears at \`waiverClears\`). Each player also has position, NFL team, injury status, bye week, this week's game, projected and actual points for the week, season points and projection, % rostered and its recent change, and positional rank, plus \`news\`: his latest ESPN news blurb, when there is one. Use it for "who has X", "how is X doing", or to check a player before a trade or claim, including one too little rostered to appear in get_free_agents. Partial names work ("Vidal", "St. Brown") and punctuation is optional ("AJ Brown"). If any players match the name exactly, only they are returned (two players can share a name); otherwise every player whose first or last name starts that way, most rostered first. An empty \`players\` list means no match: check the spelling. When \`totalMatches\` is more than \`players\`, the name was ambiguous: ask which one, or retry with the full name. ${FRESHNESS}`,
      inputSchema: z.object({
        league,
        name: z
          .string()
          .trim()
          .min(2)
          .describe('Player name, full or partial, e.g. "Kimani Vidal", "Vidal" or "Bills D/ST".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(5)
          .describe("Most players to return when several match (1–25, default 5)."),
        week,
      }),
      outputSchema: PlayerSearch,
      annotations: READ,
    },
    async (args) =>
      result(await service().getPlayer(args.league, args.name, args.limit, args.week)),
  );

  server.registerTool(
    "get_player_news",
    {
      title: "Player news",
      description:
        "Recent news blurbs for players named in one league, newest first (Rotowire's, via ESPN's fantasy news feed): injuries and how serious they are, practice participation, inactives, benchings and role changes. Use it to learn why a player's status or projection changed, or to vet a trade target or a pickup. Lineup risks from get_optimal_lineup and players from get_player already carry their latest blurb as `news`; call this for anyone else or for more history. Names resolve like get_player: an exact match, else the most rostered player whose name starts that way. `otherMatches` above 0 means the name was ambiguous (retry with the full name if the player is wrong), and `notFound` lists names that matched no one. Blurbs can trail breaking news, so close to kickoff compare `published` with the latest reports.",
      inputSchema: z.object({
        league,
        names: z
          .array(z.string().trim().min(2))
          .min(1)
          .max(10)
          .describe('Player names, full or partial, e.g. ["A.J. Brown", "Vidal"] (1–10).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(3)
          .describe("Blurbs per player, newest first (1–5, default 3)."),
      }),
      outputSchema: PlayerNews,
      annotations: READ,
    },
    async (args) => result(await service().getPlayerNews(args.league, args.names, args.limit)),
  );

  server.registerTool(
    "get_free_agents",
    {
      title: "Free agents",
      description:
        "The best available players in a league, sorted by projected points for the week, or by ESPN's full-season projection with `sort: \"season\"` (better for stash candidates; it's the whole season's projection, not rest of season). `status` is FREE_AGENT (can be added now) or WAIVERS (needs a waiver claim). Each player also has % rostered and its recent change, injury status, bye week, and season points. The pool is the most-rostered available players (at least 50), so a barely rostered breakout can be missing.",
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
        sort: FreeAgentSort.default("week").describe(
          '"week" ranks by this week\'s projection (default); "season" by the full-season projection.',
        ),
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
          args.sort,
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
    "get_pending_claims",
    {
      title: "My pending claims",
      description:
        "The user's waiver claims that are queued but not yet processed in a league: the player to add, the player to drop (with the lineup slot they leave), the FAAB bid (null in priority-waiver leagues), when it was submitted and when ESPN will process it. Call this before recommending claims, so you don't repeat one or drop a player who's already being dropped. An empty list means nothing is queued. ESPN doesn't expose the claim priority order the user set: claims are listed in submission order (proposedAt), which may not be the order they process in, so ask the user if order matters. Only the user's own claims are visible.",
      inputSchema: z.object({ league }),
      outputSchema: z.object({ league: z.string(), claims: z.array(PendingClaim) }),
      annotations: READ,
    },
    async (args) =>
      result({ league: args.league, claims: await service().getPendingClaims(args.league) }),
  );

  server.registerTool(
    "get_waiver_results",
    {
      title: "My waiver results",
      description:
        "How the user's claims fared in their latest waiver run of a week in a league (some leagues also run waivers daily; a later run without the user's claims doesn't hide this one). Each claim is WON, LOST (another team got the player: `wonBy` names the team and its winning FAAB bid, which is null in priority-waiver leagues, where the team ahead in waiver priority wins), FAILED (any other reason, in `reason`) or CANCELED (withdrawn before the run). Also returns when the run processed (`processedAt`, null if none has run this week yet) and the user's waiver priority now (`waiverRank`, 1 = first). Use it after claims process (usually Wednesday morning) to report results and find replacements for lost claims with get_free_agents.",
      inputSchema: z.object({
        league,
        week: week.describe("NFL week. Defaults to the league's current week."),
      }),
      outputSchema: WaiverResults,
      annotations: READ,
    },
    async (args) => result(await service().getWaiverResults(args.league, args.week)),
  );

  server.registerTool(
    "get_faab_prices",
    {
      title: "FAAB prices by position",
      description:
        "What winning waiver claims cost in one league, every team's, by position (QB, RB, WR, TE, K, D/ST), over recent weeks: the number of wins, how many were `contested` (another team bid too), and the median, lowest and highest winning bid, plus the highest bids (5 per position, 15 with `position`), each with the player, week, winning team, `runnerUp` (the highest bid another team lost with, null if nobody else bid) and `bidders` (teams that bid, the winner included). `all` sums every position. `budget` and `minimumBid` put the numbers in scale. Use it to size FAAB bids from what this league actually pays: prices differ a lot between leagues and positions (QBs cost far more in superflex). Caveats: samples are small (a few claims per position), a winning bid shows what one manager paid, not what was needed (`runnerUp` is closer to that), and free-agent adds aren't bids, so they're not counted. In a priority-waiver league `usesFaab` is false: there are no bids, so only the counts are returned. Covers the current week and the ones before it (`fromWeek` to `toWeek`).",
      inputSchema: z.object({
        league,
        weeks: z
          .number()
          .int()
          .min(1)
          .max(18)
          .default(5)
          .describe(
            "How many weeks to cover, ending with the current one (1–18, default 5). Use more for a season view; each week is one more ESPN request the first time.",
          ),
        position: z
          .enum(["QB", "RB", "WR", "TE", "K", "D/ST"])
          .optional()
          .describe("Only this position, with up to 15 bids listed. Omit for every position."),
      }),
      outputSchema: FaabPrices,
      annotations: READ,
    },
    async (args) => result(await service().getFaabPrices(args.league, args.weeks, args.position)),
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

  for (const skill of options.skills ?? loadSkills()) {
    server.registerPrompt(
      promptName(skill),
      {
        title: skill.title,
        description: skill.description,
        argsSchema: z.object({
          league: z
            .string()
            .optional()
            .describe("League alias from list_leagues. Omit to cover every league."),
        }),
      },
      (args) => ({
        description: skill.description,
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: promptText(skill, args.league, now()) },
          },
        ],
      }),
    );
  }

  return server;
}
