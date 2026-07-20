/// <reference lib="dom" />
/**
 * Ai-panel.ts — AI assistant tab for the right panel (Stack B document assistant).
 *
 * Native lit-html chat UI (VSCode-Copilot style) over the reactive document-assistant
 * session: a view-state machine (key gate → sessions list ↔ chat), a message list with
 * stick-to-bottom scrolling, and the sticky composer.
 *
 * Rendering: this panel owns a private rAF-coalesced render loop into the assistant
 * `.panel-body` container (bound once via {@link bindAiPanelHost}). It deliberately
 * bypasses the right-panel scheduler's focus guard — streaming must repaint while the
 * composer is focused — which is safe because nothing here is value-bound (the composer
 * textarea is uncontrolled). The right panel renders the same template into the same
 * container on tab switches; lit reconciles both paths through one part cache.
 *
 * @license MIT
 */

import { html, render as litRender, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { getPlatform } from "../platform";
import { effect, effectScope } from "../reactivity";
import { createDocumentAssistant } from "../services/document-assistant";
import { hasOpenAiKey, setOpenAiKey } from "../services/ai-settings";
import { fetchAvailableModels, isManagedProxy, isProxyConfigured } from "../services/ai-models";
import { createAiCredentialsForm } from "../ui/ai-credentials-form";
import { clearMarkdownCache } from "./ai-chat/chat-markdown";
import { renderChatHeader, renderMessageList } from "./ai-chat/chat-view";
import { createComposer } from "./ai-chat/composer";
import { renderSessionsList } from "./ai-chat/sessions-view";

import type { EffectScope } from "@vue/reactivity";

// ─── State (module-level, persists across tab switches) ─────────────────────

let mounted = false;

/** Whether the OpenAI key form is showing (gate when no key, or re-edit via the gear). */
let keyEditing = false;

/**
 * One-time proxy probe: managed platforms (cloud Workers AI) and env-keyed dev servers report
 * `configured` from /models, unlocking the assistant without a locally stored key. Fired lazily on
 * the first gated render.
 */
let proxyProbe: Promise<void> | null = null;

function ensureProxyProbe() {
  proxyProbe ??= fetchAvailableModels({ force: true })
    .catch(() => {
      // Unreachable proxy — the key gate stays up.
    })
    .then(() => {
      scheduleAiRender();
    });
}

/** Which pane the panel shows once the key gate is passed. */
let view: "chat" | "sessions" = "chat";

/** Document AST assistant session — created lazily, persists across tab switches. */
const assistant = createDocumentAssistant();
(globalThis as Record<string, unknown>).assistant = assistant;
let assistantScope: EffectScope | null = null;

// ─── Render loop ────────────────────────────────────────────────────────────

/** The assistant tab's `.panel-body` container, bound once by the right panel. */
let hostEl: HTMLElement | null = null;
let renderQueued = false;

/**
 * Bind the panel's render host and start the streaming watcher. Called once from the right panel's
 * container setup; replaces the old global render-bridge.
 *
 * @param {HTMLElement} el
 */
export function bindAiPanelHost(el: HTMLElement) {
  hostEl = el;
  watchAssistant();
}

/** Coalesce a re-render of the whole panel onto the next animation frame. */
function scheduleAiRender() {
  if (renderQueued || !hostEl) {
    return;
  }
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (hostEl) {
      litRender(renderAiPanelTemplate(), hostEl);
      maintainScroll();
    }
  });
}

/**
 * Reactively repaint on chat-state changes. Tracks the message count, the tail message's growth
 * (streaming deltas / tool calls), status, and errors; the actual DOM work happens in the
 * rAF-coalesced render, so token rate never exceeds frame rate.
 */
function watchAssistant() {
  assistantScope?.stop();
  assistantScope = effectScope();
  assistantScope.run(() => {
    effect(() => {
      const cs = assistant.chatState;
      void cs.messages.length;
      const last = cs.messages.at(-1);
      void last?.content;
      void last?.toolCalls?.length;
      void cs.status;
      void cs.error;
      scheduleAiRender();
    });
  });
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function mountAiPanel() {
  if (mounted) {
    return;
  }
  mounted = true;
}

// ─── Auto-scroll (stick to bottom unless the user scrolled up) ──────────────

let messagesEl: HTMLElement | null = null;
let stickToBottom = true;

/** How close (px) to the bottom still counts as "at the bottom". */
const STICK_THRESHOLD = 48;

function onMessagesScroll(e: Event) {
  const el = e.target as HTMLElement;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
}

function onMessagesListRef(el: Element | undefined) {
  messagesEl = (el as HTMLElement | undefined) ?? null;
  maintainScroll();
}

function maintainScroll() {
  if (messagesEl && stickToBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ─── OpenAI key settings ─────────────────────────────────────────────────────

/** The panel's shared credentials form (draft/model state lives inside the form's closure). */
const credsForm = createAiCredentialsForm({
  onCancel: () => {
    keyEditing = false;
  },
  onSaved: () => {
    keyEditing = false;
  },
  requestRender: scheduleAiRender,
});

/** Open the key form, pre-filled with the current settings. */
function startEditApiKey() {
  keyEditing = true;
  credsForm.startEdit();
}

// ─── Managed Cloudflare connect (Workers AI) ─────────────────────────────────

let cfConnectBusy = false;
let cfConnectError = "";

/**
 * Managed platforms broker Workers AI on the user's own Cloudflare account: offer connecting it as
 * the keyless alternative whenever the proxy says managed-but-unconfigured and the platform can run
 * the hosted OAuth flow (the PAL seam — desktop shells can implement cfConnect later).
 */
function canOfferManagedConnect(): boolean {
  return isManagedProxy() && !isProxyConfigured() && Boolean(getPlatform().cfConnect);
}

async function connectCloudflareForAi() {
  if (cfConnectBusy) {
    return;
  }
  cfConnectBusy = true;
  cfConnectError = "";
  scheduleAiRender();
  try {
    const connection = await getPlatform().cfConnect?.();
    if (connection) {
      // Re-probe: /models flips to configured once the connection lands, opening the gate.
      await fetchAvailableModels({ force: true });
    } else {
      cfConnectError = "Cloudflare connection was not completed.";
    }
  } catch (error) {
    cfConnectError = error instanceof Error ? error.message : String(error);
  }
  cfConnectBusy = false;
  scheduleAiRender();
}

function renderManagedConnect() {
  return html`
    <div class="ai-managed-connect">
      <div>Use Workers AI on your own Cloudflare account — no API key needed.</div>
      <sp-button size="s" ?disabled=${cfConnectBusy} @click=${() => void connectCloudflareForAi()}>
        ${cfConnectBusy ? "Connecting…" : "Connect Cloudflare"}
      </sp-button>
      ${cfConnectError
        ? html`<div class="ai-managed-connect-error">${cfConnectError}</div>`
        : nothing}
      <div class="ai-managed-connect-divider">— or bring your own key —</div>
    </div>
  `;
}

/**
 * The credentials gate: on managed platforms a keyless "Connect Cloudflare" (Workers AI) option
 * sits above the OpenAI-compatible key form — both are real, working paths.
 */
function renderKeyGate() {
  return html`
    <div class="ai-tab-body">
      <div class="ai-status-center">
        ${canOfferManagedConnect() ? renderManagedConnect() : nothing} ${credsForm.render()}
      </div>
    </div>
  `;
}

// ─── Sending ────────────────────────────────────────────────────────────────

/** Send a message through the document assistant agent loop. */
async function handleAssistantSend(text: string) {
  if (!text.trim() || assistant.chatState.status === "streaming") {
    return;
  }
  // A send always lands in the chat view, pinned to the newest message.
  view = "chat";
  stickToBottom = true;
  scheduleAiRender();
  try {
    await assistant.sendMessage(text);
  } catch {
    // Synchronous failure (e.g. network unreachable) — the DocumentAssistant's
    // Own try/catch calls chatState.setError(), which the watcher renders.
  }
}

/**
 * Seed the assistant with a prompt programmatically (e.g. the New Project flow handing off a
 * project brief). Delegates to the same send path as the composer. Safe to call right after the
 * Assistant tab renders — the reactive watcher paints chat-state into the panel whenever it
 * mounts.
 */
export async function seedAssistantPrompt(text: string): Promise<void> {
  await handleAssistantSend(text);
}

// ─── Automation seeding (screenshot runner) ─────────────────────────────────

/** A canned tool-call chip for {@link seedAssistantMessages}. */
export interface SeededToolCall {
  name: string;
  /** JSON-encoded arguments, e.g. `{"path":["children",0],"text":"…"}`. */
  arguments: string;
}

/** A canned transcript entry for {@link seedAssistantMessages}. */
export interface SeededAssistantMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: SeededToolCall[];
}

let seededCount = 0;

/**
 * Automation-only seam (scripts/screenshots): stage a canned conversation without ever invoking a
 * model. Stores an inert demo key so the key gate opens (localStorage-only on the dev server — no
 * request fires), switches to the chat view, and pushes fully-formed messages straight into the
 * reactive chat state — the same path session restore uses — so the panel repaints through its
 * normal watcher.
 */
export function seedAssistantMessages(messages: SeededAssistantMessage[]): void {
  setOpenAiKey("sk-demo");
  keyEditing = false;
  view = "chat";
  stickToBottom = true;
  for (const msg of messages) {
    seededCount += 1;
    const seq = seededCount;
    assistant.chatState.messages.push({
      content: msg.content,
      id: `seeded_${seq}`,
      role: msg.role,
      timestamp: seq,
      ...(msg.toolCalls
        ? {
            toolCalls: msg.toolCalls.map((tc, i) => ({
              arguments: tc.arguments,
              id: `seeded_${seq}_tc${i}`,
              name: tc.name,
            })),
          }
        : {}),
    });
  }
  scheduleAiRender();
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function stop() {
  assistant.stop();
}

function newChat() {
  assistant.newChat();
  clearMarkdownCache();
  view = "chat";
  stickToBottom = true;
  scheduleAiRender();
}

function openSession(id: string) {
  assistant.openSession(id);
  clearMarkdownCache();
  view = "chat";
  stickToBottom = true;
  scheduleAiRender();
}

function deleteSession(id: string) {
  assistant.deleteSession(id);
  scheduleAiRender();
}

function showSessions() {
  view = "sessions";
  scheduleAiRender();
}

/** The open session's title for the chat header (null → "New chat"). */
function activeSessionTitle(): string | null {
  const id = assistant.activeSessionId();
  if (!id) {
    return null;
  }
  return assistant.listSessions().find((s) => s.id === id)?.title ?? null;
}

// ─── Composer ───────────────────────────────────────────────────────────────

const composer = createComposer({
  isStreaming: () => assistant.chatState.status === "streaming",
  onOpenSettings: startEditApiKey,
  onSend: (text) => {
    void handleAssistantSend(text);
  },
  onStop: stop,
  requestRender: scheduleAiRender,
});

// ─── Template ───────────────────────────────────────────────────────────────

/** @returns {TemplateResult} */
export function renderAiPanelTemplate(): TemplateResult {
  /* The document assistant authenticates via the AI proxy. Gate the chat
     behind the key form until a key is stored locally OR the proxy reports
     itself configured (managed platforms, env-keyed dev servers). */
  if ((!hasOpenAiKey() && !isProxyConfigured()) || keyEditing) {
    if (!keyEditing) {
      ensureProxyProbe();
    }
    return renderKeyGate();
  }

  if (view === "sessions") {
    return html`
      <div class="ai-tab-body">
        ${renderSessionsList({
          onDelete: deleteSession,
          onNew: newChat,
          onOpen: openSession,
          sessions: assistant.listSessions(),
        })}
      </div>
    `;
  }

  const cs = assistant.chatState;
  return html`
    <div class="ai-tab-body">
      ${renderChatHeader({
        onNewChat: newChat,
        onShowSessions: showSessions,
        streaming: cs.status === "streaming",
        title: activeSessionTitle(),
      })}
      ${renderMessageList({
        error: cs.error,
        listRef: onMessagesListRef,
        messages: cs.messages,
        onScroll: onMessagesScroll,
        status: cs.status,
      })}
      ${composer.render()}
    </div>
  `;
}
