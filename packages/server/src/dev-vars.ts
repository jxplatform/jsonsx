/**
 * Dev-vars — `<project>/.dev.vars` parsing (wrangler convention, specs/extensions.md §13).
 *
 * Secret VALUES never enter project.json; locally they live in the git-ignored .dev.vars file and
 * the dev server merges them over process.env when constructing mount environments. The format is
 * dotenv-shaped: KEY=VALUE lines, `#` comments, optional single/double quotes. The compiler CLI
 * keeps its own tiny copy (db-push.ts) — the compiler cannot depend on this package.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Parse .dev.vars text into a name → value record.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Load `<projectRoot>/.dev.vars`, or an empty record when absent.
 *
 * @param {string} projectRoot
 * @returns {Record<string, string>}
 */
export function loadDevVars(projectRoot: string): Record<string, string> {
  const path = resolve(projectRoot, ".dev.vars");
  if (!existsSync(path)) {
    return {};
  }
  try {
    return parseDevVars(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
