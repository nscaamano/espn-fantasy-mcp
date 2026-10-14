// The workflows in skills/<name>/SKILL.md are the single source for both forms:
// Agent Skills read the files directly, and this module serves the same text
// as MCP prompts for clients without skills support.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Skill {
  /** From frontmatter, e.g. "weekly-check". */
  name: string;
  description: string;
  /** The first "# " heading. */
  title: string;
  /** Markdown after the frontmatter. */
  body: string;
}

/** The repo's skills/ folder: three levels up from both src/ and dist/. */
export const DEFAULT_SKILLS_DIR = fileURLToPath(new URL("../../../skills/", import.meta.url));

/** Minimal frontmatter reader: single-line `key: value` pairs between `---` fences. */
export function parseSkill(text: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("SKILL.md has no frontmatter");
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = match[2]!.trim();
  if (!meta.name || !meta.description) {
    throw new Error("SKILL.md frontmatter needs name and description");
  }
  const title = /^# (.+)$/m.exec(body)?.[1]?.trim() ?? meta.name;
  return { name: meta.name, description: meta.description, title, body };
}

/** Every skills/<name>/SKILL.md, sorted by name. A missing folder means no skills. */
export function loadSkills(dir = DEFAULT_SKILLS_DIR): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => {
      const skill = parseSkill(readFileSync(join(dir, d.name, "SKILL.md"), "utf8"));
      if (skill.name !== d.name) {
        throw new Error(`skills/${d.name}/SKILL.md declares name "${skill.name}"`);
      }
      return skill;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** MCP prompt names use underscores: weekly-check → weekly_check. */
export const promptName = (skill: Skill) => skill.name.replaceAll("-", "_");

/** The prompt text: scope, the current time (the workflows depend on the day), then the workflow. */
export function promptText(skill: Skill, league: string | undefined, now: Date): string {
  const scope = league ? `the league "${league}"` : "every league from list_leagues";
  const eastern = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Follow the ${skill.name} workflow below for ${scope}. It's now ${eastern} ET (${now.toISOString()}).\n\n${skill.body}`;
}
