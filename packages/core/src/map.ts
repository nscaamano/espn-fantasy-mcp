// espn-client typed shapes → core schemas. No advice here, only mapping.

import type {
  EspnActivity,
  EspnActivityAction,
  EspnFreeAgent,
  EspnLeagueSettings,
  EspnPlayer,
  EspnRosterEntry,
  EspnTeam,
} from "@espn-fantasy-mcp/espn-client";
import type {
  FreeAgent,
  InjuryStatus,
  LeagueSettings,
  Player,
  RosterSlot,
  Team,
  Transaction,
  TransactionAction,
} from "./schemas.js";

/** NFL team id → bye week. */
export type ByeWeeks = ReadonlyMap<number, number | null>;

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

export function toPlayer(p: EspnPlayer, byes: ByeWeeks): Player {
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    proTeam: p.proTeam,
    injuryStatus: injuryStatus(p.injuryStatus),
    byeWeek: byes.get(p.proTeamId) ?? null,
    projectedPoints: p.week.projected,
    actualPoints: p.week.actual,
    percentRostered: p.percentOwned,
    eligibleSlots: p.eligibleSlots.filter((s) => !NON_STARTING.has(s)),
  };
}

export function toRosterSlot(e: EspnRosterEntry, byes: ByeWeeks): RosterSlot {
  return { slot: e.slot, locked: e.locked, player: toPlayer(e.player, byes) };
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
const slotRank = (slot: string) => {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length : i;
};

export function splitLineup(entries: EspnRosterEntry[], byes: ByeWeeks) {
  const slots = entries.map((e) => toRosterSlot(e, byes));
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

export function toFreeAgent(fa: EspnFreeAgent, byes: ByeWeeks): FreeAgent {
  return {
    ...toPlayer(fa.player, byes),
    status: fa.status === "WAIVERS" ? "WAIVERS" : "FREE_AGENT",
    percentChange: fa.player.percentChange,
    positionalRank: fa.positionalRank,
    seasonPoints: fa.player.season.actual,
    seasonProjectedPoints: fa.player.season.projected,
  };
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
