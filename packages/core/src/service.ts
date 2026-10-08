// Domain functions over espn-client. The MCP server (and any other adapter) is
// a thin layer over this class. No lineup or waiver opinions here: those belong
// in the skills.

import { EspnClient, type EspnLeagueSettings } from "@espn-fantasy-mcp/espn-client";
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
import { splitLineup, toFreeAgent, toLeagueSettings, toTransaction, type ByeWeeks } from "./map.js";
import { applyRules } from "./rules.js";
import {
  FreeAgent,
  League,
  LeagueSettings,
  Matchup,
  Roster,
  RuleKey,
  Transaction,
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
    const [roster, settings, byes] = await Promise.all([
      this.client.getRoster(cfg.leagueId, cfg.year, teamId, week),
      this.espnSettings(cfg),
      this.byeWeeks(cfg.year),
    ]);
    return Roster.parse({
      league: cfg.alias,
      teamId,
      teamName: this.teamName(settings, teamId),
      week: roster.week,
      ...splitLineup(roster.entries, byes),
    });
  }

  /** My matchup for a week: both starting lineups and projected/actual totals. */
  async getMatchup(league: string, week?: number): Promise<Matchup> {
    const cfg = findLeague(this.config, league);
    const [matchups, settings, byes] = await Promise.all([
      this.client.getMatchups(cfg.leagueId, cfg.year, week),
      this.espnSettings(cfg),
      this.byeWeeks(cfg.year),
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
    const side = (s: NonNullable<typeof me>): MatchupSide => ({
      teamId: s.teamId,
      teamName: this.teamName(settings, s.teamId),
      score: s.score,
      projected: s.projected,
      starters: splitLineup(s.lineup, byes).starters,
    });
    return Matchup.parse({
      league: cfg.alias,
      week: mine.week,
      isPlayoff: mine.playoffTier !== "NONE",
      me: side(me!),
      opponent: opp ? side(opp) : null,
    });
  }

  /**
   * Top available players at a position by this week's projection. ESPN only
   * sorts by % rostered, so this fetches a wider pool and re-sorts it.
   */
  async getFreeAgents(
    league: string,
    position: string | undefined,
    limit = 15,
    week?: number,
  ): Promise<FreeAgent[]> {
    const cfg = findLeague(this.config, league);
    const pool = Math.max(50, limit * 3);
    const [agents, byes] = await Promise.all([
      this.client.getFreeAgents(cfg.leagueId, cfg.year, position, pool, week),
      this.byeWeeks(cfg.year),
    ]);
    return agents
      .map((fa) => FreeAgent.parse(toFreeAgent(fa, byes)))
      .sort(
        (a, b) =>
          (b.projectedPoints ?? -1) - (a.projectedPoints ?? -1) ||
          (b.percentRostered ?? 0) - (a.percentRostered ?? 0),
      )
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

  private async byeWeeks(year: number): Promise<ByeWeeks> {
    try {
      const teams = await this.client.getProTeams(year);
      return new Map(teams.map((t) => [t.id, t.byeWeek]));
    } catch {
      // Bye weeks are a nice-to-have; don't fail a roster read over them.
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
