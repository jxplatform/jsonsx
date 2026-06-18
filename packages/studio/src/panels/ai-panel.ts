/// <reference lib="dom" />
/**
 * Ai-panel.js — Claude AI Assistant tab for the right panel
 *
 * Uses QuikChat for the chat UI with Claude Agent SDK streaming via SSE.
 */

import { html, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import quikchat from "quikchat/md";
import { getPlatform } from "../platform";
import { reloadFileInTab } from "../files/files";
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

import type { EffectScope } from "@vue/reactivity";

/** Which agent backs the panel. "assistant" (Stack B, canonical) is the default. */
type AiMode = "assistant" | "dev-agent";

// ─── State (module-level, persists across tab switches) ─────────────────────

/**
 * @type {{
 *   role: string;
 *   content: string;
 *   toolUse?: { tool: string; input?: Record<string, unknown> };
 * }[]}
 */
let messages: {
  role: string;
  content: string;
  toolUse?: { tool: string; input?: Record<string, unknown> };
}[] = [];
let streaming = false;
let sessionId = null as string | null;
let authStatus = "unknown" as "authenticated" | "unauthenticated" | "checking" | "unknown";
let authError = "";
let currentAssistantText = "";
let eventSource = null as EventSource | null;
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
let currentStreamMsgId = null as number | null;
let streamStarted = false;
const pendingFileReloads = new Set<string>();

// ─── Mode (Stack B "assistant" default, Stack A "dev-agent" optional) ───────

let mode: AiMode = "assistant";

/** Whether the OpenAI key form is showing (gate when no key, or re-edit via the toolbar). */
let keyEditing = false;
let keyDraft = "";
let baseUrlDraft = "";
let modelDraft = "";

/** Fetched from /__studio/ai/models (proxied to the upstream provider). */
let availableModels: { id: string; name: string }[] = [];
let modelsLoading = false;
let modelsError = "";

/** Stack B (document AST assistant) session — created lazily, persists across tab switches. */
const assistant = createDocumentAssistant();
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
  void checkAuth();
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
      if (mode === "assistant") {
        handleAssistantSend(msg);
      } else {
        void handleUserSend(msg);
      }
    },
    {
      messagesArea: { alternating: false },
      showTimestamps: false,
      theme: "quikchat-theme-dark",
      titleArea: { show: false },
    },
  );
  chatContainerEl = container;

  if (mode === "assistant") {
    assistantRenderedCount = 0;
    assistantStreamingMsgId = null;
    assistantStreamedLen = 0;
    replayAssistantMessages();
    watchAssistant();
    if (assistant.chatState.status === "streaming") {
      chatInstance?.inputAreaSetEnabled(false);
    }
    return;
  }

  replayMessages();

  if (streaming) {
    chatInstance?.inputAreaSetEnabled(false);
  }
}

/**
 * Switch between the Stack B document assistant and the Stack A dev agent. Tears down the current
 * QuikChat instance so the next mount wires up the right send handler and history.
 *
 * @param {AiMode} next
 */
function setMode(next: AiMode) {
  if (mode === next) {
    return;
  }
  mode = next;
  chatInstance = null;
  chatContainerEl = null;
  assistantScope?.stop();
  assistantScope = null;
  rerenderPanel();
}

// ─── OpenAI key settings (Stack B) ──────────────────────────────────────────

/** Open the key form, pre-filled with the current settings. */
function startEditApiKey() {
  keyDraft = getOpenAiKey();
  baseUrlDraft = getBaseUrl();
  modelDraft = getModel();
  keyEditing = true;
  rerenderPanel();
  // Auto-fetch available models if not already loaded.
  if (availableModels.length === 0 && !modelsLoading) {
    fetchModels();
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
    const data = await resp.json();
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
        <div style="font-size:11px;color:var(--spectrum-global-color-gray-600)">
          Any OpenAI-compatible key works. Stored locally in this browser; sent only to the Studio
          proxy (never to a third party except your chosen endpoint).
        </div>
        <input
          type="password"
          style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--spectrum-global-color-gray-400);background:var(--spectrum-global-color-gray-50);color:var(--spectrum-global-color-gray-900);font-size:12px"
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
                style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--spectrum-global-color-gray-400);background:var(--spectrum-global-color-gray-50);color:var(--spectrum-global-color-gray-900);font-size:12px"
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
            ? html`<span style="font-size:10px;color:var(--spectrum-global-color-red-600)"
                >${modelsError}</span
              >`
            : nothing}
        </div>
        <input
          type="text"
          style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--spectrum-global-color-gray-400);background:var(--spectrum-global-color-gray-50);color:var(--spectrum-global-color-gray-900);font-size:12px"
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

// ─── Stack B (document assistant) rendering ─────────────────────────────────

/** Send a message through the Stack B document assistant agent loop. */
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
  if (assistant.chatState.status !== "streaming") {
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
    // Raw tool results are hidden from the user (spec §3.1).
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
    const m = msgs[i];
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
        const m = msgs[i];
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
        renderAssistantMessage(m);
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

/** @param {{ name: string; arguments: string }} tc */
function formatAssistantToolLabel(tc: { name: string; arguments: string }) {
  let detail = "";
  try {
    const args = tc.arguments ? JSON.parse(tc.arguments) : {};
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

function replayMessages() {
  if (!chatInstance || messages.length === 0) {
    return;
  }
  for (const msg of messages) {
    if (msg.role === "user") {
      chatInstance.messageAddNew(msg.content, "You", "right", "user");
    } else if (msg.role === "tool" && msg.toolUse) {
      chatInstance.messageAddNew(
        formatToolLabel(msg.toolUse.tool, msg.toolUse.input),
        "",
        "left",
        "tool",
      );
    } else {
      chatInstance.messageAddNew(msg.content, "", "left", "assistant");
    }
  }
  if (streaming && currentAssistantText) {
    currentStreamMsgId = chatInstance.messageAddNew(currentAssistantText, "", "left", "assistant");
    streamStarted = true;
  }
}

// ─── Auth ───────────────────────────────────────────────────────────────────

async function checkAuth() {
  authStatus = "checking";
  rerenderPanel();
  try {
    const plat = getPlatform();
    const result = await plat.aiAuthStatus();
    authStatus = result.authenticated ? "authenticated" : "unauthenticated";
    authError = result.error || "";
  } catch (error) {
    authStatus = "unauthenticated";
    authError = String(error);
  }
  rerenderPanel();
}

// ─── Messaging ──────────────────────────────────────────────────────────────

/** @param {string} text */
async function handleUserSend(text: string) {
  if (!text.trim() || streaming) {
    return;
  }

  messages.push({ content: text, role: "user" });
  streaming = true;
  currentAssistantText = "";
  streamStarted = false;

  if (chatInstance) {
    currentStreamMsgId = chatInstance.messageAddTypingIndicator("");
    chatInstance.inputAreaSetEnabled(false);
  }

  rerenderPanel();

  const plat = getPlatform();

  try {
    if (!sessionId) {
      const result = await plat.aiCreateSession({ message: text });
      sessionId = result.id;
      await connectStream(sessionId!);
    } else {
      await plat.aiSendMessage(sessionId, text);
    }
  } catch (error) {
    if (chatInstance && currentStreamMsgId != null) {
      chatInstance.messageReplaceContent(currentStreamMsgId, `Error: ${error}`);
    }
    messages.push({ content: `Error: ${error}`, role: "assistant" });
    streaming = false;
    if (chatInstance) {
      chatInstance.inputAreaSetEnabled(true);
    }
    rerenderPanel();
  }
}

function stop() {
  if (mode === "assistant") {
    assistant.stop();
    return;
  }
  if (!sessionId) {
    return;
  }
  const plat = getPlatform();
  void plat.aiStopSession(sessionId);
  finishStream();
}

function newChat() {
  if (mode === "assistant") {
    assistant.newChat();
    assistantRenderedCount = 0;
    assistantStreamingMsgId = null;
    assistantStreamedLen = 0;
    if (chatInstance) {
      chatInstance.historyImport([]);
      chatInstance.inputAreaSetEnabled(true);
    }
    rerenderPanel();
    return;
  }
  if (sessionId) {
    const plat = getPlatform();
    void plat.aiDeleteSession(sessionId);
  }
  disconnectStream();
  messages = [];
  sessionId = null;
  streaming = false;
  currentAssistantText = "";
  currentStreamMsgId = null;
  streamStarted = false;
  pendingFileReloads.clear();
  if (chatInstance) {
    chatInstance.historyImport([]);
    chatInstance.inputAreaSetEnabled(true);
  }
  rerenderPanel();
}

// ─── SSE Stream ─────────────────────────────────────────────────────────────

/** SSE `stream_event` payload (subset used here). */
interface StreamEventData {
  event?: { type?: string; delta?: { type?: string; text?: string } };
}

/** SSE `result` payload (subset used here). */
interface ResultData {
  result?: string;
  is_error?: boolean;
}

/** SSE `error` payload (subset used here). */
interface ErrorData {
  error?: string;
}

/** Parse SSE JSON into the expected shape. Returns null on malformed input. */
function parseSse<T>(raw: unknown): T | null {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

async function connectStream(id: string) {
  disconnectStream();
  const plat = getPlatform();
  const url = await Promise.resolve(plat.aiStreamUrl(id));
  eventSource = new EventSource(url);

  eventSource.addEventListener("stream_event", (e) => {
    const data = parseSse<StreamEventData>((e as MessageEvent).data);
    const evt = data?.event;
    if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta") {
      const token = evt.delta.text ?? "";
      currentAssistantText += token;
      if (chatInstance && currentStreamMsgId != null) {
        if (!streamStarted) {
          chatInstance.messageReplaceContent(currentStreamMsgId, currentAssistantText);
          streamStarted = true;
        } else {
          chatInstance.messageAppendContent(currentStreamMsgId, token);
        }
      }
    }
  });

  eventSource.addEventListener("assistant", (e) => {
    const data = parseSse<AssistantMessageData>((e as MessageEvent).data);
    if (data) {
      handleAssistantMessage(data);
    }
  });

  eventSource.addEventListener("result", (e) => {
    const data = parseSse<ResultData>((e as MessageEvent).data);
    if (data?.result && data.is_error) {
      if (chatInstance && currentStreamMsgId != null) {
        chatInstance.messageReplaceContent(currentStreamMsgId, `Error: ${data.result}`);
      }
      currentAssistantText = `Error: ${data.result}`;
    }
    finishStream();
  });

  eventSource.addEventListener("done", () => {
    finishStream();
  });

  eventSource.addEventListener("error", (e) => {
    const data = parseSse<ErrorData>((e as MessageEvent).data);
    if (data?.error) {
      if (chatInstance && currentStreamMsgId != null) {
        chatInstance.messageReplaceContent(currentStreamMsgId, `Error: ${data.error}`);
      }
      currentAssistantText = `Error: ${data.error}`;
    }
    finishStream();
  });

  eventSource.addEventListener("error", () => {
    finishStream();
  });
}

function finishStream() {
  if (!streaming) {
    return;
  }
  if (currentAssistantText) {
    messages.push({ content: currentAssistantText, role: "assistant" });
    currentAssistantText = "";
  }
  streaming = false;
  currentStreamMsgId = null;
  streamStarted = false;
  if (chatInstance) {
    chatInstance.inputAreaSetEnabled(true);
  }

  if (pendingFileReloads.size > 0) {
    for (const fp of pendingFileReloads) {
      void reloadFileInTab(fp);
    }
    pendingFileReloads.clear();
  }

  rerenderPanel();
}

function disconnectStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

/** SSE payload from the assistant stream: message blocks or a bare content array. */
interface AssistantMessageData {
  message?: { content?: AssistantBlock[] };
  content?: AssistantBlock[];
}

interface AssistantBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

/** @param {AssistantMessageData} data */
function handleAssistantMessage(data: AssistantMessageData) {
  const content = data.message?.content || data.content;
  if (!content) {
    return;
  }

  let text = "";
  const toolBlocks = [];

  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      toolBlocks.push({ tool: block.name, ...(block.input ? { input: block.input } : {}) });
      if ((block.name === "Edit" || block.name === "Write") && block.input) {
        const fp = block.input.file_path || block.input.path;
        if (fp) {
          pendingFileReloads.add(String(fp));
        }
      }
    }
  }

  if (toolBlocks.length > 0) {
    if (currentAssistantText) {
      messages.push({ content: currentAssistantText, role: "assistant" });
    }
    for (const t of toolBlocks) {
      messages.push({ content: "", role: "tool", toolUse: t });
      if (chatInstance) {
        chatInstance.messageAddNew(formatToolLabel(t.tool, t.input), "", "left", "tool");
      }
    }
  }

  currentAssistantText = text;
  if (chatInstance) {
    currentStreamMsgId = chatInstance.messageAddNew(text || "", "", "left", "assistant");
    streamStarted = Boolean(text);
  }
}

// ─── Tool Label Formatting ─────────────────────────────────────────────────

/**
 * @param {string} tool
 * @param {Record<string, unknown>} [input]
 */
function formatToolLabel(tool: string, input?: Record<string, unknown>) {
  switch (tool) {
    case "Edit":
    case "Write": {
      return `📝 ${tool}: ${input?.file_path || input?.path || "file"}`;
    }
    case "Read": {
      return `📖 Read: ${input?.file_path || input?.path || "file"}`;
    }
    case "Bash": {
      return `⚡ Run: ${truncate(String(input?.command || ""), 50)}`;
    }
    case "Glob": {
      return `🔍 Glob: ${input?.pattern || ""}`;
    }
    case "Grep": {
      return `🔍 Grep: ${truncate(String(input?.pattern || ""), 40)}`;
    }
    default: {
      return `🔧 ${tool}`;
    }
  }
}

/** @param {string} s @param {number} max */
function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ─── Template ───────────────────────────────────────────────────────────────

/** @returns {import("lit-html").TemplateResult} */
export function renderAiPanelTemplate() {
  // The Claude auth gate only applies to the Stack A "dev-agent" mode; the Stack B document
  // Assistant authenticates via the AI proxy (OpenAI key), not Claude login.
  if (mode === "dev-agent" && (authStatus === "checking" || authStatus === "unknown")) {
    return html`<div class="ai-tab-body">
      <div class="ai-status-center">Checking authentication...</div>
    </div>`;
  }

  if (mode === "dev-agent" && authStatus === "unauthenticated") {
    return html`
      <div class="ai-tab-body">
        <div class="ai-status-center">
          <sp-icon-artboard style="font-size:32px"></sp-icon-artboard>
          <div>Claude authentication required</div>
          <div
            style="font-size:var(--spectrum-font-size-50, 11px);color:var(--spectrum-gray-600, #808080)"
          >
            Run the following in your terminal:
          </div>
          <code class="ai-code-snippet">npx @anthropic-ai/claude-code login</code>
          ${authError
            ? html`<sp-help-text variant="negative">${authError}</sp-help-text>`
            : nothing}
          <sp-button size="s" variant="primary" @click=${checkAuth}>Retry</sp-button>
        </div>
      </div>
    `;
  }

  // Stack B gate: the document assistant needs an OpenAI-compatible key (or the server env var).
  if (mode === "assistant" && (!hasOpenAiKey() || keyEditing)) {
    return renderKeyGate();
  }

  const busy = mode === "assistant" ? assistant.chatState.status === "streaming" : streaming;

  return html`
    <div class="ai-tab-body">
      <div class="ai-toolbar">
        <sp-action-group size="xs" selects="single" compact>
          <sp-action-button ?selected=${mode === "assistant"} @click=${() => setMode("assistant")}>
            Assistant
          </sp-action-button>
          <sp-action-button ?selected=${mode === "dev-agent"} @click=${() => setMode("dev-agent")}>
            Dev Agent
          </sp-action-button>
        </sp-action-group>
        ${busy ? html`<sp-action-button size="xs" @click=${stop}>Stop</sp-action-button>` : nothing}
        <sp-action-button size="xs" quiet @click=${newChat}>
          <sp-icon-add slot="icon"></sp-icon-add>
          New Chat
        </sp-action-button>
        ${mode === "assistant"
          ? html`<sp-action-button
              size="xs"
              quiet
              title="API key & endpoint"
              @click=${startEditApiKey}
            >
              🔑
            </sp-action-button>`
          : nothing}
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
