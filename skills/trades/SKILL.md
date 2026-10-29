---
name: trades
description: Find trades in the user's ESPN fantasy football leagues that both sides could plausibly accept. Fix mode fills a roster hole from another team's surplus; opportunity mode looks for consolidation, buy-low and sell-high deals. Every proposal gets a fairness check under the league's own scoring. Use for "find me a trade", "find me a WR trade in the superflex league", "who should I trade with", "sell high", "buy low", or when weekly-check or waivers finds a starter hole the waiver wire can't fill.
---

# Trade finder

Uses the espn-fantasy MCP tools. They're read-only, so you propose trades and the user offers them in the ESPN app. Run it on demand, or after weekly-check or waivers finds a starter hole (a long injury, a bad bye week) where the best free agent projects well below the player being replaced.

Trades are per league. Use the league the user named. Otherwise, go through each league from `list_leagues`: fix mode where there's a hole, opportunity mode where there isn't, and say "nothing worth offering" for a league with neither.

## 1. Gather, per league

1. **`get_league_settings`.** Note:
   - the scoring format and `receptionPoints`, the starting slots (`OP` means superflex), whether it starts D/ST and K, bench size and `positionLimits`;
   - `trades.deadline`, `trades.reviewHours` and `trades.vetoVotesRequired`;
   - `currentWeek`, `schedule.regularSeasonWeeks`, `schedule.playoffStartWeek` and `schedule.playoffTeams`.

   If `missingRules` or `conflicts` is non-empty (including the trade deadline), ask the user first, and save the answer with `set_league_rule`. Never carry one league's rules over to another. **If the deadline has passed, stop** and say so.
2. **`get_teams`**: every team's record, points for and against, and playoff seed. `isMine` marks the user.
3. **`get_my_roster`**, then **`get_team_roster`** for every other team, for the current week.
4. **`get_recent_activity`** (limit about 50): who is active, who traded recently (TRADE_SENT, TRADE_RECEIVED) and for what, and who just added depth at a position. A manager with no moves in weeks may never answer an offer.
5. **`get_pending_claims`**: don't trade away a player a queued claim drops, or count on a claim that hasn't won.
6. **`get_free_agents`** at the position of need. That's the bar: a trade has to beat the best free agent clearly, or the answer is a claim, not a trade.
7. **`get_player`** for a player the user names ("what would it take to get X"): who has him, his slot there, his injury and projections.

## 2. Map needs and surpluses, every team

- **Need:** a starting slot filled by a weak, injured or bye-week player; a starter OUT for weeks (web-search how long: an IR or OUT tag doesn't say); upcoming byes stacked at one position (compare `byeWeek`); in superflex, fewer than two startable QBs, or no third for byes.
- **Surplus:** startable players beyond what the league's slots and the upcoming byes need, especially a bench player who would start for another team. FLEX takes RB, WR or TE, and OP takes QB, RB, WR or TE, so count depth against those slots too.
- **Context** from `get_teams`: contenders (a good record or a playoff seed) want points now. Teams falling out of the race (a losing record, well out of the last playoff seed) are more open to selling veterans or taking a gamble. A team with several starters out needs points this week.

## 3. Value players rest of season, under this league's scoring

Value is points over the rest of the season, not this week. ESPN's numbers are one input; form your own view, and say why when it differs.

- **Rest-of-season points:** `seasonProjectedPoints` is the full season, not what's left. Estimate the rest as roughly `seasonProjectedPoints` ÷ 17 per game, times his games left over the weeks that matter (minus a bye still to come), and label it as derived. Where his role has changed, trust the recent `projectedPoints` over the season figure. Web-search rest-of-season rankings for this league's format, and cite the source and date.
- **Over replacement:** what matters is how much he beats the best free agent at his position in this league. A WR in a deep free-agent pool is worth less than a TE or superflex QB with nothing behind him.
- **Scoring format:**
  - Full PPR lifts high-target WRs, TEs and pass-catching backs. Half-PPR lifts them less; in standard, touchdown-heavy backs gain.
  - Superflex: a startable QB is worth far more than in a one-QB league, often a top RB or WR. Never leave the user with fewer than two startable QBs.
  - K and D/ST have almost no trade value: stream them instead.
- **Situation:** role (snap share, targets, carries over the last few weeks), injury and return date, upcoming schedule, byes left, and, for a contender, the playoff weeks (`playoffStartWeek` onward). Web-search role and news for every player in a proposal, and cite source and date.

## 4. Build proposals

**Fix mode** (the user has a hole): find teams with surplus at the user's need, then offer from the user's surplus at a position they're short at.

**Opportunity mode** (the user is in good shape): scan for struggling teams (starters injured, a brutal bye week, a losing streak, no depth at a position) and use the user's depth to upgrade.
- **Consolidation:** two solid bench players for one of their better starters. It works for a team with holes.
- **Buy low:** a good player in a slump or about to return from injury, from a manager who needs points now. Check that the slump isn't a lost role.
- **Sell high:** a hot player whose role or schedule is about to get worse (a starter returning ahead of him, hard matchups, a bye in the playoffs). Confirm it in the news.

Prefer active managers with a reason to deal. Mind whom a trade strengthens: this week's opponent, or a rival for the last playoff seed.

**Roster mechanics:** the side that gets more players needs room. Name the user's drop, note that the other team must drop someone, and respect `positionLimits`.

## 5. Fairness check, every proposal

- **Both sides should gain:** each team's best starting lineup should project more points per week over the rest of the season, or at least fill a real need. Work it out from each roster and the league's slots.
- **Value in, value out:** what the user gives and gets, in rest-of-season points over replacement, should be roughly even, within about 15%. The leverage is the other manager's need, not a lopsided deal: those get rejected, vetoed (if `vetoVotesRequired` is set) and sour future offers.
- **If the user gives up more value,** say so, and propose it only when filling the hole is worth it.
- **Don't build a deal on news the other manager may not have seen,** such as an injury that broke an hour ago. It's likely to be vetoed and remembered.
- Cut any proposal that fails the check. If none survives, say so and fall back to the best free agent.

## 6. Deadline and review

- `trades.deadline` is ISO, UTC. Within a few days of it, propose only deals likely to be accepted quickly, and leave time for the review period.
- An accepted trade processes after `trades.reviewHours`. Players coming in can't start until it processes, so if review runs past a player's kickoff, set this week's lineup with the current roster.
- For a contender late in the season, weigh the playoff weeks over the regular-season weeks that are left.

## 7. Report

Up to three proposals per league, the best first, with times in the user's time zone (Eastern if unknown):

```
**<league alias>** (half-PPR, week 9, 5-3, 4th seed). Deadline Tue Nov 18, 12:00 PM ET; 48-hour review.
Need: RB2. A is out 4–6 weeks (source, date). Best free agent: B, 6.1 projected.
1. Give C (WR) + D (RB), get E (RB) from <team> (3-5, 9th).
   You: +4.1 starting points per week rest of season. Drop F for the roster spot.
   Them: +2.5 per week. They start G at WR, who's on bye in weeks 10 and 11, and E is their third startable RB.
   Risk: E is questionable (hamstring, limited Thursday; source, date). C and your other WR share the week 12 bye.
   Message: "You're thin at WR with G's bye coming. C and D for E?"
Passed on: H for I. They'd lose 5 points a week.
```

For each proposal give what the user gives, what he gets, his gain, their gain and why they'd accept, the risks (injury, bye overlap, role), and a short message to send the manager. The user makes the offer in the ESPN app.
