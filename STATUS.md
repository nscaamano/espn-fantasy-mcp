# Status

Last updated: 2026-10-14 · Design and specs: [docs/design.md](docs/design.md)

**Next session:** the step 4 done-checks: a real Saturday lineup check and a Tuesday waiver run. Also the live game-day check below, during any game window.

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
  - [x] All seven original tools on MCP SDK v2 (`@modelcontextprotocol/server` 2.1.0), with core schemas as output schemas, structured output plus text, and read-only annotations.
  - [x] The server finds `leagues.json` and `.env` itself, and rebuilds the service when either changes. Config errors come back as tool errors.
  - [x] `set_league_rule` validates values against the settings schema before saving.
  - [x] `.mcp.json` for Claude Code; README config for Claude Desktop, Cursor, VS Code, Codex CLI and Gemini CLI.
  - [x] 9 tests over an in-memory client. A live stdio run launched from an unrelated cwd returned every tool's data for all three leagues.
  - [x] Verified 2026-10-08: "show my superflex roster" in Claude Code returned the right starters, bench and IR, and the tools work in the MCP Inspector (CLI mode).

- [x] **`get_pending_claims` tool** (2026-10-13). The user's queued claims from `view=mPendingTransactions`: add, drop (with the slot it leaves), bid (null in priority leagues), `proposedAt` and `processesAt`. Names come from one player-card request.
  - `memberId` is never modeled in espn-client, so it can't reach output. The tests check this, plus the empty case.
  - Only the user's own team's claims are returned; service filters by `myTeamId` in case ESPN ever sends others.
  - ESPN exposes no claim priority order, so the tool lists claims in submission order and says so.
  - The server instructions tell the assistant to call it before recommending claims.
  - Fixture `pending_transactions.json` was recorded live and scrubbed (see the fixtures README).
  - Verified live: two claims in the priority league, one $5 FAAB claim, and an empty list in the third league.
- [x] **WSL timestamp fix** in `apps/mcp/src/load.ts`: the loader now detects changes to `leagues.json`/`.env` by content hash, not mtime and size. Linux's coarse mtime made a same-size edit within a few ms look unchanged; this failed a test on WSL but not macOS.

## In progress / next

- [ ] Check live game-day shapes (fixtures are from 2018): during a game window, confirm `locked` and actual points on `get_matchup`.
- [ ] **Step 4: Skills.** Written 2026-10-14. The done-check is still pending.
  - [x] `skills/weekly-check/SKILL.md` and `skills/waivers/SKILL.md` (Agent Skills format), with the rules of thumb from the design doc built in.
  - [x] Claude Code loads them through symlinks in `.claude/skills/`. The MCP server serves the same files as the prompts `weekly_check` and `waivers` (optional `league` argument; the text starts with the current time). A test fails if a skill names a tool the server doesn't have.
  - [x] Every player now carries this week's `game` (opponent, home or away, kickoff), from the NFL schedule already fetched for byes. The lock and late-game backup rules use it. Verified live for week 6.
  - [ ] Done when one real Tuesday waiver run and one Saturday lineup check produce moves the user would actually make. Tune the `SKILL.md` files from what those runs get wrong.
  - [x] First tuning pass on `waivers` (2026-10-14, from a test run). Injury length comes from news, never from the tag. ESPN's projections and % rostered are inputs, not the answer, so check role, usage and schedule. Drops are judged on role and upside, not % rostered. When streaming, the K or D/ST being replaced is the drop.
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
- **Waiver process hour.** `acquisitionSettings.waiverProcessHour` is 11 in all three leagues, but it isn't a clock hour in UTC or Eastern time. Every pending claim on 2026-10-13 had `processDate` 07:00 UTC (Wed 3:00 AM ET). `status.waiverProcessStatus` (past runs, keyed by timestamp) shows runs between 07:00 and 08:00 UTC on Wed and some Thu/Fri/Sat/Sun. `status.waiverLastExecutionDate` was Tue 07:24–07:52 UTC, a day not in `waiverProcessDays`. Meaning of 11 unknown. Use a claim's `processesAt` for timing. `get_league_settings` still passes `processHour` through raw; consider replacing it with the last and next run times from `status`.
- **`get_league_settings` size.** It's about 7 KB (≈2k tokens) per league, mostly scoring items and the team list. Fine for now; if it adds up across three leagues, split standings into `get_teams` (planned for trades anyway) or drop zero-point scoring items. Separately, zod v4 gives every `.int()` field ±2^53 bounds in the tools' JSON Schema, which pads `tools/list`; strip them if tool-list size matters.
- **Trade activity mapping** (message 244) is ported from espn-api but not yet seen in live data. Verify on the first real trade.

## Ideas / reach goals

- **Matchup strength.** ESPN's `mPositionalRatings` gives the defense-vs-position rank, which is useful for start/sit tiebreaks.
- **FAAB market memory.** Log every league's winning bids weekly (`getRecentActivity` already returns them) to learn what a breakout RB actually costs in each league.
- **Manager profiles** for trades: activity level, positional needs, how often they accept trades.
- **Pre-lock alerts.** A scheduled check (Claude Code routines or a cron) that pings when a starter turns OUT before kickoff.
- **Remote MCP** so Claude mobile can reach it. It would need auth, since the server holds ESPN cookies.
- **Other platforms** (Sleeper, Yahoo) as more clients behind the same core contract.
- **Public vs private leagues.** A league read without cookies returns 200 for a public league and 401 for a private one; ESPN's settings also carry `settings.isPublic` (both checked live). Add `isPublic` to `get_league_settings` and a cookie-free `isLeaguePublic` probe in espn-client, so onboarding can skip cookies for public leagues.
