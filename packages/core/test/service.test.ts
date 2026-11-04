import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EspnClient } from "@nscaamano/espn-fantasy-client";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../../espn-client/test/fixtures.js";
import { loadConfig, type LeaguesConfig } from "../src/config.js";
import { toPendingClaim } from "../src/map.js";
import { FantasyService } from "../src/service.js";

const config = (myTeamId = 2): LeaguesConfig => ({
  leagues: [{ alias: "test", leagueId: 1234, year: 2018, myTeamId, rules: {} }],
});

function service(myTeamId = 2) {
  const { fetch, calls } = fixtureFetch();
  return { svc: new FantasyService(new EspnClient({ fetch }), config(myTeamId)), calls };
}

describe("FantasyService", () => {
  it("lists leagues with format and roster shape", async () => {
    const [league] = await service().svc.listLeagues();
    expect(league).toMatchObject({
      alias: "test",
      myTeamId: 2,
      size: 10,
      scoringFormat: "PPR",
      waiverType: "PRIORITY",
      superflex: false,
      hasDst: true,
      hasK: true,
    });
  });

  it("resolves leagues by alias case-insensitively, and explains unknown ones", async () => {
    const { svc } = service();
    await expect(svc.getLeagueSettings("TEST")).resolves.toMatchObject({ league: "test" });
    await expect(svc.getLeagueSettings("nope")).rejects.toThrow(/Known leagues: test/);
  });

  it("returns settings with rules sources and my waiver rank", async () => {
    const s = await service().svc.getLeagueSettings("test");
    expect(s.roster).toMatchObject({ benchSize: 6, irSlots: 0, slots: { QB: 1, FLEX: 1 } });
    expect(s.waivers).toMatchObject({ type: "PRIORITY", myWaiverRank: 5, faabRemaining: null });
    expect(s.ruleSources["scoring.receptionPoints"]).toBe("espn");
    expect(s.teams.filter((t) => t.isMine).map((t) => t.id)).toEqual([2]);
  });

  it("rejects a myTeamId that isn't in the league", async () => {
    await expect(service(99).svc.getLeagueSettings("test")).rejects.toThrow(
      /myTeamId 99 isn't in test/,
    );
  });

  it("splits my roster into starters, bench and IR with bye weeks", async () => {
    const roster = await service(1).svc.getMyRoster("test", 1);
    expect(roster.teamName).toBe("Goin' HAM Newton");
    expect(roster.starters.map((s) => s.slot)).toEqual([
      "QB",
      "RB",
      "RB",
      "WR",
      "WR",
      "TE",
      "FLEX",
      "D/ST",
      "K",
    ]);
    expect(roster.bench).toHaveLength(6);
    const brown = roster.starters.find((s) => s.player.name === "Antonio Brown")!;
    expect(brown.player).toMatchObject({
      proTeam: "PIT",
      injuryStatus: "ACTIVE",
      byeWeek: 9,
      // Fixture schedule is the 2024 one: PIT at ATL, week 1.
      game: { opponent: "ATL", home: false, kickoff: "2024-09-08T17:00:00.000Z" },
    });
    expect(brown.player.eligibleSlots).not.toContain("BE");
  });

  it("gives players no game in a week the schedule doesn't cover", async () => {
    const roster = await service(1).svc.getMyRoster("test", 2);
    expect(roster.starters.every((s) => s.player.game === null)).toBe(true);
  });

  it("returns my matchup with both starting lineups", async () => {
    const m = await service(11).svc.getMatchup("test", 13);
    expect(m.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.week).toBe(13);
    expect(m.me).toMatchObject({ teamId: 11, score: 128 });
    expect(m.opponent).toMatchObject({ teamId: 2, score: 151.8 });
    expect(m.me.starters.every((s) => s.slot !== "BE")).toBe(true);
  });

  it("sorts free agents by projection and trims to the limit", async () => {
    const { svc, calls } = service();
    const fas = await svc.getFreeAgents("test", "WR", 5, 1);
    expect(fas).toHaveLength(5);
    const proj = fas.map((f) => f.projectedPoints ?? -1);
    expect(proj).toEqual([...proj].sort((a, b) => b - a));
    expect(fas[0]).toMatchObject({ status: "FREE_AGENT" });
    // Asks ESPN for a wider pool than the limit, to re-sort by projection.
    const req = calls.find((c) => c.url.searchParams.getAll("view").includes("kona_player_info"))!;
    expect(JSON.parse(req.headers["x-fantasy-filter"]!).players.limit).toBe(50);
  });

  it("looks up a rostered player with his team and slot", async () => {
    const { svc, calls } = service();
    const found = await svc.getPlayer("test", "Antonio Brown", 5, 1);
    expect(found).toMatchObject({
      league: "test",
      query: "Antonio Brown",
      week: 1,
      totalMatches: 1,
    });
    expect(found.players[0]).toMatchObject({
      name: "Antonio Brown",
      status: "ROSTERED",
      team: { id: 1, name: "Goin' HAM Newton", slot: "WR", isMine: false },
      projectedPoints: 18.5,
      actualPoints: 22.4,
      seasonPoints: 323.7,
      positionalRank: 3,
      waiverClears: null,
      game: { opponent: "ATL" },
    });
    // The slot comes from the owner's roster alone.
    const rosterReqs = calls.filter((c) => c.url.searchParams.getAll("view").includes("mRoster"));
    expect(rosterReqs.map((c) => c.url.searchParams.get("forTeamId"))).toEqual(["1"]);
  });

  it("returns every player sharing a name, marking the user's", async () => {
    const found = await service(2).svc.getPlayer("test", "pat sample", 5, 1);
    expect(found.totalMatches).toBe(2);
    expect(found.players.map((p) => [p.position, p.status, p.team])).toEqual([
      ["RB", "FREE_AGENT", null],
      // Not on team 2's fixture roster, so the slot is unknown.
      ["TE", "ROSTERED", { id: 2, name: expect.any(String), slot: null, isMine: true }],
    ]);
  });

  it("reports when a waiver player clears, and trims a partial name's matches", async () => {
    const svc = service().svc;
    const [tester] = (await svc.getPlayer("test", "AJ Tester", 5, 1)).players;
    expect(tester).toMatchObject({
      status: "WAIVERS",
      team: null,
      waiverClears: "2018-09-11T08:00:00.000Z",
      injuryStatus: "QUESTIONABLE",
    });
    const pat = await svc.getPlayer("test", "Pat", 2, 1);
    expect(pat.players).toHaveLength(2);
    expect(pat.totalMatches).toBe(3);
  });

  it("attaches each match's latest news", async () => {
    const [brown] = (await service().svc.getPlayer("test", "Antonio Brown", 5, 1)).players;
    expect(brown!.news).toEqual({
      headline: expect.stringMatching(/^When asked whether Receiver/),
      story: expect.stringMatching(/inactive for Sunday/),
      published: "2026-11-02T16:43:16Z",
    });
  });

  it("returns recent news for named players, and says which names matched nobody", async () => {
    const { svc, calls } = service();
    const news = await svc.getPlayerNews(
      "test",
      ["Antonio Brown", "pat sample", "Nobody Atall"],
      2,
    );
    expect(news.notFound).toEqual(["Nobody Atall"]);
    expect(news.players.map((p) => [p.query, p.name, p.otherMatches])).toEqual([
      ["Antonio Brown", "Antonio Brown", 0],
      // Two players share the name: the most rostered is used, and it says so.
      ["pat sample", "Pat Sample", 1],
    ]);
    expect(news.players[0]!.news.map((n) => n.published)).toEqual([
      "2026-11-02T16:43:16Z",
      "2026-10-31T17:07:17Z",
    ]);
    expect(
      calls
        .filter((c) => c.url.pathname.includes("/news/"))
        .map((c) => c.url.searchParams.get("playerId")),
    ).toEqual(["13934", expect.any(String)]);
  });

  it("returns no players for an unknown name", async () => {
    const found = await service().svc.getPlayer("test", "Nobody Atall", 5, 1);
    expect(found).toMatchObject({ players: [], totalMatches: 0 });
  });

  it("maps injury statuses to the schema's enum", async () => {
    const fas = await service().svc.getFreeAgents("test", "WR", 8, 1);
    const statuses = new Set(fas.map((f) => f.injuryStatus));
    expect(statuses.has("IR")).toBe(true);
    expect([...statuses].every((s) => ["ACTIVE", "QUESTIONABLE", "OUT", "IR"].includes(s))).toBe(
      true,
    );
  });

  it("names teams in recent activity", async () => {
    const tx = await service().svc.getRecentActivity("test", 6);
    expect(tx).toHaveLength(6);
    expect(tx[0]!.items[0]).toMatchObject({ action: "ADD", team: expect.any(String) });
    expect(tx[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops ESPN's placeholder $0 bids in a priority-waiver league", async () => {
    const tx = await service().svc.getRecentActivity("test", 6);
    expect(tx[5]!.items[0]).toMatchObject({ action: "WAIVER_ADD", bid: null });
  });

  it("caches league settings between calls", async () => {
    const { svc, calls } = service();
    await svc.getLeagueSettings("test");
    await svc.getLeagueSettings("test");
    expect(
      calls.filter((c) => c.url.searchParams.getAll("view").includes("mSettings")),
    ).toHaveLength(1);
  });

  it("saves a confirmed rule to leagues.json and applies it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
    const path = join(dir, "leagues.json");
    writeFileSync(path, JSON.stringify(config()));
    const { fetch } = fixtureFetch();
    const svc = new FantasyService(new EspnClient({ fetch }), loadConfig(path), {
      configPath: path,
      now: () => new Date("2026-10-07T12:00:00Z"),
    });

    svc.setLeagueRule("test", "waivers.type", "FAAB", "user");

    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.leagues[0].rules["waivers.type"]).toEqual({
      value: "FAAB",
      source: "user",
      confirmed: "2026-10-07",
    });
    const s = await svc.getLeagueSettings("test");
    expect(s.waivers.type).toBe("FAAB");
    expect(s.conflicts).toHaveLength(1);
  });

  it("rejects a rule value that doesn't fit the settings schema, without saving it", () => {
    const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
    const path = join(dir, "leagues.json");
    writeFileSync(path, JSON.stringify(config()));
    const { fetch } = fixtureFetch();
    const svc = new FantasyService(new EspnClient({ fetch }), loadConfig(path), {
      configPath: path,
    });

    expect(() => svc.setLeagueRule("test", "waivers.type", "faab", "user")).toThrow(
      /Invalid value for waivers.type/,
    );
    expect(() => svc.setLeagueRule("test", "waivers.faabBudget", null, "user")).toThrow(
      /Invalid value/,
    );
    expect(svc.setLeagueRule("test", "roster.slots", { QB: 1, OP: 1 }, "upload")).toMatchObject({
      value: { QB: 1, OP: 1 },
      source: "upload",
    });
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).leagues[0].rules)).toEqual([
      "roster.slots",
    ]);
  });
});

describe("FantasyService.getWaiverResults", () => {
  it("reports my claims in the latest run, in a priority league, with my waiver rank", async () => {
    const { svc, calls } = service(2);
    const r = await svc.getWaiverResults("test", 8);
    expect(calls.some((c) => c.url.searchParams.get("scoringPeriodId") === "8")).toBe(true);
    expect(r).toMatchObject({
      league: "test",
      week: 8,
      processedAt: "2026-10-28T07:20:36.575Z",
      usesFaab: false,
      waiverRank: 5,
    });
    expect(r.claims.map((c) => [c.result, c.add?.name, c.wonBy?.team ?? c.reason])).toEqual([
      ["WON", "James Conner", null],
      ["LOST", "Player 101", "Watch What You Saquon"],
      ["FAILED", "Player 102", "FAILED_ROSTERLIMIT"],
      ["CANCELED", "Player 103", null],
    ]);
    // Priority league: no bids, not even the winner's.
    expect(r.claims.every((c) => c.bid === null && (c.wonBy?.bid ?? null) === null)).toBe(true);
  });
});

describe("FantasyService.getFaabPrices", () => {
  /** The fixtures as a FAAB league, with a card (a QB) for the player team 5 won. */
  const faabLeague = () => {
    const { fetch, calls } = fixtureFetch();
    const wrapped: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const views = new URL(String(input)).searchParams.getAll("view");
      if (views.includes("mSettings")) {
        const body = (await res.json()) as {
          settings: { acquisitionSettings: { isUsingAcquisitionBudget: boolean } };
        };
        body.settings.acquisitionSettings.isUsingAcquisitionBudget = true;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (views.includes("kona_playercard")) {
        const body = (await res.json()) as { players: unknown[] };
        body.players.push({
          id: 101,
          player: { id: 101, fullName: "Sample Passer", defaultPositionId: 1, proTeamId: 1 },
        });
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return res;
    };
    const svc = new FantasyService(new EspnClient({ fetch: wrapped }), config(2));
    const logRequests = () =>
      calls.filter((c) => c.url.searchParams.getAll("view").includes("mTransactions2"));
    return { svc, logRequests };
  };

  it("prices winning bids by position over the last five weeks, with the runner-up", async () => {
    const { svc, logRequests } = faabLeague();
    const prices = await svc.getFaabPrices("test");
    // The fixture league is in week 16; every week serves the same log, counted once.
    expect(logRequests().map((c) => c.url.searchParams.get("scoringPeriodId"))).toEqual([
      "12",
      "13",
      "14",
      "15",
      "16",
    ]);
    expect(prices).toMatchObject({
      league: "test",
      usesFaab: true,
      budget: 100,
      minimumBid: 1,
      fromWeek: 12,
      toWeek: 16,
      // Player 105's card is missing, so his win has no position and isn't counted.
      all: { wins: 2, contested: 1, median: 22.5, min: 5, max: 40 },
    });
    expect(prices.positions.map((p) => [p.position, p.wins, p.median])).toEqual([
      ["QB", 1, 40],
      ["RB", 1, 5],
    ]);
    expect(prices.positions[0]!.bids).toEqual([
      {
        player: "Sample Passer",
        proTeam: "ATL",
        week: 12,
        bid: 40,
        runnerUp: 26,
        bidders: 3,
        team: "Watch What You Saquon",
      },
    ]);
  });

  it("caches past weeks' logs and refetches only the current week", async () => {
    const { svc, logRequests } = faabLeague();
    await svc.getFaabPrices("test", 3);
    await svc.getFaabPrices("test", 3);
    expect(logRequests().map((c) => c.url.searchParams.get("scoringPeriodId"))).toEqual([
      "14",
      "15",
      "16",
      "16",
    ]);
    // weeks is clamped to the season's start.
    await expect(svc.getFaabPrices("test", 18, "RB")).resolves.toMatchObject({
      fromWeek: 1,
      positions: [{ position: "RB", wins: 1 }],
    });
  });

  it("gives counts without bids in a priority league", async () => {
    const prices = await service(2).svc.getFaabPrices("test", 1);
    expect(prices).toMatchObject({ usesFaab: false, budget: null, minimumBid: null });
    expect(prices.all).toEqual({ wins: 1, contested: 0, median: null, min: null, max: null });
    expect(prices.positions).toEqual([
      { position: "RB", wins: 1, contested: 0, median: null, min: null, max: null, bids: [] },
    ]);
  });
});

describe("FantasyService.getPendingClaims", () => {
  it("returns my queued claims with ISO times and no bid in a priority league", async () => {
    const claims = await service(1).svc.getPendingClaims("test");
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual({
      type: "WAIVER",
      add: { name: "Player 4571557", position: null, proTeam: null },
      drop: { name: "Player 4034949", position: null, proTeam: null, slot: "K" },
      bid: null,
      proposedAt: "2026-10-13T18:07:18.126Z",
      processesAt: "2026-10-14T07:00:00.000Z",
    });
  });

  it("returns an empty list when only other teams have claims", async () => {
    await expect(service(2).svc.getPendingClaims("test")).resolves.toEqual([]);
  });

  it("keeps the bid in a FAAB league", () => {
    const claim = toPendingClaim(
      {
        id: null,
        type: "WAIVER",
        teamId: 1,
        bid: 5,
        proposedDate: null,
        processDate: null,
        add: null,
        drop: null,
      },
      true,
    );
    expect(claim).toMatchObject({ bid: 5, add: null, drop: null, processesAt: null });
  });
});

describe("FantasyService across leagues and teams", () => {
  it("returns every league's matchup, and lists a league that fails instead of throwing", async () => {
    const { fetch } = fixtureFetch();
    const svc = new FantasyService(new EspnClient({ fetch }), {
      leagues: [
        { alias: "one", leagueId: 1, year: 2018, myTeamId: 11, rules: {} },
        // Team 99 has no matchup in the fixture, like a bye week.
        { alias: "two", leagueId: 2, year: 2018, myTeamId: 99, rules: {} },
      ],
    });
    const board = await svc.getScoreboard(13);
    expect(board.matchups.map((m) => m.league)).toEqual(["one"]);
    expect(board.matchups[0]!.me.teamId).toBe(11);
    expect(board.errors).toEqual([{ league: "two", error: expect.stringMatching(/No matchup/) }]);
  });

  it("plans bye coverage from the roster's bye weeks, from the current week by default", async () => {
    const { svc, calls } = service(1);
    // The 2018 fixture's current week is its last (16), so the default range is that week alone.
    const byDefault = await svc.getByeCoverage("test");
    expect(byDefault).toMatchObject({ league: "test", fromWeek: 16, toWeek: 16 });
    expect(byDefault.weeks.map((w) => w.week)).toEqual([16]);

    const out = await svc.getByeCoverage("test", 5, 14);
    expect(out.weeks.map((w) => w.week)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const roster = await svc.getMyRoster("test");
    const players = [...roster.starters, ...roster.bench].map((s) => s.player);
    for (const w of out.weeks) {
      expect(w.byes).toEqual(players.filter((p) => p.byeWeek === w.week).map((p) => p.name));
    }
    expect(Object.values(out.fullStrength).reduce((a, b) => a + b, 0)).toBe(9);
    // A range past the league's last week is capped there; one starting after it is refused.
    expect((await svc.getByeCoverage("test", 15, 20)).toWeek).toBe(16);
    await expect(svc.getByeCoverage("test", 17)).rejects.toThrow(/last scoring week is 16/);
    await expect(svc.getByeCoverage("test", 10, 9)).rejects.toThrow(/after toWeek/);
    // Read-only: settings, roster and the NFL schedule.
    expect(calls.every((c) => !c.url.pathname.includes("/news/"))).toBe(true);
  });

  it("applies stored starting slots to bye coverage", async () => {
    const { fetch } = fixtureFetch();
    const slots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, "D/ST": 1, K: 3 };
    const svc = new FantasyService(new EspnClient({ fetch }), {
      leagues: [
        {
          alias: "test",
          leagueId: 1234,
          year: 2018,
          myTeamId: 1,
          rules: { "roster.slots": { value: slots, source: "user", confirmed: "2026-11-04" } },
        },
      ],
    });
    const out = await svc.getByeCoverage("test", 15, 16);
    for (const w of out.weeks) expect(w.openSlots?.filter((s) => s === "K").length).toBe(2);
  });

  it("suggests free agents for a slot the roster can't fill", async () => {
    const { fetch } = fixtureFetch();
    // A stored rule asking for more RBs than the roster has forces an empty slot.
    const slots = { QB: 1, RB: 8, WR: 2, TE: 1, FLEX: 1, "D/ST": 1, K: 1 };
    const svc = new FantasyService(new EspnClient({ fetch }), {
      leagues: [
        {
          alias: "test",
          leagueId: 1234,
          year: 2018,
          myTeamId: 1,
          rules: { "roster.slots": { value: slots, source: "user", confirmed: "2026-10-25" } },
        },
      ],
    });
    const lineup = await svc.getOptimalLineup("test", 1);
    const empty = lineup.risks.filter((r) => r.type === "EMPTY_SLOT");
    expect(empty.length).toBeGreaterThan(0);
    for (const r of empty) {
      expect(r.slot).toBe("RB");
      expect(r.freeAgents!.length).toBeGreaterThan(0);
      expect(r.freeAgents!.length).toBeLessThanOrEqual(3);
      expect(r.freeAgents![0]).toMatchObject({
        name: expect.any(String),
        status: expect.any(String),
      });
    }
    // Risks that aren't holes get no suggestions.
    for (const r of lineup.risks.filter((x) => x.type === "GAME_TIME")) {
      expect(r.freeAgents).toBeUndefined();
    }
  });

  it("attaches the latest news to every risk about a player, and skips it when the feed fails", async () => {
    /** The fixtures with team 1's QB questionable and unlocked, so starting him is a GAME_TIME risk. */
    const questionable = (newsDown = false) => {
      const { fetch } = fixtureFetch();
      const wrapped: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (newsDown && url.pathname.includes("/news/"))
          return new Response("down", { status: 500 });
        const res = await fetch(input, init);
        if (!url.searchParams.getAll("view").includes("mRoster")) return res;
        const body = (await res.json()) as {
          teams: {
            id: number;
            roster: {
              entries: {
                lineupSlotId: number;
                playerPoolEntry: { lineupLocked: boolean; player: { injuryStatus: string } };
              }[];
            };
          }[];
        };
        const qb = body.teams
          .find((t) => t.id === 1)!
          .roster.entries.find((e) => e.lineupSlotId === 0)!;
        qb.playerPoolEntry.player.injuryStatus = "QUESTIONABLE";
        qb.playerPoolEntry.lineupLocked = false;
        return new Response(JSON.stringify(body), { status: 200 });
      };
      // The day before the fixtures' week 1 games, so nothing is locked yet.
      return new FantasyService(new EspnClient({ fetch: wrapped, retries: 0 }), config(1), {
        now: () => new Date("2024-09-07T12:00:00.000Z"),
      });
    };

    const lineup = await questionable().getOptimalLineup("test", 1);
    const risk = lineup.risks.find((r) => r.type === "GAME_TIME");
    expect(risk?.news).toMatchObject({ published: "2026-11-02T16:43:16Z" });
    for (const r of lineup.risks.filter((x) => x.player === null)) expect(r.news).toBeUndefined();

    // News is a bonus: without it the lineup and its risks are the same.
    const without = await questionable(true).getOptimalLineup("test", 1);
    expect(without.risks.map((r) => r.type)).toEqual(lineup.risks.map((r) => r.type));
    expect(without.risks.every((r) => r.news === undefined)).toBe(true);
  });

  it("lists the league's teams with mine marked", async () => {
    const teams = await service(2).svc.getTeams("test");
    expect(teams).toHaveLength(10);
    expect(teams.filter((t) => t.isMine).map((t) => t.id)).toEqual([2]);
  });

  it("sorts free agents by season projection when asked", async () => {
    const fas = await service().svc.getFreeAgents("test", "WR", 8, 1, "season");
    const season = fas.map((f) => f.seasonProjectedPoints ?? -1);
    expect(season).toEqual([...season].sort((a, b) => b - a));
  });

  it("carries lastNewsDate and a read time on rosters", async () => {
    const roster = await service(1).svc.getMyRoster("test", 1);
    expect(roster.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const all = [...roster.starters, ...roster.bench];
    expect(all.some((s) => s.player.lastNewsDate !== null)).toBe(true);
  });
});

describe("loadConfig", () => {
  it("rejects placeholder ids with a hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "espn-fantasy-mcp-"));
    const path = join(dir, "leagues.json");
    writeFileSync(path, readFileSync(join(import.meta.dirname, "../../../leagues.example.json")));
    expect(() => loadConfig(path)).toThrow(/set leagueId/);
  });
});
