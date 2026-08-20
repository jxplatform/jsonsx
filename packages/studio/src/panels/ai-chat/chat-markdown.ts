/**
 * Chat-markdown.js — memoized markdown rendering for assistant chat messages.
 *
 * Wraps @jxsuite/markup/md-html (sanitized markdown → HTML) with a per-message cache
 * keyed by message id + content length, so re-renders during streaming only re-parse
 * the message that actually grew.
 *
 * The HTML goes through `unsafeHTML`, which is this app's ONE injection sink, and it goes through
 * the Trusted Types policy on the way. md-html already sanitizes — raw HTML dropped, javascript:
 * URLs stripped — and the policy asserts that it did, rather than taking a comment's word for it.
 * A `createHTML` that passed its input through unchanged would satisfy the API and defend nothing.
 *
 * @license MIT
 */

import { html } from "lit-html";
import type { TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { markdownToHtml } from "@jxsuite/markup/md-html";
import { trustedHtml } from "../../services/trusted-types";

const cache = new Map<string, { len: number; html: string }>();

/**
 * Render a message's markdown content, memoized by message id.
 *
 * @param {string} id - Stable message id (cache key).
 * @param {string} content
 * @returns {TemplateResult}
 */
export function renderMarkdown(id: string, content: string): TemplateResult {
  let entry = cache.get(id);
  if (!entry || entry.len !== content.length) {
    entry = { len: content.length, html: markdownToHtml(content) };
    cache.set(id, entry);
  }
  return html`<div class="ai-msg-md">${unsafeHTML(String(trustedHtml(entry.html)))}</div>`;
}

/** Drop all cached renders (call on session switch / new chat). */
export function clearMarkdownCache() {
  cache.clear();
}
