# Status

Last updated: 2026-10-07 · Design and specs: [docs/design.md](docs/design.md)

## Done

- [x] **Step 1: Scaffold.** pnpm workspace, strict TypeScript (project references), Vitest, ESLint and Prettier. `.env.example` and `leagues.example.json`. Node 24 via `.nvmrc`.
- [x] **Step 2: espn-client + core.** Verified live: `pnpm smoke` passes against three real 2026 leagues (full PPR with priority waivers, superflex with FAAB, half-PPR with FAAB).
  - espn-client covers league settings, rosters (one or all teams), matchups, free agents, recent activity (with player names resolved from player cards) and NFL bye weeks. Constants are ported from espn-api v1.0.0 (825ee9a).
  - core has the zod schemas, `leagues.json` config, `FantasyService`, and league rules discovery (ESPN values plus stored `upload`/`user` overrides, `missingRules` and `conflicts`).
  - 47 unit tests on espn-api's recorded fixtures, plus a fake-fetch end-to-end test of the service.
  - Fixes from the first live run: dropped ESPN's placeholder $0 bids in priority-waiver leagues, and trimmed whitespace in team names.

## In progress / next

- [ ] Spot-check injury tags in `pnpm smoke` against the ESPN app.
- [ ] **Step 3: MCP server** (`apps/mcp`): `McpServer` over stdio with `registerTool` and the core zod schemas as output schemas.
  - Tools: `list_leagues`, `get_league_settings`, `get_my_roster`, `get_matchup`, `get_free_agents`, `get_recent_activity`.
  - Also `set_league_rule`, which persists rules the user confirms by uploading a settings page or answering a question.
  - Register it in `.mcp.json`, with cookies from `.env`.
  - Done when "show my superflex roster" in Claude Code returns the right starters and bench.
- [ ] **Step 4: Skills** in `skills/`: `weekly-check` and `waivers`.
  - Bake in these rules of thumb: Tuesday injury tags are stale; lineups lock per player; start the safe lineup; Monday-night backups; every claim needs a drop; IR moves; bye stacking; FAAB discipline; superflex QBs.
  - Done when one real Tuesday waiver run and one Saturday lineup check produce moves the user would actually make.
- [ ] **Step 5:** use it for 2–3 weeks and note what's missing.

## Later

- [ ] **Trades skill.** Add `get_teams` and `get_team_roster` tools; core already has `getTeamRoster`, and espn-client already fetches every roster in one request.
  - Fix mode fills my hole from another team's surplus.
  - Opportunity mode covers consolidation, buy-low and sell-high.
  - Every proposal gets a fairness check.

## Open questions

- **Rest-of-season projections.** ESPN returns a stat entry with `statSplitTypeId: 3`, season period, projected source, alongside the season projection. It may be rest-of-season; unverified. Check it against ESPN's ROS rankings before building trades.
- **Free-agent depth.** `getFreeAgents` pulls ESPN's top 50 by % rostered, then re-sorts by projection, so a low-rostered breakout outside the top 50 can be missed. Consider paging, or ESPN's projection sort filter.
- **Waiver process hour.** ESPN reports `processHour: 11` with no timezone. Confirm against when claims actually clear.
- **Trade activity mapping** (message 244) is ported from espn-api but not yet seen in live data. Verify on the first real trade.

## Ideas / reach goals

- **Kickoff times and opponents.** The pro schedule has per-week game times. Surfacing "locks Thursday 8:15pm vs SEA" would sharpen the per-player lock advice.
- **Matchup strength.** ESPN's `mPositionalRatings` gives the defense-vs-position rank, which is useful for start/sit tiebreaks.
- **FAAB market memory.** Log every league's winning bids weekly (`getRecentActivity` already returns them) to learn what a breakout RB actually costs in each league.
- **Manager profiles** for trades: activity level, positional needs, how often they accept trades.
- **Pre-lock alerts.** A scheduled check (Claude Code routines or a cron) that pings when a starter turns OUT before kickoff.
- **Remote MCP** so Claude mobile can reach it. It would need auth, since the server holds ESPN cookies.
- **Other platforms** (Sleeper, Yahoo) as more clients behind the same core contract.
- **Publish packages to npm** so other projects can depend on `espn-client` and `core`.
