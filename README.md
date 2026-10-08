# espn-fantasy-mcp

A read-only [MCP](https://modelcontextprotocol.io) server and TypeScript client for ESPN fantasy football. It reads your rosters, matchups, free agents, league settings and league activity from ESPN's fantasy API, so any MCP-enabled assistant can give lineup and waiver advice without screenshots: Claude Code, Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI and others. It never makes moves; you make them in the ESPN app.

> **Status:** the ESPN client, core library and MCP server work and have been checked against live 2026 leagues. Lineup and waiver skills are next. See [STATUS.md](STATUS.md) for progress and [docs/design.md](docs/design.md) for the design.

```
packages/
  espn-client/   thin client for ESPN's undocumented fantasy v3 API (fetch + cookies), raw JSON → typed
  core/          zod schemas, leagues.json config, league rules discovery, domain functions
apps/
  mcp/           the MCP server (stdio)
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
pnpm smoke                            # builds, then checks every league live
```

Then connect your MCP client (below).

### ESPN cookies

Private leagues need two cookies from a browser session that's logged in to ESPN.

1. Log in at fantasy.espn.com in Chrome or Edge, then **open one of your leagues**. The fantasy home page doesn't set the cookies; they only show up once you're on a league page (a URL containing `leagueId=`).
2. Open dev tools (F12) and go to Application → Storage → Cookies → `https://fantasy.espn.com`.
3. Copy the values of `espn_s2` (long and URL-encoded; copy it exactly) and `SWID` (keep the `{…}` braces) into `.env`.

`espn_s2` expires every so often. A 401 from `pnpm smoke` means it's time to re-copy it. The cookies stay in `.env` on your machine, and `.env` is gitignored.

### League and team ids

Both are in the query string of ESPN's URLs.

- **League id:** open your league; it's the `leagueId=` value in the URL, e.g. `https://fantasy.espn.com/football/league?leagueId=12345678`.
- **Team id:** click your team (My Team); it's the `teamId=` value in that page's URL, e.g. `https://fantasy.espn.com/football/team?leagueId=12345678&teamId=4&seasonId=2026`. It's a small number (1–12 or so), separate from the league id.

If the team id is wrong, the error message lists every team in the league with its id.

## MCP server

| Tool | Returns |
| --- | --- |
| `list_leagues` | your leagues with alias, scoring format, waiver type and roster shape |
| `get_league_settings` | scoring, roster slots, waivers and FAAB left, lineup lock, trades, playoffs, standings, plus `missingRules` and `conflicts` |
| `get_my_roster` | starters, bench and IR with injury status, bye, projected and actual points, lock state |
| `get_matchup` | both starting lineups, scores and projected totals |
| `get_free_agents` | best available at a position by projection, free agent vs waivers |
| `get_recent_activity` | adds, drops, waiver claims with FAAB bids, trades |
| `set_league_rule` | saves a rule you confirmed to `leagues.json` (never writes to ESPN) |

`league` takes the alias from `leagues.json`. Every tool returns structured JSON plus the same JSON as text.

The server finds `leagues.json` by itself (set `LEAGUES_CONFIG` to put it somewhere else), and reads ESPN cookies from the `.env` next to it, so client configs only need the launch command and never contain cookies. Edits to either file are picked up on the next tool call, without a restart.

Run `pnpm build` first. Every client launches the same command:

```sh
node /absolute/path/to/espn-fantasy-mcp/apps/mcp/dist/index.js
```

**Claude Code:** the repo's [`.mcp.json`](.mcp.json) registers it for this project; approve it on first use. To use it from any directory, run `claude mcp add --scope user espn-fantasy -- node /absolute/path/to/espn-fantasy-mcp/apps/mcp/dist/index.js`.

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`), **Gemini CLI** (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "espn-fantasy": {
      "command": "node",
      "args": ["/absolute/path/to/espn-fantasy-mcp/apps/mcp/dist/index.js"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "espn-fantasy": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/espn-fantasy-mcp/apps/mcp/dist/index.js"]
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.espn-fantasy]
command = "node"
args = ["/absolute/path/to/espn-fantasy-mcp/apps/mcp/dist/index.js"]
```

Desktop apps don't always see the `node` from nvm. If the server won't start, set `command` to the full path that `which node` prints (Node 24 or later).

To try the tools without an assistant, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector): `npx @modelcontextprotocol/inspector node apps/mcp/dist/index.js`.

## Commands

| Command | Does |
| --- | --- |
| `pnpm build` | Build all packages and the MCP server |
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

Each key is a path into the settings output. The output also lists `missingRules` (ESPN didn't say: ask before advising) and `conflicts` (a stored value ESPN disagrees with: re-confirm it). The `set_league_rule` tool (`FantasyService.setLeagueRule`) writes these entries, and rejects a value that doesn't match the field's type.

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
