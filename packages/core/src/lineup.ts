// The highest-projected legal lineup. Mechanical only: it knows slot
// eligibility, byes, injury designations and lock state, but not the news.
// The weekly-check skill decides what to do with the result.

import { slotRank } from "./map.js";
import type { LineupPlayer, OptimalLineup, Player, Roster, RosterSlot } from "./schemas.js";

const CANT_PLAY = new Set(["OUT", "IR", "SUSPENDED"]);
const GAME_TIME = new Set(["QUESTIONABLE", "DOUBTFUL"]);

// Tie-breakers, far below a projection's 0.01 resolution: a filled slot beats
// an empty one, and the current slot beats an equal swap, so nothing churns.
const FILL_BONUS = 0.001;
const STAY_BONUS = 0.0001;
const INELIGIBLE = 1e6;

type Risk = OptimalLineup["risks"][number];

/**
 * Min-cost assignment of rows to distinct columns (Hungarian algorithm,
 * O(rows² × cols)). Needs rows ≤ cols. Returns the column for each row.
 */
export function assign(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  if (n > m) throw new Error("assign: more rows than columns");
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // column → row (1-based), 0 = free
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) rowToCol[p[j]! - 1] = j - 1;
  return rowToCol;
}

const compact = (s: RosterSlot): LineupPlayer => ({
  id: s.player.id,
  name: s.player.name,
  position: s.player.position,
  proTeam: s.player.proTeam,
  injuryStatus: s.player.injuryStatus,
  projectedPoints: s.player.projectedPoints,
  kickoff: s.player.game?.kickoff ?? null,
  locked: s.locked,
});

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Fills `slots` (starting slot → count, from league settings) from the roster's
 * starters and bench to maximize projected points. Locked players stay put, IR
 * slots are left alone, and players on bye or OUT/IR/SUSPENDED don't start.
 */
export function optimizeLineup(roster: Roster, slots: Record<string, number>): OptimalLineup {
  const week = roster.week;
  const pool = [...roster.starters, ...roster.bench];
  // If the NFL schedule didn't load, nobody has a game; fall back to byeWeek alone.
  const scheduleKnown = pool.some((s) => s.player.game !== null);
  const whyOut = (p: Player): string | null => {
    if (p.byeWeek === week || (scheduleKnown && p.game === null)) return "bye";
    if (CANT_PLAY.has(p.injuryStatus)) return p.injuryStatus;
    return null;
  };

  // Locked starters keep their slot; locked bench players can't come in.
  const fixed = roster.starters.filter((s) => s.locked);
  const open: string[] = [];
  for (const [slot, count] of Object.entries(slots)) {
    const taken = fixed.filter((s) => s.slot === slot).length;
    for (let i = taken; i < count; i++) open.push(slot);
  }
  open.sort((a, b) => slotRank(a) - slotRank(b));
  const candidates = pool.filter((s) => !s.locked && whyOut(s.player) === null);

  // Rows: open slots. Columns: candidates, then one "leave empty" per slot.
  const cost = open.map((slot) => [
    ...candidates.map((c) =>
      c.player.eligibleSlots.includes(slot)
        ? // A negative projection (D/ST can have one) still beats an empty slot.
          -(
            Math.max(0, c.player.projectedPoints ?? 0) +
            FILL_BONUS +
            (c.slot === slot ? STAY_BONUS : 0)
          )
        : INELIGIBLE,
    ),
    ...open.map(() => 0),
  ]);
  const picks = open.length ? assign(cost) : [];

  const chosen = new Map<number, { slot: string; s: RosterSlot }>(); // open index → pick
  picks.forEach((col, row) => {
    const c = candidates[col];
    if (c && cost[row]![col]! < INELIGIBLE) chosen.set(row, { slot: open[row]!, s: c });
  });

  const starters: OptimalLineup["starters"] = [
    ...fixed.map((s) => ({ slot: s.slot, player: compact(s) })),
    ...open.map((slot, row) => {
      const pick = chosen.get(row);
      return { slot, player: pick ? compact(pick.s) : null };
    }),
  ].sort((a, b) => slotRank(a.slot) - slotRank(b.slot));

  // Moves: compare every non-IR player's slot before and after.
  const newSlot = new Map<number, string>();
  for (const s of fixed) newSlot.set(s.player.id, s.slot);
  for (const { slot, s } of chosen.values()) newSlot.set(s.player.id, slot);
  const moves: OptimalLineup["moves"] = [];
  for (const s of pool) {
    const to = newSlot.get(s.player.id) ?? "BE";
    if (to === s.slot) continue;
    const benched = to === "BE";
    moves.push({
      player: s.player.name,
      from: s.slot,
      to,
      reason: benched ? (whyOut(s.player) ?? "lower projection") : null,
    });
  }
  // Benchings first, then who comes in, so each move reads as a swap.
  moves.sort((a, b) => Number(b.to === "BE") - Number(a.to === "BE"));

  const risks: Risk[] = [];
  const startingIds = new Set(newSlot.keys());
  const bench = candidates.filter((c) => !startingIds.has(c.player.id));
  for (const { slot, s } of chosen.values()) {
    const p = s.player;
    if (GAME_TIME.has(p.injuryStatus) && p.game) {
      const kickoff = Date.parse(p.game.kickoff);
      const backups = bench
        .filter(
          (b) =>
            b.player.eligibleSlots.includes(slot) &&
            b.player.game !== null &&
            Date.parse(b.player.game.kickoff) >= kickoff,
        )
        .map((b) => b.player.name);
      risks.push({
        type: "GAME_TIME",
        slot,
        player: p.name,
        detail: backups.length
          ? `${p.injuryStatus}; bench backups who play at the same time or later: ${backups.join(", ")}`
          : `${p.injuryStatus}; no healthy bench backup plays at the same time or later, so there's no pivot after inactives`,
      });
    }
    if (!p.projectedPoints) {
      risks.push({
        type: "NO_PROJECTION",
        slot,
        player: p.name,
        detail: "projected at 0 or not projected; ESPN may expect him to sit",
      });
    }
  }
  open.forEach((slot, row) => {
    if (!chosen.has(row)) {
      risks.push({
        type: "EMPTY_SLOT",
        slot,
        player: null,
        detail: "no healthy, eligible player on the roster; look at free agents",
      });
    }
  });

  const total = starters.reduce((t, s) => t + (s.player?.projectedPoints ?? 0), 0);
  return {
    league: roster.league,
    week,
    starters,
    projectedTotal: round(total),
    currentProjectedTotal: roster.projectedTotal,
    moves,
    risks,
    asOf: roster.asOf,
  };
}
