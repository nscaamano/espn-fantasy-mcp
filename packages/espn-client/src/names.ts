// Player-name matching for EspnClient.searchPlayers. ESPN's own name filter
// matches the start of a first or last name exactly as typed, punctuation
// included, so "AJ Brown" misses "A.J. Brown". These compare names loosely.

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** Lowercase words without accents or punctuation: "Ja'Marr St. Brown" → ["jamarr", "st", "brown"]. */
export function nameWords(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A name without punctuation, spacing or suffix, for exact comparison: "Kenneth Walker III" → "kennethwalker". */
export function nameKey(name: string): string {
  const words = nameWords(name);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join("");
}

/**
 * True when `query` loosely names `fullName`: every query word starts one of
 * the name's words ("amon ra" → "Amon-Ra St. Brown"), or the query's letters
 * appear together in the name's ("aj brown" → "A.J. Brown").
 */
export function nameMatches(fullName: string, query: string): boolean {
  const q = nameWords(query);
  if (!q.length) return false;
  const words = nameWords(fullName);
  if (q.every((w) => words.some((n) => n.startsWith(w)))) return true;
  return words.join("").includes(q.join(""));
}
