/// <reference lib="dom" />
/**
 * Chat-view.js — the active-conversation templates: header and message list.
 *
 * Message-row anatomy: user messages render as right-aligned bubbles (attached-context
 * blocks become chips), assistant messages render sanitized markdown plus tool-call
 * chips, tool messages surface failures only (ADR §11.3), the streaming tail renders
 * as plain text with a cursor (markdown parses once on finalize), and chat errors get
 * a danger row with recovery advice. Pure templates — state lives in ai-panel.
 *
 * @license MIT
 */

import { html, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import type { Message, ToolCallRecord } from "@jxsuite/ai/chat-state";
import { splitAttachedContext } from "./attached-context";
import { renderMarkdown } from "./chat-markdown";

// ─── Helpers (moved from ai-panel.ts) ────────────────────────────────────────

/**
 * Parse a tool result message content (JSON string) into its success/error shape. Returns null if
 * the content isn't a valid tool result.
 *
 * @param {string} content
 * @returns {{ success: boolean; error?: string; summary?: string } | null}
 */
export function tryParseToolResult(
  content: string,
): { success: boolean; error?: string; summary?: string } | null {
  try {
    const parsed = JSON.parse(content) as { success?: unknown; error?: string; summary?: string };
    if (parsed && typeof parsed.success === "boolean") {
      return parsed as { success: boolean; error?: string; summary?: string };
    }
  } catch {
    /* Not JSON — not a tool result */
  }
  return null;
}

/**
 * Label for an assistant tool call: the tool name plus the target path when present.
 *
 * @param {{ name: string; arguments: string }} tc
 * @returns {string}
 */
export function formatToolLabel(tc: { name: string; arguments: string }): string {
  let detail = "";
  try {
    const args = (tc.arguments ? JSON.parse(tc.arguments) : {}) as {
      path?: unknown;
      parentPath?: unknown;
    };
    if (Array.isArray(args.path)) {
      detail = `: ${JSON.stringify(args.path)}`;
    } else if (Array.isArray(args.parentPath)) {
      detail = `: ${JSON.stringify(args.parentPath)}`;
    }
  } catch {
    /* Partial/unparsed args — show name only */
  }
  return `${tc.name}${detail}`;
}

/**
 * Return actionable advice for common AI assistant errors so the user knows how to recover instead
 * of just seeing a raw error message.
 *
 * @param {string} error
 * @returns {string}
 */
export function formatErrorAdvice(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("no api key") || lower.includes("401")) {
    return "Use the settings button below the message box to add an OpenAI-compatible API key.";
  }
  if (lower.includes("network error") || lower.includes("fetch")) {
    return "Check that the dev server is running and reachable.";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "The API rate limit was hit. Wait a moment and try again.";
  }
  if (lower.includes("500") || lower.includes("internal")) {
    return "The upstream API returned a server error. Try again in a moment.";
  }
  return "";
}

// ─── Header ─────────────────────────────────────────────────────────────────

export interface ChatHeaderOptions {
  /** The open session's title, or null for a fresh unsaved chat. */
  title: string | null;
  streaming: boolean;
  onShowSessions: () => void;
  onNewChat: () => void;
}

/** The chat header: history button, session title, streaming spinner, New Chat. */
export function renderChatHeader(opts: ChatHeaderOptions): TemplateResult {
  return html`
    <div class="ai-chat-header">
      <sp-action-button size="s" quiet title="Chat history" @click=${opts.onShowSessions}>
        <sp-icon-history slot="icon"></sp-icon-history>
      </sp-action-button>
      <span class="ai-chat-title">${opts.title ?? "New chat"}</span>
      <span class="ai-header-spacer"></span>
      ${
        opts.streaming
          ? html`<sp-progress-circle size="s" indeterminate></sp-progress-circle>`
          : nothing
      }
      <sp-action-button size="s" quiet title="New chat" @click=${opts.onNewChat}>
        <sp-icon-add slot="icon"></sp-icon-add>
      </sp-action-button>
    </div>
  `;
}

// ─── Message rows ───────────────────────────────────────────────────────────

function renderUserMessage(msg: Message): TemplateResult {
  const { body, contextLines } = splitAttachedContext(msg.content);
  return html`
    <div class="ai-msg-user">
      <div class="ai-msg-user-body">${body}</div>
      ${
        contextLines.length > 0
          ? html`
              <div class="ai-msg-context-chips">
                ${contextLines.map((line) => html`<span class="ai-context-chip">${line}</span>`)}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderToolChips(toolCalls: ToolCallRecord[]): TemplateResult | typeof nothing {
  if (toolCalls.length === 0) {
    return nothing;
  }
  return html`
    <div class="ai-msg-tools">
      ${toolCalls.map(
        (tc) => html`
          <span class="ai-tool-chip">
            <sp-icon-gears size="xs"></sp-icon-gears>
            ${formatToolLabel(tc)}
          </span>
        `,
      )}
    </div>
  `;
}

function renderAssistantMessage(msg: Message): TemplateResult | typeof nothing {
  const toolCalls = msg.toolCalls ?? [];
  if (!msg.content && toolCalls.length === 0) {
    return nothing;
  }
  return html`
    <div class="ai-msg-assistant">
      ${msg.content ? renderMarkdown(msg.id, msg.content) : nothing} ${renderToolChips(toolCalls)}
    </div>
  `;
}

function renderToolMessage(msg: Message): TemplateResult | typeof nothing {
  // Show only failed tool results so the user knows why an edit didn't land
  // (ADR §11.3). Successful tool results stay hidden to reduce noise.
  const parsed = tryParseToolResult(msg.content);
  if (!parsed || parsed.success) {
    return nothing;
  }
  return html`<div class="ai-msg-tool-error">⚠️ ${parsed.error || "Tool call failed"}</div>`;
}

function renderStreamingTail(msg: Message): TemplateResult {
  if (!msg.content) {
    return html`
      <div class="ai-msg-typing">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;
  }
  return html`
    <div class="ai-msg-assistant">
      <span class="ai-msg-streaming">${msg.content}</span>
      ${renderToolChips(msg.toolCalls ?? [])}
    </div>
  `;
}

// ─── Message list ───────────────────────────────────────────────────────────

export interface MessageListOptions {
  messages: Message[];
  /** ChatState status — "streaming" renders the tail live. */
  status: string;
  error: string | null;
  onScroll: (e: Event) => void;
  /** Ref to the scrolling element, for stick-to-bottom maintenance. */
  listRef: (el: Element | undefined) => void;
}

/** The scrollable message list — THE scroller of the chat view. */
export function renderMessageList(opts: MessageListOptions): TemplateResult {
  const { messages, status } = opts;
  const lastIdx = messages.length - 1;
  return html`
    <div class="ai-chat-messages" ${ref(opts.listRef)} @scroll=${opts.onScroll}>
      ${
        messages.length === 0 && status !== "streaming"
          ? html`
              <div class="ai-chat-empty">
                Ask the assistant to build or edit this page — it can add sections, restyle
                elements, and wire up components.
              </div>
            `
          : nothing
      }
      ${messages.map((msg, i) => {
        if (msg.role === "user") {
          return renderUserMessage(msg);
        }
        if (msg.role === "tool") {
          return renderToolMessage(msg);
        }
        if (msg.role === "assistant") {
          if (status === "streaming" && i === lastIdx) {
            return renderStreamingTail(msg);
          }
          return renderAssistantMessage(msg);
        }
        return nothing;
      })}
      ${
        status !== "streaming" && opts.error
          ? html`
              <div class="ai-msg-error">
                <div>${opts.error}</div>
                ${
                  formatErrorAdvice(opts.error)
                    ? html`<div class="ai-msg-error-advice">${formatErrorAdvice(opts.error)}</div>`
                    : nothing
                }
              </div>
            `
          : nothing
      }
    </div>
  `;
}
