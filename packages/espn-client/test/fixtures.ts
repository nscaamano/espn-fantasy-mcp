import { readFileSync } from "node:fs";
import { join } from "node:path";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as T;
}

/**
 * A fetch stand-in that serves fixtures by request shape, so EspnClient can be
 * exercised end to end without the network. Records every request it sees.
 */
export function fixtureFetch() {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const views = url.searchParams.getAll("view");
    let body: unknown;
    if (url.pathname.includes("/communication")) body = fixture("recent_activity.json");
    else if (views.includes("proTeamSchedules_wl")) body = fixture("pro_schedule.json");
    else if (views.includes("kona_player_info")) body = fixture("free_agents.json");
    else if (views.includes("kona_playercard")) body = fixture("player_card.json");
    else if (views.includes("mMatchupScore")) body = fixture("boxscore.json");
    else body = fixture("league.json");
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch: impl as typeof fetch, calls };
}
