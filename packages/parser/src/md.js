/**
 * jxsuite/md — Markdown integration for Jx
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
import { mdastNodeToJx } from "./transpile.js";

// ─── Tree utilities (inline to avoid Bun ESM resolution issues with unist-util-*) ──

/**
 * Walk an AST tree, calling visitor for nodes matching the given type.
 *
 * @param {object} tree
 * @param {string | function} typeOrVisitor
 * @param {function} [maybeVisitor]
 */
function visit(tree, typeOrVisitor, maybeVisitor) {
  const type = typeof typeOrVisitor === "string" ? typeOrVisitor : null;
  const visitor = type ? maybeVisitor : typeOrVisitor;

  function walk(/** @type {any} */ node) {
    if (!node || typeof node !== "object") return;
    if (!type || node.type === type) /** @type {Function} */ (visitor)(node);
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  }
  walk(tree);
}

/**
 * Serialize an mdast tree to plain text.
 *
 * @param {any} node
 * @returns {string}
 */
function mdastToString(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.value) return node.value;
  if (Array.isArray(node.children)) return node.children.map(mdastToString).join("");
  return "";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Estimate reading time based on word count (~200 wpm average).
 *
 * @param {string} text
 * @returns {number} Minutes (rounded up, minimum 1)
 */
function readingTime(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

/**
 * Extract table of contents entries from an mdast tree.
 *
 * @param {object} tree - Mdast AST
 * @returns {{ depth: number; text: string; id: string }[]}
 */
function extractToc(tree) {
  /** @type {{ depth: number; text: string; id: string }[]} */
  const entries = [];
  visit(tree, "heading", (/** @type {MdastNode} */ node) => {
    const text = mdastToString(node);
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    entries.push({ depth: /** @type {number} */ (node.depth), text, id });
  });
  return entries;
}

/**
 * Extract first paragraph as a JX text string from an mdast tree.
 *
 * @param {object} tree - Mdast AST
 * @returns {string} Plain text of first paragraph, or empty string
 */
function extractExcerpt(tree) {
  /** @type {MdastNode | null} */
  let firstParagraph = null;
  visit(tree, "paragraph", (/** @type {MdastNode} */ node) => {
    if (!firstParagraph) firstParagraph = node;
  });
  if (!firstParagraph) return "";
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
function processMarkdown(source, filePath, config = {}) {
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
  processor.runSync(tree, /** @type {any} */ (vfile));

  const vfileData = /** @type {Record<string, unknown>} */ (vfile.data);
  const frontmatter = /** @type {Record<string, unknown>} */ (vfileData.frontmatter ?? {});
  const plainText = mdastToString(tree);
  const toc = extractToc(tree);
  const excerpt = extractExcerpt(tree);
  const slug = basename(filePath, extname(filePath));

  const bodyNodes = /** @type {MdastNode[]} */ (
    tree.children.filter((/** @type {any} */ n) => n.type !== "yaml" && n.type !== "toml")
  );
  const $children = /** @type {(JxElement | string)[]} */ (
    bodyNodes.map(/** @type {(n: MdastNode) => any} */ (mdastNodeToJx)).filter(Boolean)
  );

  return {
    slug,
    path: filePath,
    frontmatter,
    $children,
    $excerpt: excerpt,
    $toc: toc,
    $readingTime: readingTime(plainText),
    $wordCount: plainText.split(/\s+/).filter(Boolean).length,
  };
}

/**
 * Resolve a dot-notation path within an object.
 *
 * @param {Record<string, unknown> | MarkdownFileResult} obj
 * @param {string} path
 * @returns {unknown}
 */
function getNestedValue(obj, path) {
  return path
    .split(".")
    .reduce(
      (/** @type {unknown} */ o, k) => /** @type {Record<string, unknown> | undefined} */ (o)?.[k],
      /** @type {unknown} */ (obj),
    );
}

// ─── MarkdownFile ─────────────────────────────────────────────────────────────

/**
 * Parse a single markdown file. Satisfies the Jx external class contract ($prototype).
 *
 * @example
 *   { "$prototype": "MarkdownFile", "$src": "@jxsuite/md", "src": "./content/about.md" }
 */
export class MarkdownFile {
  /**
   * @param {object} config
   * @param {string} config.src - File path to markdown file
   * @param {unknown[]} [config.remarkPlugins] Default is `[]`
   * @param {unknown[]} [config.rehypePlugins] Default is `[]`
   * @param {string} [config.basePath] - Base path for resolving src
   * @param {boolean} [config.directives] - Enable directive support
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * Parse and resolve the markdown file.
   *
   * @returns {MarkdownFileResult}
   */
  resolve() {
    const { src, basePath, ...processorConfig } = this.config;
    const filePath = basePath ? resolvePath(basePath, src) : resolvePath(src);
    const source = readFileSync(filePath, "utf-8");
    return processMarkdown(source, filePath, processorConfig);
  }
}

// ─── MarkdownCollection ───────────────────────────────────────────────────────

/**
 * Parse a glob of markdown files into a sorted, filterable array. Satisfies the Jx external class
 * contract ($prototype).
 *
 * @example
 *   { "$prototype": "MarkdownCollection", "$src": "@jxsuite/md", "src": "./posts/*.md" }
 */
export class MarkdownCollection {
  /**
   * @param {object} config
   * @param {string} config.src - Glob pattern or directory path
   * @param {string} [config.sortBy] Default is `'frontmatter.date'`
   * @param {string} [config.sortOrder] Default is `'desc'`
   * @param {number} [config.limit]
   * @param {Function} [config.filter] - Filter function
   * @param {unknown[]} [config.remarkPlugins] Default is `[]`
   * @param {unknown[]} [config.rehypePlugins] Default is `[]`
   * @param {string} [config.basePath] - Base path for resolving glob
   * @param {boolean} [config.directives] - Enable directive support
   */
  constructor(config) {
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

    const results = files.map((filePath) => {
      const source = readFileSync(filePath, "utf-8");
      return processMarkdown(source, filePath, processorConfig);
    });

    // Filter
    let filtered = results;
    if (typeof filter === "function") {
      filtered = results.filter(/** @type {(r: MarkdownFileResult) => boolean} */ (filter));
    }

    // Sort
    filtered.sort((a, b) => {
      const aVal = /** @type {any} */ (getNestedValue(a, sortBy) ?? "");
      const bVal = /** @type {any} */ (getNestedValue(b, sortBy) ?? "");
      if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
      if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
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
} from "./transpile.js";
