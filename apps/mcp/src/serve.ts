#!/usr/bin/env node
// HTTP entry point for remote hosting. Configuration comes from the environment:
//   MCP_AUTH_TOKEN   required; the shared secret clients present (≥ 32 chars)
//   PORT             default 3000
//   ESPN_S2, SWID    ESPN cookies (or a .env beside leagues.json)
//   LEAGUES_CONFIG   path to leagues.json, e.g. on a persistent volume
//   LEAGUES_JSON     contents to seed LEAGUES_CONFIG with when that file doesn't exist yet

import { seedConfig, serviceLoader } from "./load.js";
import { createHttpServer } from "./http.js";

const token = process.env.MCP_AUTH_TOKEN ?? "";
const port = Number(process.env.PORT ?? 3000);

try {
  const seeded = seedConfig();
  if (seeded) console.log(`Seeded ${seeded} from LEAGUES_JSON`);
  const server = createHttpServer(serviceLoader(), { token });
  server.listen(port, () => console.log(`espn-fantasy-mcp listening on :${port}`));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
