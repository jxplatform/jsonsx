/**
 * Md-html — compatibility shim.
 *
 * The browser-safe markdown → sanitized HTML pipeline moved to `@jxsuite/markup/md-html`;
 * this module re-exports it so the parser's historical `@jxsuite/parser/md-html`
 * entrypoint keeps working for downstream consumers.
 *
 * @module @jxsuite/parser/md-html
 * @license MIT
 */

export { markdownToHtml } from "@jxsuite/markup/md-html";
