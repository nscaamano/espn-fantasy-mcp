// Bye coverage: for each upcoming week, which starting slots the roster can't
// fill and which positions run short of the full-strength lineup. Eligibility
// only, no weekly projections: a planning view for trades and claims, not a
// lineup. The skills decide what a hole is worth.

import { assign } from "./lineup.js";
import { slotRank } from "./map.js";
import type { ByeCoverage, InjuryStatus, Player, Roster } from "./schemas.js";

/** Can't play now. Whether he's back by a future week is unknown, so he's reported apart. */
const CANT_PLAY: ReadonlySet<InjuryStatus> = new Set(["OUT", "IR", "SUSPENDED"]);
const INELIGIBLE = 1e6;
const FILL_BONUS = 0.001;
/** Per accepted position: makes the broadest slot the one reported open when several could be. */
const BREADTH_TIE = 0.001;

/** One entry per starting slot, e.g. { QB: 1, RB: 2 } → ["QB", "RB", "RB"], in lineup order. */
export function slotList(slots: Record<string, number>): string[] {
  return Object.entries(slots)
    .flatMap(([slot, n]) => Array.from({ length: Math.max(0, n) }, () => slot))
    .sort((a, b) => slotRank(a) - slotRank(b));
}

const eligible = (p: Player, slot: string) => p.eligibleSlots.includes(slot);

/**
 * Starting slots a group of players can't fill, by a maximum matching on
 * eligibility alone. When several slots could be the open one (one player for
 * RB or FLEX), the broadest slot (accepting the most positions) is reported,
 * since any of them would do.
 */
export function unfilledSlots(players: readonly Player[], slots: readonly string[]): string[] {
  if (!slots.length) return [];
  const breadth = (slot: string) =>
    new Set(players.filter((p) => eligible(p, slot)).map((p) => p.position)).size;
  const cost = slots.map((slot) => [
    ...players.map((p) => (eligible(p, slot) ? 0 : INELIGIBLE)),
    ...slots.map(() => 1 - BREADTH_TIE * breadth(slot)),
  ]);
  const picks = assign(cost);
  return slots.filter((_, row) => {
    const col = picks[row]!;
    return col >= players.length || cost[row]![col]! >= INELIGIBLE;
  });
}

/**
 * How many players of each position the full-strength lineup starts: the best
 * assignment of every player to the starting slots by season projection,
 * ignoring byes and injuries. In superflex that's usually two QBs (QB + OP).
 */
export function fullStrength(
  players: readonly Player[],
  slots: readonly string[],
): Record<string, number> {
  if (!slots.length) return {};
  const value = (p: Player) => Math.max(0, p.seasonProjectedPoints ?? p.projectedPoints ?? 0);
  const cost = slots.map((slot) => [
    ...players.map((p) => (eligible(p, slot) ? -(value(p) + FILL_BONUS) : INELIGIBLE)),
    ...slots.map(() => 0),
  ]);
  const counts: Record<string, number> = {};
  assign(cost).forEach((col, row) => {
    const p = players[col];
    if (p && cost[row]![col]! < INELIGIBLE) counts[p.position] = (counts[p.position] ?? 0) + 1;
  });
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => slotRank(a) - slotRank(b) || a.localeCompare(b)),
  );
}

/**
 * Bye coverage for weeks `fromWeek` through `toWeek`, from the roster's
 * starters and bench (IR-slot players don't count). A player is available in
 * a week unless his NFL team is on bye then, he's OUT, IR or SUSPENDED now, or
 * ESPN projects him for 0 points this season (it zeroes players it expects to
 * sit: benched, out for the year). Current injuries are carried forward as
 * unknown rather than guessed: counts and slots that would change if every
 * injured player were back come with an `ifHealthy` figure.
 */
export function byeCoverage(
  roster: Roster,
  slots: Record<string, number>,
  fromWeek: number,
  toWeek: number,
): ByeCoverage {
  const pool = [...roster.starters, ...roster.bench].map((s) => s.player);
  const starting = slotList(slots);
  const strength = fullStrength(pool, starting);
  // If ESPN sent no season projections at all, a 0 means "not loaded", not "won't play".
  const projectionsKnown = pool.some((p) => (p.seasonProjectedPoints ?? 0) !== 0);
  const idle = (p: Player) => projectionsKnown && p.seasonProjectedPoints === 0;
  const counted = pool.filter((p) => !idle(p));
  const injured = counted.filter((p) => CANT_PLAY.has(p.injuryStatus));

  const weeks: ByeCoverage["weeks"] = [];
  for (let week = fromWeek; week <= toWeek; week++) {
    const onBye = (p: Player) => p.byeWeek === week;
    const playing = counted.filter((p) => !onBye(p));
    const healthy = playing.filter((p) => !CANT_PLAY.has(p.injuryStatus));

    const open = unfilledSlots(healthy, starting);
    const openIfHealthy =
      healthy.length === playing.length ? open : unfilledSlots(playing, starting);

    const short: NonNullable<ByeCoverage["weeks"][number]["short"]> = [];
    for (const [position, needed] of Object.entries(strength)) {
      const available = healthy.filter((p) => p.position === position).length;
      if (available >= needed) continue;
      const ifHealthy = playing.filter((p) => p.position === position).length;
      short.push({ position, available, needed, ...(ifHealthy > available ? { ifHealthy } : {}) });
    }

    weeks.push({
      week,
      byes: pool.filter(onBye).map((p) => p.name),
      ...(open.length ? { openSlots: open } : {}),
      ...(openIfHealthy.length !== open.length ? { openSlotsIfHealthy: openIfHealthy } : {}),
      ...(short.length ? { short } : {}),
    });
  }

  return {
    league: roster.league,
    fromWeek,
    toWeek,
    fullStrength: strength,
    injured: injured.map((p) => ({
      name: p.name,
      position: p.position,
      injuryStatus: p.injuryStatus,
    })),
    zeroProjection: pool.filter(idle).map((p) => p.name),
    weeks,
    asOf: roster.asOf,
  };
}
