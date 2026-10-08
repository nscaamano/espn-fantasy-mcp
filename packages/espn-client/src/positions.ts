import { POSITION_MAP } from "./constants.js";

// Not in espn-api's constants: a player's `defaultPositionId` uses its own id
// space, separate from lineup slot ids. It's also the key space of
// `rosterSettings.positionLimits`.
export const DEFAULT_POSITION_MAP: Readonly<Record<number, string>> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  7: "P",
  9: "DT",
  10: "DE",
  11: "LB",
  12: "CB",
  13: "S",
  14: "HC",
  16: "D/ST",
};

/** Lineup slot id → display label. Same as POSITION_MAP except 23 reads as FLEX. */
export function slotLabel(slotId: number): string {
  if (slotId === 23) return "FLEX";
  return POSITION_MAP[slotId] ?? `SLOT_${slotId}`;
}

/** Display label → lineup slot id, for free-agent filters. Accepts FLEX and OP. */
export function slotIdForPosition(position: string): number | undefined {
  const label = position.toUpperCase();
  if (label === "FLEX") return 23;
  if (label === "OP" || label === "SUPERFLEX") return 7;
  if (label === "DST" || label === "DEF") return 16;
  for (const [id, name] of Object.entries(POSITION_MAP)) {
    if (name === label) return Number(id);
  }
  return undefined;
}
