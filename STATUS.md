# Status

Last updated: 2026-11-04 · Design and specs: [docs/design.md](docs/design.md)

**Next session: tooling requests, round 2** (2026-11-04, from two weeks of real use through the connector). Ordered easiest first, which also puts the assistant's own top pick (news) near the top. Each ships with a live check, tests, the skills updated to use it, and README/design rows.

1. [x] **Pivot fix** done 2026-11-04 (under Done).
2. [x] **Player news, built in** done 2026-11-04 (under Done).
3. [x] **FAAB price history by position** done 2026-11-04 (under Done).
4. [x] **Bye coverage planner** done 2026-11-04 (under Done).
5. [x] **Trade partner finder** done 2026-11-04 (under Done).

Built in parallel by three agents in separate worktrees, reviewed and merged one by one. Next: use them for a week (the done-checks below), then tune from what they get wrong.

**Bid competition** done 2026-11-06 (under Done). Next: use it on Tuesday's waivers and compare its ranges with what claims actually go for; tune `INTEREST_SHARE`, `SIMILAR_SHARE` and the range rule from that.

**Ongoing (user):** the Step 4 done-checks (a real weekend `weekly-check` and a Tuesday `waivers` run), testing the `trades` skill by hand, and reconnecting cached clients after each deploy that adds tools or fields. Publishing a new core to npm is optional now (no app needs the new types), so batch it.

**After any deploy that adds output fields:** clients that cache tool schemas (Claude's connectors) reject the new fields ("must NOT have additional properties") until their tool list is refreshed, because zod objects become JSON Schemas with `additionalProperties: false`. Reconnect the connector (or `/mcp` → Reconnect in Claude Code) after deploying. Clients that list tools per session, like the web app, aren't affected.

## Done

- [x] **Bid competition** (2026-11-06). `get_bid_competition(league, players[1–5])` sizes up who else wants a waiver target and what it may take. Pure logic in `core/src/bids.ts`.
  - **Value, byes counted:** a team's gain is its best lineups' added points over the weeks left, each week without the players on bye, each player at his rest-of-season projection per game left (the trade finder's assignment with a per-game value). That's what makes a third QB worth his bye-week cover in superflex.
  - **Rivals:** teams he'd help by at least 10% of his projection (`INTEREST_SHARE`), with `faabRemaining`, waiver rank and a bidding `history` from the season's `mTransactions2` logs (claims that won or were outbid; other failures don't show willingness). `aheadOfMe` counts interested teams ahead in priority, which decides claims in priority leagues.
  - **Market:** wins on similar players, matched on per-game value now within 40% (`SIMILAR_SHARE`, one `kona_playercard` request for every won player); else the position; else every win. The first rule, priced against the whole position, put a backup RB at $31–40 because of one premium back's $30 runner-up; similar-value pricing put him at $8–10.
  - **Range:** none with budget: the minimum; one rival: median to upper quartile; two or more: upper quartile to the highest win; capped at the richest rival's budget + 1 and the user's. `basis` names the strongest rival so the skill can argue for going higher (a new starter's projection trails his role).
  - Verified live in all three leagues (about 2–4 KB, about 2 s): a FAAB rival with the biggest gain and a full budget had never made a claim, which the skill now reads as a signal; the priority league returns no range, just who's ahead. Other teams' queued claims aren't visible, so it's tendencies, not a prediction.

- [x] **Trade partner finder** (round 2, item 5; 2026-11-04). `find_trade_partners(league, need, offer?, limit?)` reads every roster (one `mRoster` per team, in parallel) and builds each team's best lineup by `seasonProjectedPoints` over the starting slots (FLEX and OP included; OUT/IR/SUSPENDED players listed as `out`, not counted). Pure logic in `core/src/partners.ts`.
  - A player is spare for his team when he'd add at least a point to the other lineup, no less than his team loses without him, and that loss is under a quarter of his projection. Per partner: `theirSurplus` at the need, `forThem` (the user's spare players; offer inferred when omitted), `theirShortage` (rank at each offer position, bottom third `short`), and `bestSwap`/`fit`, the one-for-one swap that helps both lineups most. `reach` flags room for an uneven deal. The thresholds (`MIN_EDGE`, `DEPTH_SHARE`) are tuned on three leagues only.
  - The `trades` skill starts partner discovery with it and confirms only the shortlisted rosters with `get_team_roster`.
  - Verified live: for a superflex QB need, the top partner had a third startable QB on the bench and ranked 11th of 12 at WR (confirmed against its roster). About 3.5–5.7 KB and 1.3 s.
- [x] **Bye coverage planner** (round 2, item 4; 2026-11-04). `get_bye_coverage(league, fromWeek?, toWeek?)`: per week (default: the current week and the five after, capped at the league's last scoring week), `openSlots` (a maximum matching of available players to the starting slots by eligibility, via the optimizer's `assign()`) and `short` (positions with fewer available players than `fullStrength`, the best lineup by season projection with everyone healthy, which catches a superflex QB conflict that eligibility alone misses). `core/src/byes.ts`, pure and unit-tested.
  - Available means not on bye, not OUT/IR/SUSPENDED now, and not at a 0 season projection (`zeroProjection`). Injury is only known for now, so `injured` players count in no week, and `ifHealthy`/`openSlotsIfHealthy` say what changes if they're back.
  - Skills: `trades` and `waivers` judge proposals, claims and drops against the flagged weeks; `weekly-check` adds a one-line heads-up for next week.
  - Verified live: a superflex roster one QB short in two straight weeks (one starter's bye each week; the third QB projects 0), checked against the roster; K, D/ST and TE weeks with no backup elsewhere. About 0.5–0.7 KB.
- [x] **FAAB price history by position** (round 2, item 3; 2026-11-04). `get_faab_prices(league, weeks?, position?)`: every team's winning waiver bids by position over the last `weeks` scoring periods (default 5, up to the season): wins, `contested`, median, min, max and the top bids. One `mTransactions2` request per week; past weeks are cached for good.
  - Checked live: an outbid claim is another team's `FAILED_INVALIDPLAYERSOURCE` PROCESS record in the same run, and it keeps its bid, which gives each win a `runnerUp` and a `bidders` count. Roster-limit failures and a team's own backup claims don't count as competition; free-agent adds aren't bids.
  - Priority leagues return counts only (`usesFaab: false`). The `waivers` skill sizes bids from it: the position's median, comparable players, and `runnerUp` for contested targets.
  - Verified live in all three leagues; a contested superflex QB went for $20 (runner-up $8), matching `get_waiver_results`. About 0.7–4 KB.

- [x] **Player news, built in** (round 2, item 2; 2026-11-04). ESPN's public fantasy news feed (`site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?playerId=…`; no cookies are sent; one player per request, a list of ids is refused) mixes long ESPN articles (`type: "Story"`) with short Rotowire blurbs, which are all that's kept: headline, story, published, newest first. Checked live: the latest blurb's `published` equals the player's `lastNewsDate`.
  - **Attached where problems are flagged:** every `get_optimal_lineup` risk about a player carries `news` (his latest blurb), and so do `get_player`'s first 5 matches. Fetched in parallel and cached briefly per player; a failed fetch just leaves `news` out.
  - **`get_player_news(league, names[1–10], limit 1–5)`** for anyone else or more history. Names resolve like `get_player`; `otherMatches` flags an ambiguous name, `notFound` the misses.
  - Skills: `weekly-check` quotes the attached blurb and web-searches only when it's older than the latest practice report or inactives, or for the team's injury report; `waivers` and `trades` read targets' news in one `get_player_news` call before searching.
  - Verified live 2026-11-04: five GAME_TIME risks in the superflex league each came with the blurb behind the tag (a hamstring strain, a groin, a knee, ankle/knee, an iced throwing arm). `get_player_news` explained a 0-projection QB: he's been benched to third string. Two players at two blurbs each is about 3.9 KB.
- [x] **Pivot fix** (round 2, item 1; 2026-11-04). A `GAME_TIME` starter's pivots are bench players whose game starts after his inactives come out (`INACTIVES_LEAD_MS`, 90 minutes before his kickoff), not only those at the same time or later: a 4:05 PM backup now counts for a 4:25 PM starter, a 1:00 PM one still doesn't. The same rule protects a starter's only pivot from drop suggestions. The no-pivot wording keeps its "no healthy bench backup" prefix, which clients match on.

- [x] **Player lookup by name** (tooling request 5, 2026-10-29). `get_player(league, name, limit?, week?)` takes full or partial names and returns players of any status: ROSTERED (team, lineup slot, `isMine`), FREE_AGENT, or WAIVERS (with `waiverClears`), each with the free-agent fields (injury, game, week and season points and projections, % rostered, positional rank).
  - ESPN's `filterName` on `kona_player_info`, checked live: it matches the start of a first or last name as typed, needs a sort when given a `limit`, and returns every status with `onTeamId`. espn-api has no server-side name search (it downloads every player and matches exact names).
  - With no hits it retries word by word with loose matching (punctuation and word order ignored), so "AJ Brown" and "Jamarr Chase" work. Exact name matches win, and `totalMatches` flags an ambiguous name.
  - Slots come from the owners' rosters. `getRoster` now sends `forTeamId`, so one team's roster is about 0.34 MB instead of 3.4 MB, which also speeds up `get_my_roster` and `get_team_roster`.
  - Verified live in all three leagues: rostered (mine and another team's), free agent, waivers, no match, partial name. The skills and the server instructions point to it for named players.
- [x] **Trades skill** (2026-10-29). `skills/trades/SKILL.md`, served as the `trades` prompt.
  - Fix mode fills a hole the waiver wire can't from another team's surplus; opportunity mode covers consolidation, buy-low and sell-high.
  - Players are valued rest of season under each league's own scoring (reception points, superflex QBs) and over the best free agent. Rest-of-season points come from `seasonProjectedPoints` (rest of season during the season; see Open questions) plus web-searched rankings.
  - Every proposal gets a fairness check (both lineups gain or fill a need, value within about 15%), respects the deadline and review period, and comes with a message for the other manager.
  - `weekly-check` and `waivers` suggest it for a hole no free agent fills. Not yet run live.
- [x] **`get_waiver_results` fix** (2026-10-29): it reports the latest run that has any of the user's claims, not the league's latest. Leagues that also run waivers daily for dropped players had a later run with none of the user's claims, which hid Wednesday's results. Verified live.
- [x] **`get_waiver_results` tool** (2026-10-28). How the user's claims fared in the week's latest waiver run, from `view=mTransactions2` (the league's transaction log, every team's):
  - A run writes one `PROCESS` record per claim (`EXECUTED` or `FAILED_*`) pointing at its proposal (`relatedTransactionId`), which stays `PENDING` in the log, so only PROCESS and CANCEL records count. Claims processed within an hour of the latest one form the run (daily-waiver leagues have several runs a week).
  - Each claim is WON, LOST (another team's EXECUTED add of the same player in the run: that team and its bid), FAILED (ESPN's status as `reason`) or CANCELED (since the run before; the bid comes from the canceled proposal, since the cancel record says $0). Bids are null in priority leagues. Plus `processedAt` and the user's `waiverRank` now.
  - `memberId` isn't modeled. The test fixture is hand-written in the live shape. Verified live on 2026-10-28 for all three leagues (a won $5 claim and a canceled $3 one in the FAAB superflex league).
- [x] **ESPN's win probability** (2026-10-28): `winProbability` (0–1) on each matchup side in `get_matchup` and `get_scoreboard`, from `mMatchupScore`. ESPN sets it for the current matchup period only, so other weeks return null. The scoreboard skill shows it as a "Win %" column. Verified live for all three leagues.
- [x] **Optimizer fixes from real use** (2026-10-28). All additive (new fields, risk types and one rule; no renames), from misses in weeks 7–8:
  - **`IR_INELIGIBLE` risk:** a player in an IR slot whose status softened (OUT → QUESTIONABLE) blocks adds and claims. The new rule `roster.irEligibleStatuses` sits in `missingRules` until set (ESPN doesn't expose it; checked live), and the optimizer assumes OUT/IR/SUSPENDED meanwhile. Both skills ask for it once per league.
  - **`droppable`** on roster slots (ESPN's undroppable list, and false once the game kicks off) and lineup players. **`seasonProjectedPoints`** on every player.
  - **Drop suggestions:** with a full roster (starting slots plus bench; ESPN's `isBenchUnlimited` is true even when a max applies), each pickup and IR fix names the droppable bench player with the lowest season projection. It never picks the only late backup or a player in a pending claim.
  - **`waiverClears`** on free agents (ESPN's `waiverProcessDate`), plus `kickoff` on suggestions: a claim's deadline is the claim run, a free agent's is his kickoff.
  - **Pending claims** in `get_optimal_lineup`: players a claim drops leave the pool, and a claim whose add fits an empty slot is attached as `pendingClaim` (no duplicate suggestion, no extra drop).
  - **`staleTag`** on GAME_TIME risks: news older than the week's latest Wed–Fri practice report (counted from 4 PM ET) or than kickoff minus 8 days.
  - **A 0-projection best option leaves the slot empty:** one EMPTY_SLOT names him, and no move benches him. A negative D/ST projection still starts, and the rule is skipped when no projections are loaded. NO_PROJECTION stays in the enum for older clients but isn't emitted.
  - Verified live (week 8): superflex's empty RB slot shows the queued claim, an Oct 18 Q tag is flagged stale, and roster limits (15 and 16) match ESPN. 131 tests.

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
- [x] **Remote HTTP mode** (2026-10-16). `pnpm start` serves the same tools and prompts over Streamable HTTP, behind a shared-secret token (in the path or as a bearer header) with an unauthenticated `/health`.
  - `LEAGUES_JSON` seeds `LEAGUES_CONFIG` on first start.
  - Verified on a hosted deployment: live ESPN reads work from a cloud host, and claude.ai connects as a custom connector.
  - Provider-specific setup stays out of the repo.
- [x] **CI** (2026-10-21). GitHub Actions runs build, typecheck, lint, format check and tests on every push and pull request.
- [x] **Several people per server** (2026-10-28). Each token maps to one person: the environment's setup, plus a folder per person under `MCP_TENANTS_DIR`, each with its own `leagues.json` and `.env` (cookies and token). Folders are re-read per request. `MCP_AUTH_TOKEN` takes comma-separated tokens so each client can be revoked alone. Tests check that a folder tenant's ESPN requests carry its own cookies, never the server owner's.
- [x] **Network retry** (2026-10-25). espn-client retries once, after 500 ms, on a network failure or a 502/503/504; auth and not-found errors fail at once. Errors now name the cause (`fetch failed (ECONNRESET)`). Prompted by 2026-10-14, when one of ESPN's CDN addresses failed for minutes. A retry opens a new connection, which usually gets another address, but nothing guarantees it.
- [x] **Live game-day check** (2026-10-25, Sunday night of week 7).
  - Actual points come through as expected: null until a player's game starts, then live.
  - **ESPN's matchup data never sets `lineupLocked`**, even after a game ends. Rosters do set it.
  - Core now locks matchup players at kickoff (`lockAtKickoff`), so `get_matchup` and `get_scoreboard` report `locked` correctly. The `scoreboard` skill relies on that flag.
  - Found while building the private web app's scoreboard.
- [x] **Security upgrade** (2026-10-25). `pnpm audit` flagged high advisories on the MCP SDK (server < 2.3.0: messages crossing between HTTP clients, and memory exhaustion from one request) and zod (< 4.6.6: memory exhaustion). Upgraded to SDK 2.3.1 and zod 4.6.7, so the audit is clean. Run `pnpm audit` before releases.
- [x] **Deploy-on-push** (2026-10-25). The hosted copy deploys from `main` after CI passes. The setup lives on the host; details are in the private runbook.

## In progress / next

- [ ] **Step 4: Skills.** Written 2026-10-14. The done-check is still pending.
  - [x] `skills/weekly-check/SKILL.md` and `skills/waivers/SKILL.md` (Agent Skills format), with the rules of thumb from the design doc built in.
  - [x] Claude Code loads them through symlinks in `.claude/skills/`. The MCP server serves the same files as the prompts `weekly_check` and `waivers` (optional `league` argument; the text starts with the current time). A test fails if a skill names a tool the server doesn't have.
  - [x] Every player now carries this week's `game` (opponent, home or away, kickoff), from the NFL schedule already fetched for byes. The lock and late-game backup rules use it. Verified live for week 6.
  - [x] `skills/scoreboard/SKILL.md` (2026-10-25): every league's matchup on one screen. A summary table puts each side's top three scorers next to its score, then each league's starters slot by slot with points and projections. It shows status only, without advice. Written from a real Sunday request made from the phone.
  - [ ] Done when one real Tuesday waiver run and one Saturday lineup check produce moves the user would actually make. Tune the `SKILL.md` files from what those runs get wrong.
  - [x] First tuning pass on `waivers` (2026-10-14, from a test run). Injury length comes from news, never from the tag. ESPN's projections and % rostered are inputs, not the answer, so check role, usage and schedule. Drops are judged on role and upside, not % rostered. When streaming, the K or D/ST being replaced is the drop.
  - [x] First tuning pass on `weekly-check` (applied 2026-10-29, proposed after the 2026-10-14 run). The first check is Thursday afternoon, after the Wednesday and Thursday practice reports. Pickups use what an `EMPTY_SLOT` risk already carries (`freeAgents`, `pendingClaim`, `drop`). A `GAME_TIME` risk with no late backup, or a starter the news rules out, gets a `get_free_agents` search for a fill-in with the same or a later kickoff, plus a drop judged on role, never the only late backup. IR follows the `IR_INELIGIBLE` risk; when an IR player's tag softened without a risk, the user confirms in the app that ESPN still allows him there.
- [ ] **Step 5:** use it for 2–3 weeks and note what's missing.

## Tooling requests (from mobile use, 2026-10-25)

After a few weeks of use from the Claude iPhone app, the assistant listed the tools that slowed it down. Its top two were **fresher injury status** (an ESPN tag showed OUT while the app showed Q) and a **lineup optimizer** (a bye-week player almost stayed in a lineup). Ordered here from easiest to hardest:

1. [x] **Multi-league calls** (2026-10-25). `get_scoreboard` returns my matchup in every league from one call, run in parallel; a league that fails (a bye, an ESPN error) is listed in `errors` instead of failing the rest. The `scoreboard` skill uses it. Rosters are still per league.
2. [x] **Status freshness** (2026-10-25). Every `Player` has `lastNewsDate` (when ESPN last posted news on him), and rosters and matchups have `asOf` (when they were read), so the assistant can tell a stale tag or an old result. Checked live:
   - Rosters and free agents carry `lastNewsDate` for everyone but team defenses. **ESPN's matchup data doesn't include it** (the 2018 fixtures did), so it's null in `get_matchup` and `get_scoreboard`, and those tools say to use `get_my_roster` when freshness matters.
   - The stale-OUT theory about reading the wrong field was wrong: the roster entry's own `injuryStatus` reads `NORMAL` for every player in 2026, and the parser already uses the player's. ESPN's read host doesn't cache either (`must-revalidate`, CloudFront misses). The likely cause was the assistant reusing an earlier result, or ESPN's API lagging its app; `asOf` covers the first.
3. [x] **Free-agent sort by season value** (2026-10-25). `get_free_agents` takes `sort: "week" | "season"`; `season` ranks by ESPN's season projection (rest of season, in-season), which surfaces stash candidates. Schedule strength is a separate, medium job (see Matchup strength under ideas). True rest-of-season projections are still an open question.
4. [x] **Other teams' rosters** (2026-10-25). `get_teams` (record, points, seed, waiver rank, FAAB left) and `get_team_roster` (any team, same shape as `get_my_roster`). These were the data the trades skill needed.
5. [x] **Player lookup by name** (2026-10-29): `get_player`, under Done.
6. [ ] **FAAB bid history by position.** Now round 2, item 3 (top of this file), built on `mTransactions2` instead of paging activity. Was: Medium. Winning bids are in `get_recent_activity`, but a season's worth means paging the activity endpoint and aggregating by position and week. Same as FAAB market memory under ideas.
7. [x] **Lineup optimizer** (2026-10-25). `get_optimal_lineup` (`core/src/lineup.ts`) solves the slot assignment exactly (Hungarian algorithm) over the league's starting slots, with stored rules applied.
   - It excludes byes and OUT/IR/SUSPENDED players, keeps locked players in place, and leaves IR slots alone. Ties keep the current lineup, so it doesn't churn.
   - It returns the moves (benchings come with a reason) and before/after totals, plus `risks`:
     - GAME_TIME: a Q or D starter, with the bench backups who play at the same time or later.
     - NO_PROJECTION: a starter projected at 0.
     - EMPTY_SLOT: a slot nobody healthy can fill.
   - `weekly-check` now starts from it and adds the news.
   - Verified live: it caught next week's superflex lineup with an RB slot nobody can fill (the starter is on bye and the only other RB projects 0).
   - Tuned after the first run from the phone (2026-10-25). Every move has a reason: incoming players say whom they replace. EMPTY_SLOT and NO_PROJECTION risks carry the top three free agents for that slot (fetched per slot, in parallel; a failed lookup just leaves them out). NO_PROJECTION now says to treat the slot as open, since the optimizer only starts a 0-projection player when nobody else can.
8. [ ] **Practice reports and inactives.** Partly covered by round 2, item 2: ESPN's player news blurbs report practice participation and inactive calls as text. Structured data is still missing. Hard. ESPN's fantasy API has no practice participation, and inactives land about 90 minutes before kickoff. It would need ESPN's separate, also undocumented, news feed or another source, plus polling on game day. Until then, the skills use web search.
9. [ ] **Write actions** (`set_lineup`, `add_drop`, `submit_claim`). Hardest, and it needs a decision first: the project is read-only by design. ESPN's write endpoints are unofficial and thinly covered by espn-api, a bad call costs a real roster move, and the hosted server's token-in-URL auth would be guarding writes (see OAuth under open questions). If pursued: lineup moves first (reversible until kickoff), every write behind an explicit confirmation (MCP elicitation where the client supports it), and claims last.

## Later

- [x] **Trades skill** (2026-10-29), under Done. Still to do: run it live and tune it.
- [x] **Publish to npm** (2026-10-25). `@nscaamano/espn-fantasy-client@0.1.0` and `@nscaamano/espn-fantasy-core@0.1.0` are live.
  - Publishing needs 2FA on the npm account. Run `pnpm publish` from each package folder, client first; npm asks for approval in the browser.
  - New packages also get a `0.0.0-stage` placeholder version from npm's staged-publishing system. It's harmless; `latest` points to the real version.
  - Right after a publish, the registry can lag a minute or two, and a retry then fails with "cannot publish over 0.1.0". That error means the publish worked.
  - When a tool's output changes, bump and publish core, so apps typed against it stay in sync.
  - [ ] Optional: npm trusted publishing from GitHub Actions (OIDC, with `npm stage publish`), so a version tag publishes without a token.
  - [ ] The MCP server with a `bin` for `npx`. It needs to ship `skills/` inside the package first.

## Open questions

- **OAuth for the HTTP mode.** A token in the URL is simple but weaker. claude.ai connectors support OAuth, which would allow per-device revocation and avoid long-lived secrets in URLs.
- ~~**Rest-of-season projections.**~~ Answered 2026-11-04: during the season, the season projection itself (`seasonProjectedPoints`, `statSplitTypeId: 0`) covers the games left. Live in week 9 it tracked the weekly projection times the games left, and a player with 144 points through eight games projected 154. The trades skill and tool descriptions now treat it as rest of season. The `statSplitTypeId: 3` entry is still unexplained.
- **Free-agent depth.** `getFreeAgents` pulls ESPN's top 50 by % rostered, then re-sorts by projection, so a low-rostered breakout outside the top 50 can be missed. Consider paging, or ESPN's projection sort filter. A player found through news can now be checked by name with `get_player`.
- **Waiver process hour.** `acquisitionSettings.waiverProcessHour` is 11 in all three leagues, but it isn't a clock hour in UTC or Eastern time. Every pending claim on 2026-10-13 had `processDate` 07:00 UTC (Wed 3:00 AM ET). `status.waiverProcessStatus` (past runs, keyed by timestamp) shows runs between 07:00 and 08:00 UTC on Wed and some Thu/Fri/Sat/Sun. `status.waiverLastExecutionDate` was Tue 07:24–07:52 UTC, a day not in `waiverProcessDays`. Meaning of 11 unknown. Use a claim's `processesAt` for timing. `get_league_settings` still passes `processHour` through raw; consider replacing it with the last and next run times from `status`.
- **`get_league_settings` size.** It's about 7 KB (≈2k tokens) per league, mostly scoring items and the team list. Fine for now; if it adds up across three leagues, split standings into `get_teams` (planned for trades anyway) or drop zero-point scoring items. Separately, zod v4 gives every `.int()` field ±2^53 bounds in the tools' JSON Schema, which pads `tools/list`; strip them if tool-list size matters.
- **Trade activity mapping** (message 244) is ported from espn-api but not yet seen in live data. Verify on the first real trade.

## Ideas / reach goals

- **Matchup strength.** ESPN's `mPositionalRatings` gives the defense-vs-position rank, which is useful for start/sit tiebreaks.
- **FAAB market memory** (now round 2, item 3). Log every league's winning bids weekly (`getRecentActivity` already returns them) to learn what a breakout RB actually costs in each league.
- **Manager profiles** for trades: activity level, positional needs, how often they accept trades.
- **Pre-lock alerts.** A scheduled check (Claude Code routines or a cron) that pings when a starter turns OUT before kickoff.
- **Other platforms** (Sleeper, Yahoo) as more clients behind the same core contract.
- **Public vs private leagues.** A league read without cookies returns 200 for a public league and 401 for a private one; ESPN's settings also carry `settings.isPublic` (both checked live). Add `isPublic` to `get_league_settings` and a cookie-free `isLeaguePublic` probe in espn-client, so onboarding can skip cookies for public leagues.
