/// <reference lib="dom" />
/**
 * Sessions-view.js — the full-pane chat history list (VSCode-Copilot style).
 *
 * Renders the session rows (title, relative time, message count) with per-row delete,
 * a header with a New Chat action, and an empty state. Pure template functions — all
 * state and storage live in ai-panel / document-assistant.
 *
 * @license MIT
 */

import { html } from "lit-html";
import { now } from "../../services/clock";
import type { TemplateResult } from "lit-html";
import type { SessionMeta } from "../../services/ai-session-store";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Human relative timestamp: "just now", "5m ago", "3h ago", "yesterday", "4d ago", then a locale
 * date.
 *
 * @param {number} ts
 * @param {number} [at] Epoch milliseconds to measure against; defaults to the {@link now} seam.
 * @returns {string}
 */
export function relativeTime(ts: number, at: number = now()): string {
  const delta = Math.max(0, at - ts);
  if (delta < MINUTE) {
    return "just now";
  }
  if (delta < HOUR) {
    return `${Math.floor(delta / MINUTE)}m ago`;
  }
  if (delta < DAY) {
    return `${Math.floor(delta / HOUR)}h ago`;
  }
  if (delta < 2 * DAY) {
    return "yesterday";
  }
  if (delta < 7 * DAY) {
    return `${Math.floor(delta / DAY)}d ago`;
  }
  return new Date(ts).toLocaleDateString();
}

export interface SessionsListOptions {
  sessions: SessionMeta[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}

function renderRow(s: SessionMeta, opts: SessionsListOptions): TemplateResult {
  return html`
    <div class="ai-session-row" @click=${() => opts.onOpen(s.id)}>
      <div class="ai-session-text">
        <div class="ai-session-title">${s.title}</div>
        <div class="ai-session-meta">
          ${relativeTime(s.updatedAt)} · ${s.messageCount}
          ${s.messageCount === 1 ? "message" : "messages"}
        </div>
      </div>
      <sp-action-button
        quiet
        size="s"
        class="ai-session-delete"
        title="Delete chat"
        @click=${(e: Event) => {
          e.stopPropagation();
          opts.onDelete(s.id);
        }}
      >
        <sp-icon-delete slot="icon"></sp-icon-delete>
      </sp-action-button>
    </div>
  `;
}

/** The sessions pane: header ("Chats" + New Chat) above the scrollable session rows. */
export function renderSessionsList(opts: SessionsListOptions): TemplateResult {
  return html`
    <div class="ai-chat-header">
      <span class="ai-chat-title">Chats</span>
      <span class="ai-header-spacer"></span>
      <sp-action-button size="s" quiet title="New chat" @click=${opts.onNew}>
        <sp-icon-add slot="icon"></sp-icon-add>
        New Chat
      </sp-action-button>
    </div>
    <div class="ai-sessions">
      ${
        opts.sessions.length === 0
          ? html`<div class="ai-sessions-empty">No previous chats</div>`
          : opts.sessions.map((s) => renderRow(s, opts))
      }
    </div>
  `;
}
