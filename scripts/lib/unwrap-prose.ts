/**
 * Put each paragraph on one line, so a Markdown source file never wraps and an editor's soft wrap
 * is the only wrapping a reader sees.
 *
 * Source wrapping and soft wrapping fight each other. Soft wrap re-flows to the viewport; a
 * hard-wrapped file is already flowed to somebody else's viewport, so the two interleave into
 * ragged half-width lines that change shape with the window. It also makes prose diffs unreadable:
 * editing a hard-wrapped paragraph re-flows every line after the edit, so a one-word change reads
 * as a five-line change.
 *
 * **Oxfmt cannot do this.** Its `proseWrap: "never"` only knows CommonMark, so it folds a
 * `:::doc-note` marker into the paragraph beneath it and joins the `::starter-card` directives on
 * `sites/jxsuite.com/pages/templates.md` into one line, which drops seven starters out of the page
 * and reds `docs:claims`. Hence this pass, run beside it.
 *
 * **The block structure is parsed, not pattern-matched.** An earlier version of this file scanned
 * lines against a list of "structural" regexes, and the price was that everything with a line
 * prefix was excluded rather than handled: a wrapped list item and a wrapped block quote both
 * stayed wrapped, which is most of the corpus. This one parses with the same stack that renders the
 * pages — `remark-parse` + GFM + frontmatter + directives, the pipeline in
 * `extensions/parser/src/md.ts` — and joins line breaks only inside a `paragraph` node. Tables,
 * fenced and indented code, frontmatter, headings, HTML blocks, link and footnote definitions,
 * thematic breaks and every directive marker are other node types, so they are never touched by
 * construction rather than by a rule somebody has to remember to add.
 *
 * **The edit is made on source offsets, never by re-serialising the tree.** The output is the input
 * with specific newlines replaced by single spaces, so a parse that is subtly wrong about inline
 * syntax cannot rewrite a character of content.
 *
 * Two kinds of line break survive:
 *
 * 1. **A hard break the author wrote** — a trailing backslash, or two trailing spaces, which the
 *    parser reports as a `break` node. The two-space form is normalised to a backslash, because an
 *    invisible break is one an editor, a linter or a careless paste silently deletes.
 * 2. **A labelled run** — two or more consecutive lines that each open with a bold key, as a spec
 *    header's `**Version:** … / **Status:** … / **Updated:** …` does. Those lines are a list that
 *    happens to lack a marker, not a wrapped sentence, so joining them destroys the document. They
 *    get explicit backslash breaks instead, which is the same intent written where a parser and a
 *    reader can both see it.
 * 3. **A line that is nothing but a text directive** — `:span[Workflow]{style.display="block" …}` on
 *    `sites/jxsuite.com/pages/index.md`. The syntax is inline and the intent is a block, which is
 *    what the directive's own attributes say; joining two of them yields 500 characters of markup
 *    soup on one line. This one gets no marker either, because a hard break between two blocks is a
 *    `<br>` nobody asked for, and a break that changes the rendering is not formatting.
 *
 * @docs extending/contributing/docs
 */

import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * A run of lines that each open with `**Key:**`. See the header: this is a list without a marker,
 * and the only shape in this corpus whose line breaks are meaning rather than wrapping.
 */
const LABELLED = /^\*\*[^*\n]+:\*\*/;

/** Block-quote markers and indentation a continuation line carries. Never content. */
const CONTINUATION_PREFIX = /^(?:\s*>)*\s*/;

/**
 * Whether a line already ends in a hard break. An ODD run of trailing backslashes is one; an even
 * run is an escaped backslash the author wrote as content, and appending to it would silently turn
 * a literal `\\` into a line break.
 *
 * Exported for `spec-bump.ts`, which rewrites lines inside a spec's labelled header block and has
 * to put back the marker it overwrote.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function endsInHardBreak(line: string): boolean {
  return (/\\*$/.exec(line)?.[0].length ?? 0) % 2 === 1;
}

/** Minimal structural surface of the unified processor — the ESM-only types read as `any`. */
interface MarkdownProcessor {
  use: (plugin: unknown, ...options: unknown[]) => MarkdownProcessor;
  parse: (source: string) => MdNode;
}

interface MdNode {
  type: string;
  children?: MdNode[];
  position?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

const processor = (unified as unknown as () => MarkdownProcessor)()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkDirective);

export interface UnwrapResult {
  text: string;
  /** 1-based lines that moved, for a `--check` report that points somewhere. */
  lines: number[];
}

/**
 * Every `paragraph` in the tree, in document order.
 *
 * @param {MdNode} node
 * @param {MdNode[]} found
 * @returns {MdNode[]}
 */
function paragraphs(node: MdNode, found: MdNode[] = []): MdNode[] {
  if (node.type === "paragraph") {
    found.push(node);
  }
  for (const child of node.children ?? []) {
    paragraphs(child, found);
  }
  return found;
}

/**
 * The 1-based lines a hard break inside this paragraph starts. A `break` spans from the end of the
 * text before it to column 1 of the next line, so its END line is the continuation.
 *
 * @param {MdNode} node
 * @param {Set<number>} found
 * @returns {Set<number>}
 */
function breakLines(node: MdNode, found = new Set<number>()): Set<number> {
  if (node.type === "break" && node.position) {
    found.add(node.position.end.line);
  }
  for (const child of node.children ?? []) {
    breakLines(child, found);
  }
  return found;
}

/**
 * The 1-based lines this paragraph gives over entirely to one text directive. See the header: the
 * syntax is inline, the intent is a block, and the line break between two of them is structure.
 *
 * @param {MdNode} node
 * @param {string[]} lines
 * @param {Set<number>} found
 * @returns {Set<number>}
 */
function soloDirectiveLines(node: MdNode, lines: string[], found = new Set<number>()): Set<number> {
  const at = node.position;
  if (node.type === "textDirective" && at && at.start.line === at.end.line) {
    const line = lines[at.start.line - 1] ?? "";
    const before = line.slice(0, at.start.column - 1);
    const after = line.slice(at.end.column - 1);
    if (CONTINUATION_PREFIX.exec(before)?.[0].length === before.length && after.trim() === "") {
      found.add(at.start.line);
    }
  }
  for (const child of node.children ?? []) {
    soloDirectiveLines(child, lines, found);
  }
  return found;
}

/**
 * Join every hard-wrapped paragraph in one document onto a single line.
 *
 * @param {string} source
 * @returns {UnwrapResult}
 */
export function unwrapProse(source: string): UnwrapResult {
  const lines = source.split("\n");
  /** 1-based lines to fold into the line above. */
  const join = new Set<number>();
  /** 1-based lines that must end with an explicit `\` break. */
  const mark = new Set<number>();

  let tree: MdNode;
  try {
    tree = processor.parse(source);
  } catch {
    return { lines: [], text: source }; // Unparseable: not this pass's problem to guess at.
  }

  for (const paragraph of paragraphs(tree)) {
    const span = paragraph.position;
    if (!span || span.end.line <= span.start.line) {
      continue;
    }
    const hard = breakLines(paragraph);
    const body = lines
      .slice(span.start.line - 1, span.end.line)
      .map((line) => line.replace(CONTINUATION_PREFIX, ""));

    if (body.every((line) => LABELLED.test(line))) {
      for (let n = span.start.line; n < span.end.line; n += 1) {
        mark.add(n);
      }
      continue;
    }
    const solo = soloDirectiveLines(paragraph, lines);
    for (let n = span.start.line + 1; n <= span.end.line; n += 1) {
      if (hard.has(n)) {
        mark.add(n - 1);
      } else if (!solo.has(n) && !solo.has(n - 1)) {
        join.add(n);
      }
    }
  }

  const moved: number[] = [];
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const marked = mark.has(number)
      ? endsInHardBreak(line.trimEnd())
        ? line.trimEnd()
        : `${line.trimEnd()}\\`
      : line;
    if (marked !== line) {
      moved.push(number);
    }
    if (join.has(number)) {
      out[out.length - 1] += ` ${marked.replace(CONTINUATION_PREFIX, "").trimEnd()}`;
      moved.push(number);
      continue;
    }
    out.push(marked);
  }

  return { lines: [...new Set(moved)].toSorted((a, b) => a - b), text: out.join("\n") };
}
