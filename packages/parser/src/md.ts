/**
 * Jxsuite/md — Markdown integration for Jx
 *
 * Provides two exports:
 *   - MarkdownFile       — Parse a single markdown file (external class for $prototype)
 *   - MarkdownCollection — Parse a glob of markdown files as a content collection
 *
 * Built on the unified/remark ecosystem. Converts MDAST to JX node trees via mdastNodeToJx.
 *
 * @module @jxsuite/md
 * @license MIT
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkParseFrontmatter from "remark-parse-frontmatter";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import { readFileSync } from "node:fs";
import { basename, extname, resolve as resolvePath } from "node:path";
import { globSync } from "glob";
import { mdastNodeToJx } from "./transpile.ts";
import type { MarkdownFileResult, MdastNode, TocEntry } from "./types.ts";
import type { JxElement } from "@jxsuite/schema/types";

// ─── Tree utilities (inline to avoid Bun ESM resolution issues with unist-util-*) ──

/**
 * Walk an AST tree, calling visitor for nodes matching the given type.
 *
 * @param {object} tree
 * @param {string | function} typeOrVisitor
 * @param {function} [maybeVisitor]
 */
function visit(
  tree: MdastNode,
  typeOrVisitor: string | ((node: MdastNode) => void),
  maybeVisitor?: (node: MdastNode) => void,
) {
  const type = typeof typeOrVisitor === "string" ? typeOrVisitor : null;
  const visitor = type ? maybeVisitor : typeOrVisitor;

  function walk(node: MdastNode) {
    if (!node || typeof node !== "object") {
      return;
    }
    if (!type || node.type === type) {
      (visitor as (node: MdastNode) => void)(node);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }
  walk(tree as MdastNode);
}

/**
 * Serialize an mdast tree to plain text.
 *
 * @param {MdastNode} node
 * @returns {string}
 */
function mdastToString(node: MdastNode): string {
  if (!node) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (node.value) {
    return node.value;
  }
  if (Array.isArray(node.children)) {
    return node.children.map(mdastToString).join("");
  }
  return "";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Estimate reading time based on word count (~200 wpm average).
 *
 * @param {string} text
 * @returns {number} Minutes (rounded up, minimum 1)
 */
function readingTime(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

/**
 * Extract table of contents entries from an mdast tree.
 *
 * @param {object} tree - Mdast AST
 * @returns {{ depth: number; text: string; id: string }[]}
 */
function extractToc(tree: MdastNode) {
  /** @type {{ depth: number; text: string; id: string }[]} */
  const entries: TocEntry[] = [];
  visit(tree, "heading", (node: MdastNode) => {
    const text = mdastToString(node);
    const id = text
      .toLowerCase()
      .replaceAll(/[^\w\s-]/g, "")
      .replaceAll(/\s+/g, "-")
      .replaceAll(/-+/g, "-")
      .replaceAll(/^-|-$/g, "");
    entries.push({ depth: node.depth as number, id, text });
  });
  return entries;
}

/**
 * Extract first paragraph as a JX text string from an mdast tree.
 *
 * @param {object} tree - Mdast AST
 * @returns {string} Plain text of first paragraph, or empty string
 */
function extractExcerpt(tree: MdastNode) {
  let firstParagraph: MdastNode | null = null;
  visit(tree, "paragraph", (node: MdastNode) => {
    if (!firstParagraph) {
      firstParagraph = node;
    }
  });
  if (!firstParagraph) {
    return "";
  }
  return mdastToString(firstParagraph);
}

/**
 * Process a single markdown source string into a MarkdownFileResult.
 *
 * Converts the MDAST directly to JX nodes via mdastNodeToJx — no rehype/HTML intermediary.
 *
 * @param {string} source - Raw markdown string
 * @param {string} filePath - File path (for slug derivation)
 * @param {object} config - Processing options
 * @param {boolean} [config.directives] - Enable directive support
 * @param {unknown} [config.directiveOptions] - Directive plugin options
 * @returns {MarkdownFileResult}
 */
export function processMarkdown(
  source: string,
  filePath: string,
  config: {
    directives?: boolean;
    directiveOptions?: unknown;
  } = {},
) {
  let processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkParseFrontmatter)
    .use(remarkGfm);

  if (config.directives || config.directiveOptions) {
    processor = processor.use(remarkDirective);
  }

  const tree = processor.parse(source);
  const vfile = { data: {} };
  processor.runSync(tree, vfile);

  const vfileData = vfile.data as Record<string, unknown>;
  const frontmatter = (vfileData.frontmatter ?? {}) as Record<string, unknown>;
  const mdTree = tree as unknown as MdastNode;
  const plainText = mdastToString(mdTree);
  const toc = extractToc(tree);
  const excerpt = extractExcerpt(tree);
  const slug = basename(filePath, extname(filePath));

  const bodyNodes = tree.children.filter(
    (n: MdastNode) => n.type !== "yaml" && n.type !== "toml",
  ) as MdastNode[];
  const $children = bodyNodes.map((n: MdastNode) => mdastNodeToJx(n)).filter(Boolean) as (
    | JxElement
    | string
  )[];

  return {
    $children,
    $excerpt: excerpt,
    $readingTime: readingTime(plainText),
    $toc: toc,
    $wordCount: plainText.split(/\s+/).filter(Boolean).length,
    frontmatter,
    path: filePath,
    slug,
  };
}

/**
 * Resolve a dot-notation path within an object.
 *
 * @param {Record<string, unknown> | MarkdownFileResult} obj
 * @param {string} path
 * @returns {unknown}
 */
function getNestedValue(obj: Record<string, unknown> | MarkdownFileResult, path: string) {
  let current: unknown = obj;
  for (const k of path.split(".")) {
    current = (current as Record<string, unknown> | undefined)?.[k];
  }
  return current;
}

// ─── Markdown format class (re-exported from browser-safe module) ────────────

export { Markdown } from "./markdown.ts";

// ─── MarkdownCollection ───────────────────────────────────────────────────────

/**
 * Parse a glob of markdown files into a sorted, filterable array. Satisfies the Jx external class
 * contract ($prototype).
 *
 * @example
 *   { "$prototype": "MarkdownCollection", "$src": "@jxsuite/md", "src": "./posts/*.md" }
 */
export class MarkdownCollection {
  config: {
    src: string;
    sortBy?: string;
    sortOrder?: string;
    limit?: number;
    filter?: (result: MarkdownFileResult) => boolean;
    remarkPlugins?: unknown[];
    rehypePlugins?: unknown[];
    basePath?: string;
    directives?: boolean;
  };
  /**
   * @param {object} config
   * @param {string} config.src - Glob pattern or directory path
   * @param {string} [config.sortBy] Default is `'frontmatter.date'`
   * @param {string} [config.sortOrder] Default is `'desc'`
   * @param {number} [config.limit]
   * @param {(result: MarkdownFileResult) => boolean} [config.filter] - Filter function
   * @param {unknown[]} [config.remarkPlugins] Default is `[]`
   * @param {unknown[]} [config.rehypePlugins] Default is `[]`
   * @param {string} [config.basePath] - Base path for resolving glob
   * @param {boolean} [config.directives] - Enable directive support
   */
  constructor(config: {
    src: string;
    sortBy?: string;
    sortOrder?: string;
    limit?: number;
    filter?: (result: MarkdownFileResult) => boolean;
    remarkPlugins?: unknown[];
    rehypePlugins?: unknown[];
    basePath?: string;
    directives?: boolean;
  }) {
    this.config = config;
  }

  /**
   * Glob files, parse each, sort, filter, and limit.
   *
   * @returns {Promise<MarkdownFileResult[]>} Array of MarkdownFileResult
   */
  async resolve() {
    const {
      src,
      sortBy = "frontmatter.date",
      sortOrder = "desc",
      limit,
      filter,
      basePath,
      ...processorConfig
    } = this.config;

    const resolved = basePath ? resolvePath(basePath, src) : src;
    // Normalize to forward slashes — glob requires POSIX paths on all platforms
    const pattern = resolved.split("\\").join("/");
    const files = globSync(pattern, { absolute: true });

    const results = files.map((filePath: string) => {
      const source = readFileSync(filePath, "utf8");
      return processMarkdown(source, filePath, processorConfig);
    });

    // Filter
    let filtered = results;
    if (typeof filter === "function") {
      filtered = results.filter((r: MarkdownFileResult) =>
        (filter as (r: MarkdownFileResult) => boolean)(r),
      );
    }

    // Sort
    filtered.sort((a: MarkdownFileResult, b: MarkdownFileResult) => {
      const aVal = getNestedValue(a, sortBy) ?? ("" as string | number);
      const bVal = getNestedValue(b, sortBy) ?? ("" as string | number);
      if (aVal < bVal) {
        return sortOrder === "asc" ? -1 : 1;
      }
      if (aVal > bVal) {
        return sortOrder === "asc" ? 1 : -1;
      }
      return 0;
    });

    // Limit
    if (limit && limit > 0) {
      return filtered.slice(0, limit);
    }

    return filtered;
  }
}

// ─── Jx Markdown Transpiler (re-exported from browser-safe module) ──────────

export {
  expandDotPaths,
  collapseDotPaths,
  expandStylePaths,
  collapseStylePaths,
  applyStyleKeyMapping,
  isJxMarkdown,
  transpileJxMarkdown,
  mdastNodeToJx,
  convertChildren,
  jxKey,
  mdKey,
} from "./transpile.ts";
