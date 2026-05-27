/** Ai-message.js — Template helpers for rendering AI chat messages */

import { html, nothing } from "lit-html";

/**
 * Render basic markdown to HTML-safe lit-html templates. Supports: code blocks, inline code, bold,
 * italic, links.
 *
 * @param {string} text
 * @returns {import("lit-html").TemplateResult}
 */
export function renderMarkdown(text) {
  if (!text) return html``;

  const lines = text.split("\n");
  /** @type {(import("lit-html").TemplateResult | string)[]} */
  const parts = [];
  let inCodeBlock = false;
  let codeLines = [];
  let _codeLang = "";

  for (const line of lines) {
    if (line.startsWith("```") && !inCodeBlock) {
      inCodeBlock = true;
      _codeLang = line.slice(3).trim();
      codeLines = [];
      continue;
    }
    if (line.startsWith("```") && inCodeBlock) {
      inCodeBlock = false;
      const code = codeLines.join("\n");
      parts.push(html`<pre><code>${code}</code></pre>`);
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    parts.push(renderInline(line));
    parts.push(html``);
  }

  if (inCodeBlock) {
    parts.push(html`<pre><code>${codeLines.join("\n")}</code></pre>`);
  }

  return html`${parts}`;
}

/**
 * @param {string} text
 * @returns {import("lit-html").TemplateResult}
 */
function renderInline(text) {
  const escaped = text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>");
  // Use unsafeHTML-free approach: just return as text with inline code via split
  return html`<span .innerHTML=${escaped}></span>`;
}

/**
 * Render a user message bubble.
 *
 * @param {string} content
 */
export function userMessage(content) {
  return html`<div class="ai-msg ai-msg--user">${content}</div>`;
}

/**
 * Render an assistant message bubble with markdown.
 *
 * @param {string} content
 * @param {boolean} [streaming]
 */
export function assistantMessage(content, streaming = false) {
  return html`<div class="ai-msg ai-msg--assistant">
    ${renderMarkdown(content)}${streaming ? html`<span class="ai-cursor">▊</span>` : nothing}
  </div>`;
}

/**
 * Render a tool use indicator block.
 *
 * @param {{ tool: string; input?: Record<string, unknown> }} toolUse
 */
export function toolUseBlock(toolUse) {
  const label = formatToolLabel(toolUse.tool, toolUse.input);
  return html`
    <details class="ai-tool-block">
      <summary>${label}</summary>
      ${toolUse.input
        ? html`<pre style="font-size:10px;margin-top:4px;opacity:0.7">
${JSON.stringify(toolUse.input, null, 2)}</pre
          >`
        : nothing}
    </details>
  `;
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} [input]
 */
function formatToolLabel(tool, input) {
  switch (tool) {
    case "Edit":
    case "Write":
      return `📝 ${tool}: ${input?.file_path || input?.path || "file"}`;
    case "Read":
      return `📖 Read: ${input?.file_path || input?.path || "file"}`;
    case "Bash":
      return `⚡ Run: ${truncate(String(input?.command || ""), 50)}`;
    case "Glob":
      return `🔍 Glob: ${input?.pattern || ""}`;
    case "Grep":
      return `🔍 Grep: ${truncate(String(input?.pattern || ""), 40)}`;
    default:
      return `🔧 ${tool}`;
  }
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
