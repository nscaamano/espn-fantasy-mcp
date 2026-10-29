# espn-fantasy-mcp

A read-only [MCP](https://modelcontextprotocol.io) server and TypeScript libraries for ESPN fantasy football. It reads your rosters, matchups, free agents, league settings and league activity from ESPN's fantasy API, so any MCP-enabled assistant can give lineup and waiver advice without screenshots: Claude Code, Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI and others. It never makes moves; you make them in the ESPN app.

> **Status:** the ESPN client, core library and MCP server work and have been checked against live 2026 leagues. The server runs locally over stdio or hosted over HTTP. The client and core are on npm. The lineup and waiver workflows are being tried on real weeks. See [STATUS.md](STATUS.md) for progress and [docs/design.md](docs/design.md) for the design.

```
packages/
  espn-client/   @nscaamano/espn-fantasy-client: thin client for ESPN's undocumented fantasy v3 API, raw JSON → typed
  core/          @nscaamano/espn-fantasy-core: zod schemas, leagues.json config, league rules, lineup optimizer, FantasyService
apps/
  mcp/           the MCP server: stdio for local clients, Streamable HTTP for hosted ones
skills/          weekly-check, waivers, trades and scoreboard workflows (Agent Skills; also served as MCP prompts)
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
| `get_my_roster` | starters, bench and IR with injury status and when ESPN last had news on the player, bye, this week's game (opponent, kickoff), projected and actual points, lock state |
| `get_optimal_lineup` | your best lineup by projection (slot eligibility, byes, OUT players, locks, pending claims), the moves to get there, and risks: a questionable starter with no late backup (flagged when the tag may be stale), a slot nobody can fill (with free agents and their claim or add deadline, or the queued claim that covers it), and a player left on IR who isn't IR-eligible. With a full roster, it also names a drop |
| `get_matchup` | both starting lineups, scores, projected totals and ESPN's win probability |
| `get_scoreboard` | your matchup in every league in one call; a league that can't be read is listed separately |
| `get_teams` | every team in a league: record, points, seed, waiver rank, FAAB left |
| `get_team_roster` | any team's roster, same shape as `get_my_roster` |
| `get_free_agents` | best available at a position by this week's or the season's projection, free agent vs waivers |
| `get_player` | any player by name (partial names work): who has him and in which slot, or free agent or on waivers (and when he clears), with status and projections |
| `get_recent_activity` | adds, drops, waiver claims with FAAB bids, trades |
| `get_pending_claims` | your queued waiver claims: add, drop, bid and when they process |
| `get_waiver_results` | how your claims fared in the latest waiver run: won, lost (to whom, for how much) or failed, and your waiver priority now |
| `set_league_rule` | saves a rule you confirmed to `leagues.json` (never writes to ESPN) |

`league` takes the alias from `leagues.json`. Every tool returns structured JSON plus the same JSON as text.

### Workflows: skills and prompts

The judgment lives in workflows in `skills/`. Each is a `SKILL.md` in the [Agent Skills](https://agentskills.io) format:

- **weekly-check:** flags injured, questionable, bye-week and zero-projection starters, checks the news, and gives start/sit moves per league. Run it before Thursday's game and again on Saturday or Sunday morning.
- **waivers:** finds roster holes, ranks free agents by fit, and gives FAAB bids or claim order with a named drop for every claim. Run it Monday night or Tuesday, before claims process.
- **trades:** finds trades both sides could plausibly accept. Fix mode fills a roster hole the waiver wire can't, from another team's surplus; opportunity mode looks for consolidation, buy-low and sell-high deals. Every proposal is valued rest of season under the league's own scoring and gets a fairness check. Run it on demand, or when weekly-check or waivers finds a hole no free agent fills.
- **scoreboard:** every league's matchup on one screen: a summary table with each side's score, top three scorers and projection, then each league's starters slot by slot. It shows status only, without advice. Use it during or after game windows.

How to run them:

- **Claude Code:** sees them automatically through symlinks in `.claude/skills/`. Ask for "a weekly check", "waiver run", "find me a trade" or "my scores", or invoke `/weekly-check`, `/waivers`, `/trades` or `/scoreboard`.
- **Other skills-capable clients:** point them at `skills/`.
- **Clients without skills:** use the MCP prompts `weekly_check`, `waivers`, `trades` and `scoreboard`, generated from the same files. Each takes an optional `league` argument.

Injury news needs the assistant's own web search; without it, the workflows say so and fall back to ESPN's tags.

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

### Remote hosting (HTTP)

The commands above use stdio: the client launches the server on your machine. Some clients can't do that, such as claude.ai custom connectors, which also reach the Claude mobile apps. For those, run the HTTP entry point on any host that runs Node 24 and serves HTTPS:

```sh
pnpm install && pnpm build
pnpm start                    # node apps/mcp/dist/serve.js
```

All configuration comes from environment variables:

| Variable | Meaning |
| --- | --- |
| `MCP_AUTH_TOKEN` | A random secret of at least 32 characters, e.g. from `openssl rand -hex 32`. Several can be listed, comma-separated (say, one per client), so each can be revoked alone. Required unless `MCP_TENANTS_DIR` is set. |
| `PORT` | Port to listen on (default 3000). |
| `ESPN_S2`, `SWID` | Your ESPN cookies. |
| `LEAGUES_CONFIG` | Path to `leagues.json`. Put it on persistent storage so rules saved with `set_league_rule` survive restarts. |
| `LEAGUES_JSON` | Contents of `leagues.json`, written to `LEAGUES_CONFIG` on first start if that file doesn't exist yet. |
| `MCP_TENANTS_DIR` | Optional: a folder for more people on the same server (below). |

Endpoints:

- `GET /health` returns `ok`. It needs no token and exposes no data, so it's safe for health checks.
- `/mcp/<token>` is the MCP endpoint, for clients that only take a URL, like claude.ai custom connectors.
- `/mcp` with an `Authorization: Bearer <token>` header serves clients that can send headers.
- Anything else, including a wrong token, gets an empty 404.

The server holds your ESPN cookies, so treat the token URL like a password: anyone with it can read your leagues. To revoke access, change `MCP_AUTH_TOKEN` and restart. The hosted server keeps its own copy of `leagues.json`, so rules saved through it don't show up in your local copy, and the reverse.

#### More than one person

One server can serve several people, each with their own leagues and ESPN cookies. The token decides whose data a request reads, so one person's token can't reach another person's leagues. Under `MCP_TENANTS_DIR`, add a folder per person:

```
$MCP_TENANTS_DIR/
  alex/
    leagues.json    # their leagues and team ids, same format as leagues.example.json
    .env            # ESPN_S2=…  SWID={…}  MCP_AUTH_TOKEN=…
```

- The server re-reads the folder on every request, so adding or removing someone needs no restart. Their `set_league_rule` saves go to their own `leagues.json`.
- A folder's `.env` is the only place its cookies come from. The server's own `ESPN_S2` and `SWID` never apply to it.
- The setup configured through the environment variables above keeps working alongside the folders.
- Problems such as a folder with no token, or a token shared by two people, are logged with the folder name, never the token. A shared token is turned off for both.

### Calling the tools from your own app

MCP doesn't need an AI model: the tools are plain function calls that return structured JSON. A web or mobile backend can call a hosted server directly with the MCP client SDK, and type the results with the schemas from `@nscaamano/espn-fantasy-core`. One server then holds the ESPN cookies, `leagues.json` and stored rules, and the assistant and the app always see the same data.

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Scoreboard } from "@nscaamano/espn-fantasy-core";

const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("https://your-host.example/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } },
  }),
);
const res = await client.callTool({ name: "get_scoreboard", arguments: {} });
const scoreboard = res.structuredContent as Scoreboard; // validated by the server against core's schema
```

Keep the token in server-side code only, never in a browser bundle, and put the app behind its own login.

## Use the libraries

The client and core are on npm, for apps that want to talk to ESPN directly instead of through the server:

```sh
pnpm add @nscaamano/espn-fantasy-core     # brings @nscaamano/espn-fantasy-client with it
```

```ts
import { FantasyService } from "@nscaamano/espn-fantasy-core";

// ESPN_S2 and SWID from the environment; leagues.json from LEAGUES_CONFIG or the nearest one up.
const service = FantasyService.fromEnv();
const lineup = await service.getOptimalLineup("my-league-alias");
```

Server-side only: the ESPN cookies must never reach a browser. Each package has its own README on npm.

## Commands

| Command | Does |
| --- | --- |
| `pnpm build` | Build all packages and the MCP server |
| `pnpm start` | Run the HTTP server (see Remote hosting) |
| `pnpm test` | Unit tests on recorded ESPN responses (offline) |
| `pnpm typecheck` | Type-check packages, tests and scripts |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm smoke [-- --league ppr --week 5 --position RB]` | Live check per league: settings, roster, matchup, top 10 free agents, recent activity |
| `pnpm audit` | Check dependencies for security advisories; run before releases and deploys |

To publish the libraries: bump the version in both `package.json` files, then run `pnpm publish` in `packages/espn-client` and then `packages/core`. pnpm replaces `workspace:*` with the real version. npm requires 2FA for publishing.

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
