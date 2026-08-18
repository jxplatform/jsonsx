/**
 * Undo the escapes a visual Markdown editor leaves behind.
 *
 * A round trip through a WYSIWYG editor rewrites `## 18.` as `## 18\.` and `RESERVED_KEYS` as
 * `RESERVED\_KEYS`. Both render identically, so nothing looks wrong — and one of them cost this
 * repository every one of `spec.md`'s twelve standards rows, because `STANDARDS_HEADING` could no
 * longer find the section and a parser that cannot find a section silently stops checking it.
 *
 * Oxfmt normalizes plenty of Markdown (`* * *` becomes `---`) but preserves both escapes, and a
 * formatter has no rule system to extend — hence this pass, run beside it.
 *
 * **This cannot undo the damage that matters most.** The same round trip flattens `[RFC
 * 6901](https://…)` to bare `RFC 6901` and `**Adopted**` to `Adopted`, and those URLs are simply
 * gone. Recovering them means `git show` on the last good commit. What this script does is remove
 * the _cosmetic_ residue; what protects the _content_ is `check-standards.ts`, which now reads the
 * section either way and reports the escape as `heading-escaped` precisely because it is the
 * visible symptom of an edit that probably also destroyed something invisible.
 *
 * Both rules are deliberately narrow. An escape is only removed where Markdown never needed one:
 * after the number of a numbered heading, and between two word characters. A `\*` in prose, or a
 * leading `\_`, is left alone — those may be load-bearing. Fenced code is skipped entirely, since
 * inside a fence a backslash is content.
 *
 * Usage: `bun scripts/normalize-markdown.ts [--check] [paths…]`
 */

import { readFileSync, writeFileSync } from "node:fs";

/** `## 18\.` — the editor is stopping the line re-parsing as an ordered-list item. */
const ESCAPED_HEADING = /^(#{1,6}\s+\d+(?:\.\d+)*[a-z]?)\\\./;

/** `RESERVED\_KEYS` — the editor is stopping the underscore reading as emphasis. Never needed. */
const ESCAPED_INNER_UNDERSCORE = /(\w)\\_(?=\w)/g;

const FENCE = /^\s*(```|~~~)/;

export interface NormalizeResult {
  text: string;
  /** 1-based lines that changed, for a `--check` report that points somewhere. */
  lines: number[];
}

/**
 * Normalize one document's text.
 *
 * @param {string} source
 * @returns {NormalizeResult}
 */
export function normalizeMarkdown(source: string): NormalizeResult {
  const lines = source.split("\n");
  const changed: number[] = [];
  let inFence = false;

  const out = lines.map((line, i) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) {
      return line;
    }
    const next = line.replace(ESCAPED_HEADING, "$1.").replaceAll(ESCAPED_INNER_UNDERSCORE, "$1_");
    if (next !== line) {
      changed.push(i + 1);
    }
    return next;
  });

  return { lines: changed, text: out.join("\n") };
}

/** Files to sweep when none are named: everything tracked, minus what oxfmt already ignores. */
async function defaultPaths(): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files", "*.md"], { stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  const listed = text.trim();
  return listed === ""
    ? []
    : listed.split("\n").filter((p) => !p.startsWith("CHANGELOG") && !p.includes("_fixtures/"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const named = args.filter((a) => !a.startsWith("--"));
  const paths = named.length > 0 ? named : await defaultPaths();

  const offenders: { path: string; lines: number[] }[] = [];
  for (const path of paths) {
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const result = normalizeMarkdown(source);
    if (result.lines.length === 0) {
      continue;
    }
    offenders.push({ lines: result.lines, path });
    if (!check) {
      writeFileSync(path, result.text, "utf8");
    }
  }

  if (offenders.length === 0) {
    console.log(`markdown: ${paths.length} file(s) carry no visual-editor escapes.`);
    return;
  }
  for (const o of offenders) {
    const where = o.lines.slice(0, 6).join(", ") + (o.lines.length > 6 ? ", …" : "");
    console.log(`${check ? "escaped" : "normalized"} ${o.path}: line ${where}`);
  }
  if (check) {
    console.error(
      `\n${offenders.length} file(s) carry visual-editor escapes. Run \`bun run format:md\`, ` +
        "then check that this file's links and bold survived the edit that caused them.",
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
