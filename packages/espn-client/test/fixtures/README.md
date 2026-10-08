Recorded ESPN fantasy v3 responses, trimmed from the test data in
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

Per-player stats were cut to the scoring periods the tests read, and stat
breakdowns were dropped.
