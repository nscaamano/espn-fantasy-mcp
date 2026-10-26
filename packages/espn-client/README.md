# @nscaamano/espn-fantasy-client

A small, read-only TypeScript client for ESPN fantasy football's undocumented v3 API. It covers league settings, rosters (one team or all), matchups, free agents, recent activity, pending waiver claims and the NFL schedule, and turns ESPN's raw JSON into typed objects.

Most apps want [`@nscaamano/espn-fantasy-core`](https://www.npmjs.com/package/@nscaamano/espn-fantasy-core) instead, which adds zod schemas, league rules discovery and a lineup optimizer on top of this client.

```ts
import { EspnClient } from "@nscaamano/espn-fantasy-client";

// Private leagues need the espn_s2 and SWID cookies from a logged-in browser.
const client = new EspnClient({ espnS2: process.env.ESPN_S2, swid: process.env.SWID });
const settings = await client.getLeagueSettings(12345678, 2026);
```

Request shapes and ID mappings follow [cwendt94/espn-api](https://github.com/cwendt94/espn-api); see `THIRD_PARTY_NOTICES.md`. ESPN's API is unofficial and can change without notice. Not affiliated with or endorsed by ESPN.

Source, docs and the MCP server built on it: [nscaamano/espn-fantasy-mcp](https://github.com/nscaamano/espn-fantasy-mcp). MIT licensed.
