# @nscaamano/espn-fantasy-core

Domain layer over ESPN fantasy football, built on [`@nscaamano/espn-fantasy-client`](https://www.npmjs.com/package/@nscaamano/espn-fantasy-client):

- **Zod schemas** for leagues, settings, rosters, matchups, free agents, transactions, pending claims and optimal lineups, with types inferred from them.
- **`FantasyService`**: your leagues from a `leagues.json`, with "my team" resolved, NFL bye weeks and kickoff times attached, and every league's matchup in one call.
- **League rules discovery**: ESPN's settings, with values you've confirmed stored as overrides, plus the rules that are still missing or conflict.
- **A lineup optimizer**: the highest-projected legal lineup, with the moves to get there and the risks to check.

```ts
import { FantasyService } from "@nscaamano/espn-fantasy-core";

// Reads ESPN_S2 and SWID from the environment, and leagues.json from LEAGUES_CONFIG
// or the nearest one above the working directory.
const service = FantasyService.fromEnv();
const lineup = await service.getOptimalLineup("my-league-alias");
```

It's read-only toward ESPN. ESPN's API is unofficial and can change without notice. Not affiliated with or endorsed by ESPN.

Source, docs and the MCP server built on it: [nscaamano/espn-fantasy-mcp](https://github.com/nscaamano/espn-fantasy-mcp). MIT licensed.
