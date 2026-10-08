// leagues.json: your leagues, your team in each, and rules confirmed by hand.
// Cookies come from the environment, never from this file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { RuleKey, RuleSource } from "./schemas.js";

export const StoredRule = z.object({
  value: z.unknown(),
  source: RuleSource,
  /** YYYY-MM-DD the value was confirmed. */
  confirmed: z.string(),
});
export type StoredRule = z.infer<typeof StoredRule>;

export const LeagueConfig = z.object({
  /** Short name used by tools, e.g. "ppr", "superflex". */
  alias: z.string().min(1),
  name: z.string().optional(),
  leagueId: z
    .number()
    .int()
    .positive("set leagueId (the number after leagueId= in the league URL)"),
  year: z.number().int(),
  myTeamId: z.number().int().positive("set myTeamId (the number after teamId= on your team page)"),
  rules: z.partialRecord(RuleKey, StoredRule).default({}),
});
export type LeagueConfig = z.infer<typeof LeagueConfig>;

export const LeaguesConfig = z.object({
  leagues: z.array(LeagueConfig).min(1),
});
export type LeaguesConfig = z.infer<typeof LeaguesConfig>;

const CONFIG_FILE = "leagues.json";

/** LEAGUES_CONFIG if set, else the nearest leagues.json from `from` upward. */
export function findConfigPath(from = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.LEAGUES_CONFIG) return resolve(env.LEAGUES_CONFIG);
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No ${CONFIG_FILE} found from ${from} upward. Copy leagues.example.json to leagues.json ` +
          `and fill in your league and team ids, or set LEAGUES_CONFIG.`,
      );
    }
    dir = parent;
  }
}

export function loadConfig(path = findConfigPath()): LeaguesConfig {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Can't read ${path}: ${(err as Error).message}`, { cause: err });
  }
  const parsed = LeaguesConfig.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  const aliases = parsed.data.leagues.map((l) => l.alias.toLowerCase());
  const dup = aliases.find((a, i) => aliases.indexOf(a) !== i);
  if (dup) throw new Error(`Invalid ${path}: alias "${dup}" is used twice`);
  return parsed.data;
}

export function saveConfig(config: LeaguesConfig, path: string): void {
  writeFileSync(path, JSON.stringify(LeaguesConfig.parse(config), null, 2) + "\n");
}

/** Finds a league by alias (case-insensitive) or by league id. */
export function findLeague(config: LeaguesConfig, league: string): LeagueConfig {
  const key = league.trim().toLowerCase();
  const found = config.leagues.find(
    (l) => l.alias.toLowerCase() === key || String(l.leagueId) === key,
  );
  if (!found) {
    const aliases = config.leagues.map((l) => l.alias).join(", ");
    throw new Error(`Unknown league "${league}". Known leagues: ${aliases}`);
  }
  return found;
}
