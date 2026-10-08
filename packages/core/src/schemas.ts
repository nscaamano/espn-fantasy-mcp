// The one contract: MCP tools use these as output schemas, and any other
// adapter validates with them and imports the inferred types.

import { z } from "zod";

export const InjuryStatus = z.enum([
  "ACTIVE",
  "PROBABLE",
  "QUESTIONABLE",
  "DOUBTFUL",
  "OUT",
  "IR",
  "SUSPENDED",
  "OTHER",
]);
export type InjuryStatus = z.infer<typeof InjuryStatus>;

export const RuleSource = z.enum(["espn", "upload", "user"]);
export type RuleSource = z.infer<typeof RuleSource>;

/**
 * Rules that change the advice. Each key is a dotted path into LeagueSettings,
 * so a stored override replaces the value at that path.
 */
export const RULE_KEYS = [
  "waivers.type",
  "waivers.faabBudget",
  "waivers.faabRemaining",
  "waivers.waiverHours",
  "waivers.processDays",
  "waivers.processHour",
  "waivers.priorityResets",
  "scoring.format",
  "scoring.receptionPoints",
  "scoring.items",
  "roster.slots",
  "roster.positionLimits",
  "lineupLock",
  "trades.deadline",
  "trades.vetoVotesRequired",
  "trades.reviewHours",
  "schedule.playoffTeams",
  "schedule.playoffStartWeek",
] as const;
export const RuleKey = z.enum(RULE_KEYS);
export type RuleKey = z.infer<typeof RuleKey>;

export const Player = z.object({
  id: z.number().int(),
  name: z.string(),
  position: z.string(),
  proTeam: z.string(),
  injuryStatus: InjuryStatus,
  byeWeek: z.number().int().nullable(),
  /** For the requested week. */
  projectedPoints: z.number().nullable(),
  actualPoints: z.number().nullable(),
  percentRostered: z.number().nullable(),
  /** Starting slots the player can fill (BE and IR omitted). */
  eligibleSlots: z.array(z.string()),
});
export type Player = z.infer<typeof Player>;

export const RosterSlot = z.object({
  slot: z.string(),
  /** Game has kicked off; the player can't be moved this week. */
  locked: z.boolean(),
  player: Player,
});
export type RosterSlot = z.infer<typeof RosterSlot>;

export const Roster = z.object({
  league: z.string(),
  teamId: z.number().int(),
  teamName: z.string(),
  week: z.number().int(),
  starters: z.array(RosterSlot),
  bench: z.array(RosterSlot),
  ir: z.array(RosterSlot),
  projectedTotal: z.number(),
  actualTotal: z.number(),
});
export type Roster = z.infer<typeof Roster>;

export const Team = z.object({
  id: z.number().int(),
  name: z.string(),
  abbrev: z.string(),
  owners: z.array(z.string()),
  wins: z.number().int(),
  losses: z.number().int(),
  ties: z.number().int(),
  pointsFor: z.number(),
  pointsAgainst: z.number(),
  playoffSeed: z.number().int().nullable(),
  waiverRank: z.number().int().nullable(),
  faabRemaining: z.number().nullable(),
  isMine: z.boolean(),
});
export type Team = z.infer<typeof Team>;

export const League = z.object({
  alias: z.string(),
  name: z.string(),
  leagueId: z.number().int(),
  year: z.number().int(),
  myTeamId: z.number().int(),
  myTeamName: z.string(),
  size: z.number().int(),
  currentWeek: z.number().int(),
  scoringFormat: z.string(),
  waiverType: z.string().nullable(),
  superflex: z.boolean(),
  hasDst: z.boolean(),
  hasK: z.boolean(),
});
export type League = z.infer<typeof League>;

export const ScoringItem = z.object({
  abbr: z.string(),
  label: z.string(),
  points: z.number(),
  overrides: z.record(z.string(), z.number()).optional(),
});
export type ScoringItem = z.infer<typeof ScoringItem>;

export const RuleConflict = z.object({
  rule: RuleKey,
  espn: z.unknown(),
  stored: z.unknown(),
  storedSource: RuleSource,
});
export type RuleConflict = z.infer<typeof RuleConflict>;

export const LeagueSettings = z.object({
  league: z.string(),
  leagueId: z.number().int(),
  year: z.number().int(),
  name: z.string(),
  size: z.number().int(),
  currentWeek: z.number().int(),
  myTeamId: z.number().int(),
  scoring: z.object({
    type: z.string().nullable(),
    /** PPR, HALF_PPR, STANDARD or CUSTOM, from points per reception. */
    format: z.string().nullable(),
    receptionPoints: z.number().nullable(),
    items: z.array(ScoringItem),
  }),
  roster: z.object({
    /** Starting slots and counts, e.g. { QB: 1, RB: 2, FLEX: 1, OP: 1 }. */
    slots: z.record(z.string(), z.number()),
    benchSize: z.number().int(),
    benchUnlimited: z.boolean(),
    irSlots: z.number().int(),
    superflex: z.boolean(),
    hasDst: z.boolean(),
    hasK: z.boolean(),
    /** Max players per position; unlimited positions omitted. */
    positionLimits: z.record(z.string(), z.number()),
  }),
  waivers: z.object({
    type: z.enum(["FAAB", "PRIORITY"]).nullable(),
    faabBudget: z.number().nullable(),
    faabRemaining: z.number().nullable(),
    minimumBid: z.number().nullable(),
    myWaiverRank: z.number().int().nullable(),
    waiverHours: z.number().nullable(),
    processDays: z.array(z.string()).nullable(),
    /** Hour waivers process, as ESPN reports it (timezone not documented). */
    processHour: z.number().nullable(),
    priorityResets: z.boolean().nullable(),
    seasonAcquisitionLimit: z.number().nullable(),
  }),
  /** INDIVIDUAL_GAME = each player locks at his own kickoff. */
  lineupLock: z.string().nullable(),
  trades: z.object({
    deadline: z.string().nullable(),
    vetoVotesRequired: z.number().int().nullable(),
    reviewHours: z.number().nullable(),
  }),
  schedule: z.object({
    regularSeasonWeeks: z.number().int().nullable(),
    playoffTeams: z.number().int().nullable(),
    playoffStartWeek: z.number().int().nullable(),
    playoffMatchupLength: z.number().int().nullable(),
  }),
  teams: z.array(Team),
  /** Where each rule's value came from. Stored upload/user values override ESPN. */
  ruleSources: z.partialRecord(RuleKey, RuleSource),
  /** Rules ESPN didn't provide and nothing stored covers: ask before advising. */
  missingRules: z.array(RuleKey),
  /** Stored values that disagree with ESPN: re-confirm with the user. */
  conflicts: z.array(RuleConflict),
});
export type LeagueSettings = z.infer<typeof LeagueSettings>;

export const MatchupSide = z.object({
  teamId: z.number().int(),
  teamName: z.string(),
  score: z.number(),
  projected: z.number(),
  starters: z.array(RosterSlot),
});
export type MatchupSide = z.infer<typeof MatchupSide>;

export const Matchup = z.object({
  league: z.string(),
  week: z.number().int(),
  isPlayoff: z.boolean(),
  me: MatchupSide,
  /** Null on a bye. */
  opponent: MatchupSide.nullable(),
});
export type Matchup = z.infer<typeof Matchup>;

export const FreeAgent = Player.extend({
  status: z.enum(["FREE_AGENT", "WAIVERS"]),
  percentChange: z.number().nullable(),
  positionalRank: z.number().int().nullable(),
  seasonPoints: z.number().nullable(),
  seasonProjectedPoints: z.number().nullable(),
});
export type FreeAgent = z.infer<typeof FreeAgent>;

export const TransactionAction = z.enum([
  "ADD",
  "WAIVER_ADD",
  "DROP",
  "TRADE_SENT",
  "TRADE_RECEIVED",
  "UNKNOWN",
]);
export type TransactionAction = z.infer<typeof TransactionAction>;

export const Transaction = z.object({
  date: z.string(),
  items: z.array(
    z.object({
      action: TransactionAction,
      team: z.string().nullable(),
      player: z.string(),
      position: z.string().nullable(),
      proTeam: z.string().nullable(),
      /** FAAB bid, for waiver adds. */
      bid: z.number().nullable(),
    }),
  ),
});
export type Transaction = z.infer<typeof Transaction>;
