/**
 * The heading anchors a docs page publishes, derived the way the site derives them.
 *
 * Thirty-one links inside `/docs` point at a `#anchor`, and nothing has ever checked one. The slug
 * is not the heading text: it is `slugifyHeading` applied to the heading's RENDERED text, so the
 * backticks around `` `project.json` `` and the brackets around a link are gone by the time the id
 * is minted, and a repeated heading takes a `-2` suffix. Re-deriving that here by hand would put a
 * second implementation of the site's anchors in the repository, and the two would drift the first
 * time either moved. So this imports the real one from the parser, which costs about 40 ms.
 *
 * The rendered-text step is the part worth reading. `## Code mode: the whole file as source` and
 * ``## Code mode: the whole file as `source` `` are the same anchor, because the code span
 * contributes its content and not its punctuation.
 */

import { readFileSync } from "node:fs";
import { slugifyHeading } from "../../../extensions/parser/src/transpile.ts";

const FENCE = /^\s*(```|~~~)/;
const FRONTMATTER = /^---\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

export interface Heading {
  /** The heading as written, markup and all. */
  text: string;
  /** The published anchor, `-2` suffix included. */
  slug: string;
  depth: number;
  /** 1-based. */
  line: number;
}

/**
 * Reduce one heading's Markdown to the text a reader sees, which is what the slug is minted from.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function renderedHeadingText(markdown: string): string {
  return markdown
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // Image: alt text survives
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1") // Link: label survives
    .replaceAll(/:[a-z][\w-]*\[([^\]]*)\][^\s]*/gi, "$1") // Text directive, `:kbd[⌘K]`
    .replaceAll(/`+([^`]*)`+/g, "$1") // Code span
    .replaceAll(/(\*\*|__)(.*?)\1/g, "$2") // Strong
    .replaceAll(/(\*|_)(.*?)\1/g, "$2") // Emphasis
    .replaceAll(/<[^>]+>/g, "") // Inline HTML
    .trim();
}

/**
 * Every heading in one document, with the anchor it publishes.
 *
 * @param {string} source
 * @returns {Heading[]}
 */
export function headingsOf(source: string): Heading[] {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  let inFrontmatter = false;

  for (const [i, line] of source.split("\n").entries()) {
    if (inFrontmatter) {
      inFrontmatter = !FRONTMATTER.test(line);
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
    if (inFence) {
      continue;
    }
    const m = HEADING.exec(line);
    if (!m) {
      continue;
    }
    const text = m[2] ?? "";
    // `|| "section"` and the `-2` suffix are assignHeadingIds', not this file's invention.
    const base = slugifyHeading(renderedHeadingText(text)) || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({
      depth: m[1]?.length ?? 1,
      line: i + 1,
      slug: count === 0 ? base : `${base}-${count + 1}`,
      text,
    });
  }
  return headings;
}

/**
 * The anchors one file publishes.
 *
 * @param {string} path
 * @returns {Set<string>}
 */
export function anchorsOf(path: string): Set<string> {
  return new Set(headingsOf(readFileSync(path, "utf8")).map((h) => h.slug));
}
