// Raw ESPN JSON → typed shapes. Pure functions, so they're testable against
// recorded fixtures. Logic follows espn-api's football models.

import {
  ACTIVITY_MAP,
  POSITION_MAP,
  PRO_TEAM_MAP,
  SETTINGS_SCORING_FORMAT_MAP,
} from "./constants.js";
import { DEFAULT_POSITION_MAP, slotLabel } from "./positions.js";
import type {
  RawCommunication,
  RawLeague,
  RawMatchupSide,
  RawMember,
  RawPlayer,
  RawProSchedule,
  RawRosterEntry,
  RawTeam,
} from "./raw.js";
import type {
  EspnActivity,
  EspnActivityAction,
  EspnActivityItem,
  EspnFreeAgent,
  EspnLeagueSettings,
  EspnMatchup,
  EspnMatchupSide,
  EspnPlayer,
  EspnProTeam,
  EspnRoster,
  EspnRosterEntry,
  EspnTeam,
} from "./types.js";

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

function primaryPosition(raw: RawPlayer): string {
  const byDefault =
    raw.defaultPositionId !== undefined && DEFAULT_POSITION_MAP[raw.defaultPositionId];
  if (byDefault) return byDefault;
  // espn-api's fallback: first eligible slot that isn't a combo slot or "Rookie".
  for (const id of raw.eligibleSlots ?? []) {
    const label = POSITION_MAP[id] ?? "";
    if (id !== 25 && label && !label.includes("/")) return label;
  }
  return "";
}

export function parsePlayer(
  raw: RawPlayer,
  year: number,
  week: number,
  entryInjuryStatus?: string,
): EspnPlayer {
  const weekPts: EspnPlayer["week"] = { actual: null, projected: null };
  const seasonPts: EspnPlayer["season"] = { actual: null, projected: null };

  for (const s of raw.stats ?? []) {
    if (s.seasonId !== year || s.appliedTotal === undefined) continue;
    const key = s.statSourceId === 0 ? "actual" : s.statSourceId === 1 ? "projected" : null;
    if (!key) continue;
    if (s.statSplitTypeId === 1 && s.scoringPeriodId === week) weekPts[key] = round(s.appliedTotal);
    if (s.statSplitTypeId === 0 && s.scoringPeriodId === 0) seasonPts[key] = round(s.appliedTotal);
  }

  const proTeamId = raw.proTeamId ?? 0;
  const ownership = raw.ownership;
  return {
    id: raw.id ?? 0,
    name: raw.fullName ?? "Unknown",
    position: primaryPosition(raw),
    eligibleSlots: (raw.eligibleSlots ?? []).map(slotLabel),
    proTeamId,
    proTeam: PRO_TEAM_MAP[proTeamId] ?? "None",
    injuryStatus: raw.injuryStatus ?? entryInjuryStatus ?? null,
    injured: raw.injured ?? false,
    percentOwned: ownership?.percentOwned !== undefined ? round(ownership.percentOwned, 1) : null,
    percentStarted:
      ownership?.percentStarted !== undefined ? round(ownership.percentStarted, 1) : null,
    percentChange:
      ownership?.percentChange !== undefined ? round(ownership.percentChange, 2) : null,
    week: weekPts,
    season: seasonPts,
  };
}

export function parseRosterEntry(raw: RawRosterEntry, year: number, week: number): EspnRosterEntry {
  const slotId = raw.lineupSlotId ?? 20;
  return {
    slotId,
    slot: slotLabel(slotId),
    locked: raw.playerPoolEntry?.lineupLocked ?? false,
    acquisitionType: orNull(raw.acquisitionType),
    player: parsePlayer(raw.playerPoolEntry?.player ?? {}, year, week, raw.injuryStatus),
  };
}

function teamName(t: RawTeam): string {
  // Managers type names like "Tuna  Can "; collapse the stray whitespace.
  const name = (t.name || [t.location, t.nickname].filter(Boolean).join(" "))
    .replace(/\s+/g, " ")
    .trim();
  return name || `Team ${t.id}`;
}

function memberName(m: RawMember): string {
  if (m.displayName) return m.displayName;
  return [m.firstName, m.lastName].filter(Boolean).join(" ") || (m.id ?? "unknown");
}

export function parseTeam(t: RawTeam, members: RawMember[] = []): EspnTeam {
  const overall = t.record?.overall ?? {};
  const byId = new Map(members.map((m) => [m.id, m]));
  return {
    id: t.id,
    abbrev: t.abbrev ?? "",
    name: teamName(t),
    owners: (t.owners ?? []).map((id) => {
      const m = byId.get(id);
      return m ? memberName(m) : id;
    }),
    wins: overall.wins ?? 0,
    losses: overall.losses ?? 0,
    ties: overall.ties ?? 0,
    pointsFor: round(overall.pointsFor ?? 0),
    pointsAgainst: round(overall.pointsAgainst ?? 0),
    streak:
      overall.streakType && overall.streakType !== "NONE"
        ? { type: overall.streakType, length: overall.streakLength ?? 0 }
        : null,
    playoffSeed: orNull(t.playoffSeed),
    waiverRank: orNull(t.waiverRank),
    faabSpent: t.transactionCounter?.acquisitionBudgetSpent ?? 0,
    acquisitions: t.transactionCounter?.acquisitions ?? 0,
    drops: t.transactionCounter?.drops ?? 0,
    trades: t.transactionCounter?.trades ?? 0,
  };
}

/** Current scoring period, capped at the season's last one (as espn-api does). */
export function currentWeek(raw: RawLeague): number {
  const period = raw.scoringPeriodId ?? raw.status?.latestScoringPeriod ?? 1;
  const final = raw.status?.finalScoringPeriod;
  return final !== undefined && period > final ? final : period;
}

export function parseLeagueSettings(
  raw: RawLeague,
  leagueId: number,
  year: number,
): EspnLeagueSettings {
  const s = raw.settings ?? {};
  const acq = s.acquisitionSettings ?? {};
  const roster = s.rosterSettings ?? {};
  const sched = s.scheduleSettings ?? {};
  const trade = s.tradeSettings ?? {};

  const lineupSlotCounts: Record<string, number> = {};
  for (const [id, count] of Object.entries(roster.lineupSlotCounts ?? {})) {
    if (count > 0) lineupSlotCounts[slotLabel(Number(id))] = count;
  }

  const positionLimits: Record<string, number> = {};
  for (const [id, max] of Object.entries(roster.positionLimits ?? {})) {
    const label = DEFAULT_POSITION_MAP[Number(id)];
    if (label && max > 0) positionLimits[label] = max;
  }

  const matchupPeriods: Record<number, number[]> = {};
  for (const [period, weeks] of Object.entries(sched.matchupPeriods ?? {})) {
    matchupPeriods[Number(period)] = weeks;
  }

  return {
    leagueId,
    year,
    name: s.name ?? `League ${leagueId}`,
    size: s.size ?? raw.teams?.length ?? 0,
    currentWeek: currentWeek(raw),
    currentMatchupPeriod: raw.status?.currentMatchupPeriod ?? currentWeek(raw),
    finalScoringPeriod: orNull(raw.status?.finalScoringPeriod),
    scoringType: orNull(s.scoringSettings?.scoringType),
    scoringItems: (s.scoringSettings?.scoringItems ?? []).map((item) => {
      const format = SETTINGS_SCORING_FORMAT_MAP[item.statId];
      const overrides: Record<string, number> = {};
      for (const [slot, pts] of Object.entries(item.pointsOverrides ?? {})) {
        overrides[slotLabel(Number(slot))] = pts;
      }
      return {
        statId: item.statId,
        abbr: format?.abbr ?? `STAT_${item.statId}`,
        label: format?.label ?? "Unknown",
        points: item.points ?? 0,
        overrides,
      };
    }),
    lineupSlotCounts,
    positionLimits,
    benchUnlimited: roster.isBenchUnlimited ?? false,
    lineupLockType: orNull(roster.lineupLocktimeType),
    acquisition: {
      type: orNull(acq.acquisitionType),
      usesFaab: acq.isUsingAcquisitionBudget ?? false,
      budget: orNull(acq.acquisitionBudget),
      minimumBid: orNull(acq.minimumBid),
      waiverHours: orNull(acq.waiverHours),
      waiverOrderReset: orNull(acq.waiverOrderReset),
      processDays: acq.waiverProcessDays ?? [],
      processHour: orNull(acq.waiverProcessHour),
      seasonLimit:
        acq.acquisitionLimit !== undefined && acq.acquisitionLimit >= 0
          ? acq.acquisitionLimit
          : null,
      matchupLimit:
        acq.matchupAcquisitionLimit !== undefined && acq.matchupAcquisitionLimit > 0
          ? acq.matchupAcquisitionLimit
          : null,
    },
    trade: {
      deadline: trade.deadlineDate ?? null,
      vetoVotesRequired: orNull(trade.vetoVotesRequired),
      reviewHours: orNull(trade.revisionHours),
    },
    schedule: {
      regularSeasonMatchups: orNull(sched.matchupPeriodCount),
      matchupPeriods,
      playoffTeamCount: orNull(sched.playoffTeamCount),
      playoffMatchupPeriodLength: orNull(sched.playoffMatchupPeriodLength),
      playoffSeedingRule: orNull(sched.playoffSeedingRule),
    },
    teams: (raw.teams ?? []).map((t) => parseTeam(t, raw.members)).sort((a, b) => a.id - b.id),
  };
}

export function parseRosters(raw: RawLeague, year: number, week: number): EspnRoster[] {
  return (raw.teams ?? []).map((t) => ({
    teamId: t.id,
    week,
    entries: (t.roster?.entries ?? []).map((e) => parseRosterEntry(e, year, week)),
  }));
}

const isStarter = (e: EspnRosterEntry) => e.slot !== "BE" && e.slot !== "IR";

function parseMatchupSide(
  side: RawMatchupSide | undefined,
  year: number,
  week: number,
): EspnMatchupSide | null {
  if (!side || side.teamId === undefined) return null;
  const lineup = (side.rosterForCurrentScoringPeriod?.entries ?? []).map((e) =>
    parseRosterEntry(e, year, week),
  );
  const live = side.totalProjectedPointsLive;
  const projected =
    live !== undefined && live !== -1
      ? round(live)
      : round(lineup.filter(isStarter).reduce((sum, e) => sum + (e.player.week.projected ?? 0), 0));
  return {
    teamId: side.teamId,
    score: round(side.totalPointsLive ?? side.totalPoints ?? 0),
    projected,
    lineup,
  };
}

export function parseMatchups(raw: RawLeague, year: number, week: number): EspnMatchup[] {
  return (raw.schedule ?? []).map((m) => ({
    matchupPeriod: m.matchupPeriodId ?? week,
    week,
    playoffTier: m.playoffTierType ?? "NONE",
    winner: m.winner ?? "UNDECIDED",
    home: parseMatchupSide(m.home, year, week),
    away: parseMatchupSide(m.away, year, week),
  }));
}

export function parseFreeAgents(raw: RawLeague, year: number, week: number): EspnFreeAgent[] {
  return (raw.players ?? []).map((p) => ({
    status: p.status ?? "FREEAGENT",
    positionalRank: p.ratings?.["0"]?.positionalRanking ?? null,
    player: parsePlayer(p.player ?? {}, year, week),
  }));
}

/** Activity topics → items, without player names (see EspnClient.getRecentActivity). */
export function parseActivity(raw: RawCommunication): EspnActivity[] {
  return (raw.topics ?? []).map((topic) => {
    const items: EspnActivityItem[] = [];
    const item = (
      action: EspnActivityAction,
      teamId: number | undefined,
      playerId: number,
      bid: number | null = null,
    ) =>
      items.push({
        action,
        // ESPN uses 0 for "no team" (e.g. the free-agent pool).
        teamId: teamId ? teamId : null,
        playerId,
        playerName: null,
        position: null,
        proTeam: null,
        bid,
      });

    for (const msg of topic.messages ?? []) {
      const id = msg.messageTypeId ?? -1;
      const playerId = msg.targetId ?? 0;
      if (id === 244) {
        item("TRADE SENT", msg.from, playerId);
        if (msg.to !== undefined) item("TRADE RECEIVED", msg.to, playerId);
        continue;
      }
      const action = (ACTIVITY_MAP[id] as EspnActivityAction | undefined) ?? "UNKNOWN";
      const teamId = id === 239 ? msg.for : msg.to;
      item(action, teamId, playerId, action === "WAIVER ADDED" ? (msg.from ?? null) : null);
    }
    return { id: orNull(topic.id), date: topic.date ?? 0, items };
  });
}

export function parseProTeams(raw: RawProSchedule): EspnProTeam[] {
  return (raw.settings?.proTeams ?? [])
    .filter((t) => t.id !== 0)
    .map((t) => ({
      id: t.id,
      // ESPN's own abbrevs are inconsistently cased ("Ind"); prefer the map.
      abbrev: PRO_TEAM_MAP[t.id] ?? t.abbrev ?? String(t.id),
      byeWeek: t.byeWeek && t.byeWeek > 0 ? t.byeWeek : null,
    }));
}
