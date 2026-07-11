/**
 * Html-to-jx — compatibility shim.
 *
 * The HTML → Jx conversion pipeline moved to `@jxsuite/markup/html-to-jx`; this module
 * re-exports it so the parser's historical `@jxsuite/parser/html-to-jx` entrypoint keeps
 * working for downstream consumers.
 *
 * @module @jxsuite/parser/html-to-jx
 * @license MIT
 */

export { htmlToJx } from "@jxsuite/markup/html-to-jx";
