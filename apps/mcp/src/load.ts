// Finds leagues.json and .env without help from the MCP client, so client
// configs hold only the launch command and never the cookies.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { FantasyService, LeaguesConfig, findConfigPath, saveConfig } from "@espn-fantasy-mcp/core";
import { z } from "zod";

/** LEAGUES_CONFIG, else the nearest leagues.json above this package, else above the cwd. */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  from = import.meta.dirname,
): string {
  try {
    return findConfigPath(from, env);
  } catch {
    return findConfigPath(process.cwd(), env);
  }
}

/** Variables from the .env beside leagues.json. Ones already in `env` win, as with node --env-file. */
export function envWithDotenv(configPath: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = join(dirname(configPath), ".env");
  if (!existsSync(file)) return env;
  return { ...parseEnv(readFileSync(file, "utf8")), ...env };
}

// A content hash rather than mtime: Linux (and WSL) stamps mtime from a coarse
// clock, so a same-size edit within a few ms looks unchanged. Both files are tiny.
const stamp = (path: string) => {
  if (!existsSync(path)) return "none";
  return createHash("sha1").update(readFileSync(path)).digest("hex");
};

/**
 * Returns a getter for the service that rebuilds it whenever leagues.json or
 * .env changes, so a re-copied espn_s2 or a new league needs no restart.
 */
export function serviceLoader(env: NodeJS.ProcessEnv = process.env): () => FantasyService {
  let cached: { key: string; service: FantasyService } | undefined;
  return () => {
    const configPath = resolveConfigPath(env);
    const key = [configPath, stamp(configPath), stamp(join(dirname(configPath), ".env"))].join(":");
    if (cached?.key !== key) {
      const service = FantasyService.fromEnv(envWithDotenv(configPath, env), configPath);
      cached = { key, service };
    }
    return cached.service;
  };
}

/**
 * First boot on a fresh volume: when LEAGUES_CONFIG names a file that doesn't
 * exist yet and LEAGUES_JSON holds its contents, validate and write it. Later
 * edits (set_league_rule) then persist on the volume. Returns the path written.
 */
export function seedConfig(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.LEAGUES_CONFIG;
  const json = env.LEAGUES_JSON;
  if (!path || !json || existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`LEAGUES_JSON isn't valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const parsed = LeaguesConfig.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid LEAGUES_JSON:\n${z.prettifyError(parsed.error)}`);
  mkdirSync(dirname(path), { recursive: true });
  saveConfig(parsed.data, path);
  return path;
}
