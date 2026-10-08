# espn-fantasy-mcp

A read-only ESPN fantasy football service for Claude. It reads your rosters, matchups, free agents, league settings and league activity from ESPN's fantasy API, so Claude can give lineup and waiver advice without screenshots. It never makes moves: you make them in the ESPN app.

> **Status:** the ESPN client and core library work and have been checked against live 2026 leagues. The MCP server is next. See [STATUS.md](STATUS.md) for progress and [docs/design.md](docs/design.md) for the design.

```
packages/
  espn-client/   thin client for ESPN's undocumented fantasy v3 API (fetch + cookies), raw JSON → typed
  core/          zod schemas, leagues.json config, league rules discovery, domain functions
scripts/
  smoke.ts                 live check against your leagues
  port_espn_constants.py   regenerates espn-client/src/constants.ts from espn-api
```

## Setup

Needs Node 24 (`nvm use`) and pnpm via corepack (`corepack enable`).

```sh
pnpm install
cp .env.example .env                  # add ESPN_S2 and SWID
cp leagues.example.json leagues.json  # add league and team ids
pnpm smoke
```

### ESPN cookies

Private leagues need two cookies from a browser session that's logged in to ESPN.

1. Log in at fantasy.espn.com in Chrome or Edge, then open dev tools (F12).
2. Go to Application → Storage → Cookies → `https://fantasy.espn.com`.
3. Copy the values of `espn_s2` (long and URL-encoded; copy it exactly) and `SWID` (keep the `{…}` braces) into `.env`.

`espn_s2` expires every so often. A 401 from `pnpm smoke` means it's time to re-copy it. The cookies stay in `.env` on your machine, and `.env` is gitignored.

### League and team ids

- **League id:** the `leagueId=` number in your league's URL.
- **Team id:** the `teamId=` number on your team page.

If the team id is wrong, the error message lists every team in the league with its id.

## Commands

| Command | Does |
| --- | --- |
| `pnpm build` | Build all packages |
| `pnpm test` | Unit tests on recorded ESPN responses (offline) |
| `pnpm typecheck` | Type-check packages, tests and scripts |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm smoke [-- --league ppr --week 5 --position RB]` | Live check per league: settings, roster, matchup, top 10 free agents, recent activity |

## League rules

Advice depends on each league's rules (FAAB or priority waivers, PPR or half-PPR, superflex, lineup lock, trade deadline and so on). `getLeagueSettings` reads them from ESPN first, then applies any values stored in the league's `rules` block in `leagues.json`, which win:

```json
"rules": {
  "waivers.type": { "value": "PRIORITY", "source": "user", "confirmed": "2026-10-07" }
}
```

Each key is a path into the settings output. The output also lists `missingRules` (ESPN didn't say: ask before advising) and `conflicts` (a stored value ESPN disagrees with: re-confirm it). `FantasyService.setLeagueRule` writes these entries.

## Updating ESPN constants

ESPN's API is undocumented. Request shapes and ID mappings follow [cwendt94/espn-api](https://github.com/cwendt94/espn-api). When an espn-api release mentions an ESPN API change, regenerate the constants from a clone of it:

```sh
python3 -I scripts/port_espn_constants.py path/to/espn-api/espn_api/football/constant.py "$(git -C path/to/espn-api log -1 --format=%h)" \
  > packages/espn-client/src/constants.ts
```

## Disclaimer

Not affiliated with or endorsed by ESPN. This uses ESPN's private, undocumented API, which can change without notice. Use it only with leagues and accounts you have access to.

## License

[MIT](LICENSE). Includes constants and test fixtures derived from [espn-api](https://github.com/cwendt94/espn-api); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
