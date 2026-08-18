/**
 * Markdown — the markdown format-extension class for Jx
 *
 * Single class carrying every format capability:
 * - static `parse` (markdown source → Jx document) — browser-safe
 * - static `serialize` (Jx document → markdown source) — browser-safe
 * - static `discover` / `load` (compile-time content access) — node-only, dynamic imports
 * - instance `resolve` (runtime on-demand access for `$prototype: "Markdown"` state)
 *
 * The node-only capabilities dynamically import `node:fs` / `./md.ts` inside the
 * method so this module stays importable in the browser (studio calls parse/serialize
 * in-process).
 *
 * @module @jxsuite/parser/markdown
 * @license MIT
 */

import { transpileJxMarkdown } from "./transpile.ts";
import { serializeJxMarkdown } from "./serialize.ts";
import type { SerializeOptions } from "./serialize.ts";
import type { JxDocument } from "@jxsuite/schema/types";
import type { ContentLoaderEntry, MarkdownFileResult } from "./types.ts";

export interface MarkdownLoadOptions {
  /** Options for the MarkdownDirective plugin (allowedNames, prefix, ...). */
  directiveOptions?: unknown;
  /** Enable remark-directive parsing. Implied by directiveOptions. */
  directives?: boolean;
  /**
   * Resolved content-source root directory. When set, entries in subdirectories get path-based ids
   * (`studio/canvas` for `studio/canvas.md`, `/index` stripped); files directly at the root keep
   * basename ids.
   */
  sourceRoot?: string;
}

/**
 * Markdown format class. Satisfies the Jx external class contract ($prototype + instance resolve)
 * and the format capability contract (static parse / serialize / discover / load).
 *
 * @example
 *   { "$prototype": "Markdown", "$src": "@jxsuite/parser/Markdown.class.json", "src": "./post.md" }
 */
export class Markdown {
  config: { src: string; basePath?: string } & MarkdownLoadOptions;

  constructor(config: { src: string; basePath?: string } & MarkdownLoadOptions) {
    this.config = config;
  }

  /** Transpile Jx Markdown source into a complete Jx JSON document (browser-safe). */
  static parse(source: string): JxDocument {
    return transpileJxMarkdown(source);
  }

  /** Serialize a Jx document to markdown source (browser-safe). See SerializeOptions. */
  static serialize(doc: JxDocument, options?: SerializeOptions): string {
    return serializeJxMarkdown(doc, options);
  }

  /** List .md entry files for a content-type source (file path or directory). */
  static async discover(source: string, options: { baseDir?: string } = {}): Promise<string[]> {
    const { existsSync, readdirSync } = await import("node:fs");
    const { resolve, extname } = await import("node:path");
    const resolved = options.baseDir ? resolve(options.baseDir, source) : resolve(source);

    if (extname(resolved)) {
      return existsSync(resolved) ? [resolved] : [];
    }
    try {
      return readdirSync(resolved, { recursive: true })
        .filter((f) => String(f).endsWith(".md"))
        .map((f) => resolve(resolved, String(f)));
    } catch {
      return [];
    }
  }

  /** Load one markdown file into a content entry (frontmatter → data, body preserved). */
  static async load(
    path: string,
    options: MarkdownLoadOptions = {},
  ): Promise<ContentLoaderEntry[]> {
    const { processMarkdown } = await import("./md.ts");
    const { readFileSync, statSync } = await import("node:fs");
    const source = readFileSync(path, "utf8");
    const result = processMarkdown(source, path, {
      ...(options.directives !== undefined && { directives: options.directives }),
      ...(options.directiveOptions !== undefined && {
        directiveOptions: options.directiveOptions,
      }),
      ...(options.sourceRoot !== undefined && { sourceRoot: options.sourceRoot }),
    });
    const _meta: ContentLoaderEntry["_meta"] = {};
    /*
     * The modification time is the only date a file always has. A feed falls back to it when the
     * frontmatter carries none, and it is what would let the sitemap stop giving every page
     * generated from one template that template's `<lastmod>`.
     */
    try {
      _meta.mtime = statSync(path)
        .mtime.toISOString()
        .replace(/\.\d{3}Z$/, "Z");
    } catch {
      // A format class may be handed content that is not on disk; an absent mtime is not an error.
    }
    if (result.$excerpt != null) {
      _meta.excerpt = result.$excerpt;
    }
    if (result.$toc != null) {
      _meta.toc = result.$toc;
    }
    if (result.$readingTime != null) {
      _meta.readingTime = result.$readingTime;
    }
    if (result.$wordCount != null) {
      _meta.wordCount = result.$wordCount;
    }
    return [
      {
        $children: result.$children,
        _meta,
        body: source,
        data: result.frontmatter,
        id: result.slug,
      },
    ];
  }

  /** Runtime on-demand access: parse the configured markdown file. */
  async resolve(): Promise<MarkdownFileResult> {
    const { processMarkdown } = await import("./md.ts");
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { src, basePath, ...processorConfig } = this.config;
    const filePath = basePath ? resolve(basePath, src) : resolve(src);
    const source = readFileSync(filePath, "utf8");
    return processMarkdown(source, filePath, processorConfig);
  }
}
