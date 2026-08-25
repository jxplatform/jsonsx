/**
 * Put each paragraph on one line, so prose diffs are about words rather than re-wrapping.
 *
 * The corpus arrived split: 78 pages write a paragraph as one long line and 53 hard-wrap at about
 * 100 columns. Editing a hard-wrapped paragraph re-flows every line after the edit, so a one-word
 * change reads as a five-line change and a reviewer checking that a rewrite kept every claim has to
 * reconstruct the sentences first. One line per paragraph makes the diff say what changed.
 *
 * **The formatter cannot do this.** Oxfmt's `proseWrap: "never"` was tried first and is unusable
 * here: it only knows CommonMark, so it folds a `:::doc-note` marker into the paragraph beneath it
 * (186 callouts in `/docs`) and joins the `::starter-card` directives on `pages/templates.md` into
 * one line, which drops seven starters out of the page and reds `docs:claims`. It also unpads every
 * table. Hence this pass, which knows what a container directive is.
 *
 * `specs/**` is deliberately NOT in scope and must never be added. `check-spec-release.ts` compares
 * a spec's normalised body LINE BY LINE, so re-flowing one reads as a body change and demands a
 * version bump; unwrapping the seventeen specs would mint seventeen releases for whitespace.
 *
 * A line is joined onto the one before it only when both are ordinary prose. Everything with
 * structure in its line breaks is left exactly as it is: fenced code, frontmatter, headings,
 * tables, list items, block quotes, container directives (`::`, `:::`, `::::…`), HTML blocks,
 * thematic breaks, link reference definitions, and any line the author ended with a hard break (a
 * backslash, or two trailing spaces). Indented code inside a list is why an indented line only
 * continues a paragraph that is itself indented.
 *
 * Usage: `bun scripts/docs/unwrap-prose.ts [--check] <paths…>`
 */

import { readFileSync, writeFileSync } from "node:fs";

const FENCE = /^\s*(```|~~~)/;
const FRONTMATTER = /^---\s*$/;

/** Lines that own their break. A paragraph never starts on one, and never absorbs one. */
const STRUCTURAL = [
  /^\s*#{1,6}\s/, //            Heading
  /^\s*\|/, //                  Table row
  /^\s*(?:[-*+]|\d+[.)])\s/, // List item
  /^\s*>/, //                   Block quote
  /^\s*:{2,}/, //               Container directive: ::card, :::doc-note, ::::::hero
  /^\s*</, //                   HTML block
  /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, // Thematic break
  /^\s*\[[^\]]+\]:\s/, //       Link reference definition
  /^\s*$/, //                   Blank
];

/** A break the author asked for: `line\` or `line `. Joining it would delete a rendered <br>. */
const HARD_BREAK = /(?:\\|\s{2})$/;

function isStructural(line: string): boolean {
  return STRUCTURAL.some((re) => re.test(line));
}

/** Leading whitespace, so an indented paragraph only ever absorbs equally indented lines. */
function indentOf(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? "";
}

export interface UnwrapResult {
  text: string;
  /**
   * 1-based lines that were folded into the line above, for a `--check` report that points
   * somewhere.
   */
  lines: number[];
}

/**
 * Join every hard-wrapped paragraph in one document onto a single line.
 *
 * @param {string} source
 * @returns {UnwrapResult}
 */
export function unwrapProse(source: string): UnwrapResult {
  const lines = source.split("\n");
  const out: string[] = [];
  const folded: number[] = [];
  let inFence = false;
  let inFrontmatter = false;
  /** Whether the last line written to `out` is a paragraph line that may still absorb the next. */
  let open = false;
  let openIndent = "";

  for (const [i, line] of lines.entries()) {
    // Frontmatter is a delimited block, not a thematic break: only line 1 opens one, and the next
    // `---` closes it. A `---` anywhere after that is an ordinary thematic break.
    if (inFrontmatter) {
      inFrontmatter = !FRONTMATTER.test(line);
      out.push(line);
      continue;
    }
    if (i === 0 && FRONTMATTER.test(line)) {
      inFrontmatter = true;
      out.push(line);
      open = false;
      continue;
    }
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      open = false;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    if (isStructural(line)) {
      out.push(line);
      open = false;
      continue;
    }

    if (open && indentOf(line) === openIndent) {
      out[out.length - 1] += ` ${line.trim()}`;
      folded.push(i + 1);
      open = !HARD_BREAK.test(line);
      continue;
    }

    out.push(line);
    open = !HARD_BREAK.test(line);
    openIndent = indentOf(line);
  }

  return { lines: folded, text: out.join("\n") };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const paths = args.filter((a) => !a.startsWith("--"));

  if (paths.length === 0) {
    console.error(
      "unwrap-prose: name the files to unwrap. There is no default sweep, because specs/** must " +
        "never be re-flowed (see this file's header).",
    );
    process.exit(1);
  }

  const offenders: { path: string; lines: number[] }[] = [];
  for (const path of paths) {
    if (path.startsWith("specs/")) {
      console.error(`unwrap-prose: refusing ${path} — re-flowing a spec demands a release.`);
      process.exit(1);
    }
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const result = unwrapProse(source);
    if (result.lines.length === 0) {
      continue;
    }
    offenders.push({ lines: result.lines, path });
    if (!check) {
      writeFileSync(path, result.text, "utf8");
    }
  }

  if (offenders.length === 0) {
    console.log(`unwrap-prose: ${paths.length} file(s) already write one line per paragraph.`);
    return;
  }
  for (const o of offenders) {
    const where = o.lines.slice(0, 6).join(", ") + (o.lines.length > 6 ? ", …" : "");
    console.log(`${check ? "wrapped" : "unwrapped"} ${o.path}: line ${where}`);
  }
  if (check) {
    console.error(
      `\n${offenders.length} file(s) hard-wrap a paragraph. Run ` +
        "`bun scripts/docs/unwrap-prose.ts <paths…>`.",
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
