// Generates docs/studio/projects/starters.md from packages/starters/registry.json —
// The same registry Studio's New Project template gallery reads.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BANNER, frontmatter } from "./shared.ts";

const ROOT = resolve(import.meta.dir, "../../..");

interface StarterEntry {
  id: string;
  name: string;
  industry: string;
  tagline: string;
  description: string;
  features: string[];
}

/** Render the starter-templates reference page. */
export function generateStarters(): string {
  const registry = JSON.parse(
    readFileSync(join(ROOT, "packages/starters/registry.json"), "utf8"),
  ) as StarterEntry[];

  const lines: string[] = [
    frontmatter({
      description:
        "The starter templates that ship with Jx Studio — what each includes and who it's for.",
      title: "Starter templates",
    }),
    BANNER,
    "",
    "# Starter templates",
    "",
    `Jx Studio ships ${registry.length} starter templates. Pick one in the **New Project** dialog — Studio copies it into your project folder as a complete, editable site with real content, components, and styles. Nothing about a starter is special afterward: it is plain Jx files you own.`,
    "",
  ];

  for (const starter of registry) {
    lines.push(
      `## ${starter.name}`,
      "",
      `**${starter.industry}** — ${starter.tagline}`,
      "",
      starter.description,
      "",
      ...starter.features.map((f) => `- ${f}`),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
