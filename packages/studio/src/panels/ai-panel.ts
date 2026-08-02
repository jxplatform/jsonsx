/// <reference lib="dom" />
/**
 * Ai-panel.ts — AI assistant tab for the right panel (Stack B document assistant).
 *
 * Native lit-html chat UI (VSCode-Copilot style) over the reactive document-assistant
 * session: a view-state machine (sessions list ↔ chat), a message list with
 * stick-to-bottom scrolling, and the sticky composer.
 *
 * Credentials are NOT a state of this panel. A provider key is a roaming application setting
 * configured once, so it lives in the `Assistant: Settings…` dialog ({@link openAssistantSettings});
 * the panel with no key configured still opens on an invitation to talk, with the settings action
 * offered beneath it.
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
import { ref } from "lit-html/directives/ref.js";
import type { TemplateResult } from "lit-html";
import { effect, effectScope } from "../reactivity";
import { createDocumentAssistant } from "../services/document-assistant";
import { setOpenAiKey } from "../services/ai-settings";
import { hasAiCredentials } from "../services/ai-models";
import { showDialog } from "../ui/layers";
import { createAiCredentialsForm } from "../ui/ai-credentials-form";
import { createManagedConnect } from "../ui/ai-managed-connect";
import { clearMarkdownCache } from "./ai-chat/chat-markdown";
import { renderChatHeader, renderMessageList } from "./ai-chat/chat-view";
import { createComposer } from "./ai-chat/composer";
import { renderSessionsList } from "./ai-chat/sessions-view";

import type { EffectScope } from "@vue/reactivity";

// ─── State (module-level, persists across tab switches) ─────────────────────

let mounted = false;

/** Which pane the panel shows. */
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

// ─── Assistant settings (the provider credentials, in a dialog) ──────────────

/**
 * Repaint the open settings dialog, if one is up. The dialog outlives a single {@link showDialog}
 * render — the credentials form and the Cloudflare connect flow both re-render themselves on every
 * keystroke and every probe — so it re-renders in place the same way `showPromptDialog` does.
 */
let settingsRerender: (() => void) | null = null;

/** Dismiss the open settings dialog, if one is up. */
let settingsClose: (() => void) | null = null;

/** Repaint whichever surfaces are currently showing credential state. */
function refreshCredentialSurfaces() {
  settingsRerender?.();
  scheduleAiRender();
}

/** The shared credentials form (draft/model state lives inside the form's closure). */
const credsForm = createAiCredentialsForm({
  onCancel: () => settingsClose?.(),
  onSaved: () => settingsClose?.(),
  requestRender: refreshCredentialSurfaces,
});

/** Shared with the New Project modal's gates — see ui/ai-managed-connect.ts. */
const managedConnect = createManagedConnect({ requestRender: refreshCredentialSurfaces });

/**
 * `Assistant: Settings…` — the provider credentials, as an ephemeral dialog rather than a column.
 *
 * On managed platforms a keyless "Connect Cloudflare" (Workers AI) option sits above the
 * OpenAI-compatible key form; both are real, working paths. Resolves when the dialog closes.
 */
export function openAssistantSettings(): Promise<null> {
  managedConnect.ensureProbe();
  credsForm.startEdit();
  return showDialog<null>((done) => {
    let wrapperEl: HTMLElement | null = null;

    function finish() {
      settingsRerender = null;
      settingsClose = null;
      done(null);
      scheduleAiRender();
    }

    function build(): TemplateResult {
      return html`
        <sp-dialog-wrapper
          open
          underlay
          headline="Assistant settings"
          cancel-label="Close"
          size="s"
          @cancel=${finish}
          @close=${finish}
          ${ref((el?: Element) => {
            if (el) {
              wrapperEl = el as HTMLElement;
            }
          })}
        >
          <div class="ai-settings-dialog">${managedConnect.render()} ${credsForm.render()}</div>
        </sp-dialog-wrapper>
      `;
    }

    settingsClose = finish;
    settingsRerender = () => {
      // Resolved lazily: lit commits element refs before inserting the fragment, so the slot the
      // Dialog was rendered into is only reachable once the first render has landed.
      const host = wrapperEl?.parentElement;
      if (host) {
        litRender(build(), host);
      }
    };
    return build();
  });
}

/**
 * The in-panel residue of the credentials gate: one line and the action that fixes it, under a chat
 * that still invites a conversation. The probe fires here for the same reason the old gate fired it
 * — a managed platform or an env-keyed dev server is already configured, and only `/models` knows.
 */
function renderSetupNotice(): TemplateResult {
  managedConnect.ensureProbe();
  return html`
    <div class="ai-setup-notice">
      <span>No AI provider is connected yet.</span>
      <sp-button size="s" variant="secondary" @click=${() => void openAssistantSettings()}>
        Assistant: Settings…
      </sp-button>
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
  onOpenSettings: () => void openAssistantSettings(),
  onSend: (text) => {
    void handleAssistantSend(text);
  },
  onStop: stop,
  requestRender: scheduleAiRender,
});

// ─── Template ───────────────────────────────────────────────────────────────

/** @returns {TemplateResult} */
export function renderAiPanelTemplate(): TemplateResult {
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
      ${hasAiCredentials() ? nothing : renderSetupNotice()} ${composer.render()}
    </div>
  `;
}
