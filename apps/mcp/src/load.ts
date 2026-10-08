// Finds leagues.json and .env without help from the MCP client, so client
// configs hold only the launch command and never the cookies.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { FantasyService, findConfigPath } from "@espn-fantasy-mcp/core";

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

const stamp = (path: string) => {
  if (!existsSync(path)) return "none";
  const { mtimeMs, size } = statSync(path);
  return `${mtimeMs}/${size}`;
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
