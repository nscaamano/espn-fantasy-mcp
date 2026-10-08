// Live check against your real leagues: settings, your roster, this week's
// matchup, top free-agent WRs and recent activity for every league in
// leagues.json. Run before each weekly check: `pnpm smoke`.
//
//   pnpm smoke                    all leagues, current week
//   pnpm smoke -- --league ppr    one league
//   pnpm smoke -- --week 5        a specific week
//   pnpm smoke -- --position RB   free agents at another position

import { parseArgs } from "node:util";
import { FantasyService, type Player, type RosterSlot } from "@espn-fantasy-mcp/core";

const { values: args } = parseArgs({
  options: {
    league: { type: "string" },
    week: { type: "string" },
    position: { type: "string", default: "WR" },
  },
});
const week = args.week ? Number(args.week) : undefined;
const position = args.position!;

const pad = (s: string | number | null | undefined, n: number) => String(s ?? "–").padEnd(n);
const num = (n: number | null | undefined) => (n === null || n === undefined ? "–" : n.toFixed(1));
const flag = (p: Player, wk: number) =>
  [p.injuryStatus !== "ACTIVE" ? p.injuryStatus : "", p.byeWeek === wk ? "BYE" : ""]
    .filter(Boolean)
    .join(" ");

function slotLine(s: RosterSlot, wk: number): string {
  const p = s.player;
  return `  ${pad(s.slot, 5)}${pad(p.name, 26)}${pad(p.position, 5)}${pad(p.proTeam, 5)}proj ${pad(num(p.projectedPoints), 6)}act ${pad(num(p.actualPoints), 6)}bye ${pad(p.byeWeek, 3)}${s.locked ? "🔒 " : ""}${flag(p, wk)}`;
}

let svc: FantasyService;
try {
  svc = FantasyService.fromEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const leagues = args.league ? svc.leagues.filter((l) => l.alias === args.league) : svc.leagues;
if (!leagues.length) {
  console.error(`No league "${args.league}". Known: ${svc.leagues.map((l) => l.alias).join(", ")}`);
  process.exit(1);
}

let failures = 0;
async function step(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

for (const { alias } of leagues) {
  console.log(`\n═══ ${alias} ═══`);

  await step("settings", async () => {
    const s = await svc.getLeagueSettings(alias);
    const me = s.teams.find((t) => t.isMine)!;
    const slots = Object.entries(s.roster.slots)
      .map(([k, v]) => `${k}${v > 1 ? `×${v}` : ""}`)
      .join(" ");
    const waivers =
      s.waivers.type === "FAAB"
        ? `FAAB $${s.waivers.faabRemaining}/${s.waivers.faabBudget} left`
        : `${s.waivers.type ?? "?"} waivers, my rank ${s.waivers.myWaiverRank ?? "?"}`;
    console.log(
      `${s.name} · ${s.size} teams · week ${s.currentWeek} · me: ${me.name} (${me.wins}-${me.losses}${me.ties ? `-${me.ties}` : ""})`,
    );
    console.log(
      `  ${s.scoring.format ?? "?"} (${s.scoring.receptionPoints ?? "?"}/rec) · ${waivers} · lock ${s.lineupLock ?? "?"}`,
    );
    console.log(
      `  slots: ${slots} · bench ${s.roster.benchSize} · IR ${s.roster.irSlots}${s.roster.superflex ? " · SUPERFLEX" : ""}`,
    );
    if (s.missingRules.length) console.log(`  missing rules (ask): ${s.missingRules.join(", ")}`);
    for (const c of s.conflicts) {
      console.log(
        `  conflict ${c.rule}: ESPN ${JSON.stringify(c.espn)} vs ${c.storedSource} ${JSON.stringify(c.stored)}`,
      );
    }
  });

  await step("roster", async () => {
    const r = await svc.getMyRoster(alias, week);
    console.log(
      `\nRoster, week ${r.week} — proj ${num(r.projectedTotal)}, actual ${num(r.actualTotal)}`,
    );
    for (const s of [...r.starters, ...r.bench, ...r.ir]) console.log(slotLine(s, r.week));
  });

  await step("matchup", async () => {
    const m = await svc.getMatchup(alias, week);
    const opp = m.opponent;
    console.log(
      `\nMatchup, week ${m.week}${m.isPlayoff ? " (playoffs)" : ""}: ${m.me.teamName} ${num(m.me.score)} (proj ${num(m.me.projected)}) vs ` +
        (opp ? `${opp.teamName} ${num(opp.score)} (proj ${num(opp.projected)})` : "BYE"),
    );
    if (opp) for (const s of opp.starters) console.log(slotLine(s, m.week));
  });

  await step("free agents", async () => {
    const fas = await svc.getFreeAgents(alias, position, 10, week);
    console.log(`\nTop ${fas.length} free-agent ${position}s by projection`);
    fas.forEach((p, i) =>
      console.log(
        `  ${pad(i + 1 + ".", 4)}${pad(p.name, 26)}${pad(p.proTeam, 5)}proj ${pad(num(p.projectedPoints), 6)}${pad(num(p.percentRostered) + "%", 7)}${pad(p.status === "WAIVERS" ? "WAIVERS" : "FA", 8)}bye ${pad(p.byeWeek, 3)}${p.injuryStatus !== "ACTIVE" ? p.injuryStatus : ""}`,
      ),
    );
  });

  await step("recent activity", async () => {
    const tx = await svc.getRecentActivity(alias, 5);
    console.log(`\nRecent activity (latest ${tx.length})`);
    for (const t of tx) {
      const items = t.items
        .map(
          (i) =>
            `${i.action} ${i.player}${i.bid !== null ? ` $${i.bid}` : ""}${i.team ? ` (${i.team})` : ""}`,
        )
        .join("; ");
      console.log(`  ${t.date.slice(0, 10)}  ${items}`);
    }
  });
}

console.log(failures ? `\n${failures} step(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
