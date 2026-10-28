// The highest-projected legal lineup. Mechanical only: it knows slot
// eligibility, byes, injury designations, lock state, IR rules and queued
// claims, but not the news. The weekly-check skill decides what to do with it.

import { slotRank } from "./map.js";
import type {
  InjuryStatus,
  LineupPlayer,
  OptimalLineup,
  PendingClaim,
  Player,
  Roster,
  RosterSlot,
} from "./schemas.js";

const CANT_PLAY = new Set(["OUT", "IR", "SUSPENDED"]);
const GAME_TIME = new Set(["QUESTIONABLE", "DOUBTFUL"]);

// Tie-breakers, far below a projection's 0.01 resolution: a filled slot beats
// an empty one, and the current slot beats an equal swap, so nothing churns.
const FILL_BONUS = 0.001;
const STAY_BONUS = 0.0001;
const INELIGIBLE = 1e6;

type Risk = OptimalLineup["risks"][number];

/**
 * Min-cost assignment of rows to distinct columns (Hungarian algorithm,
 * O(rows² × cols)). Needs rows ≤ cols. Returns the column for each row.
 */
export function assign(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  if (n > m) throw new Error("assign: more rows than columns");
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // column → row (1-based), 0 = free
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) rowToCol[p[j]! - 1] = j - 1;
  return rowToCol;
}

const compact = (s: RosterSlot): LineupPlayer => ({
  id: s.player.id,
  name: s.player.name,
  position: s.player.position,
  proTeam: s.player.proTeam,
  injuryStatus: s.player.injuryStatus,
  projectedPoints: s.player.projectedPoints,
  kickoff: s.player.game?.kickoff ?? null,
  locked: s.locked,
  droppable: s.droppable,
  lastNewsDate: s.player.lastNewsDate,
});

const round = (n: number) => Math.round(n * 100) / 100;

/** What ESPN usually allows in an IR slot, when the league hasn't said otherwise. */
export const DEFAULT_IR_ELIGIBLE: readonly InjuryStatus[] = ["OUT", "IR", "SUSPENDED"];

export interface OptimizeOptions {
  /** Most players allowed outside IR (starting slots plus bench). Enables drop suggestions. */
  rosterMax?: number;
  /** Injury designations allowed in an IR slot. Defaults to DEFAULT_IR_ELIGIBLE. */
  irEligible?: readonly InjuryStatus[];
  /** Queued claims: players they drop leave the pool, and adds can fill empty slots. */
  pendingClaims?: readonly PendingClaim[];
  /** The clock for stale-tag checks. Defaults to the current time. */
  now?: Date;
}

/** Positions each combo slot takes; any other slot takes its own position. */
const COMBO_SLOTS: Record<string, readonly string[]> = {
  FLEX: ["RB", "WR", "TE"],
  OP: ["QB", "RB", "WR", "TE"],
  "RB/WR": ["RB", "WR"],
  "WR/TE": ["WR", "TE"],
};
const positionFits = (position: string | null, slot: string) =>
  !!position && (position === slot || (COMBO_SLOTS[slot]?.includes(position) ?? false));

// ── Stale injury tags ───────────────────────────────────────────────────────

const ET = "America/New_York";
const DAY_MS = 86_400_000;
const etFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

function etParts(ms: number) {
  const parts = Object.fromEntries(etFormat.formatToParts(ms).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday: parts.weekday ?? "",
  };
}

/** Midnight Eastern time on the ET calendar day containing `ms`. */
function etMidnight(ms: number): number {
  const { year, month, day } = etParts(ms);
  // Midnight ET is 04:00 UTC in daylight time and 05:00 UTC in standard time.
  for (const hour of [4, 5]) {
    const t = Date.UTC(year, month - 1, day, hour);
    const p = etParts(t);
    if (p.hour === 0 && p.day === day) return t;
  }
  return Date.UTC(year, month - 1, day, 5);
}

const PRACTICE_DAYS = new Set(["Wed", "Thu", "Fri"]);
/** Teams usually publish the day's practice report by mid-afternoon; count it from 4 PM ET. */
const REPORT_HOUR_MS = 16 * 60 * 60 * 1000;

/**
 * The latest Wed–Fri practice report before kickoff that's out by `now`, as the
 * time it counts from (4 PM ET that day). Undefined before the week's first one.
 */
export function latestPracticeReport(kickoff: number, now: number): number | undefined {
  const gameDay = etMidnight(kickoff);
  let latest: number | undefined;
  for (let back = 1; back <= 6; back++) {
    const day = etMidnight(kickoff - back * DAY_MS);
    const report = day + REPORT_HOUR_MS;
    if (day < gameDay && report <= now && PRACTICE_DAYS.has(etParts(day).weekday)) {
      latest = Math.max(latest ?? 0, report);
    }
  }
  return latest;
}

const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { timeZone: ET, month: "short", day: "numeric" });

/** Flags a game-time tag whose latest news predates this week's practice reports. */
export function staleTag(p: Player, now: number): { lastNews: string; reason: string } | undefined {
  if (!p.game || !p.lastNewsDate) return undefined;
  const kickoff = Date.parse(p.game.kickoff);
  const news = Date.parse(p.lastNewsDate);
  if (news < kickoff - 8 * DAY_MS) {
    return {
      lastNews: p.lastNewsDate,
      reason: `last news ${shortDate(news)}, before his previous game; the tag may be stale`,
    };
  }
  const report = latestPracticeReport(kickoff, now);
  if (report !== undefined && news < report) {
    const weekday = new Date(report).toLocaleDateString("en-US", { timeZone: ET, weekday: "long" });
    return {
      lastNews: p.lastNewsDate,
      reason: `last news ${shortDate(news)}, before ${weekday}'s practice report; the tag may be stale`,
    };
  }
  return undefined;
}

// ── The optimizer ───────────────────────────────────────────────────────────

/**
 * Fills `slots` (starting slot → count, from league settings) from the roster's
 * starters and bench to maximize projected points. Locked players stay put, IR
 * slots are left alone, and players on bye or OUT/IR/SUSPENDED don't start.
 *
 * A player projecting exactly 0 (or with no projection) doesn't fill a slot:
 * ESPN usually zeroes players it expects to sit. If he's the only option, the
 * slot comes back empty with one EMPTY_SLOT that names him, and no move benches
 * him (he might still play, and an empty slot surely scores 0). When no player
 * has a projection at all, projections are treated as not loaded yet and
 * ignored for this rule.
 */
export function optimizeLineup(
  roster: Roster,
  slots: Record<string, number>,
  options: OptimizeOptions = {},
): OptimalLineup {
  const week = roster.week;
  const now = (options.now ?? new Date()).getTime();
  const irEligible = new Set(options.irEligible ?? DEFAULT_IR_ELIGIBLE);
  const claims = options.pendingClaims ?? [];
  const claimDrops = new Set(claims.map((c) => c.drop?.name).filter((n): n is string => !!n));
  const claimAdds = new Set(claims.map((c) => c.add?.name).filter((n): n is string => !!n));

  const pool = [...roster.starters, ...roster.bench];
  // If the NFL schedule didn't load, nobody has a game; fall back to byeWeek alone.
  const scheduleKnown = pool.some((s) => s.player.game !== null);
  const whyOut = (p: Player): string | null => {
    if (p.byeWeek === week || (scheduleKnown && p.game === null)) return "bye";
    if (CANT_PLAY.has(p.injuryStatus)) return p.injuryStatus;
    return null;
  };
  const projectionsKnown = pool.some((s) => (s.player.projectedPoints ?? 0) !== 0);
  const projects = (p: Player) => !projectionsKnown || (p.projectedPoints ?? 0) !== 0;

  // Locked starters keep their slot; locked bench players can't come in.
  const fixed = roster.starters.filter((s) => s.locked);
  const open: string[] = [];
  for (const [slot, count] of Object.entries(slots)) {
    const taken = fixed.filter((s) => s.slot === slot).length;
    for (let i = taken; i < count; i++) open.push(slot);
  }
  open.sort((a, b) => slotRank(a) - slotRank(b));
  const available = pool.filter(
    (s) => !s.locked && whyOut(s.player) === null && !claimDrops.has(s.player.name),
  );
  const candidates = available.filter((s) => projects(s.player));
  /** Healthy players who project 0: never starters, but named when nobody else can fill a slot. */
  const zeroes = available.filter((s) => !projects(s.player));

  // Rows: open slots. Columns: candidates, then one "leave empty" per slot.
  const cost = open.map((slot) => [
    ...candidates.map((c) =>
      c.player.eligibleSlots.includes(slot)
        ? // A negative projection (D/ST can have one) still beats an empty slot.
          -(
            Math.max(0, c.player.projectedPoints ?? 0) +
            FILL_BONUS +
            (c.slot === slot ? STAY_BONUS : 0)
          )
        : INELIGIBLE,
    ),
    ...open.map(() => 0),
  ]);
  const picks = open.length ? assign(cost) : [];

  const chosen = new Map<number, { slot: string; s: RosterSlot }>(); // open index → pick
  picks.forEach((col, row) => {
    const c = candidates[col];
    if (c && cost[row]![col]! < INELIGIBLE) chosen.set(row, { slot: open[row]!, s: c });
  });

  // Empty slots: name the zero-projection option, preferring whoever sits there now.
  const zeroFor = new Map<number, RosterSlot>(); // open index → zero-projection option
  const usedZero = new Set<number>();
  open.forEach((slot, row) => {
    if (chosen.has(row)) return;
    const fits = zeroes.filter(
      (z) => !usedZero.has(z.player.id) && z.player.eligibleSlots.includes(slot),
    );
    const pick = fits.find((z) => z.slot === slot) ?? fits[0];
    if (pick) {
      zeroFor.set(row, pick);
      usedZero.add(pick.player.id);
    }
  });

  const starters: OptimalLineup["starters"] = [
    ...fixed.map((s) => ({ slot: s.slot, player: compact(s) })),
    ...open.map((slot, row) => {
      const pick = chosen.get(row);
      return { slot, player: pick ? compact(pick.s) : null };
    }),
  ].sort((a, b) => slotRank(a.slot) - slotRank(b.slot));

  // Moves: compare every non-IR player's slot before and after.
  const newSlot = new Map<number, string>();
  for (const s of fixed) newSlot.set(s.player.id, s.slot);
  for (const { slot, s } of chosen.values()) newSlot.set(s.player.id, slot);
  // A zero-projection player already in the slot he'd be named for stays: no move.
  open.forEach((slot, row) => {
    const z = zeroFor.get(row);
    if (z && z.slot === slot) newSlot.set(z.player.id, slot);
  });
  // Who leaves each slot, so a player coming in can say whom he replaces.
  const leaving = new Map<string, string[]>();
  for (const s of roster.starters) {
    if ((newSlot.get(s.player.id) ?? "BE") === s.slot) continue;
    leaving.set(s.slot, [...(leaving.get(s.slot) ?? []), s.player.name]);
  }
  const moves: OptimalLineup["moves"] = [];
  for (const s of pool) {
    const to = newSlot.get(s.player.id) ?? "BE";
    if (to === s.slot) continue;
    let reason: string;
    if (to === "BE") {
      reason = claimDrops.has(s.player.name)
        ? "being dropped in a pending claim"
        : (whyOut(s.player) ?? "lower projection");
    } else {
      const out = leaving.get(to)?.shift();
      reason = out ? `replaces ${out}` : "fills an empty slot";
    }
    moves.push({ player: s.player.name, from: s.slot, to, reason });
  }
  // Benchings first, then who comes in, so each move reads as a swap.
  moves.sort((a, b) => Number(b.to === "BE") - Number(a.to === "BE"));

  const risks: Risk[] = [];
  const startingIds = new Set(newSlot.keys());
  const bench = candidates.filter((c) => !startingIds.has(c.player.id));
  /** A bench player who's the only late backup for a game-time starter: never suggested as a drop. */
  const onlyPivots = new Set<string>();
  for (const { slot, s } of chosen.values()) {
    const p = s.player;
    if (GAME_TIME.has(p.injuryStatus) && p.game) {
      const kickoff = Date.parse(p.game.kickoff);
      const backups = bench
        .filter(
          (b) =>
            b.player.eligibleSlots.includes(slot) &&
            b.player.game !== null &&
            Date.parse(b.player.game.kickoff) >= kickoff,
        )
        .map((b) => b.player.name);
      if (backups.length === 1) onlyPivots.add(backups[0]!);
      const stale = staleTag(p, now);
      risks.push({
        type: "GAME_TIME",
        slot,
        player: p.name,
        detail: backups.length
          ? `${p.injuryStatus}; bench backups who play at the same time or later: ${backups.join(", ")}`
          : `${p.injuryStatus}; no healthy bench backup plays at the same time or later, so there's no pivot after inactives`,
        ...(stale ? { staleTag: stale } : {}),
      });
    }
  }

  const usedClaims = new Set<PendingClaim>();
  open.forEach((slot, row) => {
    if (chosen.has(row)) return;
    const zero = zeroFor.get(row);
    const claim = claims.find(
      (c) => !usedClaims.has(c) && c.add && positionFits(c.add.position, slot),
    );
    if (claim) usedClaims.add(claim);
    risks.push({
      type: "EMPTY_SLOT",
      slot,
      player: zero?.player.name ?? null,
      detail: zero
        ? `the best option on the roster, ${zero.player.name}, projects 0, so ESPN may expect him to sit`
        : "no healthy, eligible player on the roster",
      ...(claim?.add
        ? {
            pendingClaim: {
              add: claim.add.name,
              drop: claim.drop?.name ?? null,
              processesAt: claim.processesAt,
            },
          }
        : {}),
    });
  });

  // IR slots: a player whose status isn't IR-eligible anymore blocks adds and claims.
  const fullRoster =
    options.rosterMax !== undefined &&
    roster.starters.length + roster.bench.length >= options.rosterMax;
  for (const s of roster.ir) {
    if (irEligible.has(s.player.injuryStatus)) continue;
    risks.push({
      type: "IR_INELIGIBLE",
      slot: s.slot,
      player: s.player.name,
      detail: `${s.player.injuryStatus} in an IR slot, which isn't IR-eligible: ESPN blocks adds and claims until he moves to the bench${fullRoster ? " (the roster is full, so drop someone first)" : ""}`,
    });
  }

  // With a full roster, every pickup (an empty slot without a queued claim) and
  // every IR fix needs room: name a drop for each, a different one each time.
  if (fullRoster) {
    const dropPool = pool
      .filter(
        (s) =>
          !newSlot.has(s.player.id) &&
          s.droppable &&
          !onlyPivots.has(s.player.name) &&
          !claimDrops.has(s.player.name) &&
          !claimAdds.has(s.player.name),
      )
      .sort(
        (a, b) => (a.player.seasonProjectedPoints ?? 0) - (b.player.seasonProjectedPoints ?? 0),
      );
    for (const risk of risks) {
      const needsRoom =
        risk.type === "IR_INELIGIBLE" || (risk.type === "EMPTY_SLOT" && !risk.pendingClaim);
      if (!needsRoom) continue;
      const next = dropPool.shift();
      if (!next) break;
      const value = next.player.seasonProjectedPoints;
      risk.drop = {
        player: next.player.name,
        reason: `lowest season projection on the bench${value === null ? "" : ` (${value.toFixed(1)})`}, droppable`,
      };
    }
  }

  const total = starters.reduce((t, s) => t + (s.player?.projectedPoints ?? 0), 0);
  return {
    league: roster.league,
    week,
    starters,
    projectedTotal: round(total),
    currentProjectedTotal: roster.projectedTotal,
    moves,
    risks,
    asOf: roster.asOf,
  };
}
