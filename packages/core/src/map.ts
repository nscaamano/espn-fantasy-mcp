// espn-client typed shapes → core schemas. No advice here, only mapping.

import type {
  EspnActivity,
  EspnActivityAction,
  EspnClaimPlayer,
  EspnFreeAgent,
  EspnLeagueSettings,
  EspnPendingClaim,
  EspnPlayer,
  EspnPoolPlayer,
  EspnProTeam,
  EspnRosterEntry,
  EspnTeam,
  EspnTransaction,
} from "@nscaamano/espn-fantasy-client";
import type {
  ClaimPlayer,
  ClaimResult,
  FreeAgent,
  InjuryStatus,
  LeagueSettings,
  PendingClaim,
  Player,
  PlayerInfo,
  RosterSlot,
  Team,
  Transaction,
  TransactionAction,
} from "./schemas.js";

/** NFL team id → bye week and per-week games. */
export type ProSchedule = ReadonlyMap<number, EspnProTeam>;

export function injuryStatus(raw: string | null): InjuryStatus {
  if (!raw) return "ACTIVE";
  switch (raw.toUpperCase()) {
    case "ACTIVE":
    case "NORMAL":
      return "ACTIVE";
    case "PROBABLE":
      return "PROBABLE";
    case "QUESTIONABLE":
    case "DAY_TO_DAY":
      return "QUESTIONABLE";
    case "DOUBTFUL":
      return "DOUBTFUL";
    case "OUT":
      return "OUT";
    case "INJURY_RESERVE":
    case "IR":
      return "IR";
    case "SUSPENSION":
    case "SUSPENDED":
      return "SUSPENDED";
    default:
      return raw.toUpperCase().includes("RESERVE") ? "IR" : "OTHER";
  }
}

const NON_STARTING = new Set(["BE", "IR"]);

export function toPlayer(p: EspnPlayer, schedule: ProSchedule, week: number): Player {
  const team = schedule.get(p.proTeamId);
  const game = team?.games[week];
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    proTeam: p.proTeam,
    injuryStatus: injuryStatus(p.injuryStatus),
    byeWeek: team?.byeWeek ?? null,
    game: game
      ? { opponent: game.opponent, home: game.home, kickoff: new Date(game.kickoff).toISOString() }
      : null,
    projectedPoints: p.week.projected,
    actualPoints: p.week.actual,
    percentRostered: p.percentOwned,
    lastNewsDate: p.lastNewsDate,
    seasonProjectedPoints: p.season.projected,
    eligibleSlots: p.eligibleSlots.filter((s) => !NON_STARTING.has(s)),
  };
}

export function toRosterSlot(e: EspnRosterEntry, schedule: ProSchedule, week: number): RosterSlot {
  return {
    slot: e.slot,
    locked: e.locked,
    // ESPN locks a player for the rest of the week once his game kicks off.
    droppable: e.player.droppable !== false && !e.locked,
    player: toPlayer(e.player, schedule, week),
  };
}

/**
 * ESPN's matchup data never sets lineupLocked (seen live, 2026 week 7: false for
 * every player, even after his game ended). A lineup locks per player at
 * kickoff, so derive it from the kickoff time.
 */
export function lockAtKickoff(s: RosterSlot, now: Date): RosterSlot {
  const started = s.player.game !== null && Date.parse(s.player.game.kickoff) <= now.getTime();
  return started && !s.locked ? { ...s, locked: true, droppable: false } : s;
}

// ESPN lists slots by id (QB, RB, WR, TE, OP, D/ST, K, FLEX); sort starters
// into the order the app shows them.
const SLOT_ORDER = [
  "QB",
  "TQB",
  "RB",
  "RB/WR",
  "WR",
  "WR/TE",
  "TE",
  "FLEX",
  "OP",
  "D/ST",
  "K",
  "P",
];
export const slotRank = (slot: string) => {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length : i;
};

export function splitLineup(entries: EspnRosterEntry[], schedule: ProSchedule, week: number) {
  const slots = entries.map((e) => toRosterSlot(e, schedule, week));
  const starters = slots
    .filter((s) => !NON_STARTING.has(s.slot))
    .sort((a, b) => slotRank(a.slot) - slotRank(b.slot));
  const sum = (key: "projectedPoints" | "actualPoints") =>
    Math.round(starters.reduce((t, s) => t + (s.player[key] ?? 0), 0) * 100) / 100;
  return {
    starters,
    bench: slots.filter((s) => s.slot === "BE"),
    ir: slots.filter((s) => s.slot === "IR"),
    projectedTotal: sum("projectedPoints"),
    actualTotal: sum("actualPoints"),
  };
}

export function toTeam(t: EspnTeam, s: EspnLeagueSettings, myTeamId: number): Team {
  const budget = s.acquisition.usesFaab ? s.acquisition.budget : null;
  return {
    id: t.id,
    name: t.name,
    abbrev: t.abbrev,
    owners: t.owners,
    wins: t.wins,
    losses: t.losses,
    ties: t.ties,
    pointsFor: t.pointsFor,
    pointsAgainst: t.pointsAgainst,
    playoffSeed: t.playoffSeed,
    waiverRank: t.waiverRank,
    faabRemaining: budget === null ? null : budget - t.faabSpent,
    isMine: t.id === myTeamId,
  };
}

function scoringFormat(receptionPoints: number | null): string | null {
  if (receptionPoints === null) return null;
  if (receptionPoints === 1) return "PPR";
  if (receptionPoints === 0.5) return "HALF_PPR";
  if (receptionPoints === 0) return "STANDARD";
  return "CUSTOM";
}

/**
 * ESPN's view of the league, before stored rule overrides. Missing values are
 * null, so rules discovery can tell "ESPN didn't say" from a real value.
 */
export function toLeagueSettings(
  s: EspnLeagueSettings,
  alias: string,
  myTeamId: number,
): Omit<LeagueSettings, "ruleSources" | "missingRules" | "conflicts"> {
  const reception = s.scoringItems.find((i) => i.statId === 53);
  // A league with no reception scoring item is standard scoring, but only if
  // ESPN sent scoring at all.
  const receptionPoints = reception ? reception.points : s.scoringItems.length ? 0 : null;

  const { BE: benchSize = 0, IR: irSlots = 0, ...slots } = s.lineupSlotCounts;
  const myTeam = s.teams.find((t) => t.id === myTeamId);
  const acq = s.acquisition;
  const faab = acq.usesFaab;
  const playoffStartPeriod =
    s.schedule.regularSeasonMatchups !== null ? s.schedule.regularSeasonMatchups + 1 : null;

  return {
    league: alias,
    leagueId: s.leagueId,
    year: s.year,
    name: s.name,
    size: s.size,
    currentWeek: s.currentWeek,
    myTeamId,
    scoring: {
      type: s.scoringType,
      format: scoringFormat(receptionPoints),
      receptionPoints,
      items: s.scoringItems
        .filter((i) => i.points !== 0 || Object.keys(i.overrides).length > 0)
        .map((i) => ({
          abbr: i.abbr,
          label: i.label,
          points: i.points,
          ...(Object.keys(i.overrides).length ? { overrides: i.overrides } : {}),
        })),
    },
    roster: {
      slots,
      benchSize,
      benchUnlimited: s.benchUnlimited,
      irSlots,
      superflex: (slots.OP ?? 0) > 0 || (slots.QB ?? 0) > 1,
      hasDst: (slots["D/ST"] ?? 0) > 0,
      hasK: (slots.K ?? 0) > 0,
      positionLimits: s.positionLimits,
      // ESPN doesn't expose which designations may sit on IR (checked live).
      irEligibleStatuses: null,
    },
    waivers: {
      type: acq.type === null && !faab ? null : faab ? "FAAB" : "PRIORITY",
      faabBudget: faab ? acq.budget : null,
      faabRemaining: faab && acq.budget !== null && myTeam ? acq.budget - myTeam.faabSpent : null,
      minimumBid: faab ? acq.minimumBid : null,
      myWaiverRank: myTeam?.waiverRank ?? null,
      waiverHours: acq.waiverHours,
      processDays: acq.processDays.length ? acq.processDays : null,
      processHour: acq.processHour,
      priorityResets: faab ? null : acq.waiverOrderReset,
      seasonAcquisitionLimit: acq.seasonLimit,
    },
    lineupLock: s.lineupLockType,
    trades: {
      deadline: s.trade.deadline ? new Date(s.trade.deadline).toISOString() : null,
      vetoVotesRequired: s.trade.vetoVotesRequired,
      reviewHours: s.trade.reviewHours,
    },
    schedule: {
      regularSeasonWeeks: s.schedule.regularSeasonMatchups,
      playoffTeams: s.schedule.playoffTeamCount,
      playoffStartWeek:
        playoffStartPeriod !== null
          ? (s.schedule.matchupPeriods[playoffStartPeriod]?.[0] ?? null)
          : null,
      playoffMatchupLength: s.schedule.playoffMatchupPeriodLength,
    },
    teams: s.teams.map((t) => toTeam(t, s, myTeamId)),
  };
}

export function toFreeAgent(fa: EspnFreeAgent, schedule: ProSchedule, week: number): FreeAgent {
  return {
    ...toPlayer(fa.player, schedule, week),
    status: fa.status === "WAIVERS" ? "WAIVERS" : "FREE_AGENT",
    percentChange: fa.player.percentChange,
    positionalRank: fa.positionalRank,
    seasonPoints: fa.player.season.actual,
    seasonProjectedPoints: fa.player.season.projected,
    waiverClears: fa.status === "WAIVERS" ? fa.waiverProcessDate : null,
  };
}

/** `team` is the fantasy team he's on (with his slot there), or null. */
export function toPlayerInfo(
  p: EspnPoolPlayer,
  schedule: ProSchedule,
  week: number,
  team: PlayerInfo["team"],
): PlayerInfo {
  const fa = toFreeAgent(p, schedule, week);
  return team ? { ...fa, status: "ROSTERED", waiverClears: null, team } : { ...fa, team: null };
}

const ACTIONS: Record<EspnActivityAction, TransactionAction> = {
  "FA ADDED": "ADD",
  "WAIVER ADDED": "WAIVER_ADD",
  DROPPED: "DROP",
  "TRADE SENT": "TRADE_SENT",
  "TRADE RECEIVED": "TRADE_RECEIVED",
  UNKNOWN: "UNKNOWN",
};

/** `usesFaab`: ESPN reports a $0 "bid" on every waiver add in priority leagues; drop it there. */
export function toTransaction(
  a: EspnActivity,
  teamNames: ReadonlyMap<number, string>,
  usesFaab: boolean,
): Transaction {
  return {
    date: new Date(a.date).toISOString(),
    items: a.items.map((i) => ({
      action: ACTIONS[i.action],
      team: i.teamId === null ? null : (teamNames.get(i.teamId) ?? `Team ${i.teamId}`),
      player: i.playerName ?? `Player ${i.playerId}`,
      position: i.position,
      proTeam: i.proTeam,
      bid: usesFaab ? i.bid : null,
    })),
  };
}

function toClaimPlayer(p: EspnClaimPlayer): ClaimPlayer {
  return { name: p.playerName ?? `Player ${p.playerId}`, position: p.position, proTeam: p.proTeam };
}

const isoOrNull = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** `usesFaab`: priority-waiver leagues report bidAmount 0, which isn't a bid. */
export function toPendingClaim(c: EspnPendingClaim, usesFaab: boolean): PendingClaim {
  return {
    type: c.type,
    add: c.add ? toClaimPlayer(c.add) : null,
    drop: c.drop ? { ...toClaimPlayer(c.drop), slot: c.drop.fromSlot } : null,
    bid: usesFaab ? c.bid : null,
    proposedAt: isoOrNull(c.proposedDate),
    processesAt: isoOrNull(c.processDate),
  };
}

/** Claims ESPN processed within this long of a run's latest one belong to that run. */
const RUN_WINDOW_MS = 60 * 60 * 1000;
const RESULT_ORDER: Record<ClaimResult["result"], number> = {
  WON: 0,
  LOST: 1,
  FAILED: 2,
  CANCELED: 3,
};

/**
 * The user's claims in their latest waiver run among `transactions` (one
 * scoring period's log, every team's), with who got each lost player and for
 * how much. Some leagues also run waivers daily for players other teams
 * dropped, so the latest run that had any of the user's claims counts, not
 * just the latest run. With none, it's the latest run and no claims.
 * Proposals stay PENDING in the log after a run; only PROCESS and CANCEL
 * records count. `usesFaab`: priority leagues report $0 bids; drop them there.
 */
export function toWaiverResults(
  transactions: EspnTransaction[],
  myTeamId: number,
  usesFaab: boolean,
  teamName: (teamId: number) => string,
): { processedAt: string | null; claims: ClaimResult[] } {
  const processed = transactions.filter(
    (t) => t.type === "WAIVER" && t.executionType === "PROCESS" && t.processDate !== null,
  );
  // Each run's time (its latest record), newest first.
  const runs: number[] = [];
  for (const d of processed.map((t) => t.processDate!).sort((a, b) => b - a)) {
    const last = runs[runs.length - 1];
    if (last === undefined || last - d >= RUN_WINDOW_MS) runs.push(d);
  }
  for (const [i, runAt] of runs.entries()) {
    // Cancellations count back to the run before this one.
    const claims = claimsInRun(runAt, runs[i + 1] ?? -Infinity);
    if (claims.length) return { processedAt: new Date(runAt).toISOString(), claims };
  }
  return {
    processedAt: runs[0] === undefined ? null : new Date(runs[0]).toISOString(),
    claims: [],
  };

  function claimsInRun(runAt: number, since: number): ClaimResult[] {
    const run = processed.filter(
      (t) => t.processDate! <= runAt && runAt - t.processDate! < RUN_WINDOW_MS,
    );
    const canceled = transactions.filter(
      (t) =>
        t.type === "WAIVER" &&
        t.teamId === myTeamId &&
        t.status === "CANCELED" &&
        t.proposedDate !== null &&
        t.proposedDate > since &&
        t.proposedDate <= runAt,
    );
    const winners = new Map(
      run.filter((t) => t.status === "EXECUTED" && t.add).map((t) => [t.add!.playerId, t]),
    );
    const byId = new Map(transactions.filter((t) => t.id).map((t) => [t.id!, t]));
    // A cancellation records $0; the bid is on the proposal it cancels.
    const bid = (t: EspnTransaction) =>
      !usesFaab
        ? null
        : t.status === "CANCELED"
          ? (byId.get(t.relatedId ?? "")?.bid ?? t.bid)
          : t.bid;

    const claims = [...run.filter((t) => t.teamId === myTeamId), ...canceled].map(
      (t): ClaimResult => {
        const base = {
          add: t.add ? toClaimPlayer(t.add) : null,
          drop: t.drop ? toClaimPlayer(t.drop) : null,
          bid: bid(t),
          wonBy: null,
          reason: null,
        };
        if (t.status === "CANCELED") return { ...base, result: "CANCELED" };
        if (t.status === "EXECUTED") return { ...base, result: "WON" };
        const winner = t.add ? winners.get(t.add.playerId) : undefined;
        if (winner?.teamId === myTeamId) {
          return { ...base, result: "FAILED", reason: "another of your claims added him first" };
        }
        if (winner) {
          return {
            ...base,
            result: "LOST",
            wonBy: { team: teamName(winner.teamId), bid: bid(winner) },
          };
        }
        return { ...base, result: "FAILED", reason: t.status };
      },
    );
    return claims.sort((a, b) => RESULT_ORDER[a.result] - RESULT_ORDER[b.result]);
  }
}
