---
name: waivers
description: Find waiver-wire and free-agent pickups across the user's ESPN fantasy football leagues. Finds roster holes, ranks targets by fit, sets FAAB bids or claim order, and names a drop for every claim. Use for "waivers", "who should I pick up", "FAAB bids", "free agents", "need a replacement for an injured player", usually Monday night or Tuesday before claims process.
---

# Waiver and free-agent run

Uses the espn-fantasy MCP tools. They're read-only, so you recommend claims, bids and drops, and the user enters them in the ESPN app. The best time is Monday night or Tuesday, before claims process. Claims usually process overnight into Wednesday; each pending claim's `processesAt` gives the exact time. Also run it after a starter gets hurt.

## 1. Gather, per league

Use the league the user named, or every league from `list_leagues`. For each one:

1. **`get_league_settings`.** Note:
   - `waivers.type`: FAAB or PRIORITY.
   - For FAAB, `faabRemaining`, `faabBudget` and `minimumBid`.
   - For PRIORITY, `myWaiverRank` and `priorityResets`.
   - The starting slots, bench size, IR slots and `positionLimits`.
   - The trade deadline and playoff start week, for how far ahead to plan.

   If `missingRules` or `conflicts` is non-empty, ask the user first, and save the answer with `set_league_rule`. That includes `roster.irEligibleStatuses`, which ESPN never reports: an ineligible player left on IR blocks every claim. Never assume a waiver system. Don't suggest bids in a priority league.
2. **`get_my_roster`** for the current week. On waiver day, ESPN's current week is already the upcoming one.
3. **`get_pending_claims`.** What the user has already queued: don't repeat a claim or reuse a drop by accident.
4. **`get_recent_activity`.** The prices in this league. Winning FAAB bids show what managers here pay. It also shows who just dropped whom.

## 2. Find the holes

- **This week:**
  - Starters on a bye with no startable bench replacement.
  - Starters who are OUT, IR, DOUBTFUL, or QUESTIONABLE with a 0.0 projection.
  - Web-search how long each injury is expected to last. An IR or OUT tag doesn't say whether it's one week or the season, so never guess the length from the tag.
- **Depth:** enough startable players to cover every starting slot plus the byes in the next two to three weeks (compare `byeWeek` across the roster). In superflex, keep three startable QBs if possible, because a QB bye or injury is otherwise a zero.
- **Dead bench spots:**
  - Long-term injured players who belong on IR (if a slot is open and ESPN allows it).
  - Players with no role on their NFL team, confirmed by news or usage, not just a tiny projection or a low % rostered.
  - Bye-week fill-ins whose job is done.
  - A second K or D/ST. The league starts one, and they're easy to stream, so a backup is worth almost nothing.
- **Streaming,** in leagues that start D/ST or K: compare the next matchup (`game.opponent`) against the current starter's.

## 3. Find candidates

Call `get_free_agents` for each position with a hole, plus OP or QB in superflex and D/ST or K for streaming.

- `status` FREE_AGENT means the user can add the player right now in the app, with no claim needed. Say so.
- `status` WAIVERS means he needs a claim.
- The pool is the most-rostered available players, so a barely rostered breakout can be missing. Web-search the week's top pickups if a hole is urgent.

## 4. Rank by fit, not just projection

ESPN's projections and % rostered are inputs from one model and from the crowd. They aren't the answer. Form your own view, and when it differs from ESPN's numbers, say why.

- Does he fill this week's hole? A player on a bye this week can't. Or is he a rest-of-season upgrade?
- **His role:** starter, committee or handcuff. Check his snap share, carries or targets over the last few weeks, and his place on the depth chart. Web-search his usage and news, and cite source and date.
- **Has the situation changed?** If the player ahead of him got hurt, check how long he'll be out. A season-ending injury turns a one-week fill-in into a rest-of-season starter, and ESPN's season projection can lag behind that change.
- **Upcoming schedule:** the opponents over the next few weeks, not just this one.
- **Momentum:** a rising `percentChange` means other managers are noticing, so he'll cost more.
- **ESPN's numbers, as one input:** `projectedPoints`, `seasonPoints`, `seasonProjectedPoints`, `injuryStatus` and upcoming byes.

## 5. Bids or claim order

**FAAB leagues:**
- Size each bid from:
  - the remaining budget;
  - how much he matters to the lineup;
  - how scarce the position is;
  - what similar players went for in this league (`get_recent_activity`).
- Don't bid big on a speculative add (single-digit % rostered). The minimum bid, or $0 where `minimumBid` is 0, is often enough.
- Save budget for real breakouts, such as the new lead back after a starter's season-ending injury. Those deserve a large share of what's left.
- Budget is worth nothing after the season, so spend more freely as the playoffs near.
- Give a range when unsure ("$8, up to $12 if you really want him"). Keep the bid within `faabRemaining`.

**Priority leagues:**
- Rank the claims in the order the user should enter them.
- Say whether the claim is worth using a high waiver spot. If priority resets weekly (`priorityResets: true`), using it costs little. If it rolls over, save it for difference-makers.

## 6. A drop for every claim

- **Every claim needs a named drop.** Otherwise it fails for lack of roster space. Pick the player with the least value to this roster, and judge it the same way as adds:
  - **Role and upside first:** a backup RB who'd start if the player ahead of him got hurt is worth more than his projection, especially while one of the user's own starters is questionable.
  - **% rostered measures popularity, not value to this roster.** Don't name a drop because of a low % rostered or a small projection alone.
  - **When streaming a K or D/ST, drop the one being replaced.** Don't keep two on the bench unless a bye makes it necessary, and even then, compare the backup with a skill player who has upside.
  - Keep anyone needed for an upcoming bye.
- **Claims can't land on IR,** and a claim mustn't push a position past `positionLimits`.
- **Alternative claims share a drop:** "RB A, else RB B", both dropping C. Once one wins, the other fails, which is what you want.
- **Claims the user wants both of need different drops.**
- **Check the pending claims.** Don't reuse a drop that's already queued unless that's intended, and say so.
- ESPN doesn't expose the order of queued claims. If order matters, tell the user the order to set in the app.

## 7. Report

Give one block per league, with times in the user's time zone (Eastern if unknown):

```
**<league alias>** (FAAB $53 of $100 left, min $1). Claims process Wed 3:00 AM ET.
Already queued: X ($5), dropping Y.
Holes: RB2 (Z on bye in week 8), QB depth (W on bye in week 10).
Claims, in this order:
1. Add A (RB, HOU), bid $14, drop B. Starting job after C's injury (source, date).
2. Add D (QB, NO), bid $3, drop E. Covers the week 10 bye.
Add now (free agent): F (K) for G.
Passed on: H. Hyped, but 2% rostered and no role yet.
```

Put the most important move first. If nothing is worth a claim, say so plainly.
