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
  "roster.irEligibleStatuses",
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
  /** ESPN's full-season projection: a steadier measure of value than one week (e.g. on a bye). */
  seasonProjectedPoints: z.number().nullable(),
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
  /**
   * Can be dropped now: not on the league's undroppable list, and his game this
   * week hasn't kicked off (ESPN locks a player for the rest of the week once it has).
   */
  droppable: z.boolean(),
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
    /**
     * Injury designations allowed in an IR slot. ESPN's settings don't expose
     * this, so it's null (and in missingRules) until confirmed with set_league_rule.
     * The optimizer assumes OUT, IR and SUSPENDED meanwhile.
     */
    irEligibleStatuses: z.array(InjuryStatus).nullable(),
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
  /** ESPN's chance this side wins (0–1), live during the week. Null for other weeks. */
  winProbability: z.number().nullable(),
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

export const FreeAgentSort = z.enum(["week", "season"]);
export type FreeAgentSort = z.infer<typeof FreeAgentSort>;
export type Matchup = z.infer<typeof Matchup>;

export const FreeAgent = Player.extend({
  status: z.enum(["FREE_AGENT", "WAIVERS"]),
  percentChange: z.number().nullable(),
  positionalRank: z.number().int().nullable(),
  seasonPoints: z.number().nullable(),
  seasonProjectedPoints: z.number().nullable(),
  /** For WAIVERS: when he clears, the next claim run (ISO, UTC). Null for free agents. */
  waiverClears: z.string().nullable(),
});
export type FreeAgent = z.infer<typeof FreeAgent>;

/** Any player in the league's pool, with who has him. */
export const PlayerInfo = FreeAgent.extend({
  /** ROSTERED (see `team`), FREE_AGENT (can be added now) or WAIVERS (needs a claim). */
  status: z.enum(["ROSTERED", "FREE_AGENT", "WAIVERS"]),
  /** For ROSTERED: the team, his lineup slot this week (null if unknown), and whether it's the user's. */
  team: z
    .object({
      id: z.number().int(),
      name: z.string(),
      slot: z.string().nullable(),
      isMine: z.boolean(),
    })
    .nullable(),
});
export type PlayerInfo = z.infer<typeof PlayerInfo>;

/** A name lookup. Several players can match a partial or shared name. */
export const PlayerSearch = z.object({
  league: z.string(),
  /** The name as asked. */
  query: z.string(),
  week: z.number().int(),
  /** Exact name matches if any, else every player whose name starts that way; most rostered first. */
  players: z.array(PlayerInfo),
  /** How many players matched (counting at most 50); more than `players` means the name was ambiguous. */
  totalMatches: z.number().int(),
  asOf: z.string(),
});
export type PlayerSearch = z.infer<typeof PlayerSearch>;

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
  droppable: z.boolean(),
  lastNewsDate: z.string().nullable(),
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
      /** Why a starter sits (bye, OUT, lower projection), or whom a player coming in replaces. */
      reason: z.string(),
    }),
  ),
  /** Things to check before lock. */
  risks: z.array(
    z.object({
      /**
       * GAME_TIME: a questionable or doubtful starter. EMPTY_SLOT: no healthy
       * player with a projection can fill it. IR_INELIGIBLE: a player in an IR
       * slot whose status isn't IR-eligible anymore, which blocks adds and claims.
       * NO_PROJECTION: kept for older clients; the optimizer now reports a
       * zero-projection best option as an EMPTY_SLOT instead.
       */
      type: z.enum(["GAME_TIME", "NO_PROJECTION", "EMPTY_SLOT", "IR_INELIGIBLE"]),
      slot: z.string(),
      player: z.string().nullable(),
      detail: z.string(),
      /** For EMPTY_SLOT: the top free agents for that slot this week. */
      freeAgents: z
        .array(
          FreeAgent.pick({
            name: true,
            position: true,
            proTeam: true,
            injuryStatus: true,
            projectedPoints: true,
            status: true,
            waiverClears: true,
          }).extend({
            /** The player's kickoff this week (ISO, UTC): the deadline for a free-agent add. */
            kickoff: z.string().nullable(),
          }),
        )
        .optional(),
      /** A queued claim that would fill this slot. */
      pendingClaim: z
        .object({
          add: z.string(),
          drop: z.string().nullable(),
          processesAt: z.string().nullable(),
        })
        .optional(),
      /** Who to drop to make room, when the roster is full. */
      drop: z.object({ player: z.string(), reason: z.string() }).optional(),
      /** GAME_TIME: the injury tag may be out of date. */
      staleTag: z.object({ lastNews: z.string(), reason: z.string() }).optional(),
    }),
  ),
  asOf: z.string(),
});
export type OptimalLineup = z.infer<typeof OptimalLineup>;

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

/** How one of the user's claims fared in the latest waiver run. */
export const ClaimResult = z.object({
  /**
   * WON; LOST: another team got the player (see `wonBy`); FAILED: any other
   * reason (see `reason`); CANCELED: withdrawn before the run.
   */
  result: z.enum(["WON", "LOST", "FAILED", "CANCELED"]),
  add: ClaimPlayer.nullable(),
  drop: ClaimPlayer.nullable(),
  /** The user's FAAB bid; null in priority-waiver leagues. */
  bid: z.number().nullable(),
  /**
   * Who got the player instead, and their winning bid (null in priority-waiver
   * leagues, where the team ahead in waiver priority wins).
   */
  wonBy: z.object({ team: z.string(), bid: z.number().nullable() }).nullable(),
  /** Why a FAILED claim failed: ESPN's status (e.g. FAILED_ROSTERLIMIT) or a note. */
  reason: z.string().nullable(),
});
export type ClaimResult = z.infer<typeof ClaimResult>;

export const WaiverResults = z.object({
  league: z.string(),
  week: z.number().int(),
  /** When this week's latest waiver run processed; null if none has yet. */
  processedAt: z.string().nullable(),
  usesFaab: z.boolean(),
  /** The user's waiver priority now (1 = first in line), after the run. */
  waiverRank: z.number().int().nullable(),
  /** The user's claims in that run, plus ones canceled since the run before. */
  claims: z.array(ClaimResult),
  /** When this was read from ESPN (ISO, UTC). */
  asOf: z.string(),
});
export type WaiverResults = z.infer<typeof WaiverResults>;
