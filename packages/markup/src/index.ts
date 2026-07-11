/**
 * Markup — browser-safe markup conversion utilities.
 *
 * Re-exports the package's two pipelines: `htmlToJx` (HTML string → Jx tree nodes) and
 * `markdownToHtml` (markdown → sanitized HTML string). Both are DOM-free and node-free, so
 * they are safe for any bundle target (studio, workers, node).
 *
 * @module @jxsuite/markup
 * @license MIT
 */

export { htmlToJx } from "./html-to-jx";
export { markdownToHtml } from "./md-html";
