# Design

This is the source of truth for what the service does and how the next pieces (the MCP server, the skills, trades) should work. [STATUS.md](../STATUS.md) tracks progress against it.

## Goal and scope

A read-only TypeScript service that pulls a user's ESPN fantasy football data, so an AI assistant can check rosters, matchups and free agents directly instead of working from pasted screenshots. It's exposed over MCP, so it works with any MCP client. Claude Code is the primary client it's developed against.

- **Read-only.** Claude recommends lineup changes, waiver claims, FAAB bids and drops; the user makes the moves in the ESPN app. ESPN's write endpoints are thin and unofficial, and the user wants to press the final button themselves.
- **Injury and news research** stays with the assistant's own web search. The service supplies ESPN data only.
- **Multiple leagues with different rules.** The reference setup is three leagues: full PPR with priority waivers; superflex (an OP slot, no D/ST or K) with FAAB; and half-PPR with D/ST and K, also FAAB. Nothing may assume one league's rules apply to another.

## Architecture

All TypeScript, in one pnpm-workspaces monorepo. The ESPN logic lives once, in `espn-client` and `core`; adapters are thin.

```
packages/
  espn-client/   thin ESPN client (fetch + cookies), raw → typed
  core/          zod schemas + domain functions + league rules
apps/
  mcp/           McpServer (stdio): tools over core          (step 3)
skills/          weekly-check, waivers, trades SKILL.md files (step 4+)
```

- **Why TypeScript rather than wrapping the Python espn-api:** one language and shared types end to end, with no Python sidecar. espn-api stays the reference for endpoints, `view` params, headers and ID mappings: port its request shapes, don't reinvent them. If maintaining the TS client ever proves painful, the fallback is a Python sidecar running espn-api.
- **Tooling:** pnpm workspaces only; no Nx or Turborepo at this size.

| Layer | Choice |
| --- | --- |
| Language | TypeScript, `strict` (pinned to 6.0 until typescript-eslint supports 7) |
| Runtime | Node.js 24 LTS |
| Validation / types | zod v4: schemas in `core`, types inferred from them |
| MCP | `@modelcontextprotocol/sdk`: `McpServer` + `registerTool`, stdio |
| ESPN access | own `espn-client` on native `fetch` |
| Testing | Vitest unit tests on parsers, plus the live `smoke` script |
| Lint / format | ESLint + Prettier |

## espn-client

A small hand-written client for ESPN's undocumented fantasy v3 API (`lm-api-reads.fantasy.espn.com/apis/v3`).

**Auth:** private leagues need two browser cookies, `espn_s2` and `SWID`, sent on every request. They live only in `.env`. `espn_s2` expires periodically; re-copy it when calls return 401.

| Function | Returns |
| --- | --- |
| `getLeagueSettings(leagueId, year)` | scoring, roster slots, FAAB budget, waiver rules, trade and schedule settings, team list |
| `getRoster` / `getRosters(leagueId, year, [teamId], week?)` | starters by slot, bench, IR. Per player: position, pro team, injury status, projected and actual points, lock state |
| `getMatchups(leagueId, year, week?)` | every matchup in the week: both lineups, projected and actual totals |
| `getFreeAgents(leagueId, year, position, n, week?)` | available players with projections, % rostered, injury status, waiver or free-agent status (uses the `x-fantasy-filter` header) |
| `getRecentActivity(leagueId, year, limit)` | adds, drops, trades and waiver results with FAAB bids, with player names resolved |
| `getProTeams(year)` | NFL teams with bye weeks (public, cached) |

**Maintenance** (expect an hour or two, a few times a season):

- ESPN's constants (position, lineup slot, stat and pro team IDs) are generated from espn-api's `constant.py` by `scripts/port_espn_constants.py`, so updates are a straight port.
- Watch espn-api's releases. A release mentioning an ESPN API change is the signal to diff and port.
- All raw-JSON parsing stays in `espn-client`. Nothing outside it sees ESPN's response shapes.
- Run `pnpm smoke` before each weekly check.
- ESPN has moved league reads to a different host before, so the base URL is configurable (`ESPN_BASE_URL`).

## core

- **Schemas** (`schemas.ts`) are the one contract. MCP tools use them as output schemas: `League`, `LeagueSettings`, `Team`, `Player`, `RosterSlot`, `Roster`, `Matchup`, `FreeAgent`, `Transaction`.
- **Domain functions** (`FantasyService`) are thin wrappers over `espn-client`. They map to the schemas, attach bye weeks, and resolve "my team" from config.
- **Config:** `leagues.json` lists the user's leagues (id, year, my team id, a short alias, stored rules). Cookies come from env, never this file.
- **No opinions here.** Lineup and waiver judgment belongs in the skills, so it can change without a code change.

## League rules discovery

Every recommendation depends on the league's rules, so the service learns them per league before advising, and asks when ESPN won't say.

| Rule | Why it matters |
| --- | --- |
| Waiver system: FAAB vs priority order | bid amounts vs claim order; how priority resets |
| FAAB budget and amount left | sizing bids |
| Waiver period and processing time | when claims must be in |
| Scoring: full / half / no PPR, TD and bonus values | ranking players |
| Roster slots: superflex/OP, flex, D/ST, K, bench, IR | who can start where |
| Position maximums | whether a claim is even legal |
| Lineup lock: per player at kickoff vs weekly | late swaps and Monday-night hedges |
| Trade deadline, playoff weeks and teams | late-season strategy |

**Discovery order, per league:**

1. **ESPN settings endpoint** (`getLeagueSettings`). Values are tagged with source `espn`.
2. **Settings page upload.** If a field is missing, ask the user to paste or upload the league's settings page (ESPN's settings page saved as PDF works) and extract the rules. Source: `upload`.
3. **Ask.** For anything still missing, ask one short question per rule ("Does this league use FAAB or a priority order?"). Source: `user`.

- **Storage:** the league's `rules` block in `leagues.json`, keyed by a dotted path into `LeagueSettings` and tagged with source and confirmation date. Stored values override ESPN's (implemented in `core/src/rules.ts`).
- **Re-check** at the start of each season, and whenever ESPN disagrees with a stored value (`conflicts` in the output).
- **Skills read rules first.** Every skill calls `get_league_settings` before anything else and never assumes a default (for example, never suggests FAAB bids in a priority-waiver league).

## MCP server (step 3)

Use `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` with `registerTool` and the core zod schemas, over stdio. The low-level `Server` also works, but it means hand-writing the `tools/list` and `tools/call` handlers.

All tools are read-only toward ESPN. `league` accepts an alias from `leagues.json`.

| Tool | Inputs | Use |
| --- | --- | --- |
| `list_leagues` | — | my leagues with scoring type and format |
| `get_league_settings` | league | roster slots, scoring, FAAB remaining, waiver rules, `missingRules`, `conflicts` |
| `get_my_roster` | league, week? | starters, bench, IR with injury tags, byes, projections, lock state |
| `get_matchup` | league, week? | both starting lineups and projected totals |
| `get_free_agents` | league, position, limit? | top available by projection; waiver vs FA status |
| `get_recent_activity` | league, limit? | recent adds, drops, waiver results with bids, trades |
| `set_league_rule` | league, rule, value, source | persist a rule confirmed by upload or answer (writes `leagues.json` only) |

- **Output:** compact JSON, never ESPN's raw payload, so each call costs few tokens.
- **Runs locally** as a stdio server; ESPN cookies stay on the user's machine.

### Client compatibility

The server targets any MCP client, not just Claude: Claude Code, Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI and others. That means:

- **Spec-only features.** Use only tools (and prompts, below). Nothing should depend on a particular client's extensions.
- **Structured output plus text.** Return `structuredContent` (validated against the output schema) and the same JSON as a text content block, since some clients only read text.
- **Self-contained descriptions.** Tool and parameter descriptions must make sense to any model. For example, the `league` description should say where valid aliases come from: `list_leagues`.
- **The server loads its own secrets.** It reads `.env` and `leagues.json` itself, found by walking up from its own location or via `LEAGUES_CONFIG`. Client configs then contain only the launch command, never cookies, and stay identical across clients: `node <repo>/apps/mcp/dist/index.js`.
- **Config examples.** Ship `.mcp.json` for Claude Code at the repo root, and document the equivalent snippets for Claude Desktop, Cursor (`.cursor/mcp.json`) and VS Code (`.vscode/mcp.json`) in the README.
- **Test with the MCP Inspector** (`npx @modelcontextprotocol/inspector`) as well as Claude Code.

## Skills (step 4)

They hold the judgment; the MCP tools only fetch data. Output is a short per-league list of moves for the user to make in the app.

- **Primary form:** `SKILL.md` files in `skills/` (the Agent Skills format), used by Claude Code and other clients that support skills.
- **Portable form:** the same workflows exposed as MCP **prompts** (`weekly_check`, `waivers`), so any client that supports MCP prompts gets them too. Write each workflow once and generate both forms from it, so they can't drift apart.
- **Injury news** needs the client's own web search. Where a client has none, the workflow says so and falls back to ESPN injury tags, labeled as such.

**weekly-check:** run before each week's first game, and again on Saturday.

1. For each league: `get_league_settings`, `get_my_roster`, `get_matchup`.
2. Flag every starter or key bench player with an injury tag or a bye.
3. Web-search the flagged players' current status. Cite the source and date.
4. Recommend start/sit per league by projection, adjusted for news. Note the projected margin.
5. List moves as plain instructions: "Superflex: start Brissett at QB, bench Nix."

**waivers:** run Tuesday afternoon, before claims process overnight.

1. Find each roster's holes: injuries, byes next week, dead bench spots.
2. `get_free_agents` for the positions that matter; rank by fit, not just projection.
3. FAAB leagues: suggest a bid from budget left, % rostered and need. Priority-waiver leagues: suggest a claim order.
4. Name a specific drop for every claim.

**Rules of thumb** (bake into both skills):

- An injury tag on Tuesday is often left over from last week. Teams post the new report from Wednesday; check Wednesday–Friday before acting.
- Lineups lock per player at kickoff, not at the week's first game. A Sunday player can still be swapped after Thursday's game.
- Default to the safe lineup: a questionable star sits until news clears him, then swap him in. A forgotten swap shouldn't mean a zero.
- A questionable Monday-night starter needs a same-game or Monday backup on the bench, ideally his own teammate who absorbs his targets.
- Every waiver claim needs its own drop attached, or it fails for roster space. Claims can't land directly on IR.
- Long-term injured players go to IR to free a bench spot; check that ESPN marks them IR-eligible.
- Watch bye weeks across starters; avoid stacking three starters on one bye.
- Don't bid big FAAB on a 4%-rostered player. Save budget for real breakouts after a starter's injury.
- QBs in superflex: start the two best-projected QBs regardless of name, and check for byes.

## Trades skill (later)

For when a lineup hole can't be filled from waivers: scan the other teams and propose trades both sides could plausibly accept. Build it after weekly-check and waivers have run for a few real weeks.

**When it runs:** suggested automatically when weekly-check or waivers finds a starter hole (a long injury, a bad bye week) and the best free agent projects well below the player being replaced. Also on demand: "find me a WR trade in the superflex league."

**Two modes:**

- **Fix mode** (in a tight spot): fill my hole from another team's surplus.
- **Opportunity mode** (in a good spot): scan weekly for struggling teams (starters injured, a brutal bye week, a losing streak, no depth at a position) and use my depth to upgrade.
  - **Consolidation:** two solid bench players for one of their better starters.
  - **Buy low:** a good player in a slump or returning from injury, from a manager who needs points now.
  - **Sell high:** a hot player whose role or schedule is about to get worse.
  - Flag managers worth targeting: losing records, inactive lately, several starters out.

Opportunity mode still applies the fairness check: the leverage is their urgent need, not a lopsided deal. Lopsided offers get rejected or vetoed and sour future trades.

**New reads** (still read-only): `get_teams` (every team's manager, record, standings, points for, playoff position) and `get_team_roster` (any team's roster, same shape as `get_my_roster`). `getRosters` already fetches all rosters in one request, and core has `getTeamRoster`.

**How it picks trades:**

1. Map needs and surpluses for every team, mine included: starters, bench depth, injuries, upcoming byes.
2. Match teams whose surplus covers my need and whose need my surplus covers.
3. Value players rest of season, not this week: remaining projections, injury return dates, byes left, league format (QBs are worth more in superflex).
4. Fairness check: both sides should gain projected starting points, or at least fill a need.
5. Context: prefer motivated partners (contenders short at a position, rebuilders with veterans). Stop suggesting trades near the deadline unless the review period still fits.

**Output per proposal:** give and get, my rest-of-season gain, their gain, why it works for them, risks (injury, bye overlap), and a short message to send the manager. The user makes the offer in the ESPN app.

**Open question:** ESPN may not expose rest-of-season projections cleanly (see STATUS.md). If not, derive them from season projections minus weeks played, or pull public rest-of-season rankings by web search, labeled as such.
