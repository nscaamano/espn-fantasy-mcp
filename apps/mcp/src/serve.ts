#!/usr/bin/env node
// HTTP entry point for remote hosting. Configuration comes from the environment:
//   MCP_AUTH_TOKEN   the single-user setup's token(s), comma-separated, each ≥ 32 chars
//   MCP_TENANTS_DIR  optional: one folder per extra person (leagues.json + .env with
//                    ESPN_S2, SWID, MCP_AUTH_TOKEN); see tenants.ts
//   PORT             default 3000
//   ESPN_S2, SWID    ESPN cookies for the single-user setup (or a .env beside leagues.json)
//   LEAGUES_CONFIG   path to leagues.json, e.g. on a persistent volume
//   LEAGUES_JSON     contents to seed LEAGUES_CONFIG with when that file doesn't exist yet

import { seedConfig } from "./load.js";
import { createHttpServer } from "./http.js";
import { tenantSource } from "./tenants.js";

const port = Number(process.env.PORT ?? 3000);

try {
  const seeded = seedConfig();
  if (seeded) console.log(`Seeded ${seeded} from LEAGUES_JSON`);
  const source = tenantSource();
  const { tenants, errors } = source();
  for (const e of errors) console.error(`tenants: ${e}`);
  if (!tenants.length && !process.env.MCP_TENANTS_DIR) {
    throw new Error("Set MCP_AUTH_TOKEN (at least 32 characters), or MCP_TENANTS_DIR");
  }
  // Names only: tokens never reach the logs.
  console.log(`tenants: ${tenants.map((t) => t.name).join(", ") || "none yet"}`);
  const server = createHttpServer(source);
  server.listen(port, () => console.log(`espn-fantasy-mcp listening on :${port}`));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
