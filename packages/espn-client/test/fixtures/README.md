Recorded ESPN fantasy v3 responses. All but one are trimmed from the test data in
[cwendt94/espn-api](https://github.com/cwendt94/espn-api) (MIT), commit 825ee9a,
`tests/football/unit/data/`. They're from older seasons (2018, 2019, 2024 pro
schedule), which is fine for parser tests; the live `pnpm smoke` run is what
confirms the current season's shapes.

| File | Source | Request |
| --- | --- | --- |
| `league.json` | `league_2018_data.json`, rosters kept for 2 teams | `mSettings`, `mTeam`, `mRoster` |
| `boxscore.json` | `league_boxscore_2018.json`, 2 matchups | `mMatchupScore`, `mScoreboard`, week 13 |
| `free_agents.json` | `league_free_agents_2018.json`, 8 players | `kona_player_info` |
| `recent_activity.json` | `league_recent_activity_2019.json`, 6 topics | `/communication/` |
| `player_card.json` | `league_2019_playerCard.json`, 2 players | `kona_playercard` |
| `pro_schedule.json` | `pro_schedule_2024.json`, week 1 games only | `proTeamSchedules_wl` |
| `pending_transactions.json` | Recorded live on 2026-10-13 (two queued waiver claims); see below | `mPendingTransactions` |
| `transactions.json` | Hand-written in the shape recorded live on 2026-10-28 (a FAAB waiver run); see below | `mTransactions2`, week 8 |
| `player_search.json` | Hand-written in the shape seen live on 2026-10-29; see below | `kona_player_info` with `filterName`, week 1 of 2018 |

Per-player stats were cut to the scoring periods the tests read, and stat
breakdowns were dropped.

`pending_transactions.json` was recorded from a real league and scrubbed:
`memberId` (ESPN's account GUID), `isActingAsTeamOwner` and `isLeagueManager`
were removed, the league id set to 1234, the user's team renumbered to 1, and
claim ids replaced. Player ids and timestamps are real.

`transactions.json` is made up, in the live shape: a waiver run writes one
`PROCESS` record per claim (`EXECUTED` or `FAILED_*`) whose
`relatedTransactionId` points at the proposal, which stays `PENDING` in the
log. It holds the latest run (team 2 wins one claim, loses one to team 5's $40
bid, and has one fail for another reason), the resolved proposals, a
cancellation (which records $0; its proposal has the bid), a claim queued after the run, and a run from the day before.
Player 3045147 matches `player_card.json`; the rest are placeholder ids.

`player_search.json` is made up, in the live shape of a name search: players of
every status, each with `onTeamId` (0 for none) and, on waivers,
`waiverProcessDate`. Antonio Brown (13934) is on team 1, as in `league.json`,
so his slot can be looked up; one "Pat Sample" is on team 2 but not on its
fixture roster. The rest are placeholder players. `fixtureFetch` filters it the
way ESPN's `filterName` behaves: case-insensitive, matching the start of the
full name or of the last name, punctuation as typed.
