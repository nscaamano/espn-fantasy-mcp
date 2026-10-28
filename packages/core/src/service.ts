// Domain functions over espn-client. The MCP server (and any other adapter) is
// a thin layer over this class. No lineup or waiver opinions here: those belong
// in the skills.

import { EspnClient, type EspnLeagueSettings } from "@nscaamano/espn-fantasy-client";
import { z } from "zod";
import {
  findConfigPath,
  findLeague,
  loadConfig,
  saveConfig,
  type LeagueConfig,
  type LeaguesConfig,
  type StoredRule,
} from "./config.js";
import {
  splitLineup,
  toFreeAgent,
  toLeagueSettings,
  lockAtKickoff,
  toPendingClaim,
  toTransaction,
  toWaiverResults,
  type ProSchedule,
} from "./map.js";
import { DEFAULT_IR_ELIGIBLE, optimizeLineup } from "./lineup.js";
import { applyRules } from "./rules.js";
import {
  FreeAgent,
  League,
  LeagueSettings,
  Matchup,
  PendingClaim,
  Roster,
  RuleKey,
  OptimalLineup,
  Scoreboard,
  Transaction,
  WaiverResults,
  type FreeAgentSort,
  type Team,
  ruleValueSchema,
  type MatchupSide,
  type RuleSource,
} from "./schemas.js";

export interface FantasyServiceOptions {
  /** Where leagues.json lives; needed to save rules. */
  configPath?: string;
  /** How long league settings stay cached, in ms. Default 2 minutes. */
  settingsTtlMs?: number;
  now?: () => Date;
}

export class FantasyService {
  private readonly settingsCache = new Map<
    string,
    { at: number; value: Promise<EspnLeagueSettings> }
  >();
  private readonly settingsTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly client: EspnClient,
    private config: LeaguesConfig,
    private readonly options: FantasyServiceOptions = {},
  ) {
    this.settingsTtlMs = options.settingsTtlMs ?? 120_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Cookies from ESPN_S2/SWID, leagues from LEAGUES_CONFIG or the nearest leagues.json. */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    configPath = findConfigPath(process.cwd(), env),
  ): FantasyService {
    return new FantasyService(EspnClient.fromEnv(env), loadConfig(configPath), { configPath });
  }

  get leagues(): readonly LeagueConfig[] {
    return this.config.leagues;
  }

  /** Configured leagues with scoring format, waiver type and roster shape. */
  async listLeagues(): Promise<League[]> {
    return Promise.all(
      this.config.leagues.map(async (cfg) => {
        const s = await this.getLeagueSettings(cfg.alias);
        const me = s.teams.find((t) => t.isMine);
        return League.parse({
          alias: cfg.alias,
          name: s.name,
          leagueId: cfg.leagueId,
          year: cfg.year,
          myTeamId: cfg.myTeamId,
          myTeamName: me?.name ?? `Team ${cfg.myTeamId}`,
          size: s.size,
          currentWeek: s.currentWeek,
          scoringFormat: s.scoring.format ?? "UNKNOWN",
          waiverType: s.waivers.type,
          superflex: s.roster.superflex,
          hasDst: s.roster.hasDst,
          hasK: s.roster.hasK,
        });
      }),
    );
  }

  /** ESPN settings with stored rule overrides applied, plus missing and conflicting rules. */
  async getLeagueSettings(league: string): Promise<LeagueSettings> {
    const cfg = findLeague(this.config, league);
    const raw = await this.espnSettings(cfg);
    this.assertMyTeam(cfg, raw);
    return LeagueSettings.parse(
      applyRules(toLeagueSettings(raw, cfg.alias, cfg.myTeamId), cfg.rules),
    );
  }

  async getMyRoster(league: string, week?: number): Promise<Roster> {
    const cfg = findLeague(this.config, league);
    return this.getTeamRoster(cfg.alias, cfg.myTeamId, week);
  }

  /** Any team's roster, same shape as getMyRoster. */
  async getTeamRoster(league: string, teamId: number, week?: number): Promise<Roster> {
    const cfg = findLeague(this.config, league);
    const [roster, settings, schedule] = await Promise.all([
      this.client.getRoster(cfg.leagueId, cfg.year, teamId, week),
      this.espnSettings(cfg),
      this.proSchedule(cfg.year),
    ]);
    return Roster.parse({
      league: cfg.alias,
      teamId,
      teamName: this.teamName(settings, teamId),
      week: roster.week,
      ...splitLineup(roster.entries, schedule, roster.week),
      asOf: this.now().toISOString(),
    });
  }

  /**
   * The highest-projected legal lineup for my team, from the league's starting
   * slots (stored rules applied), with the moves to get there and risks to check.
   * A slot the roster can't fill comes with the top free agents for it.
   */
  async getOptimalLineup(league: string, week?: number): Promise<OptimalLineup> {
    const [settings, roster, claims] = await Promise.all([
      this.getLeagueSettings(league),
      this.getMyRoster(league, week),
      // Claims are a refinement: without them the lineup is still right.
      this.getPendingClaims(league).catch(() => [] as PendingClaim[]),
    ]);
    const r = settings.roster;
    const lineup = optimizeLineup(roster, r.slots, {
      // The roster limit is every non-IR slot: starters plus bench. ESPN's
      // isBenchUnlimited is true even in leagues that enforce this (checked live).
      rosterMax: Object.values(r.slots).reduce((a, b) => a + b, 0) + r.benchSize,
      irEligible: r.irEligibleStatuses ?? DEFAULT_IR_ELIGIBLE,
      pendingClaims: claims,
      now: this.now(),
    });
    // A queued claim already covers its slot, so only open slots get suggestions.
    const holes = lineup.risks.filter((r) => r.type === "EMPTY_SLOT" && !r.pendingClaim);
    const slots = [...new Set(holes.map((r) => r.slot))];
    const claimed = new Set(claims.map((c) => c.add?.name).filter((n): n is string => !!n));
    const options = new Map(
      await Promise.all(
        slots.map(async (slot) => {
          // Suggestions are a bonus: a failed lookup still returns the lineup.
          const fas = await this.getFreeAgents(league, slot, 3 + claimed.size, lineup.week).catch(
            () => null,
          );
          return [slot, fas?.filter((f) => !claimed.has(f.name)).slice(0, 3) ?? null] as const;
        }),
      ),
    );
    for (const risk of holes) {
      const fas = options.get(risk.slot);
      if (fas) {
        risk.freeAgents = fas.map((f) => ({
          name: f.name,
          position: f.position,
          proTeam: f.proTeam,
          injuryStatus: f.injuryStatus,
          projectedPoints: f.projectedPoints,
          status: f.status,
          // A claim is due by the claim run; a free agent by his kickoff.
          waiverClears: f.waiverClears,
          kickoff: f.game?.kickoff ?? null,
        }));
      }
    }
    return OptimalLineup.parse(lineup);
  }

  /** Every team in a league: record, points, playoff seed, waiver rank and FAAB left. */
  async getTeams(league: string): Promise<Team[]> {
    return (await this.getLeagueSettings(league)).teams;
  }

  /** My matchup for a week: both starting lineups and projected/actual totals. */
  async getMatchup(league: string, week?: number): Promise<Matchup> {
    const cfg = findLeague(this.config, league);
    const [matchups, settings, schedule] = await Promise.all([
      this.client.getMatchups(cfg.leagueId, cfg.year, week),
      this.espnSettings(cfg),
      this.proSchedule(cfg.year),
    ]);
    const mine = matchups.find(
      (m) => m.home?.teamId === cfg.myTeamId || m.away?.teamId === cfg.myTeamId,
    );
    if (!mine) {
      const w = week ?? settings.currentWeek;
      throw new Error(
        `No matchup for team ${cfg.myTeamId} in ${cfg.alias} week ${w} (bye or eliminated?)`,
      );
    }
    const [me, opp] =
      mine.home?.teamId === cfg.myTeamId ? [mine.home, mine.away] : [mine.away!, mine.home];
    const now = this.now();
    const side = (s: NonNullable<typeof me>): MatchupSide => ({
      teamId: s.teamId,
      teamName: this.teamName(settings, s.teamId),
      score: s.score,
      projected: s.projected,
      winProbability: s.winProbability,
      starters: splitLineup(s.lineup, schedule, mine.week).starters.map((st) =>
        lockAtKickoff(st, now),
      ),
    });
    return Matchup.parse({
      league: cfg.alias,
      week: mine.week,
      isPlayoff: mine.playoffTier !== "NONE",
      me: side(me!),
      opponent: opp ? side(opp) : null,
      asOf: this.now().toISOString(),
    });
  }

  /**
   * My matchup in every league, fetched in parallel. A league that fails (a bye
   * week, an ESPN error) goes into `errors` instead of failing the rest.
   */
  async getScoreboard(week?: number): Promise<Scoreboard> {
    const results = await Promise.allSettled(
      this.config.leagues.map((cfg) => this.getMatchup(cfg.alias, week)),
    );
    const scoreboard: Scoreboard = { matchups: [], errors: [] };
    results.forEach((r, i) => {
      if (r.status === "fulfilled") scoreboard.matchups.push(r.value);
      else {
        const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
        scoreboard.errors.push({ league: this.config.leagues[i]!.alias, error });
      }
    });
    return scoreboard;
  }

  /**
   * Top available players at a position by this week's projection, or by
   * ESPN's full-season projection with `sort: "season"`. ESPN only sorts by
   * % rostered, so this fetches a wider pool and re-sorts it.
   */
  async getFreeAgents(
    league: string,
    position: string | undefined,
    limit = 15,
    week?: number,
    sort: FreeAgentSort = "week",
  ): Promise<FreeAgent[]> {
    const cfg = findLeague(this.config, league);
    const pool = Math.max(50, limit * 3);
    // Resolve the week from cached settings, so the client needn't look it up.
    const w = week ?? (await this.espnSettings(cfg)).currentWeek;
    const [agents, schedule] = await Promise.all([
      this.client.getFreeAgents(cfg.leagueId, cfg.year, position, pool, w),
      this.proSchedule(cfg.year),
    ]);
    return agents
      .map((fa) => FreeAgent.parse(toFreeAgent(fa, schedule, w)))
      .sort((a, b) => {
        const key = sort === "season" ? "seasonProjectedPoints" : "projectedPoints";
        return (
          (b[key] ?? -1) - (a[key] ?? -1) || (b.percentRostered ?? 0) - (a.percentRostered ?? 0)
        );
      })
      .slice(0, limit);
  }

  /** Recent adds, drops, waiver results with FAAB bids, and trades. Newest first. */
  async getRecentActivity(league: string, limit = 25): Promise<Transaction[]> {
    const cfg = findLeague(this.config, league);
    const [activity, settings] = await Promise.all([
      this.client.getRecentActivity(cfg.leagueId, cfg.year, limit),
      this.espnSettings(cfg),
    ]);
    const names = new Map(settings.teams.map((t) => [t.id, t.name]));
    return activity.map((a) =>
      Transaction.parse(toTransaction(a, names, settings.acquisition.usesFaab)),
    );
  }

  /**
   * My queued claims, in the order ESPN lists them (submission order so far;
   * the claim priority order isn't exposed). Other teams' claims are filtered
   * out in case ESPN ever returns them.
   */
  async getPendingClaims(league: string): Promise<PendingClaim[]> {
    const cfg = findLeague(this.config, league);
    const [claims, settings] = await Promise.all([
      this.client.getPendingClaims(cfg.leagueId, cfg.year),
      this.espnSettings(cfg),
    ]);
    return claims
      .filter((c) => c.teamId === cfg.myTeamId)
      .map((c) => PendingClaim.parse(toPendingClaim(c, settings.acquisition.usesFaab)));
  }

  /**
   * How the user's claims fared in this week's latest waiver run: won, lost
   * (to whom, for how much) or failed, plus claims canceled since the run
   * before, and the user's waiver priority now.
   */
  async getWaiverResults(league: string, week?: number): Promise<WaiverResults> {
    const cfg = findLeague(this.config, league);
    const settings = await this.espnSettings(cfg);
    const w = week ?? settings.currentWeek;
    const transactions = await this.client.getTransactions(cfg.leagueId, cfg.year, w);
    const usesFaab = settings.acquisition.usesFaab;
    return WaiverResults.parse({
      league: cfg.alias,
      week: w,
      ...toWaiverResults(transactions, cfg.myTeamId, usesFaab, (id) => this.teamName(settings, id)),
      usesFaab,
      waiverRank: settings.teams.find((t) => t.id === cfg.myTeamId)?.waiverRank ?? null,
      asOf: this.now().toISOString(),
    });
  }

  /**
   * Stores a rule the user confirmed (from a settings-page upload or by answering a
   * question). It overrides ESPN's value from then on and is saved to leagues.json.
   */
  setLeagueRule(
    league: string,
    rule: RuleKey,
    value: unknown,
    source: Exclude<RuleSource, "espn">,
  ): StoredRule {
    const cfg = findLeague(this.config, league);
    const key = RuleKey.parse(rule);
    const parsed = ruleValueSchema(key).safeParse(value);
    if (!parsed.success) {
      throw new Error(`Invalid value for ${key}:\n${z.prettifyError(parsed.error)}`);
    }
    if (!this.options.configPath) throw new Error("No configPath set; can't save leagues.json");
    const stored: StoredRule = {
      value: parsed.data,
      source,
      confirmed: this.now().toISOString().slice(0, 10),
    };
    cfg.rules[key] = stored;
    saveConfig(this.config, this.options.configPath);
    return stored;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private espnSettings(cfg: LeagueConfig): Promise<EspnLeagueSettings> {
    const key = `${cfg.leagueId}:${cfg.year}`;
    const hit = this.settingsCache.get(key);
    const at = this.now().getTime();
    if (hit && at - hit.at < this.settingsTtlMs) return hit.value;
    const value = this.client.getLeagueSettings(cfg.leagueId, cfg.year);
    value.catch(() => this.settingsCache.delete(key));
    this.settingsCache.set(key, { at, value });
    return value;
  }

  private async proSchedule(year: number): Promise<ProSchedule> {
    try {
      const teams = await this.client.getProTeams(year);
      return new Map(teams.map((t) => [t.id, t]));
    } catch {
      // Byes and kickoffs are a nice-to-have; don't fail a roster read over them.
      return new Map();
    }
  }

  private teamName(s: EspnLeagueSettings, teamId: number): string {
    return s.teams.find((t) => t.id === teamId)?.name ?? `Team ${teamId}`;
  }

  private assertMyTeam(cfg: LeagueConfig, s: EspnLeagueSettings): void {
    if (s.teams.length && !s.teams.some((t) => t.id === cfg.myTeamId)) {
      const teams = s.teams.map((t) => `${t.id}=${t.name}`).join(", ");
      throw new Error(`myTeamId ${cfg.myTeamId} isn't in ${cfg.alias}. Teams: ${teams}`);
    }
  }
}
