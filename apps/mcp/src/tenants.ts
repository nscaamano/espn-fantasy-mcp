// Several people on one HTTP server, each with their own leagues and ESPN
// cookies. A request's token decides whose data it reads, so one person's
// token can never reach another person's leagues.
//
// Two sources, usable together:
// - The environment (the single-user setup): MCP_AUTH_TOKEN, plus ESPN_S2/SWID
//   and LEAGUES_CONFIG (or a .env beside leagues.json).
// - MCP_TENANTS_DIR: one folder per person, <dir>/<name>/leagues.json and
//   <dir>/<name>/.env holding that person's ESPN_S2, SWID and MCP_AUTH_TOKEN.
//   Folders are re-read on every request, so adding a person needs no restart.
//
// MCP_AUTH_TOKEN may list several comma-separated tokens (e.g. one for an app,
// one for a Claude connector), so each can be revoked on its own.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { FantasyService } from "@nscaamano/espn-fantasy-core";
import { serviceLoader } from "./load.js";

export const MIN_TOKEN_LENGTH = 32;
/** The name of the person configured through the environment. */
export const ENV_TENANT = "default";

export interface Tenant {
  name: string;
  tokens: string[];
  service: () => FantasyService;
}

/** Every tenant right now. Errors are configuration problems to log, not fatal. */
export interface TenantList {
  tenants: Tenant[];
  errors: string[];
}

export type TenantSource = () => TenantList;

/** Comma-separated tokens; any shorter than MIN_TOKEN_LENGTH are rejected. */
export function parseTokens(value: string | undefined): { tokens: string[]; short: number } {
  const all = (value ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const tokens = all.filter((t) => t.length >= MIN_TOKEN_LENGTH);
  return { tokens, short: all.length - tokens.length };
}

/**
 * The variables a folder tenant's service sees: only where its leagues.json is
 * and the ESPN base URL. Never the server's own environment, or the server
 * owner's ESPN_S2/SWID would override the folder's .env and this person's
 * requests would run on someone else's cookies.
 */
export function folderTenantEnv(folder: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scoped: NodeJS.ProcessEnv = { LEAGUES_CONFIG: join(folder, "leagues.json") };
  if (env.ESPN_BASE_URL) scoped.ESPN_BASE_URL = env.ESPN_BASE_URL;
  return scoped;
}

/** Tenants from the environment and MCP_TENANTS_DIR, re-read on every call. */
export function tenantSource(env: NodeJS.ProcessEnv = process.env): TenantSource {
  const envLoader = serviceLoader(env);
  // One loader per folder, kept across calls so its service cache survives.
  const folderLoaders = new Map<string, () => FantasyService>();

  return () => {
    const tenants: Tenant[] = [];
    const errors: string[] = [];

    if (env.MCP_AUTH_TOKEN) {
      const { tokens, short } = parseTokens(env.MCP_AUTH_TOKEN);
      if (short)
        errors.push(`${ENV_TENANT}: ${short} token(s) shorter than ${MIN_TOKEN_LENGTH} ignored`);
      if (tokens.length) tenants.push({ name: ENV_TENANT, tokens, service: envLoader });
    }

    const dir = env.MCP_TENANTS_DIR;
    if (dir && existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const folder = join(dir, entry.name);
        const dotenv = join(folder, ".env");
        if (!existsSync(dotenv)) {
          errors.push(`${entry.name}: no .env`);
          continue;
        }
        const { tokens, short } = parseTokens(
          parseEnv(readFileSync(dotenv, "utf8")).MCP_AUTH_TOKEN,
        );
        if (short)
          errors.push(`${entry.name}: ${short} token(s) shorter than ${MIN_TOKEN_LENGTH} ignored`);
        if (!tokens.length) {
          errors.push(`${entry.name}: no MCP_AUTH_TOKEN in .env`);
          continue;
        }
        let loader = folderLoaders.get(folder);
        if (!loader) {
          loader = serviceLoader(folderTenantEnv(folder, env));
          folderLoaders.set(folder, loader);
        }
        tenants.push({ name: entry.name, tokens, service: loader });
      }
    } else if (dir) {
      errors.push(`MCP_TENANTS_DIR ${dir} doesn't exist`);
    }

    // A token shared by two tenants is ambiguous, so neither gets it.
    const owners = new Map<string, string[]>();
    for (const t of tenants)
      for (const tok of t.tokens) owners.set(tok, [...(owners.get(tok) ?? []), t.name]);
    for (const [tok, names] of owners) {
      if (names.length < 2) continue;
      errors.push(`a token is shared by ${names.join(" and ")}; it's disabled for both`);
      for (const t of tenants) t.tokens = t.tokens.filter((x) => x !== tok);
    }
    return { tenants, errors };
  };
}

/** A fixed tenant list, for tests and embedding. */
export function staticTenants(tenants: Tenant[]): TenantSource {
  return () => ({ tenants, errors: [] });
}
