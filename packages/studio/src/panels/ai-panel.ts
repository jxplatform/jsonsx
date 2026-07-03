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
import { getPlatform } from "../platform";
import { effect, effectScope } from "../reactivity";
import { createDocumentAssistant } from "../services/document-assistant";
import {
  getBaseUrl,
  getModel,
  getOpenAiKey,
  hasOpenAiKey,
  setBaseUrl,
  setModel,
  setOpenAiKey,
} from "../services/ai-settings";

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
let keyDraft = "";
let baseUrlDraft = "";
let modelDraft = "";

/** Fetched from /__studio/ai/models (proxied to the upstream provider). */
let availableModels: { id: string; name: string }[] = [];
let modelsLoading = false;
let modelsError = "";

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

/** Open the key form, pre-filled with the current settings. */
function startEditApiKey() {
  keyDraft = getOpenAiKey();
  baseUrlDraft = getBaseUrl();
  modelDraft = getModel();
  keyEditing = true;
  rerenderPanel();
  // Auto-fetch available models if not already loaded.
  if (availableModels.length === 0 && !modelsLoading) {
    void fetchModels();
  }
}

/** Persist the drafted key + endpoint and return to the chat. */
function saveApiKey() {
  setOpenAiKey(keyDraft);
  setBaseUrl(baseUrlDraft);
  setModel(modelDraft);
  keyDraft = "";
  baseUrlDraft = "";
  modelDraft = "";
  keyEditing = false;
  // Clear fetched models so they're re-fetched with the new credentials next time.
  availableModels = [];
  rerenderPanel();
}

/** Dismiss the key form without saving (only offered when a key already exists). */
function cancelEditApiKey() {
  keyDraft = "";
  baseUrlDraft = "";
  modelDraft = "";
  keyEditing = false;
  rerenderPanel();
}

/**
 * Fetch available models from the proxy's /__studio/ai/models endpoint. Sends the stored API key as
 * X-Api-Key so the proxy can forward to the upstream provider. Falls back to the proxy's hardcoded
 * default list when no key is configured.
 */
async function fetchModels() {
  modelsLoading = true;
  modelsError = "";
  rerenderPanel();
  try {
    const plat = getPlatform();
    const chatUrl = await Promise.resolve(plat.aiChatUrl());
    const modelsUrl = chatUrl.replace(/\/chat$/, "/models");

    const headers: Record<string, string> = {};
    const storedKey = getOpenAiKey() || keyDraft;
    if (storedKey) {
      headers["X-Api-Key"] = storedKey;
    }
    // Forward the chosen endpoint so the proxy lists models from THAT provider, not the
    // Default OpenAI host — otherwise a non-OpenAI key only ever gets the hardcoded fallback.
    const baseUrl = baseUrlDraft || getBaseUrl();
    if (baseUrl) {
      headers["X-Api-Base-URL"] = baseUrl;
    }

    const resp = await fetch(modelsUrl, { headers });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as { models?: { id: string; name?: string }[] };
    availableModels = (data.models || []).map((m: { id: string; name?: string }) => ({
      id: m.id,
      name: m.name || m.id,
    }));
  } catch (error: unknown) {
    modelsError = (error as Error).message || "Failed to fetch models";
  } finally {
    modelsLoading = false;
    rerenderPanel();
  }
}

/** The OpenAI (or compatible) key + endpoint settings form, shown as a gate when no key is set. */
function renderKeyGate() {
  const haveKey = hasOpenAiKey();
  return html`
    <div class="ai-tab-body">
      <div class="ai-status-center" style="gap:10px;max-width:320px;text-align:left">
        <div style="font-weight:600;align-self:center">AI provider key</div>
        <div style="font-size:11px;color:var(--fg-dim)">
          Any OpenAI-compatible key works. Stored locally in this browser; sent only to the Studio
          proxy (never to a third party except your chosen endpoint).
        </div>
        <input
          type="password"
          style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-input);color:var(--fg);font-size:12px"
          placeholder="sk-… or any compatible key"
          .value=${keyDraft}
          @input=${(e: Event) => {
            keyDraft = (e.target as HTMLInputElement).value;
          }}
        />
        <div style="font-weight:500;font-size:11px;margin-top:4px">Model</div>
        ${availableModels.length > 0
          ? html`
              <sp-combobox
                size="s"
                allows-custom-value
                .value=${modelDraft}
                @change=${(e: Event) => {
                  modelDraft = (e.target as HTMLInputElement).value;
                }}
                @input=${(e: Event) => {
                  modelDraft = (e.target as HTMLInputElement).value;
                }}
              >
                ${availableModels.map(
                  (m) => html`<sp-menu-item value=${m.id}>${m.name}</sp-menu-item>`,
                )}
              </sp-combobox>
            `
          : html`
              <input
                type="text"
                style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-input);color:var(--fg);font-size:12px"
                placeholder="Model ID (e.g. gpt-4o, claude-sonnet-4-20250514, etc.)"
                .value=${modelDraft}
                @input=${(e: Event) => {
                  modelDraft = (e.target as HTMLInputElement).value;
                }}
              />
            `}
        <div style="display:flex;gap:8px;align-items:center">
          <sp-button size="s" variant="secondary" ?disabled=${modelsLoading} @click=${fetchModels}>
            ${modelsLoading
              ? "Fetching…"
              : availableModels.length > 0
                ? "Refresh models"
                : "Fetch models"}
          </sp-button>
          ${modelsError
            ? html`<span style="font-size:10px;color:var(--danger)">${modelsError}</span>`
            : nothing}
        </div>
        <input
          type="text"
          style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-input);color:var(--fg);font-size:12px"
          placeholder="Endpoint (optional, e.g. http://localhost:11434/v1)"
          .value=${baseUrlDraft}
          @input=${(e: Event) => {
            baseUrlDraft = (e.target as HTMLInputElement).value;
          }}
        />
        <div style="display:flex;gap:8px;align-self:flex-end">
          ${haveKey
            ? html`<sp-button size="s" variant="secondary" @click=${cancelEditApiKey}
                >Cancel</sp-button
              >`
            : nothing}
          <sp-button size="s" variant="primary" @click=${saveApiKey}>Save</sp-button>
        </div>
      </div>
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
