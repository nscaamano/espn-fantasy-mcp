// League rules discovery: ESPN first, then stored values (from a settings-page
// upload or from asking the user) layered on top. Stored values win; disagreements
// are reported so the skill can re-confirm them.

import type { StoredRule } from "./config.js";
import {
  RULE_KEYS,
  type LeagueSettings,
  type RuleConflict,
  type RuleKey,
  type RuleSource,
} from "./schemas.js";

type BaseSettings = Omit<LeagueSettings, "ruleSources" | "missingRules" | "conflicts">;

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  const last = parts.pop()!;
  let cur = obj;
  for (const part of parts) {
    const next = cur[part];
    if (next === null || typeof next !== "object") cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[last] = value;
}

/** JSON with sorted keys, so {a,b} and {b,a} compare equal. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/** Rules that don't apply to this league's waiver system aren't "missing". */
function applies(rule: RuleKey, waiverType: unknown): boolean {
  if (waiverType === "PRIORITY") {
    return rule !== "waivers.faabBudget" && rule !== "waivers.faabRemaining";
  }
  if (waiverType === "FAAB") return rule !== "waivers.priorityResets";
  return true;
}

export function applyRules(
  base: BaseSettings,
  stored: Partial<Record<RuleKey, StoredRule>>,
): LeagueSettings {
  const settings = structuredClone(base) as unknown as Record<string, unknown>;
  const ruleSources: Partial<Record<RuleKey, RuleSource>> = {};
  const conflicts: RuleConflict[] = [];

  for (const rule of RULE_KEYS) {
    const espn = getPath(base, rule);
    const hasEspn = espn !== null && espn !== undefined;
    const override = stored[rule];
    if (override) {
      if (hasEspn && stable(espn) !== stable(override.value)) {
        conflicts.push({ rule, espn, stored: override.value, storedSource: override.source });
      }
      setPath(settings, rule, override.value);
      ruleSources[rule] = override.source;
    } else if (hasEspn) {
      ruleSources[rule] = "espn";
    }
  }

  const waiverType = getPath(settings, "waivers.type");
  const missingRules = RULE_KEYS.filter((rule) => !ruleSources[rule] && applies(rule, waiverType));

  return { ...(settings as unknown as BaseSettings), ruleSources, missingRules, conflicts };
}
