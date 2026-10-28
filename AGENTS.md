# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, Gemini CLI and others) working in this repo. `CLAUDE.md` imports this file.

Read-only ESPN fantasy football service, exposed as an MCP server that should work with any MCP client (Claude Code is the primary one). The assistant reads rosters, matchups, free agents and league activity through it and recommends moves; the user makes them in the ESPN app.

**Start here:**
- `docs/design.md` is the source of truth for scope, architecture, the MCP tool list, skill specs and the trades design.
- `STATUS.md` holds what's done, what's next and open questions. It's the handoff between sessions and machines (agent memory doesn't travel), so update it when a step or notable task finishes.

**This repo is public.** Keep these out of tracked files: personal league or team names, league ids, cookies, and plans for the hosted web app (which lives in a separate private repo). A private build plan, architecture notes and deployment runbooks (`*.private.md`) may sit untracked in `docs/` (or the repo root), excluded via `.git/info/exclude` rather than `.gitignore` so their names stay out of the public repo. Read them for context if present, but never commit them or copy them into tracked files. If they're copied to a new clone, add them to that clone's `.git/info/exclude` first.

## Fresh clone / new machine

```sh
nvm install 24 && nvm use        # .nvmrc pins 24; pnpm 11 needs Node >= 22.13
corepack enable                  # provides pnpm@11.8.0 from package.json "packageManager"
pnpm install && pnpm build && pnpm test
```

If `corepack enable` fails on permissions, use `npm i -g pnpm@11` instead.

Some files never travel through git, so copy them from the other machine by hand (USB, password manager), never through chat or a commit:

- `.env`: ESPN cookies.
- `leagues.json`: league ids, team ids, stored rules.
- Any private notes: the build plan, architecture notes, `*.private.md` runbooks. In the new clone, add their names and `*.private.md` to `.git/info/exclude` first.

`.env` and `leagues.json` are gitignored, so a clone doesn't have them. Either copy both from the other machine, or recreate them from `.env.example` and `leagues.example.json` following the README. Never ask the user to paste cookie values into chat: they edit `.env` themselves. Then run `pnpm smoke` to confirm live access.

The repo's `.mcp.json` launches `apps/mcp/dist/index.js`, so build before starting a Claude Code session there, and approve the `espn-fantasy` server when asked. A session that's already running keeps the old build after `pnpm build`, so reconnect it with `/mcp` → Reconnect to pick up changes. New skills only load when a session starts.

## Commands

Node 24 is required; the shell's default Node may differ, so run `nvm use` first. Agent shells are non-interactive and don't load nvm, so prefix commands with `source ~/.nvm/nvm.sh && nvm use &&`. pnpm 11 comes from corepack.

```sh
pnpm build        # tsc -b in every package (core depends on espn-client's dist)
pnpm test         # vitest, offline, against recorded fixtures
pnpm typecheck    # packages + tests + scripts
pnpm lint         # eslint
pnpm format       # prettier
pnpm smoke        # LIVE: hits ESPN for every league in leagues.json; needs .env
```

To exercise the MCP server without a chat client (LIVE, after `pnpm build`):

```sh
npx @modelcontextprotocol/inspector --cli node apps/mcp/dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli node apps/mcp/dist/index.js --method tools/call \
  --tool-name get_my_roster --tool-arg league=<alias>
```

To exercise the HTTP entry point locally (LIVE):

```sh
MCP_AUTH_TOKEN=$(openssl rand -hex 32) PORT=3999 pnpm start   # in one shell
npx @modelcontextprotocol/inspector --cli "http://localhost:3999/mcp/<token>" --transport http --method tools/list
```

Before calling a change done, run build, typecheck, lint and test. CI (`.github/workflows/ci.yml`) runs the same on every push and pull request. Run `pnpm smoke` when a change touches parsing or requests, since fixtures are from 2018–2019 and the live shapes can drift.

## Layout and boundaries

- `packages/espn-client`: the only code that knows ESPN's JSON. `raw.ts` holds the response shapes, `parse.ts` the pure parsers, `client.ts` the requests, `types.ts` the typed output. Nothing outside this package imports raw shapes.
- `packages/core`: zod schemas (`schemas.ts`) are the contract every adapter uses. `map.ts` maps client types to schemas, `rules.ts` handles league rules discovery, `service.ts` (`FantasyService`) holds the domain functions, and `config.ts` loads `leagues.json`.
- `apps/mcp`: a thin MCP adapter over `FantasyService` (SDK v2, `@modelcontextprotocol/server`). Tool descriptions must make sense to any model, not just Claude.
  - `server.ts` registers the tools and prompts.
  - `load.ts` finds `leagues.json` and `.env`, and `seedConfig` writes `LEAGUES_JSON` to `LEAGUES_CONFIG` on first start.
  - `index.ts` is the stdio entry.
  - `http.ts` is the HTTP server: the token check (path or bearer), `/health`, and a bridge to the SDK's `createMcpHandler`. `serve.ts` is its entry point, run by `pnpm start`.
  - `tenants.ts` maps tokens to people: the environment's setup plus one folder per person under `MCP_TENANTS_DIR`. A folder tenant must never inherit the server's `ESPN_S2`/`SWID` (`folderTenantEnv`).
- `skills/<name>/SKILL.md`: lineup and waiver judgment lives here, not in code. Core has no opinions. Each file is the single source for two forms:
  - Claude Code loads it through the `.claude/skills/<name>` symlink.
  - `apps/mcp/src/skills.ts` serves the same text as an MCP prompt (`weekly-check` becomes `weekly_check`).
  - A test fails if a skill names a tool the server doesn't have.
  - Edit the `SKILL.md` and both forms follow. Add a symlink for a new skill.

## Rules

- **Read-only toward ESPN.** No write calls. The only thing the service writes is `leagues.json`, via `setLeagueRule`.
- **Secrets:** `ESPN_S2` and `SWID` come from `.env` and must never be logged, returned in tool output, or committed. `.env` and `leagues.json` are gitignored and must stay that way. Only `*.example*` templates are tracked.
- **Port, don't reinvent.** Request shapes (views, `x-fantasy-filter` headers) follow cwendt94/espn-api. `constants.ts` is generated by `scripts/port_espn_constants.py`, so regenerate it rather than hand-editing.
- **Stored rules override ESPN.** Rule keys in `RULE_KEYS` are dotted paths into `LeagueSettings`. Add a new rule by adding its path there.
- **Compact output.** Tool payloads cost tokens, so keep schemas lean and never pass raw ESPN JSON through.
- **Hosting-agnostic.** Don't put provider-specific deploy config or docs in tracked files: no `railway.json`, `fly.toml` or provider names. The repo documents the generic contract (`pnpm start`, the environment variables, `/health`). A particular deployment's runbook belongs in an untracked private note (`*.private.md` is excluded via `.git/info/exclude`), and its settings live on the host.
- **The HTTP token is a password.** Never log it or echo it into tracked files. `http.ts` strips it from the URL and headers before the MCP handler sees the request.

## Conventions

- ESM throughout, so relative imports use the `.js` suffix. Strict TS with `noUncheckedIndexedAccess`. Packages are `@nscaamano/espn-fantasy-client`, `-core` and `-mcp`. The client and core are set up for npm (`publishConfig`, a `prepack` that copies LICENSE, and THIRD_PARTY_NOTICES for the client). Publish with `pnpm publish` from the package folder, so `workspace:*` becomes a real version. Bump both versions together. The MCP server stays private until it can find `skills/` without the repo.
- TypeScript is pinned to 6.0 because typescript-eslint doesn't support 7 yet. zod is v4 (`z.partialRecord`, `z.prettifyError`).
- Parsers return `null` for "ESPN didn't say", never a guessed default. Rules discovery depends on that difference.
- Tests: parser tests use `packages/espn-client/test/fixtures/`. Service and MCP tests use `fixtureFetch()`, which routes requests to fixtures by `view`; MCP tests connect a real client over `InMemoryTransport`. No network in unit tests. Use generic names in tests (no real leagues).
- Scripts in `scripts/*.ts` run with Node's native type stripping (`node scripts/x.ts`), so use erasable TS syntax only (no enums or parameter properties).
