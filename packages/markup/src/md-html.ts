/**
 * Md-html — browser-safe markdown → sanitized HTML string
 *
 * Small display pipeline for rendering untrusted markdown (e.g. LLM chat output) as
 * HTML: remark-parse + remark-gfm → remark-rehype (raw HTML disabled) → rehype-sanitize
 * (default schema: strips scripts, event handlers, javascript:/data: URLs) → stringify.
 *
 * Like everything in @jxsuite/markup this module has no node-only imports, so it is safe
 * for the studio bundle. It intentionally produces an HTML *string*, not Jx nodes — use
 * `@jxsuite/parser/markdown` for markdown → Jx document transpilation.
 *
 * @module @jxsuite/markup/md-html
 * @license MIT
 */

import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Minimal structural surface of the unified processor used here — same rationale as
 * `UnifiedProcessor` in @jxsuite/parser's types (oxlint sees the ESM-only unified types as `any`),
 * plus `processSync` which that shared type doesn't carry.
 */
interface MdHtmlProcessor {
  use: (plugin: unknown, ...options: unknown[]) => MdHtmlProcessor;
  processSync: (source: string) => { toString: () => string };
}

const processor = (unified as unknown as () => MdHtmlProcessor)()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeStringify);

/**
 * Convert markdown source to a sanitized HTML string (GFM tables/strikethrough/task lists
 * supported). Raw HTML in the source is dropped, not passed through.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToHtml(markdown: string): string {
  return String(processor.processSync(markdown));
}
