/**
 * Split a Markdown document into the spans a prose rule is allowed to judge.
 *
 * Every rule in `check-prose.ts` runs over these segments and never over raw lines, because most of
 * what looks like a violation in this corpus is punctuation inside markup. A bare em dash in a
 * table cell is the value "none" and is emitted by `generators/studio-routes.ts`; an en dash
 * between two key names is a range; a `:::doc-note` marker is not a sentence. Judging raw lines
 * would flag every one of them.
 *
 * Masking preserves length: a masked run becomes the same number of spaces, so a segment's `col`
 * still points at the right column and a report can name a place a person can find.
 *
 * **Code spans are consumed by backtick run, not matched by a regex pair.** CommonMark opens a span
 * on a run of N backticks and closes it on the next run of exactly N. A regex pairing one tick with
 * the next disagrees with that on six lines of the tracked Markdown, all of them where a span for
 * the backtick key itself contains a backtick:
 *
 *     | `⌘``  | `Ctrl+``  | Code | `format.code` |
 *
 * Five of the six are in generated pages or specs, which this gate does not read, so following the
 * spec buys nothing on today's corpus. It is done anyway because the alternative is a masker whose
 * idea of a code span differs from the renderer's, and a gate that disagrees with the page it is
 * judging produces findings nobody can reproduce by looking.
 */

/** Where a span of prose sits. Rules use this to exempt what is structure rather than writing. */
export type Ctx = "blockquote" | "frontmatter" | "heading" | "listItem" | "paragraph" | "tableCell";

export interface Segment {
  /** Masked: code spans, URLs, link targets, `:kbd[…]` and HTML comments become spaces. */
  text: string;
  /** The same span, unmasked, for the excerpt in a report. */
  raw: string;
  ctx: Ctx;
  /** 1-based line in the source document. */
  line: number;
  /** 1-based column where this span starts. */
  col: number;
}

const FENCE = /^\s*(```|~~~)/;
const FRONTMATTER = /^---\s*$/;
const HEADING = /^\s*#{1,6}\s+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BLOCKQUOTE = /^\s*>\s?/;
const DIRECTIVE = /^\s*:{2,}/;
/** `| --- | :-: |` carries no prose. */
const TABLE_DELIMITER = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;

/** Frontmatter keys whose values are prose a reader sees. The rest are paths and flags. */
const PROSE_KEYS = new Set(["description", "title"]);

function blank(length: number): string {
  return " ".repeat(length);
}

/**
 * Blank every code span on one line, consuming balanced backtick runs left to right.
 *
 * @param {string} line
 * @returns {string}
 */
export function maskCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i];
      i += 1;
      continue;
    }
    let openLength = 0;
    while (line[i + openLength] === "`") {
      openLength += 1;
    }
    const open = i;
    let j = i + openLength;
    let closed = -1;
    while (j < line.length) {
      if (line[j] !== "`") {
        j += 1;
        continue;
      }
      let runLength = 0;
      while (line[j + runLength] === "`") {
        runLength += 1;
      }
      if (runLength === openLength) {
        closed = j;
        break;
      }
      j += runLength;
    }
    if (closed === -1) {
      // An unmatched run is literal backticks, not an opener. Emit it and move on.
      out += line.slice(open, open + openLength);
      i = open + openLength;
      continue;
    }
    out += blank(closed + openLength - open);
    i = closed + openLength;
  }
  return out;
}

/**
 * Blank the parts of a line that are markup or machine-readable rather than prose.
 *
 * A link or image LABEL survives, because a reader reads it. Its target does not.
 *
 * @param {string} line
 * @returns {string}
 */
export function maskLine(line: string): string {
  return maskCodeSpans(line)
    .replaceAll(/<!--.*?-->/g, (m) => blank(m.length))
    .replaceAll(/!?\[([^\]]*)\]\(([^)]*)\)/g, (m: string, label: string) => {
      const at = m.indexOf(label);
      return blank(at) + label + blank(m.length - at - label.length);
    })
    .replaceAll(/:[a-z][\w-]*\[[^\]]*\][^\s)]*/gi, (m) => blank(m.length))
    .replaceAll(/<[^>\s][^>]*>/g, (m) => blank(m.length))
    .replaceAll(/\b[a-z][\w+.-]*:\/\/\S+/gi, (m) => blank(m.length));
}

/** Split a table row on unescaped pipes, keeping each cell's offset. */
function cellsOf(line: string): { text: string; col: number }[] {
  const cells: { text: string; col: number }[] = [];
  let start = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "|" || line[i - 1] === "\\") {
      continue;
    }
    if (start !== -1) {
      cells.push({ col: start + 2, text: line.slice(start + 1, i) });
    }
    start = i;
  }
  return cells;
}

/**
 * The prose spans of one Markdown document.
 *
 * @param {string} source
 * @returns {Segment[]}
 */
export function segment(source: string): Segment[] {
  const segments: Segment[] = [];
  let inFence = false;
  let inFrontmatter = false;

  const push = (ctx: Ctx, line: number, col: number, raw: string) => {
    if (raw.trim() === "") {
      return;
    }
    segments.push({ col, ctx, line, raw, text: maskLine(raw) });
  };

  for (const [i, line] of source.split("\n").entries()) {
    const lineNumber = i + 1;

    if (inFrontmatter) {
      inFrontmatter = !FRONTMATTER.test(line);
      const kv = /^([a-z]+):\s*"?(.*?)"?\s*$/i.exec(line);
      if (kv && PROSE_KEYS.has(kv[1]?.toLowerCase() ?? "")) {
        push("frontmatter", lineNumber, line.indexOf(kv[2] ?? "") + 1, kv[2] ?? "");
      }
      continue;
    }
    if (i === 0 && FRONTMATTER.test(line)) {
      inFrontmatter = true;
      continue;
    }
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || DIRECTIVE.test(line) || TABLE_DELIMITER.test(line)) {
      continue;
    }

    if (line.trimStart().startsWith("|")) {
      for (const cell of cellsOf(line)) {
        push("tableCell", lineNumber, cell.col, cell.text);
      }
      continue;
    }

    let ctx: Ctx = "paragraph";
    let marker = 0;
    if (HEADING.test(line)) {
      ctx = "heading";
      marker = HEADING.exec(line)?.[0].length ?? 0;
    } else if (BLOCKQUOTE.test(line)) {
      ctx = "blockquote";
      marker = BLOCKQUOTE.exec(line)?.[0].length ?? 0;
    } else if (LIST_ITEM.test(line)) {
      ctx = "listItem";
      marker = LIST_ITEM.exec(line)?.[0].length ?? 0;
    }
    // Drop the marker itself: a `-` bullet is not a dash, and a `#` is not prose.
    push(ctx, lineNumber, marker + 1, line.slice(marker));
  }

  return segments;
}
