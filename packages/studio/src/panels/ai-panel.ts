/// <reference lib="dom" />
/**
 * Ai-panel.ts — AI assistant tab for the right panel (Stack B document assistant).
 *
 * Uses QuikChat for the chat UI, driven by the reactive document-assistant session which streams
 * from the OpenAI-compatible proxy and edits the live document via tools (with undo support).
 */

import { html, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import quikchat from "quikchat/md";
import { effect, effectScope } from "../reactivity";
import { createDocumentAssistant } from "../services/document-assistant";
import { hasOpenAiKey } from "../services/ai-settings";
import { createAiCredentialsForm } from "../ui/ai-credentials-form";

import type { ChatState } from "@jxsuite/ai/chat-state";
import type { EffectScope } from "@vue/reactivity";

// ─── State (module-level, persists across tab switches) ─────────────────────

let mounted = false;

/** Minimal surface of the untyped quikchat library that this panel uses. */
interface QuikChatInstance {
  messageAddNew: (text: string, sender: string, side: string, role?: string) => number;
  messageAddTypingIndicator: (text: string) => number;
  messageReplaceContent: (id: number, text: string) => void;
  messageAppendContent: (id: number, text: string) => void;
  inputAreaSetEnabled: (enabled: boolean) => void;
  historyImport: (history: unknown[]) => void;
}

type QuikChatCtor = new (
  container: HTMLElement,
  onSend: (chat: unknown, msg: string) => void,
  opts: Record<string, unknown>,
) => QuikChatInstance;

const QuikChat = quikchat as unknown as QuikChatCtor;

let chatInstance: QuikChatInstance | null = null;
let chatContainerEl: Element | null = null;
let _quikChatEl: HTMLElement | null = null;

/** Whether the OpenAI key form is showing (gate when no key, or re-edit via the toolbar). */
let keyEditing = false;

/** Document AST assistant session — created lazily, persists across tab switches. */
const assistant = createDocumentAssistant();
(globalThis as Record<string, unknown>).assistant = assistant;
let assistantScope: EffectScope | null = null;
let assistantRenderedCount = 0;
let assistantStreamingMsgId = null as number | null;
let assistantStreamedLen = 0;

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function mountAiPanel() {
  if (mounted) {
    return;
  }
  mounted = true;
}

const _g = globalThis as unknown as {
  __jxRightPanelRender?: { render: () => void };
};

function rerenderPanel() {
  const { render } = _g.__jxRightPanelRender || {};
  if (render) {
    render();
  }
  requestAnimationFrame(() => mountQuikChat());
}

export function registerRightPanelRender(fn: () => void) {
  _g.__jxRightPanelRender = { render: fn };
}

// ─── QuikChat Mount ────────────────────────────────────────────────────────

export function mountQuikChat() {
  const container = _quikChatEl;
  if (!container) {
    return;
  }
  if (chatInstance && chatContainerEl === container) {
    return;
  }

  chatInstance = new QuikChat(
    container,
    (_chat: unknown, msg: string) => {
      void handleAssistantSend(msg);
    },
    {
      messagesArea: { alternating: false },
      showTimestamps: false,
      theme: "quikchat-theme-dark",
      titleArea: { show: false },
    },
  );
  chatContainerEl = container;

  assistantRenderedCount = 0;
  assistantStreamingMsgId = null;
  assistantStreamedLen = 0;
  replayAssistantMessages();
  watchAssistant();
  if (assistant.chatState.status === "streaming") {
    chatInstance?.inputAreaSetEnabled(false);
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
  requestRender: rerenderPanel,
});

/** Open the key form, pre-filled with the current settings. */
function startEditApiKey() {
  keyEditing = true;
  credsForm.startEdit();
}

/** The OpenAI (or compatible) key + endpoint settings form, shown as a gate when no key is set. */
function renderKeyGate() {
  return html`
    <div class="ai-tab-body">
      <div class="ai-status-center">${credsForm.render()}</div>
    </div>
  `;
}

// ─── Document assistant rendering ────────────────────────────────────────────

/** Send a message through the document assistant agent loop. */
async function handleAssistantSend(text: string) {
  if (!text.trim() || assistant.chatState.status === "streaming") {
    return;
  }
  chatInstance?.inputAreaSetEnabled(false);
  try {
    await assistant.sendMessage(text);
  } catch {
    // Synchronous failure (e.g. network unreachable) — the DocumentAssistant's
    // Own try/catch calls chatState.setError(), which watchAssistant() displays.
    // Re-enable input here as a safety net.
  }
  // Always re-enable input after the send attempt completes (or fails).
  // WatchAssistant() also re-enables it when status !== "streaming", but if
  // The assistant threw before chatState entered "streaming", we need this.
  if ((assistant.chatState.status as ChatState) !== "streaming") {
    chatInstance?.inputAreaSetEnabled(true);
  }
}

/**
 * Seed the assistant with a prompt programmatically (e.g. the New Project flow handing off a
 * project brief). Delegates to the same send path as the chat input. Safe to call right after the
 * Assistant tab renders, before the chat widget mounts: every chatInstance call is
 * optional-chained, and the reactive watcher replays chat-state into a later mount.
 */
export async function seedAssistantPrompt(text: string): Promise<void> {
  await handleAssistantSend(text);
}

/** Render a single finalized chat-state message into QuikChat. */
function renderAssistantMessage(msg: {
  role: string;
  content: string;
  toolCalls?: { name: string; arguments: string }[];
}) {
  if (!chatInstance) {
    return;
  }
  if (msg.role === "user") {
    chatInstance.messageAddNew(msg.content, "You", "right", "user");
    return;
  }
  if (msg.role === "tool") {
    // Show only failed tool results so the user knows why an edit didn't land
    // (ADR §11.3). Successful tool results stay hidden to reduce noise.
    const parsed = tryParseToolResult(msg.content);
    if (parsed && !parsed.success) {
      chatInstance.messageAddNew(`⚠️ ${parsed.error || "Tool call failed"}`, "", "left", "tool");
    }
    return;
  }
  if (msg.content) {
    chatInstance.messageAddNew(msg.content, "", "left", "assistant");
  }
  for (const tc of msg.toolCalls ?? []) {
    chatInstance.messageAddNew(formatAssistantToolLabel(tc), "", "left", "tool");
  }
}

/** Replay the assistant's existing history into a freshly mounted QuikChat instance. */
function replayAssistantMessages() {
  assistantRenderedCount = 0;
  assistantStreamingMsgId = null;
  assistantStreamedLen = 0;
  const msgs = assistant.chatState.messages;
  const isStreaming = assistant.chatState.status === "streaming";
  // Render every message except a still-streaming trailing assistant message.
  const lastIdx = msgs.length - 1;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (isStreaming && i === lastIdx && m.role === "assistant") {
      break;
    }
    renderAssistantMessage(m);
    assistantRenderedCount = i + 1;
  }
}

/**
 * Reactively sync the assistant's chat-state into QuikChat. Newly-finalized messages are appended;
 * the in-progress streaming message is updated incrementally so text flows token-by-token.
 */
function watchAssistant() {
  assistantScope?.stop();
  assistantScope = effectScope();
  assistantScope.run(() => {
    effect(() => {
      const cs = assistant.chatState;
      const msgs = cs.messages;
      const { status } = cs;
      if (!chatInstance) {
        return;
      }

      const lastIdx = msgs.length - 1;
      for (let i = assistantRenderedCount; i < msgs.length; i++) {
        const m = msgs[i]!;
        const isStreamingTail = status === "streaming" && i === lastIdx && m.role === "assistant";
        if (isStreamingTail) {
          // Stream this message's text into a live bubble rather than finalizing it.
          if (assistantStreamingMsgId == null) {
            assistantStreamingMsgId = chatInstance.messageAddNew(
              m.content || "",
              "",
              "left",
              "assistant",
            );
            assistantStreamedLen = (m.content || "").length;
          } else if ((m.content || "").length > assistantStreamedLen) {
            chatInstance.messageAppendContent(
              assistantStreamingMsgId,
              m.content.slice(assistantStreamedLen),
            );
            assistantStreamedLen = m.content.length;
          }
          break;
        }
        if (assistantStreamingMsgId != null && m.role === "assistant") {
          // The streaming bubble already contains the full text — just finalize it in place.
          chatInstance.messageReplaceContent(assistantStreamingMsgId, m.content || "");
        } else {
          renderAssistantMessage(m);
        }
        assistantRenderedCount = i + 1;
        assistantStreamingMsgId = null;
        assistantStreamedLen = 0;
      }

      if (status !== "streaming") {
        assistantStreamingMsgId = null;
        assistantStreamedLen = 0;
        chatInstance.inputAreaSetEnabled(true);
        if (cs.error) {
          const advice = formatErrorAdvice(cs.error);
          chatInstance.messageAddNew(
            `❌ ${cs.error}${advice ? `\n\n${advice}` : ""}`,
            "",
            "left",
            "assistant",
          );
        }
      }
    });
  });
}

/**
 * Parse a tool result message content (JSON string) into its success/error shape. Returns null if
 * the content isn't a valid tool result.
 *
 * @param {string} content
 * @returns {{ success: boolean; error?: string } | null}
 */
function tryParseToolResult(
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

/** @param {{ name: string; arguments: string }} tc */
function formatAssistantToolLabel(tc: { name: string; arguments: string }) {
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
  return `🔧 ${tc.name}${detail}`;
}

/**
 * Return actionable advice for common AI assistant errors so the user knows how to recover instead
 * of just seeing a raw error message.
 *
 * @param {string} error
 * @returns {string}
 */
function formatErrorAdvice(error: string) {
  const lower = error.toLowerCase();
  if (lower.includes("no api key") || lower.includes("401")) {
    return "Click the 🔑 button in the toolbar to add an OpenAI-compatible API key.";
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

// ─── Controls ─────────────────────────────────────────────────────────────────

function stop() {
  assistant.stop();
}

function newChat() {
  assistant.newChat();
  assistantRenderedCount = 0;
  assistantStreamingMsgId = null;
  assistantStreamedLen = 0;
  if (chatInstance) {
    chatInstance.historyImport([]);
    chatInstance.inputAreaSetEnabled(true);
  }
  rerenderPanel();
}

// ─── Template ───────────────────────────────────────────────────────────────

/** @returns {import("lit-html").TemplateResult} */
export function renderAiPanelTemplate() {
  // The document assistant authenticates via the AI proxy (an OpenAI-compatible key). Gate the chat
  // Behind the key form until one is stored locally.
  if (!hasOpenAiKey() || keyEditing) {
    return renderKeyGate();
  }

  const busy = assistant.chatState.status === "streaming";

  return html`
    <div class="ai-tab-body">
      <div class="ai-toolbar">
        ${busy ? html`<sp-action-button size="xs" @click=${stop}>Stop</sp-action-button>` : nothing}
        <sp-action-button size="xs" quiet @click=${newChat}>
          <sp-icon-add slot="icon"></sp-icon-add>
          New Chat
        </sp-action-button>
        <sp-action-button size="xs" quiet title="API key & endpoint" @click=${startEditApiKey}>
          🔑
        </sp-action-button>
      </div>
      <div
        id="ai-quikchat"
        ${ref((el) => {
          _quikChatEl = (el as HTMLElement | null) || null;
        })}
      ></div>
    </div>
  `;
}
