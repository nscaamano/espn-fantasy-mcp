import { describe, expect, it } from "vitest";
import { nameKey, nameMatches, nameWords } from "../src/names.js";

describe("player names", () => {
  it("splits names into plain lowercase words", () => {
    expect(nameWords("Ja'Marr St. Brown")).toEqual(["jamarr", "st", "brown"]);
    expect(nameWords("Amon-Ra  A.J.")).toEqual(["amon", "ra", "aj"]);
    expect(nameWords("Zoë Ångström")).toEqual(["zoe", "angstrom"]);
  });

  it("keys names without punctuation or suffix", () => {
    expect(nameKey("Kenneth Walker III")).toBe(nameKey("kenneth walker"));
    expect(nameKey("Marvin Harrison Jr.")).toBe("marvinharrison");
    expect(nameKey("A.J. Brown")).toBe(nameKey("AJ Brown"));
  });

  it("matches word prefixes in any order, or the letters run together", () => {
    expect(nameMatches("Amon-Ra St. Brown", "amon ra")).toBe(true);
    expect(nameMatches("Kimani Vidal", "Vidal Kimani")).toBe(true);
    expect(nameMatches("A.J. Brown", "AJ Brown")).toBe(true);
    expect(nameMatches("Amon-Ra St. Brown", "amonra")).toBe(true);
    expect(nameMatches("Antonio Brown", "AJ Brown")).toBe(false);
    expect(nameMatches("Antonio Brown", "...")).toBe(false);
  });
});
