// Typed output of espn-client. These are ESPN's data in plain shapes, with ids
// already mapped to labels; core turns them into the zod-validated contract.

export interface EspnPlayer {
  id: number;
  name: string;
  /** Primary position: QB, RB, WR, TE, K, D/ST. */
  position: string;
  /** Lineup slots the player can fill, e.g. ["WR", "FLEX", "OP", "BE", "IR"]. */
  eligibleSlots: string[];
  proTeamId: number;
  proTeam: string;
  /** ESPN's raw injury status, e.g. ACTIVE, QUESTIONABLE, INJURY_RESERVE; null when absent. */
  injuryStatus: string | null;
  injured: boolean;
  percentOwned: number | null;
  percentStarted: number | null;
  percentChange: number | null;
  /** Fantasy points for the requested scoring period. */
  week: { actual: number | null; projected: number | null };
  /** Fantasy points for the whole season. */
  season: { actual: number | null; projected: number | null };
}

export interface EspnRosterEntry {
  slotId: number;
  /** Display label: QB, RB, WR, TE, FLEX, OP, D/ST, K, BE, IR. */
  slot: string;
  /** True once the player's game has kicked off (lineups lock per player). */
  locked: boolean;
  acquisitionType: string | null;
  player: EspnPlayer;
}

export interface EspnTeam {
  id: number;
  abbrev: string;
  name: string;
  owners: string[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  streak: { type: string; length: number } | null;
  playoffSeed: number | null;
  waiverRank: number | null;
  faabSpent: number;
  acquisitions: number;
  drops: number;
  trades: number;
}

export interface EspnScoringItem {
  statId: number;
  abbr: string;
  label: string;
  points: number;
  /** Per-slot point overrides, e.g. { "D/ST": 4 } or a TE premium on receptions. */
  overrides: Record<string, number>;
}

export interface EspnLeagueSettings {
  leagueId: number;
  year: number;
  name: string;
  size: number;
  /** Current scoring period (NFL week). */
  currentWeek: number;
  currentMatchupPeriod: number;
  finalScoringPeriod: number | null;
  scoringType: string | null;
  scoringItems: EspnScoringItem[];
  /** Starting and reserve slot counts by label, zero-count slots omitted. */
  lineupSlotCounts: Record<string, number>;
  /** Max players per position, unlimited positions omitted. */
  positionLimits: Record<string, number>;
  benchUnlimited: boolean;
  lineupLockType: string | null;
  acquisition: {
    type: string | null;
    usesFaab: boolean;
    budget: number | null;
    minimumBid: number | null;
    waiverHours: number | null;
    waiverOrderReset: boolean | null;
    processDays: string[];
    processHour: number | null;
    seasonLimit: number | null;
    matchupLimit: number | null;
  };
  trade: {
    /** Epoch ms, or null when the league has no deadline. */
    deadline: number | null;
    vetoVotesRequired: number | null;
    reviewHours: number | null;
  };
  schedule: {
    regularSeasonMatchups: number | null;
    /** Matchup period → scoring periods (weeks) it spans. */
    matchupPeriods: Record<number, number[]>;
    playoffTeamCount: number | null;
    playoffMatchupPeriodLength: number | null;
    playoffSeedingRule: string | null;
  };
  teams: EspnTeam[];
}

export interface EspnRoster {
  teamId: number;
  week: number;
  entries: EspnRosterEntry[];
}

export interface EspnMatchupSide {
  teamId: number;
  score: number;
  /** ESPN's live projection when available, else the sum of starters' projections. */
  projected: number;
  lineup: EspnRosterEntry[];
}

export interface EspnMatchup {
  matchupPeriod: number;
  week: number;
  playoffTier: string;
  winner: string;
  home: EspnMatchupSide | null;
  away: EspnMatchupSide | null;
}

export interface EspnFreeAgent {
  /** FREEAGENT or WAIVERS. */
  status: string;
  positionalRank: number | null;
  player: EspnPlayer;
}

export type EspnActivityAction =
  "FA ADDED" | "WAIVER ADDED" | "DROPPED" | "TRADE SENT" | "TRADE RECEIVED" | "UNKNOWN";

export interface EspnActivityItem {
  action: EspnActivityAction;
  teamId: number | null;
  playerId: number;
  /** Resolved via rosters or player cards; null if ESPN didn't return it. */
  playerName: string | null;
  position: string | null;
  proTeam: string | null;
  /** FAAB bid for waiver adds. */
  bid: number | null;
}

export interface EspnActivity {
  id: string | null;
  /** Epoch ms. */
  date: number;
  items: EspnActivityItem[];
}

export interface EspnProTeam {
  id: number;
  abbrev: string;
  byeWeek: number | null;
}
