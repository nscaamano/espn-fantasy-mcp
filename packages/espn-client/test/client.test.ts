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

describe("EspnClient pending claims", () => {
  it("requests mPendingTransactions and names players from one card request", async () => {
    const { fetch: base, calls } = fixtureFetch();
    const card = {
      players: [
        {
          id: 4571557,
          player: { id: 4571557, fullName: "Test Runner", defaultPositionId: 2, proTeamId: 12 },
        },
        {
          id: 4034949,
          player: { id: 4034949, fullName: "Test Kicker", defaultPositionId: 5, proTeamId: 9 },
        },
      ],
    };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).searchParams.getAll("view").includes("kona_playercard")
        ? (await base(input, init), new Response(JSON.stringify(card)))
        : base(input, init)) as typeof globalThis.fetch;

    const claims = await new EspnClient({ fetch }).getPendingClaims(1234, 2026);

    expect(calls[0]!.url.searchParams.getAll("view")).toEqual(["mPendingTransactions"]);
    const cardCalls = calls.filter((c) =>
      c.url.searchParams.getAll("view").includes("kona_playercard"),
    );
    expect(cardCalls).toHaveLength(1);
    expect(JSON.parse(cardCalls[0]!.headers["x-fantasy-filter"]!).players.filterIds.value).toEqual(
      expect.arrayContaining([4571557, 4034949, -16012, 4686658]),
    );
    expect(claims[0]!.add).toMatchObject({
      playerName: "Test Runner",
      position: "RB",
      proTeam: "KC",
    });
    expect(claims[0]!.drop).toMatchObject({
      playerName: "Test Kicker",
      position: "K",
      fromSlot: "K",
    });
    expect(claims[1]!.add!.playerName).toBeNull();
  });

  it("never carries ESPN's memberId through", async () => {
    const raw = {
      pendingTransactions: [
        {
          memberId: "{SECRET-MEMBER-GUID}",
          type: "WAIVER",
          status: "PENDING",
          teamId: 1,
          bidAmount: 3,
          items: [{ type: "ADD", playerId: 1, toTeamId: 1, fromLineupSlotId: -1 }],
        },
      ],
    };
    const fetch = (async () =>
      new Response(JSON.stringify(raw))) as unknown as typeof globalThis.fetch;
    const claims = await new EspnClient({ fetch }).getPendingClaims(1, 2026);
    expect(claims).toHaveLength(1);
    expect(JSON.stringify(claims)).not.toContain("SECRET");
  });

  it("skips the player-card request when nothing is queued", async () => {
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ pendingTransactions: [] }));
    }) as unknown as typeof globalThis.fetch;
    await expect(new EspnClient({ fetch }).getPendingClaims(1, 2026)).resolves.toEqual([]);
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

describe("EspnClient retries", () => {
  /** Serves `steps` in order: an Error is thrown like a network failure, a number is a status. */
  function scripted(...steps: (number | Error)[]) {
    let calls = 0;
    const fetch = (async () => {
      const step = steps[Math.min(calls++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return new Response(step === 200 ? JSON.stringify({ id: 1 }) : "{}", { status: step });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls: () => calls };
  }
  const connReset = () =>
    Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

  it("retries once after a network failure", async () => {
    const s = scripted(connReset(), 200);
    const client = new EspnClient({ fetch: s.fetch, retryDelayMs: 0 });
    await expect(client.getLeagueSettings(1, 2026)).resolves.toBeDefined();
    expect(s.calls()).toBe(2);
  });

  it("retries once after a gateway error", async () => {
    const s = scripted(503, 200);
    await new EspnClient({ fetch: s.fetch, retryDelayMs: 0 }).getLeagueSettings(1, 2026);
    expect(s.calls()).toBe(2);
  });

  it("gives up after the retry, naming the network error code", async () => {
    const s = scripted(connReset(), connReset(), 200);
    const client = new EspnClient({ fetch: s.fetch, retryDelayMs: 0 });
    await expect(client.getLeagueSettings(1, 2026)).rejects.toThrow(
      /request failed: fetch failed \(ECONNRESET\)/,
    );
    expect(s.calls()).toBe(2);
  });

  it("doesn't retry auth or not-found errors", async () => {
    for (const status of [401, 404]) {
      const s = scripted(status, 200);
      await expect(
        new EspnClient({ fetch: s.fetch, retryDelayMs: 0 }).getLeagueSettings(1, 2026),
      ).rejects.toThrow();
      expect(s.calls()).toBe(1);
    }
  });

  it("can be turned off", async () => {
    const s = scripted(503, 200);
    const client = new EspnClient({ fetch: s.fetch, retries: 0 });
    await expect(client.getLeagueSettings(1, 2026)).rejects.toThrow(/HTTP 503/);
    expect(s.calls()).toBe(1);
  });
});
