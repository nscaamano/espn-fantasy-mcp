// Thin client for ESPN's undocumented fantasy football v3 API. Request shapes
// (views, x-fantasy-filter headers, endpoints) are ported from espn-api's
// espn_requests.py and football/league.py.

import { EspnAuthError, EspnHttpError, EspnNotFoundError } from "./errors.js";
import {
  currentWeek,
  parseActivity,
  parseFreeAgents,
  parseLeagueSettings,
  parseMatchups,
  parsePlayer,
  parseProTeams,
  parseRosters,
} from "./parse.js";
import { slotIdForPosition } from "./positions.js";
import type { RawCommunication, RawLeague, RawProSchedule } from "./raw.js";
import type {
  EspnActivity,
  EspnFreeAgent,
  EspnLeagueSettings,
  EspnMatchup,
  EspnPlayer,
  EspnProTeam,
  EspnRoster,
} from "./types.js";

/** ESPN moved league reads to this host once; keep it configurable. */
export const DEFAULT_BASE_URL = "https://lm-api-reads.fantasy.espn.com/apis/v3";
const GAME = "ffl";

export interface EspnClientOptions {
  /** `espn_s2` cookie. Required for private leagues. */
  espnS2?: string;
  /** `SWID` cookie, including braces. Required for private leagues. */
  swid?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface LeagueGetOptions {
  views?: string[];
  scoringPeriodId?: number;
  filter?: unknown;
  /** Path appended to the league URL, e.g. "/communication/". */
  extend?: string;
}

export class EspnClient {
  private readonly baseUrl: string;
  private readonly cookie: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly proTeamsByYear = new Map<number, Promise<EspnProTeam[]>>();

  constructor(options: EspnClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? fetch;
    const cookies = [
      options.espnS2 && `espn_s2=${options.espnS2}`,
      options.swid && `SWID=${options.swid}`,
    ].filter(Boolean);
    this.cookie = cookies.length ? cookies.join("; ") : undefined;
  }

  /** Reads ESPN_S2, SWID and optional ESPN_BASE_URL from the environment. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): EspnClient {
    return new EspnClient({
      espnS2: env.ESPN_S2 || undefined,
      swid: env.SWID || undefined,
      baseUrl: env.ESPN_BASE_URL || undefined,
    });
  }

  // ── The five reads ──────────────────────────────────────────────────────────

  /** Scoring, roster slots, waiver/FAAB rules, trade and schedule settings, and every team. */
  async getLeagueSettings(leagueId: number, year: number): Promise<EspnLeagueSettings> {
    const raw = await this.leagueGet<RawLeague>(leagueId, year, { views: ["mSettings", "mTeam"] });
    return parseLeagueSettings(raw, leagueId, year);
  }

  /** One team's roster for a week (defaults to the current week). */
  async getRoster(
    leagueId: number,
    year: number,
    teamId: number,
    week?: number,
  ): Promise<EspnRoster> {
    const rosters = await this.getRosters(leagueId, year, week);
    const roster = rosters.find((r) => r.teamId === teamId);
    if (!roster) {
      const ids = rosters.map((r) => r.teamId).join(", ");
      throw new EspnNotFoundError(`Team ${teamId} not found in league ${leagueId} (teams: ${ids})`);
    }
    return roster;
  }

  /** Every team's roster in one request. */
  async getRosters(leagueId: number, year: number, week?: number): Promise<EspnRoster[]> {
    const w = await this.resolveWeek(leagueId, year, week);
    const raw = await this.leagueGet<RawLeague>(leagueId, year, {
      views: ["mRoster"],
      scoringPeriodId: w,
    });
    return parseRosters(raw, year, w);
  }

  /** All matchups for a week, with both lineups and projected/actual totals. */
  async getMatchups(leagueId: number, year: number, week?: number): Promise<EspnMatchup[]> {
    const settings = await this.leagueGet<RawLeague>(leagueId, year, { views: ["mSettings"] });
    const w = week ?? currentWeek(settings);
    let matchupPeriod = week === undefined ? (settings.status?.currentMatchupPeriod ?? w) : w;
    for (const [period, weeks] of Object.entries(
      settings.settings?.scheduleSettings?.matchupPeriods ?? {},
    )) {
      if (weeks.includes(w)) {
        matchupPeriod = Number(period);
        break;
      }
    }

    const raw = await this.leagueGet<RawLeague>(leagueId, year, {
      views: ["mMatchupScore", "mScoreboard"],
      scoringPeriodId: w,
      filter: { schedule: { filterMatchupPeriodIds: { value: [matchupPeriod] } } },
    });
    return parseMatchups(raw, year, w);
  }

  /**
   * Free agents and waiver-wire players at a position, ordered by % rostered
   * (ESPN's sort). `position` is a slot label: QB, RB, WR, TE, FLEX, OP, D/ST, K;
   * omit it for all positions.
   */
  async getFreeAgents(
    leagueId: number,
    year: number,
    position: string | undefined,
    n = 50,
    week?: number,
  ): Promise<EspnFreeAgent[]> {
    const slotIds: number[] = [];
    if (position) {
      const id = slotIdForPosition(position);
      if (id === undefined) throw new Error(`Unknown position "${position}"`);
      slotIds.push(id);
    }
    const w = await this.resolveWeek(leagueId, year, week);
    const raw = await this.leagueGet<RawLeague>(leagueId, year, {
      views: ["kona_player_info"],
      scoringPeriodId: w,
      filter: {
        players: {
          filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
          filterSlotIds: { value: slotIds },
          limit: n,
          sortPercOwned: { sortPriority: 1, sortAsc: false },
          sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
        },
      },
    });
    return parseFreeAgents(raw, year, w);
  }

  /** Recent adds, drops, waiver claims (with FAAB bids) and trades, newest first. */
  async getRecentActivity(leagueId: number, year: number, limit = 25): Promise<EspnActivity[]> {
    const raw = await this.leagueGet<RawCommunication>(leagueId, year, {
      extend: "/communication/",
      views: ["kona_league_communication"],
      filter: {
        topics: {
          filterType: { value: ["ACTIVITY_TRANSACTIONS"] },
          limit,
          limitPerMessageSet: { value: 25 },
          offset: 0,
          sortMessageDate: { sortPriority: 1, sortAsc: false },
          sortFor: { sortPriority: 2, sortAsc: false },
          filterIncludeMessageTypeIds: { value: [178, 180, 179, 239, 181, 244] },
        },
      },
    });
    const activity = parseActivity(raw);

    const ids = [...new Set(activity.flatMap((a) => a.items.map((i) => i.playerId)))];
    const players = await this.getPlayers(leagueId, year, ids);
    for (const item of activity.flatMap((a) => a.items)) {
      const p = players.get(item.playerId);
      if (p) {
        item.playerName = p.name;
        item.position = p.position;
        item.proTeam = p.proTeam;
      }
    }
    return activity;
  }

  // ── Supporting reads ────────────────────────────────────────────────────────

  /** Player cards by id (any status), keyed by id. */
  async getPlayers(
    leagueId: number,
    year: number,
    ids: number[],
  ): Promise<Map<number, EspnPlayer>> {
    if (!ids.length) return new Map();
    const raw = await this.leagueGet<RawLeague>(leagueId, year, {
      views: ["kona_playercard"],
      filter: {
        players: {
          filterIds: { value: ids },
          filterStatsForTopScoringPeriodIds: {
            value: 1,
            additionalValue: [`00${year}`, `10${year}`],
          },
        },
      },
    });
    const week = currentWeek(raw);
    return new Map(
      (raw.players ?? []).map((p) => {
        const player = parsePlayer(p.player ?? {}, year, week);
        return [player.id, player];
      }),
    );
  }

  /** NFL teams with bye weeks. Public data, cached per year for the client's lifetime. */
  getProTeams(year: number): Promise<EspnProTeam[]> {
    let cached = this.proTeamsByYear.get(year);
    if (!cached) {
      const url = `${this.baseUrl}/games/${GAME}/seasons/${year}?view=proTeamSchedules_wl`;
      cached = this.request<RawProSchedule>(url).then(parseProTeams);
      cached.catch(() => this.proTeamsByYear.delete(year));
      this.proTeamsByYear.set(year, cached);
    }
    return cached;
  }

  /** The league's current scoring period (NFL week). */
  async getCurrentWeek(leagueId: number, year: number): Promise<number> {
    const raw = await this.leagueGet<RawLeague>(leagueId, year, { views: ["mSettings"] });
    return currentWeek(raw);
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  private resolveWeek(leagueId: number, year: number, week?: number): Promise<number> {
    return week !== undefined ? Promise.resolve(week) : this.getCurrentWeek(leagueId, year);
  }

  private leagueUrl(leagueId: number, year: number, opts: LeagueGetOptions): string {
    const url = new URL(
      `${this.baseUrl}/games/${GAME}/seasons/${year}/segments/0/leagues/${leagueId}${opts.extend ?? ""}`,
    );
    for (const view of opts.views ?? []) url.searchParams.append("view", view);
    if (opts.scoringPeriodId !== undefined) {
      url.searchParams.set("scoringPeriodId", String(opts.scoringPeriodId));
    }
    return url.toString();
  }

  private async leagueGet<T>(leagueId: number, year: number, opts: LeagueGetOptions): Promise<T> {
    const url = this.leagueUrl(leagueId, year, opts);
    try {
      const data = await this.request<T | T[]>(url, opts.filter);
      return (Array.isArray(data) ? data[0] : data) as T;
    } catch (err) {
      // A league with no message board 404s on /communication; treat as empty.
      if (err instanceof EspnNotFoundError && opts.extend?.includes("communication")) {
        return { topics: [] } as T;
      }
      throw err;
    }
  }

  private async request<T>(url: string, filter?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cookie) headers.Cookie = this.cookie;
    if (filter !== undefined) headers["x-fantasy-filter"] = JSON.stringify(filter);

    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new EspnHttpError(`ESPN request failed: ${(err as Error).message}`, undefined, url);
    }

    if (res.status === 401 || res.status === 403) {
      const hint = this.cookie
        ? "espn_s2 has probably expired; re-copy it from browser dev tools into .env"
        : "ESPN_S2 and SWID are not set; private leagues need both cookies";
      throw new EspnAuthError(`ESPN returned ${res.status}: ${hint}`, res.status, url);
    }
    if (res.status === 404) {
      throw new EspnNotFoundError(`ESPN returned 404 (check league id and year)`, 404, url);
    }
    if (!res.ok) {
      throw new EspnHttpError(`ESPN returned HTTP ${res.status}`, res.status, url);
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new EspnHttpError(
        `ESPN returned non-JSON (${text.slice(0, 80).replace(/\s+/g, " ")}…)`,
        res.status,
        url,
      );
    }
  }
}
