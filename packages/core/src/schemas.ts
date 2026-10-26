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
  /**
   * The player's NFL game in the requested week: opponent, home or away, and
   * kickoff (ISO, UTC). Lineups lock per player at kickoff. Null on a bye.
   */
  game: z.object({ opponent: z.string(), home: z.boolean(), kickoff: z.string() }).nullable(),
  /** For the requested week. */
  projectedPoints: z.number().nullable(),
  actualPoints: z.number().nullable(),
  percentRostered: z.number().nullable(),
  /**
   * When ESPN last posted news on the player (ISO, UTC). A status older than the
   * latest practice report or inactives may be stale. Null if ESPN didn't send
   * it: rosters and free agents have it, matchups don't (checked live, 2026).
   */
  lastNewsDate: z.string().nullable(),
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
  /** When this was read from ESPN (ISO, UTC). Re-fetch rather than reuse an old result. */
  asOf: z.string(),
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

/** The schema a stored value for `rule` must match: LeagueSettings at that path, not null. */
export function ruleValueSchema(rule: RuleKey): z.ZodType {
  let schema: z.ZodType = LeagueSettings;
  for (const part of rule.split(".")) {
    schema = (schema as z.ZodObject).shape[part]!;
  }
  return schema instanceof z.ZodNullable ? (schema.unwrap() as z.ZodType) : schema;
}

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
  /** When this was read from ESPN (ISO, UTC). Re-fetch rather than reuse an old result. */
  asOf: z.string(),
});

/** Every league's matchup in one call. A league that fails is listed in `errors`. */
export const Scoreboard = z.object({
  matchups: z.array(Matchup),
  errors: z.array(z.object({ league: z.string(), error: z.string() })),
});
export type Scoreboard = z.infer<typeof Scoreboard>;

export const LineupPlayer = Player.pick({
  id: true,
  name: true,
  position: true,
  proTeam: true,
  injuryStatus: true,
  projectedPoints: true,
}).extend({
  /** ISO, UTC; null on a bye. */
  kickoff: z.string().nullable(),
  locked: z.boolean(),
});
export type LineupPlayer = z.infer<typeof LineupPlayer>;

/** The highest-projected legal lineup. Mechanical: no news, no judgment. */
export const OptimalLineup = z.object({
  league: z.string(),
  week: z.number().int(),
  /** A null player is a slot no healthy, eligible player can fill. */
  starters: z.array(z.object({ slot: z.string(), player: LineupPlayer.nullable() })),
  projectedTotal: z.number(),
  currentProjectedTotal: z.number(),
  /** Every player whose slot changes; BE is the bench. `reason` says why a starter sits. */
  moves: z.array(
    z.object({
      player: z.string(),
      from: z.string(),
      to: z.string(),
      reason: z.string().nullable(),
    }),
  ),
  /** Things to check before lock. */
  risks: z.array(
    z.object({
      type: z.enum(["GAME_TIME", "NO_PROJECTION", "EMPTY_SLOT"]),
      slot: z.string(),
      player: z.string().nullable(),
      detail: z.string(),
    }),
  ),
  asOf: z.string(),
});
export type OptimalLineup = z.infer<typeof OptimalLineup>;

export const FreeAgentSort = z.enum(["week", "season"]);
export type FreeAgentSort = z.infer<typeof FreeAgentSort>;
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

export const ClaimPlayer = z.object({
  name: z.string(),
  position: z.string().nullable(),
  proTeam: z.string().nullable(),
});
export type ClaimPlayer = z.infer<typeof ClaimPlayer>;

/** One of the user's queued claims. ESPN doesn't expose the claim priority order. */
export const PendingClaim = z.object({
  /** WAIVER, or FREEAGENT while transactions are locked. */
  type: z.string(),
  add: ClaimPlayer.nullable(),
  drop: ClaimPlayer.extend({
    /** Lineup slot the dropped player leaves, e.g. "BE" or "K". */
    slot: z.string().nullable(),
  }).nullable(),
  /** FAAB bid; null in priority-waiver leagues. */
  bid: z.number().nullable(),
  /** When the claim was submitted. */
  proposedAt: z.string().nullable(),
  /** When ESPN will process it. */
  processesAt: z.string().nullable(),
});
export type PendingClaim = z.infer<typeof PendingClaim>;
