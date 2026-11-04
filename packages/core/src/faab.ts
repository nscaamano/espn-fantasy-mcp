// FAAB price history: winning waiver bids by position, from the league's
// transaction log (one scoring period per request). Pure functions; the
// service fetches the weeks.

import type { EspnTransaction } from "@nscaamano/espn-fantasy-client";
import { RUN_WINDOW_MS } from "./map.js";
import type { FaabBid, FaabStats, PositionPrices } from "./schemas.js";

/** The order positions are listed in; anything else follows alphabetically. */
export const FAAB_POSITIONS = ["QB", "RB", "WR", "TE", "K", "D/ST"] as const;

/** ESPN's status for a claim on a player who was gone by the time it ran: another team got him first. */
const OUTBID = "FAILED_INVALIDPLAYERSOURCE";

/** One scoring period's transaction log. */
export interface WeekLog {
  week: number;
  transactions: EspnTransaction[];
}

/** A waiver claim that won, with the competition it beat. */
export interface WinningClaim {
  playerId: number;
  player: string;
  position: string | null;
  proTeam: string | null;
  week: number;
  teamId: number;
  /** As ESPN sent it: 0 in priority leagues. */
  bid: number;
  /** The highest bid by another team that was outbid for him in the same run. */
  runnerUp: number | null;
  /** Teams that claimed him in that run and lost, plus the winner. */
  bidders: number;
  processDate: number;
}

/**
 * Every executed waiver claim in the logs, oldest first. A waiver run writes
 * one PROCESS record per claim; a losing claim on the same player in the same
 * run is another team's FAILED_INVALIDPLAYERSOURCE record, which keeps its bid.
 * Claims that failed for other reasons (roster limit, the drop already gone)
 * aren't counted as competition. A record seen in two weeks' logs counts once.
 */
export function winningClaims(logs: WeekLog[]): WinningClaim[] {
  const seen = new Set<string>();
  const wins: WinningClaim[] = [];
  for (const { week, transactions } of [...logs].sort((a, b) => a.week - b.week)) {
    const processed = transactions.filter(
      (t) =>
        t.type === "WAIVER" && t.executionType === "PROCESS" && t.add && t.processDate !== null,
    );
    for (const t of processed) {
      if (t.status !== "EXECUTED") continue;
      if (t.id !== null) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
      }
      const add = t.add!;
      const losers = processed.filter(
        (o) =>
          o.status === OUTBID &&
          o.teamId !== t.teamId &&
          o.add!.playerId === add.playerId &&
          Math.abs(o.processDate! - t.processDate!) < RUN_WINDOW_MS,
      );
      wins.push({
        playerId: add.playerId,
        player: add.playerName ?? `Player ${add.playerId}`,
        position: add.position,
        proTeam: add.proTeam,
        week,
        teamId: t.teamId,
        bid: t.bid,
        runnerUp: losers.length ? Math.max(...losers.map((o) => o.bid)) : null,
        bidders: 1 + new Set(losers.map((o) => o.teamId)).size,
        processDate: t.processDate!,
      });
    }
  }
  return wins.sort((a, b) => a.processDate - b.processDate);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Counts always; bid figures only where bids are real (FAAB leagues). */
export function priceStats(wins: WinningClaim[], usesFaab: boolean): FaabStats {
  const bids = wins.map((w) => w.bid);
  const faab = usesFaab && bids.length > 0;
  return {
    wins: wins.length,
    contested: wins.filter((w) => w.bidders > 1).length,
    median: faab ? median(bids) : null,
    min: faab ? Math.min(...bids) : null,
    max: faab ? Math.max(...bids) : null,
  };
}

export interface FaabPriceOptions {
  usesFaab: boolean;
  /** Only this position (QB, RB, WR, TE, K, D/ST). */
  position?: string;
  /** Bids listed per position: the highest, most recent first on ties. */
  bidsPerPosition: number;
  teamName: (teamId: number) => string;
}

const positionRank = (p: string) => {
  const i = (FAAB_POSITIONS as readonly string[]).indexOf(p);
  return i === -1 ? FAAB_POSITIONS.length : i;
};

/**
 * Winning claims grouped by position, each with counts, bid median, min and
 * max, and its top bids. Priority leagues get counts only, since ESPN's $0
 * isn't a bid. Claims whose player ESPN couldn't name have no position and are
 * left out.
 */
export function faabPrices(
  claims: WinningClaim[],
  opts: FaabPriceOptions,
): { all: FaabStats; positions: PositionPrices[] } {
  const wins = claims.filter(
    (c) => c.position !== null && (!opts.position || c.position === opts.position),
  );
  const byPosition = new Map<string, WinningClaim[]>();
  for (const w of wins) {
    const list = byPosition.get(w.position!) ?? [];
    list.push(w);
    byPosition.set(w.position!, list);
  }
  const positions = [...byPosition.entries()]
    .sort(([a], [b]) => positionRank(a) - positionRank(b) || a.localeCompare(b))
    .map(([position, list]): PositionPrices => {
      const bids: FaabBid[] = !opts.usesFaab
        ? []
        : [...list]
            .sort((a, b) => b.bid - a.bid || b.processDate - a.processDate)
            .slice(0, opts.bidsPerPosition)
            .map((w) => ({
              player: w.player,
              proTeam: w.proTeam,
              week: w.week,
              bid: w.bid,
              runnerUp: w.runnerUp,
              bidders: w.bidders,
              team: opts.teamName(w.teamId),
            }));
      return { position, ...priceStats(list, opts.usesFaab), bids };
    });
  return { all: priceStats(wins, opts.usesFaab), positions };
}
