// ESPN fantasy v3 response shapes, limited to the fields the parsers read.
// Everything is optional: ESPN omits fields freely, and nothing outside this
// package should ever see these types.

export interface RawStat {
  seasonId?: number;
  scoringPeriodId?: number;
  statSourceId?: number; // 0 = actual, 1 = projected
  statSplitTypeId?: number; // 0 = season, 1 = single scoring period
  appliedTotal?: number;
  proTeamId?: number;
}

export interface RawPlayer {
  id?: number;
  fullName?: string;
  defaultPositionId?: number;
  eligibleSlots?: number[];
  proTeamId?: number;
  injuryStatus?: string;
  injured?: boolean;
  /** Epoch ms of the player's latest ESPN news item. */
  lastNewsDate?: number;
  /** False for players on the league's undroppable list. */
  droppable?: boolean;
  ownership?: {
    percentOwned?: number;
    percentStarted?: number;
    percentChange?: number;
  };
  stats?: RawStat[];
}

export interface RawPlayerPoolEntry {
  id?: number;
  onTeamId?: number;
  status?: string; // FREEAGENT | WAIVERS | ONTEAM
  lineupLocked?: boolean;
  /** Epoch ms when a player on waivers clears: the next claim run. */
  waiverProcessDate?: number;
  player?: RawPlayer;
  ratings?: Record<string, { positionalRanking?: number; totalRanking?: number }>;
}

export interface RawRosterEntry {
  playerId?: number;
  lineupSlotId?: number;
  acquisitionType?: string;
  injuryStatus?: string;
  playerPoolEntry?: RawPlayerPoolEntry;
}

export interface RawRecord {
  wins?: number;
  losses?: number;
  ties?: number;
  pointsFor?: number;
  pointsAgainst?: number;
  streakLength?: number;
  streakType?: string;
}

export interface RawTeam {
  id: number;
  abbrev?: string;
  name?: string;
  location?: string;
  nickname?: string;
  owners?: string[];
  playoffSeed?: number;
  waiverRank?: number;
  record?: { overall?: RawRecord };
  transactionCounter?: {
    acquisitionBudgetSpent?: number;
    acquisitions?: number;
    drops?: number;
    trades?: number;
  };
  roster?: { entries?: RawRosterEntry[] };
}

export interface RawMember {
  id?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

export interface RawScoringItem {
  statId: number;
  points?: number;
  pointsOverrides?: Record<string, number>;
}

export interface RawSettings {
  name?: string;
  size?: number;
  acquisitionSettings?: {
    acquisitionType?: string;
    isUsingAcquisitionBudget?: boolean;
    acquisitionBudget?: number;
    acquisitionLimit?: number;
    matchupAcquisitionLimit?: number;
    minimumBid?: number;
    waiverHours?: number;
    waiverOrderReset?: boolean;
    waiverProcessDays?: string[];
    waiverProcessHour?: number;
  };
  rosterSettings?: {
    lineupSlotCounts?: Record<string, number>;
    positionLimits?: Record<string, number>;
    isBenchUnlimited?: boolean;
    lineupLocktimeType?: string;
    rosterLocktimeType?: string;
  };
  scheduleSettings?: {
    matchupPeriodCount?: number;
    matchupPeriods?: Record<string, number[]>;
    playoffTeamCount?: number;
    playoffMatchupPeriodLength?: number;
    playoffSeedingRule?: string;
  };
  scoringSettings?: {
    scoringType?: string;
    scoringItems?: RawScoringItem[];
  };
  tradeSettings?: {
    deadlineDate?: number;
    vetoVotesRequired?: number;
    revisionHours?: number;
    max?: number;
  };
}

export interface RawStatus {
  currentMatchupPeriod?: number;
  firstScoringPeriod?: number;
  finalScoringPeriod?: number;
  latestScoringPeriod?: number;
}

export interface RawMatchupSide {
  teamId?: number;
  totalPoints?: number;
  totalPointsLive?: number;
  totalProjectedPointsLive?: number;
  /** 0–1, on the current matchup period only (mMatchupScore). */
  winProbability?: number;
  rosterForCurrentScoringPeriod?: { entries?: RawRosterEntry[] };
}

export interface RawMatchup {
  id?: number;
  matchupPeriodId?: number;
  playoffTierType?: string;
  winner?: string;
  home?: RawMatchupSide;
  away?: RawMatchupSide;
}

export interface RawLeague {
  id?: number;
  seasonId?: number;
  scoringPeriodId?: number;
  status?: RawStatus;
  settings?: RawSettings;
  members?: RawMember[];
  teams?: RawTeam[];
  schedule?: RawMatchup[];
  players?: RawPlayerPoolEntry[];
  pendingTransactions?: RawPendingTransaction[];
  transactions?: RawTransaction[];
}

export interface RawTransactionItem {
  type?: string; // ADD | DROP
  playerId?: number;
  fromTeamId?: number;
  toTeamId?: number;
  fromLineupSlotId?: number; // -1 when the player wasn't on a roster
  toLineupSlotId?: number;
}

/**
 * A queued claim from `view=mPendingTransactions`. ESPN also sends `memberId`
 * (the account's user GUID); it's deliberately not modeled so it can't leak.
 */
export interface RawPendingTransaction {
  id?: string;
  type?: string; // WAIVER, or FREEAGENT while transactions are locked
  status?: string; // PENDING
  teamId?: number;
  bidAmount?: number; // 0 in priority-waiver leagues
  proposedDate?: number;
  processDate?: number;
  scoringPeriodId?: number;
  items?: RawTransactionItem[];
}

/**
 * A transaction from the league log (`view=mTransactions2`), any team. A waiver
 * run writes one PROCESS record per claim, pointing back at the proposal.
 * `memberId` is deliberately not modeled, as above.
 */
export interface RawTransaction extends RawPendingTransaction {
  executionType?: string; // EXECUTE (a proposal), PROCESS (a run's result), CANCEL
  relatedTransactionId?: string;
}

export interface RawActivityMessage {
  messageTypeId?: number;
  targetId?: number;
  from?: number;
  to?: number;
  for?: number;
}

export interface RawActivityTopic {
  id?: string;
  date?: number;
  messages?: RawActivityMessage[];
}

export interface RawCommunication {
  topics?: RawActivityTopic[];
}

export interface RawProTeam {
  id: number;
  abbrev?: string;
  byeWeek?: number;
  proGamesByScoringPeriod?: Record<
    string,
    { date?: number; homeProTeamId?: number; awayProTeamId?: number }[]
  >;
}

export interface RawProSchedule {
  settings?: { proTeams?: RawProTeam[] };
}
