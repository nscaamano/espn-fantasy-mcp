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
  parsePendingClaims,
  parseTransactions,
  parsePlayer,
  parsePlayerPool,
  parseProTeams,
  parseRosters,
} from "./parse.js";
import { nameKey, nameMatches, nameWords } from "./names.js";
import { slotIdForPosition } from "./positions.js";
import type { RawCommunication, RawLeague, RawProSchedule } from "./raw.js";
import type {
  EspnActivity,
  EspnFreeAgent,
  EspnLeagueSettings,
  EspnMatchup,
  EspnPendingClaim,
  EspnPoolPlayer,
  EspnTransaction,
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
  /** Per attempt. Default 20 s. */
  timeoutMs?: number;
  /** Extra attempts after a network failure or a 502/503/504. Default 1. */
  retries?: number;
  /** Pause before a retry. Default 500 ms. */
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

/** Gateway errors that usually clear on a second try. */
const RETRY_STATUSES = new Set([502, 503, 504]);

interface LeagueGetOptions {
  views?: string[];
  scoringPeriodId?: number;
  filter?: unknown;
  /** Path appended to the league URL, e.g. "/communication/". */
  extend?: string;
  /** Limits mRoster to one team (a tenth of the all-teams response). */
  forTeamId?: number;
}

/** How many players a name search asks ESPN for. */
const SEARCH_LIMIT = 50;

export class EspnClient {
  private readonly baseUrl: string;
  private readonly cookie: string | undefined;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly proTeamsByYear = new Map<number, Promise<EspnProTeam[]>>();

  constructor(options: EspnClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 500;
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

  /**
   * One team's roster for a week (defaults to the current week). `forTeamId`
   * makes ESPN send that team alone, a tenth of the all-teams response; it
   * sends no teams for an unknown id.
   */
  async getRoster(
    leagueId: number,
    year: number,
    teamId: number,
    week?: number,
  ): Promise<EspnRoster> {
    const w = await this.resolveWeek(leagueId, year, week);
    const raw = await this.leagueGet<RawLeague>(leagueId, year, {
      views: ["mRoster"],
      scoringPeriodId: w,
      forTeamId: teamId,
    });
    const roster = parseRosters(raw, year, w).find((r) => r.teamId === teamId);
    if (!roster) throw new EspnNotFoundError(`Team ${teamId} not found in league ${leagueId}`);
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

  /**
   * Players whose first or last name starts with `name`, any status (rostered,
   * free agent or on waivers), most rostered first. ESPN matches names exactly
   * as typed, punctuation included, so with no hits this retries each word and
   * keeps loose matches ("AJ Brown" finds "A.J. Brown"). When some names match
   * `name` exactly (ignoring punctuation and suffixes like Jr.), only those are
   * returned.
   */
  async searchPlayers(
    leagueId: number,
    year: number,
    name: string,
    week?: number,
  ): Promise<EspnPoolPlayer[]> {
    const query = name.trim().replace(/\s+/g, " ");
    if (!nameWords(query).length) return [];
    const w = await this.resolveWeek(leagueId, year, week);
    let found = await this.playersByName(leagueId, year, query, w);
    if (!found.length) {
      // Longest words first: they're the most specific. Three at most.
      const words = [...new Set(nameWords(query))].sort((a, b) => b.length - a.length).slice(0, 3);
      const lists = await Promise.all(
        words.map((word) => this.playersByName(leagueId, year, word, w)),
      );
      const seen = new Set<number>();
      found = lists
        .flat()
        .filter((p) => !seen.has(p.player.id) && seen.add(p.player.id))
        .filter((p) => nameMatches(p.player.name, query))
        .sort((a, b) => (b.player.percentOwned ?? 0) - (a.player.percentOwned ?? 0));
    }
    const key = nameKey(query);
    const exact = found.filter((p) => nameKey(p.player.name) === key);
    return exact.length ? exact : found;
  }

  private async playersByName(
    leagueId: number,
    year: number,
    name: string,
    week: number,
  ): Promise<EspnPoolPlayer[]> {
    const raw = await this.leagueGet<RawLeague>(leagueId, year, {
      views: ["kona_player_info"],
      scoringPeriodId: week,
      filter: {
        players: {
          filterName: { value: name },
          // ESPN rejects a limit without a sort.
          limit: SEARCH_LIMIT,
          sortPercOwned: { sortPriority: 1, sortAsc: false },
        },
      },
    });
    return parsePlayerPool(raw, year, week);
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
    await this.nameItems(
      leagueId,
      year,
      activity.flatMap((a) => a.items),
    );
    return activity;
  }

  /**
   * Queued claims (waiver claims, or free-agent adds while transactions are
   * locked), in ESPN's array order. ESPN has only returned the authenticated
   * user's own team's claims, and exposes no claim priority order.
   */
  async getPendingClaims(leagueId: number, year: number): Promise<EspnPendingClaim[]> {
    const raw = await this.leagueGet<RawLeague>(leagueId, year, {
      views: ["mPendingTransactions"],
    });
    const claims = parsePendingClaims(raw);
    await this.nameItems(
      leagueId,
      year,
      claims.flatMap((c) => [c.add, c.drop].filter((p) => p !== null)),
    );
    return claims;
  }

  /**
   * The league's transaction log for one scoring period, every team's, with
   * names for the players in waiver claims. A waiver run shows up as one PROCESS
   * record per claim (EXECUTED or FAILED_*), each pointing at its proposal.
   */
  async getTransactions(leagueId: number, year: number, week?: number): Promise<EspnTransaction[]> {
    const w = await this.resolveWeek(leagueId, year, week);
    const raw = await this.leagueGet<RawLeague>(leagueId, year, {
      views: ["mTransactions2"],
      scoringPeriodId: w,
    });
    const transactions = parseTransactions(raw);
    await this.nameItems(
      leagueId,
      year,
      transactions
        .filter((t) => t.type === "WAIVER")
        .flatMap((t) => [t.add, t.drop].filter((p) => p !== null)),
    );
    return transactions;
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

  /** Fills playerName, position and proTeam in place from one player-card request. */
  private async nameItems(
    leagueId: number,
    year: number,
    items: {
      playerId: number;
      playerName: string | null;
      position: string | null;
      proTeam: string | null;
    }[],
  ): Promise<void> {
    const ids = [...new Set(items.map((i) => i.playerId))];
    const players = await this.getPlayers(leagueId, year, ids);
    for (const item of items) {
      const p = players.get(item.playerId);
      if (p) {
        item.playerName = p.name;
        item.position = p.position;
        item.proTeam = p.proTeam;
      }
    }
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
    if (opts.forTeamId !== undefined) url.searchParams.set("forTeamId", String(opts.forTeamId));
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

  /**
   * One retry rides out a flaky CDN address or a gateway blip: on 2026-10-14 one
   * of ESPN's addresses failed for minutes while others worked. Auth and 4xx
   * errors aren't retried.
   */
  private async fetchWithRetry(url: string, headers: Record<string, string>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.retries;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (last) {
          throw new EspnHttpError(
            `ESPN request failed: ${describeFetchError(err)}`,
            undefined,
            url,
          );
        }
        await sleep(this.retryDelayMs);
        continue;
      }
      if (last || !RETRY_STATUSES.has(res.status)) return res;
      await res.body?.cancel();
      await sleep(this.retryDelayMs);
    }
  }

  private async request<T>(url: string, filter?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cookie) headers.Cookie = this.cookie;
    if (filter !== undefined) headers["x-fantasy-filter"] = JSON.stringify(filter);

    const res = await this.fetchWithRetry(url, headers);

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Node's fetch says only "fetch failed"; the useful part (ECONNRESET, ENOTFOUND) is in `cause`. */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}
