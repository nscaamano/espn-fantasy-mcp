---
name: weekly-check
description: Check the user's ESPN fantasy football lineups before games lock. Flags starters who are injured, questionable, on a bye or projected at zero, checks the news, and gives start/sit moves per league. Use for "check my lineups", "who should I start", "weekly check", "any lineup problems", or before Thursday, Sunday or Monday games.
---

# Weekly lineup check

Uses the espn-fantasy MCP tools. They're read-only, so you recommend moves and the user makes them in the ESPN app. Run this before the week's first game (usually Thursday), again Saturday or Sunday morning, and whenever the user asks.

## 1. Gather, per league

Use the league the user named, or every league from `list_leagues`. For each one:

1. **`get_league_settings`.** Note the starting slots (`roster.slots`), whether the league is superflex (an `OP` slot), the scoring format and `lineupLock`. If `missingRules` or `conflicts` is non-empty, ask the user before advising, and save the answer with `set_league_rule`. Never carry one league's rules over to another.
2. **`get_my_roster`** for the current week.
3. **`get_matchup`** for the projected score on both sides and the margin.
4. **`get_optimal_lineup`** for the best lineup by projection. It already handles slot eligibility, byes, OUT/IR/SUSPENDED players and locked players, and lists `risks`: questionable starters without a same-time-or-later backup, zero projections and slots nobody can fill. Treat it as the starting point, not the answer: it doesn't know the news.

## 2. Flag problems

Check every starter, then the bench:

- **Must fix:**
  - A starter on a bye: `game` is null, or `byeWeek` equals the week.
  - A starter who is OUT, IR or SUSPENDED.
  - An empty starting slot: fewer starters in a slot than `roster.slots` calls for.
- **Likely fix:**
  - A starter who is DOUBTFUL.
  - A starter who is QUESTIONABLE with a 0.0 projection. ESPN zeroes players it expects to sit, so treat him as likely out, not as a normal Q.
  - A starter with no projection who isn't on a bye.
- **Research:** a starter who is QUESTIONABLE with a normal projection.
- **Upgrade:** a healthy bench player who projects at least about 2 points more than a starter in a slot he's eligible for (`eligibleSlots`).
- **IR housekeeping:**
  - A player in an IR slot who is no longer IR- or OUT-designated has to be activated or dropped. ESPN blocks other roster moves while the IR slot holds an ineligible player.
  - A bench player who is OUT long-term can move to an open IR slot (`roster.irSlots`) to free a bench spot, if ESPN shows him as IR-eligible.
- **Locked players:** a player with `locked: true` has kicked off and can't be moved. Mention him only if it matters.

## 3. Check the news

Web-search every flagged or questionable player. Look for the team's injury report, practice participation (DNP, limited, full) and beat reporters. Cite the source and its date for every status claim.

Weigh the news by when it came out:
- **Tuesday:** injury tags are often left over from last week. Don't act on them yet.
- **Wednesday to Friday:** practice reports. Friday's game designation (out, doubtful, questionable) is the strongest signal before game day.
- **Game day:** official inactives come out about 90 minutes before kickoff. That's the final word.

If you have no web search, say so, and use the ESPN tags and projections only, labeled as such.

## 4. Set the lineup

- **Start from `get_optimal_lineup`'s `moves`**, then adjust for the news: a player the news rules out comes out, and a questionable player cleared by the news can go back in. FLEX takes RB, WR or TE. OP (superflex) takes QB, RB, WR or TE.
- **An `EMPTY_SLOT` risk** means no healthy player on the roster can fill that slot. Check `get_free_agents` for that position, then name the pickup and the drop.
- **Superflex:** start the two best-projected QBs regardless of name, and check both for byes.
- **Default to the safe lineup.** A questionable star sits until news clears him, then gets swapped in. A forgotten swap should never mean a zero. Give the user the deadline for that swap: his kickoff, or inactives about 90 minutes before.
- **Lineups lock per player at kickoff** (`game.kickoff`), not at the week's first game. A Sunday or Monday player can still be swapped after Thursday's game.
- **Late-game questionable players** need a backup who kicks off at the same time or later, ideally a teammate who absorbs his work. Otherwise the user can't pivot once inactives come out. This matters most for Sunday night and Monday night games.
- **Don't churn.** Leave near-equal choices (under about 1 point apart) alone unless the news breaks the tie.

## 5. Report

Give one short block per league, and give times in the user's time zone (Eastern if unknown):

```
**<league alias>** (format, week N): projected 128.4 vs 119.0 (+9.4)
Moves:
1. Start A at FLEX, bench B. B is OUT (team injury report, Fri Oct 16).
2. Move C to IR (OUT, multi-week), freeing a bench spot.
Watch:
- D (Q, Sun 4:25 PM ET). Confirm at inactives, about 2:55 PM. If he's out, start E.
```

Write "No changes needed" for a league that's set. Put the must-fix moves first, keep it to the moves and watches, and skip players with nothing to report.
