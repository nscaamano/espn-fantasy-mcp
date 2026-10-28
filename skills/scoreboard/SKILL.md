---
name: scoreboard
description: Show the user's live ESPN fantasy football matchup scores across all their leagues in one view. A summary table with each side's score, top three scorers and projection, then each league's starters slot by slot with points and projections. Use for "how are my matchups", "scores", "scoreboard", "am I winning", "show all my games", or during and after game windows.
---

# Scoreboard across leagues

Uses the espn-fantasy MCP tools. ESPN's app shows one matchup at a time; this puts every league on one screen. It's a status view, not advice: don't recommend moves unless the user asks.

## 1. Gather

1. **`get_scoreboard`**: every league's matchup in one call, for the current week unless the user named one. If the user named one league, use `get_matchup` for just that league instead. A league in `errors` (usually a bye week) gets a one-line note instead of a row.
2. **`list_leagues`** for each league's display name, since the matchups carry only the alias.

From each matchup, use for both sides:
- `score` (points so far) and `projected` (ESPN's live projected final).
- `winProbability`: ESPN's chance that side wins (0–1). It's set for the current week only, and is null otherwise.
- Each starter's `slot`, name, `actualPoints`, `projectedPoints`, `injuryStatus`, `locked` and `game` (kickoff, opponent).

A player has played, or is playing, if `locked` is true. Show his points even if they're 0.0. A player who hasn't kicked off shows "—" for points. On a bye week (`opponent` is null), say so and show only the user's side.

## 2. Summary table

One row per league, with the most interesting game first: closest projected margin, then the rest.

| League | You | Opponent | Proj. (you – opp) | Win % | Status |
|---|---|---|---|---|---|
| League A | **90.8** · Smith 22.9, Jones 19.7, Lee 9.1 | 83.2 Team Name · Brown 27.4, Diaz 16.4, Cole 14.7 | 104.0 – 96.5 | 71% | Leading by 7.6 · 1 left vs 1 |

- **You:** your score, bold if you're ahead, then your **top three scorers** by actual points so far, as last names with points. Before any of your starters has played, show the top three by projection instead, marked "proj".
- **Opponent:** their score (bold if they're ahead), their team name, then their top three the same way.
- **Proj.:** the two `projected` totals.
- **Win %:** your `winProbability` as a whole percentage (ESPN's number, not yours). Show "—" when it's null.
- **Status:** leading or trailing, and by how much: "Narrow lead" if the margin is under about 10, then how many starters each side still has to play ("2 left vs 3"). Once every starter on both sides has played, say "Won" or "Lost".

Above the table, say in one line whether games are still in progress, and in which window ("4:25 PM games in progress, SNF and MNF still to come").

## 3. Per-league detail

A table per league, headed with the league name:

| Slot | You | Pts / Proj | Opponent | Pts / Proj |
|---|---|---|---|---|
| QB | Player A (SNF) | — / 16.3 | Player B | 16.5 / 20.3 |

- Pair starters by slot, in the league's slot order, both sides on one row.
- Points are actual / projected, with "—" for players who haven't played.
- Mark players who haven't kicked off with their window: (TNF), (SNF), (MNF), or the day and time for anything else. Mark injury tags after the name: Q, D, O.
- Keep names short: last name without suffixes (Jr., Sr., III), or first initial plus last name if two players share one. Team defenses keep their team name ("Broncos D/ST").

## 4. One line per league

After the tables, give each league one line on what's left: who still plays on each side, and what has to happen. For example: "Up 30 with Mahomes left; they have three Monday-night starters, so it isn't locked up." Keep it factual. No lineup advice unless the user asks.

Give times in the user's time zone (Eastern if unknown).
