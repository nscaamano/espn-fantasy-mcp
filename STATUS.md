# Status

Last updated: 2026-10-08 · Design and specs: [docs/design.md](docs/design.md)

## Done

- [x] **Step 1: Scaffold.** pnpm workspace, strict TypeScript (project references), Vitest, ESLint and Prettier. `.env.example` and `leagues.example.json`. Node 24 via `.nvmrc`.
- [x] **Step 2: espn-client + core.** Verified live: `pnpm smoke` passes against three real 2026 leagues (full PPR with priority waivers, superflex with FAAB, half-PPR with FAAB).
  - espn-client covers league settings, rosters (one or all teams), matchups, free agents, recent activity (with player names resolved from player cards) and NFL bye weeks. Constants are ported from espn-api v1.0.0 (825ee9a).
  - core has the zod schemas, `leagues.json` config, `FantasyService`, and league rules discovery (ESPN values plus stored `upload`/`user` overrides, `missingRules` and `conflicts`).
  - 47 unit tests on espn-api's recorded fixtures, plus a fake-fetch end-to-end test of the service.
  - Fixes from the first live run: dropped ESPN's placeholder $0 bids in priority-waiver leagues, and trimmed whitespace in team names.
- [x] **Fresh clone on a second machine** (macOS): install, build, tests and `pnpm smoke` all pass.
- [x] **Injury tags spot-checked** against the ESPN app (2026-10-08): four superflex players tagged Q matched, including one projected at 0.0, which is how ESPN shows him too.
- [x] **Step 3: MCP server** (`apps/mcp`).
  - [x] All seven tools on MCP SDK v2 (`@modelcontextprotocol/server` 2.1.0), with core schemas as output schemas, structured output plus text, and read-only annotations.
  - [x] The server finds `leagues.json` and `.env` itself, and rebuilds the service when either changes. Config errors come back as tool errors.
  - [x] `set_league_rule` validates values against the settings schema before saving.
  - [x] `.mcp.json` for Claude Code; README config for Claude Desktop, Cursor, VS Code, Codex CLI and Gemini CLI.
  - [x] 9 tests over an in-memory client. A live stdio run launched from an unrelated cwd returned every tool's data for all three leagues.
  - [x] Verified 2026-10-08: "show my superflex roster" in Claude Code returned the right starters, bench and IR, and the tools work in the MCP Inspector (CLI mode).

## In progress / next

- [ ] Check live game-day shapes (fixtures are from 2018): during a game window, confirm `locked` and actual points on `get_matchup`.
- [ ] **Step 4: Skills:** `weekly-check` and `waivers`, as `SKILL.md` files and as MCP prompts for clients without skills.
  - Bake in these rules of thumb: Tuesday injury tags are stale; lineups lock per player; start the safe lineup; Monday-night backups; every claim needs a drop; IR moves; bye stacking; FAAB discipline; superflex QBs.
  - Done when one real Tuesday waiver run and one Saturday lineup check produce moves the user would actually make.
- [ ] **Step 5:** use it for 2–3 weeks and note what's missing.

## Later

- [ ] **Trades skill.** Add `get_teams` and `get_team_roster` tools; core already has `getTeamRoster`, and espn-client already fetches every roster in one request.
  - Fix mode fills my hole from another team's surplus.
  - Opportunity mode covers consolidation, buy-low and sell-high.
  - Every proposal gets a fairness check.
- [ ] **Publish to npm.** Publish `espn-client` and `core` as libraries, so other apps can depend on them. Publish the MCP server with a `bin`, so MCP clients can launch it with `npx`.
  - Needs an owned npm scope: create the `@espn-fantasy-mcp` org, or rename the packages to `@nscaamano/*`.
  - Do it once the MCP server works (after step 3).

## Open questions

- **Rest-of-season projections.** ESPN returns a stat entry with `statSplitTypeId: 3`, season period, projected source, alongside the season projection. It may be rest-of-season; unverified. Check it against ESPN's ROS rankings before building trades.
- **Free-agent depth.** `getFreeAgents` pulls ESPN's top 50 by % rostered, then re-sorts by projection, so a low-rostered breakout outside the top 50 can be missed. Consider paging, or ESPN's projection sort filter.
- **Waiver process hour.** ESPN reports `processHour: 11` with no timezone. Confirm against when claims actually clear.
- **`get_league_settings` size.** It's about 7 KB (≈2k tokens) per league, mostly scoring items and the team list. Fine for now; if it adds up across three leagues, split standings into `get_teams` (planned for trades anyway) or drop zero-point scoring items.
- **Trade activity mapping** (message 244) is ported from espn-api but not yet seen in live data. Verify on the first real trade.

## Ideas / reach goals

- **Kickoff times and opponents.** The pro schedule has per-week game times. Surfacing "locks Thursday 8:15pm vs SEA" would sharpen the per-player lock advice.
- **Matchup strength.** ESPN's `mPositionalRatings` gives the defense-vs-position rank, which is useful for start/sit tiebreaks.
- **FAAB market memory.** Log every league's winning bids weekly (`getRecentActivity` already returns them) to learn what a breakout RB actually costs in each league.
- **Manager profiles** for trades: activity level, positional needs, how often they accept trades.
- **Pre-lock alerts.** A scheduled check (Claude Code routines or a cron) that pings when a starter turns OUT before kickoff.
- **Remote MCP** so Claude mobile can reach it. It would need auth, since the server holds ESPN cookies.
- **Other platforms** (Sleeper, Yahoo) as more clients behind the same core contract.
