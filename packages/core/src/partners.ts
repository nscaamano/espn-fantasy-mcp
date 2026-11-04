// Trade partner search: which teams have depth at the user's need and could
// use what the user can spare. Mechanical only: every value is a best lineup by
// ESPN's season projection (`seasonProjectedPoints`) over the league's starting
// slots. Fairness, rest-of-season value and the actual proposal belong to the
// trades skill.
//
// Definitions (season-projection points throughout):
// - L(team) is the team's best lineup total: an exact slot assignment over the
//   starting slots (FLEX and OP included), from players who can play now (not
//   OUT, IR or SUSPENDED, and not in an IR slot).
// - gain = what a lineup gains with a player added; cost = what it loses
//   without him (0 for a bench player).
// - A partner's player X at the need position is **surplus** when he'd help
//   the user at least as much as he helps them (gainForMe ≥ costToThem, and at
//   least MIN_EDGE) and his team has depth behind him: costToThem is under a
//   quarter of his value (DEPTH_SHARE). A starter whose loss would gut their
//   lineup isn't surplus, however much the user wants him.
// - The user's player Y at an offer position is **spare** for a partner by the
//   same test the other way: gainForThem ≥ costToMe (and MIN_EDGE), costToMe
//   under a quarter of his value.
// - A team is **short** at a position when its Nth-best player there ranks in
//   the league's bottom third, where N is how many the league's typical best
//   lineup starts there (2 QBs in superflex).
// - **fit** is the one-for-one swap (one of their surplus for one of the user's
//   spare players) whose smaller lineup gain is largest: both sides gain at
//   least that much. Swaps are judged jointly, since one player in can change
//   who fills FLEX or OP. Shortages are context; fit already prices them in.
//   Partners without such a swap follow, by `reach`: the smaller of the best
//   gain each side could get from the other's spare players, the room for a
//   bigger or uneven deal.

import { assign } from "./lineup.js";
import type {
  Player,
  PositionRank,
  Roster,
  RosterSlot,
  Team,
  TradePartners,
  TradePlayer,
  TradePosition,
} from "./schemas.js";

const CANT_PLAY = new Set(["OUT", "IR", "SUSPENDED"]);
/** Positions offered when the caller doesn't say: K and D/ST have no trade value. */
const SKILL: readonly TradePosition[] = ["QB", "RB", "WR", "TE"];
const INELIGIBLE = 1e6;
/** Rounding slack for comparing sums of projections. */
const EPS = 0.05;
/** Season points a move must gain, beyond its cost, to count: less is noise. */
export const MIN_EDGE = 1;
/**
 * A player is spare depth when losing him costs his team less than this share
 * of his value: someone nearly as good steps in.
 */
export const DEPTH_SHARE = 0.25;
/** Players listed per side of a partner. */
const LIST = 3;

export interface PartnerInput {
  /** Every team's roster, the user's included. */
  rosters: readonly Roster[];
  teams: readonly Team[];
  myTeamId: number;
  /** Starting slots and counts, from league settings. */
  slots: Record<string, number>;
  need: TradePosition;
  /** Positions the user would give up. Omitted or empty: inferred from the user's spare depth. */
  offer?: readonly TradePosition[];
  /** Most partners to return. Default 5. */
  limit?: number;
}

const value = (p: Player) => Math.max(0, p.seasonProjectedPoints ?? 0);
const round = (n: number) => Math.round(n * 10) / 10;
const canPlay = (s: RosterSlot) => s.slot !== "IR" && !CANT_PLAY.has(s.player.injuryStatus);

const tradePlayer = (p: Player): TradePlayer => ({
  name: p.name,
  position: p.position,
  proTeam: p.proTeam,
  injuryStatus: p.injuryStatus,
  byeWeek: p.byeWeek,
  seasonProjectedPoints: p.seasonProjectedPoints,
});

/** The best lineup by season projection: its total and who starts. */
export function bestSeasonLineup(
  players: readonly Player[],
  slots: readonly string[],
): { total: number; starters: Set<number> } {
  const starters = new Set<number>();
  if (!slots.length || !players.length) return { total: 0, starters };
  // Rows: slots. Columns: players, then one "leave empty" per slot.
  const cost = slots.map((slot) => [
    ...players.map((p) => (p.eligibleSlots.includes(slot) ? -value(p) : INELIGIBLE)),
    ...slots.map(() => 0),
  ]);
  let total = 0;
  assign(cost).forEach((col, row) => {
    const p = players[col];
    if (p && cost[row]![col]! < INELIGIBLE) {
      total += value(p);
      starters.add(p.id);
    }
  });
  return { total, starters };
}

interface Side {
  roster: Roster;
  team: Team | undefined;
  /** Players who can play now. */
  pool: Player[];
  /** OUT, IR or SUSPENDED, or in an IR slot. */
  out: Player[];
  base: number;
  starters: Set<number>;
}

interface Candidate {
  player: Player;
  gain: number;
  cost: number;
}

const net = (c: Candidate) => c.gain - c.cost;
/** He'd help the other lineup at least as much as his own, and his team has depth behind him. */
const isSpare = (c: Candidate) =>
  c.gain >= Math.max(c.cost, MIN_EDGE) && c.cost < DEPTH_SHARE * value(c.player) + EPS;
const maxGain = (list: Candidate[]) => Math.max(0, ...list.map((c) => c.gain));
/** Most value created first; on a tie, the one his team misses least (a bench player). */
const byNet = (a: Candidate, b: Candidate) =>
  net(b) - net(a) || a.cost - b.cost || value(b.player) - value(a.player);

/** Lower median, at least 1. */
function coreCount(counts: number[]): number {
  const sorted = [...counts].sort((a, b) => a - b);
  return Math.max(1, sorted[Math.floor((sorted.length - 1) / 2)] ?? 1);
}

export function findTradePartners(input: PartnerInput): TradePartners {
  const { need, myTeamId } = input;
  const slotList = Object.entries(input.slots).flatMap(([slot, n]) =>
    Array.from({ length: n }, () => slot),
  );
  const teamById = new Map(input.teams.map((t) => [t.id, t]));
  const sides: Side[] = input.rosters.map((roster) => {
    const all = [...roster.starters, ...roster.bench, ...roster.ir];
    const pool = all.filter(canPlay).map((s) => s.player);
    const { total, starters } = bestSeasonLineup(pool, slotList);
    return {
      roster,
      team: teamById.get(roster.teamId),
      pool,
      out: all.filter((s) => !canPlay(s)).map((s) => s.player),
      base: total,
      starters,
    };
  });
  const me = sides.find((s) => s.roster.teamId === myTeamId);
  if (!me) throw new Error(`No roster for the user's team ${myTeamId}`);
  const others = sides.filter((s) => s !== me);
  const league = me.roster.league;

  const startsAt = (pos: string) =>
    sides.some((s) =>
      [...s.pool, ...s.out].some(
        (p) => p.position === pos && p.eligibleSlots.some((slot) => slotList.includes(slot)),
      ),
    );
  if (!startsAt(need)) throw new Error(`${league} has no starting slot for ${need}`);

  /** L(side) with one player added and/or one removed. */
  const lineup = (s: Side, add?: Player, removeId?: number) =>
    bestSeasonLineup([...s.pool.filter((p) => p.id !== removeId), ...(add ? [add] : [])], slotList)
      .total;
  const costTo = (s: Side, p: Player) =>
    s.starters.has(p.id) ? s.base - lineup(s, undefined, p.id) : 0;
  const gainFor = (s: Side, p: Player) => lineup(s, p) - s.base;

  // The user's side of every deal: the user's spare players, for each other team.
  const explicit = input.offer?.filter((p) => p !== need && startsAt(p)) ?? [];
  const candidatePositions = explicit.length
    ? explicit
    : SKILL.filter((p) => p !== need && startsAt(p));
  const myCost = new Map(
    me.pool
      .filter((p) => candidatePositions.includes(p.position as TradePosition))
      .map((p) => [p.id, costTo(me, p)] as const),
  );
  const forThemBySide = new Map<Side, Candidate[]>(
    others.map((s) => [
      s,
      me.pool
        .filter((p) => myCost.has(p.id))
        .map((p) => ({ player: p, gain: gainFor(s, p), cost: myCost.get(p.id)! }))
        .filter(isSpare)
        .sort(byNet),
    ]),
  );
  const spareIds = new Set([...forThemBySide.values()].flat().map((c) => c.player.id));
  let offer = candidatePositions;
  if (!explicit.length) {
    const spareAt = candidatePositions.filter((pos) =>
      me.pool.some((p) => spareIds.has(p.id) && p.position === pos),
    );
    if (spareAt.length) offer = spareAt;
  }

  // Strength at each position: the Nth-best player who can play, ranked league-wide.
  const n = sides.length;
  const strength = new Map<string, Map<Side, { player: Player | null; value: number }>>();
  for (const pos of new Set<string>([need, ...offer])) {
    const count = coreCount(
      sides.map((s) => s.pool.filter((p) => p.position === pos && s.starters.has(p.id)).length),
    );
    strength.set(
      pos,
      new Map(
        sides.map((s) => {
          const player =
            s.pool.filter((p) => p.position === pos).sort((a, b) => value(b) - value(a))[
              count - 1
            ] ?? null;
          return [s, { player, value: player ? value(player) : 0 }];
        }),
      ),
    );
  }
  const rankAt = (s: Side, pos: string): PositionRank => {
    const all = strength.get(pos)!;
    const mine = all.get(s)!;
    const rank = 1 + [...all.values()].filter((o) => round(o.value) > round(mine.value)).length;
    const out = s.out.filter((p) => p.position === pos).map((p) => p.name);
    return {
      position: pos,
      weakestStarter: mine.player?.name ?? null,
      seasonProjectedPoints: round(mine.value),
      rank,
      short: rank > n - Math.floor(n / 3),
      ...(out.length ? { out } : {}),
    };
  };

  const partners = others.map((s) => {
    const surplus = s.pool
      .filter((p) => p.position === need)
      .map((p) => ({ player: p, gain: gainFor(me, p), cost: costTo(s, p) }))
      .filter(isSpare)
      .sort(byNet);
    const forThem = (forThemBySide.get(s) ?? []).filter((c) =>
      offer.includes(c.player.position as TradePosition),
    );
    let best: { get: Player; give: Player; myGain: number; theirGain: number } | null = null;
    for (const x of surplus) {
      for (const y of forThem) {
        const myGain = lineup(me, x.player, y.player.id) - me.base;
        const theirGain = lineup(s, y.player, x.player.id) - s.base;
        const score = Math.min(myGain, theirGain);
        if (score < MIN_EDGE) continue;
        if (!best || score > Math.min(best.myGain, best.theirGain) + EPS) {
          best = { get: x.player, give: y.player, myGain, theirGain };
        }
      }
    }
    // The swap's players are always listed, even when they'd miss the cut.
    const top = <T extends Candidate>(list: T[], keep?: Player) => {
      const head = list.slice(0, LIST);
      const extra = keep && !head.some((c) => c.player.id === keep.id);
      return extra ? [...head, ...list.filter((c) => c.player.id === keep.id)] : head;
    };
    const t = s.team;
    return {
      topNet: surplus[0] ? net(surplus[0]) : 0,
      entry: {
        teamId: s.roster.teamId,
        team: s.roster.teamName,
        record: t ? `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}` : "",
        playoffSeed: t?.playoffSeed ?? null,
        fit: best ? round(Math.min(best.myGain, best.theirGain)) : 0,
        reach: round(Math.min(maxGain(surplus), maxGain(forThem))),
        bestSwap: best && {
          get: best.get.name,
          give: best.give.name,
          myGain: round(best.myGain),
          theirGain: round(best.theirGain),
        },
        theirSurplus: top(surplus, best?.get).map((c) => ({
          ...tradePlayer(c.player),
          gainForMe: round(c.gain),
          costToThem: round(c.cost),
        })),
        theirShortage: offer.map((pos) => rankAt(s, pos)),
        forThem: top(forThem, best?.give).map((c) => ({
          name: c.player.name,
          position: c.player.position,
          gainForThem: round(c.gain),
        })),
      },
    };
  });

  const withSurplus = partners
    .filter((p) => p.entry.theirSurplus.length)
    .sort(
      (a, b) => b.entry.fit - a.entry.fit || b.entry.reach - a.entry.reach || b.topNet - a.topNet,
    );

  const needPlayers = [...me.pool, ...me.out]
    .filter((p) => p.position === need)
    .sort((a, b) => value(b) - value(a))
    .map((p) => ({ ...tradePlayer(p), starting: me.starters.has(p.id) }));
  const spare = me.pool
    .filter((p) => spareIds.has(p.id) && offer.includes(p.position as TradePosition))
    .sort((a, b) => myCost.get(a.id)! - myCost.get(b.id)! || value(b) - value(a))
    .map((p) => ({ ...tradePlayer(p), costToMe: round(myCost.get(p.id)!) }));

  return {
    league,
    week: me.roster.week,
    need,
    offer: [...offer],
    offerInferred: !explicit.length,
    teams: n,
    mine: { atNeed: rankAt(me, need), needPlayers, spare },
    partners: withSurplus.slice(0, input.limit ?? 5).map((p) => p.entry),
    noSurplus: partners.filter((p) => !p.entry.theirSurplus.length).map((p) => p.entry.team),
    asOf: me.roster.asOf,
  };
}
