import { describe, expect, it } from "vitest";
import { EspnClient } from "../src/client.js";
import { EspnAuthError, EspnHttpError, EspnNotFoundError } from "../src/errors.js";
import { fixtureFetch } from "./fixtures.js";

const statusFetch = (status: number, body = "{}") =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("EspnClient requests", () => {
  it("sends cookies and builds the league URL", async () => {
    const { fetch, calls } = fixtureFetch();
    const client = new EspnClient({ espnS2: "s2", swid: "{SWID}", fetch });
    await client.getLeagueSettings(1234, 2026);
    expect(calls[0]!.url.pathname).toBe("/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1234");
    expect(calls[0]!.url.searchParams.getAll("view")).toEqual(["mSettings", "mTeam"]);
    expect(calls[0]!.headers.Cookie).toBe("espn_s2=s2; SWID={SWID}");
  });

  it("honors a custom base URL", async () => {
    const { fetch, calls } = fixtureFetch();
    await new EspnClient({ baseUrl: "https://example.test/v3/", fetch }).getLeagueSettings(1, 2026);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe(
      "https://example.test/v3/games/ffl/seasons/2026/segments/0/leagues/1",
    );
  });

  it("sends the free-agent filter header with the slot id", async () => {
    const { fetch, calls } = fixtureFetch();
    await new EspnClient({ fetch }).getFreeAgents(1, 2018, "WR", 40, 1);
    const filter = JSON.parse(calls[0]!.headers["x-fantasy-filter"]!);
    expect(filter.players.filterSlotIds.value).toEqual([4]);
    expect(filter.players.filterStatus.value).toEqual(["FREEAGENT", "WAIVERS"]);
    expect(filter.players.limit).toBe(40);
    expect(calls[0]!.url.searchParams.get("scoringPeriodId")).toBe("1");
  });

  it("rejects unknown positions before calling ESPN", async () => {
    const { fetch, calls } = fixtureFetch();
    await expect(new EspnClient({ fetch }).getFreeAgents(1, 2018, "LONGSNAPPER")).rejects.toThrow(
      /Unknown position/,
    );
    expect(calls).toHaveLength(0);
  });

  it("filters box scores to the week's matchup period", async () => {
    const { fetch, calls } = fixtureFetch();
    const matchups = await new EspnClient({ fetch }).getMatchups(1, 2018, 13);
    const box = calls.find((c) => c.url.searchParams.getAll("view").includes("mMatchupScore"))!;
    expect(JSON.parse(box.headers["x-fantasy-filter"]!)).toEqual({
      schedule: { filterMatchupPeriodIds: { value: [13] } },
    });
    expect(matchups).toHaveLength(2);
  });

  it("resolves activity player names from player cards", async () => {
    const { fetch: base, calls } = fixtureFetch();
    const card = {
      players: [
        {
          id: 17437,
          player: { id: 17437, fullName: "Test Receiver", defaultPositionId: 3, proTeamId: 12 },
        },
      ],
    };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).searchParams.getAll("view").includes("kona_playercard")
        ? (await base(input, init), new Response(JSON.stringify(card)))
        : base(input, init)) as typeof globalThis.fetch;

    const activity = await new EspnClient({ fetch }).getRecentActivity(1, 2019, 6);

    const cardCall = calls.find((c) =>
      c.url.searchParams.getAll("view").includes("kona_playercard"),
    )!;
    const ids = JSON.parse(cardCall.headers["x-fantasy-filter"]!).players.filterIds.value;
    expect(ids).toEqual(expect.arrayContaining([-16001, 17437, 3043234]));
    expect(activity[1]!.items[0]).toMatchObject({
      playerId: 17437,
      playerName: "Test Receiver",
      position: "WR",
      proTeam: "KC",
    });
    // Players ESPN didn't return stay unresolved rather than failing the call.
    expect(activity[0]!.items[0]!.playerName).toBeNull();
  });

  it("caches pro team schedules per year", async () => {
    const { fetch, calls } = fixtureFetch();
    const client = new EspnClient({ fetch });
    await client.getProTeams(2024);
    await client.getProTeams(2024);
    expect(calls).toHaveLength(1);
  });
});

describe("EspnClient errors", () => {
  it("explains a 401 without cookies", async () => {
    const client = new EspnClient({ fetch: statusFetch(401) });
    await expect(client.getLeagueSettings(1, 2026)).rejects.toThrow(EspnAuthError);
    await expect(client.getLeagueSettings(1, 2026)).rejects.toThrow(/ESPN_S2 and SWID are not set/);
  });

  it("explains a 401 with cookies as an expired espn_s2", async () => {
    const client = new EspnClient({ espnS2: "x", swid: "y", fetch: statusFetch(401) });
    await expect(client.getLeagueSettings(1, 2026)).rejects.toThrow(/expired/);
  });

  it("maps 404 to EspnNotFoundError, except on the message board", async () => {
    const client = new EspnClient({ fetch: statusFetch(404) });
    await expect(client.getLeagueSettings(1, 2026)).rejects.toThrow(EspnNotFoundError);
    await expect(client.getRecentActivity(1, 2026)).resolves.toEqual([]);
  });

  it("reports non-JSON responses", async () => {
    const client = new EspnClient({ fetch: statusFetch(200, "<html>blocked</html>") });
    await expect(client.getLeagueSettings(1, 2026)).rejects.toThrow(EspnHttpError);
  });
});
