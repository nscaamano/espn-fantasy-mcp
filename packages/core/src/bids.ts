// Waiver bid competition: for a target, how much he'd add to each team's
// lineup over the rest of the season (week by week, so byes count), which
// rivals have the budget and a history of bidding, what the league has paid at
// his position, and a bid range from those. Pure; the service fetches rosters,
// settings and transaction logs. Other teams' queued claims aren't visible
// before a run, so this gives tendencies and a range, not a prediction.

import { median, type WeekLog, type WinningClaim } from "./faab.js";
import { bestSeasonLineup } from "./partners.js";
import type {
  BidCompetitionTarget,
  BidMarket,
  BidProfile,
  Player,
  Roster,
  Team,
} from "./schemas.js";

const CANT_PLAY = new Set(["OUT", "IR", "SUSPENDED"]);
/** ESPN's status for a claim on a player another team got first: an outbid claim. */
const OUTBID = "FAILED_INVALIDPLAYERSOURCE";
/**
 * A team is a rival for a target when he'd add at least this share of his own
 * rest-of-season projection to its lineup, and at least MIN_INTEREST points.
 */
export const INTEREST_SHARE = 0.1;
export const MIN_INTEREST = 2;
/** Below this many wins in a market, the next wider one stands in. */
export const MIN_MARKET = 2;
/** Wins on players within this share of the target's per-game value are "similar". */
export const SIMILAR_SHARE = 0.4;
/** The similar-value market uses at most this many of the closest wins. */
const SIMILAR_MAX = 6;
const RIVALS_LISTED = 5;
const COMPARABLES = 5;

const round = (n: number) => Math.round(n * 10) / 10;

/** A roster's players who can play now: not OUT, IR or SUSPENDED, and not in an IR slot. */
export function playable(roster: Roster): Player[] {
  return [...roster.starters, ...roster.bench]
    .map((s) => s.player)
    .filter((p) => !CANT_PLAY.has(p.injuryStatus));
}

/** His rest-of-season projection spread over his games left in `weeks` (0 with none). */
export function perGame(p: Player, weeks: readonly number[]): number {
  const games = weeks.filter((w) => w !== p.byeWeek).length;
  return games ? Math.max(0, p.seasonProjectedPoints ?? 0) / games : 0;
}

/**
 * The best lineup's projected points summed over `weeks`, each week without
 * the players on bye, each player valued at his `perGame`.
 */
export function restOfSeasonValue(
  players: readonly Player[],
  slots: readonly string[],
  weeks: readonly number[],
): number {
  const perGameById = new Map(players.map((p) => [p.id, perGame(p, weeks)] as const));
  let total = 0;
  for (const week of weeks) {
    const playing = players.filter((p) => p.byeWeek !== week);
    total += bestSeasonLineup(playing, slots, (p) => perGameById.get(p.id) ?? 0).total;
  }
  return total;
}

/** One waiver claim that ran: a win, or a loss to another team's higher claim. */
export interface ClaimBid {
  teamId: number;
  playerId: number;
  position: string | null;
  bid: number;
  week: number;
  won: boolean;
}

/**
 * Every claim that went to a run and either won or was outbid, oldest first.
 * Those show what a manager was willing to pay; failures for other reasons
 * (roster limit, the drop already gone) don't. A record seen twice counts once.
 */
export function claimBids(logs: readonly WeekLog[]): ClaimBid[] {
  const seen = new Set<string>();
  const bids: ClaimBid[] = [];
  for (const { week, transactions } of [...logs].sort((a, b) => a.week - b.week)) {
    for (const t of transactions) {
      if (t.type !== "WAIVER" || t.executionType !== "PROCESS" || !t.add) continue;
      if (t.status !== "EXECUTED" && t.status !== OUTBID) continue;
      if (t.id !== null) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
      }
      bids.push({
        teamId: t.teamId,
        playerId: t.add.playerId,
        position: t.add.position,
        bid: t.bid,
        week,
        won: t.status === "EXECUTED",
      });
    }
  }
  return bids;
}

/** A team's bidding so far: how often, how much, and how high at one position. */
export function bidProfile(
  bids: readonly ClaimBid[],
  teamId: number,
  position: string,
): BidProfile {
  const mine = bids.filter((b) => b.teamId === teamId);
  const wins = mine.filter((b) => b.won);
  const atPosition = mine.filter((b) => b.position === position);
  return {
    claims: mine.length,
    wins: wins.length,
    spent: wins.reduce((t, b) => t + b.bid, 0),
    maxBid: mine.length ? Math.max(...mine.map((b) => b.bid)) : null,
    claimsAtPosition: atPosition.length,
    maxBidAtPosition: atPosition.length ? Math.max(...atPosition.map((b) => b.bid)) : null,
    lastWeek: mine.length ? Math.max(...mine.map((b) => b.week)) : null,
  };
}

/**
 * The wins to price a target against: wins on players of similar value now
 * (per game, within SIMILAR_SHARE of his, closest first), else every win at
 * his position, else every win. `values` is each won player's per-game value
 * now, by id (players ESPN didn't return are left out of the similar market).
 */
export function marketWins(
  wins: readonly WinningClaim[],
  position: string,
  targetValue: number,
  values: ReadonlyMap<number, number>,
): { scope: string; list: WinningClaim[] } {
  const atPosition = wins.filter((w) => w.position === position);
  const similar = atPosition
    .filter((w) => values.has(w.playerId))
    .map((w) => ({ w, gap: Math.abs(values.get(w.playerId)! - targetValue) }))
    .filter(({ gap }) => targetValue > 0 && gap <= SIMILAR_SHARE * targetValue)
    .sort((a, b) => a.gap - b.gap || b.w.processDate - a.w.processDate)
    .slice(0, SIMILAR_MAX)
    .map(({ w }) => w);
  if (similar.length >= MIN_MARKET) return { scope: "SIMILAR", list: similar };
  if (atPosition.length >= MIN_MARKET) return { scope: position, list: atPosition };
  return { scope: "ALL", list: wins.filter((w) => w.position !== null) };
}

/** The q-quantile, interpolating between the two nearest values; null for no values. */
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** What a set of winning claims cost. Bid figures are null in priority leagues. */
export function bidMarket(
  scope: string,
  list: readonly WinningClaim[],
  usesFaab: boolean,
): BidMarket {
  const contested = list.filter((w) => w.bidders > 1);
  const runnerUps = list.map((w) => w.runnerUp).filter((r) => r !== null);
  const faab = usesFaab && list.length > 0;
  return {
    scope,
    wins: list.length,
    contested: contested.length,
    median: faab ? median(list.map((w) => w.bid)) : null,
    upperQuartile: faab
      ? quantile(
          list.map((w) => w.bid),
          0.75,
        )
      : null,
    contestedMedian: faab ? median(contested.map((w) => w.bid)) : null,
    max: faab ? Math.max(...list.map((w) => w.bid)) : null,
    topRunnerUp: faab && runnerUps.length ? Math.max(...runnerUps) : null,
  };
}

export interface Rival {
  team: string;
  gain: number;
  faabRemaining: number | null;
}

/**
 * A bid range from the market and the rivals who'd want him (FAAB only):
 * - no rival with budget: the minimum bid;
 * - one: the market's median to its upper quartile;
 * - two or more: its upper quartile to its highest winning bid.
 * Capped at one more than the richest rival can bid, and at the user's budget.
 * `basis` names the strongest rival, so a caller can judge whether to go higher.
 * `rivals` come strongest first.
 */
export function suggestBid(
  market: BidMarket,
  rivals: readonly Rival[],
  minimumBid: number,
  myFaab: number | null,
): BidCompetitionTarget["suggestedBid"] {
  const able = rivals.filter((r) => (r.faabRemaining ?? 0) >= Math.max(1, minimumBid));
  const mid = market.median ?? minimumBid;
  const upper = market.upperQuartile ?? mid;
  let low: number;
  let high: number;
  let basis: string;
  if (!able.length) {
    low = high = minimumBid;
    basis = "no other team with budget gains much from him";
  } else {
    const top = able[0]!;
    const who = `strongest: ${top.team}, +${top.gain} points, ${top.faabRemaining} left`;
    [low, high] = able.length === 1 ? [mid, upper] : [upper, market.max ?? upper];
    basis =
      able.length === 1
        ? `one rival with budget (${who}); ${scopeText(market)}, median to upper quartile`
        : `${able.length} rivals with budget (${who}); ${scopeText(market)}, upper quartile to highest winning bid`;
  }
  const richest = Math.max(...able.map((r) => r.faabRemaining ?? 0), minimumBid - 1);
  const cap = Math.min(able.length ? richest + 1 : high, myFaab ?? Infinity);
  high = Math.max(minimumBid, Math.min(high, cap));
  low = Math.max(minimumBid, Math.min(low, high));
  return { low: Math.round(low), high: Math.round(high), basis };
}

const scopeText = (m: BidMarket) =>
  m.scope === "ALL"
    ? "league-wide"
    : m.scope === "SIMILAR"
      ? "for players like him"
      : `at ${m.scope}`;

export interface BidInput {
  target: Player;
  rosters: readonly Roster[];
  teams: readonly Team[];
  myTeamId: number;
  slots: readonly string[];
  /** The weeks left, the current one included. */
  weeks: readonly number[];
  bids: readonly ClaimBid[];
  wins: readonly WinningClaim[];
  usesFaab: boolean;
  minimumBid: number;
  /** Each team's lineup value without him, by team id (see restOfSeasonValue). */
  base: ReadonlyMap<number, number>;
  /** Each won player's per-game value now, by id (see perGame). */
  values: ReadonlyMap<number, number>;
}

/** The competition for one target, for a player who's available (a free agent or on waivers). */
export function bidCompetition(input: BidInput): Omit<BidCompetitionTarget, "query" | "player"> {
  const { target, myTeamId, usesFaab } = input;
  const teamById = new Map(input.teams.map((t) => [t.id, t]));
  const gainFor = (roster: Roster) =>
    restOfSeasonValue([...playable(roster), target], input.slots, input.weeks) -
    (input.base.get(roster.teamId) ?? 0);
  const me = teamById.get(myTeamId);
  const myRoster = input.rosters.find((r) => r.teamId === myTeamId);
  const myRank = me?.waiverRank ?? null;
  const threshold = Math.max(MIN_INTEREST, INTEREST_SHARE * (target.seasonProjectedPoints ?? 0));

  const rivals = input.rosters
    .filter((r) => r.teamId !== myTeamId)
    .map((r) => {
      const t = teamById.get(r.teamId);
      return {
        teamId: r.teamId,
        team: r.teamName,
        gain: round(gainFor(r)),
        faabRemaining: usesFaab ? (t?.faabRemaining ?? null) : null,
        waiverRank: t?.waiverRank ?? null,
        history: bidProfile(input.bids, r.teamId, target.position),
      };
    })
    .filter((r) => r.gain >= threshold)
    .sort((a, b) => b.gain - a.gain || (b.faabRemaining ?? 0) - (a.faabRemaining ?? 0));

  const value = perGame(target, input.weeks);
  const { scope, list } = marketWins(input.wins, target.position, value, input.values);
  const market = bidMarket(scope, list, usesFaab);
  // The market's own wins (closest in value first for SIMILAR), else the latest at his position.
  const shown =
    scope === "ALL"
      ? input.wins
          .filter((w) => w.position === target.position)
          .sort((a, b) => b.processDate - a.processDate)
      : scope === "SIMILAR"
        ? list
        : [...list].sort((a, b) => b.processDate - a.processDate);
  const comparables = shown.slice(0, COMPARABLES).map((w) => ({
    player: w.player,
    week: w.week,
    bid: usesFaab ? w.bid : null,
    runnerUp: usesFaab ? w.runnerUp : null,
    bidders: w.bidders,
    team: teamById.get(w.teamId)?.name ?? `Team ${w.teamId}`,
    perGame: input.values.has(w.playerId) ? round(input.values.get(w.playerId)!) : null,
  }));

  return {
    available: true,
    perGame: round(value),
    gainForMe: myRoster ? round(gainFor(myRoster)) : null,
    market,
    comparables,
    interested: rivals.length,
    aheadOfMe:
      myRank === null
        ? null
        : rivals.filter((r) => r.waiverRank !== null && r.waiverRank < myRank).length,
    rivals: rivals.slice(0, RIVALS_LISTED),
    suggestedBid: usesFaab
      ? suggestBid(market, rivals, input.minimumBid, me?.faabRemaining ?? null)
      : null,
  };
}
