/**
 * Ai-panel.js — Claude AI Assistant tab for the right panel
 *
 * Uses QuikChat for the chat UI with Claude Agent SDK streaming via SSE.
 */

import { html, nothing } from "lit-html";
import quikchat from "quikchat/md";
import { getPlatform } from "../platform.js";
import { rightPanel } from "../store.js";
import { reloadFileInTab } from "../files/files.js";

// ─── State (module-level, persists across tab switches) ─────────────────────

/**
 * @type {{
 *   role: string;
 *   content: string;
 *   toolUse?: { tool: string; input?: Record<string, unknown> };
 * }[]}
 */
let messages = [];
let streaming = false;
let sessionId = /** @type {string | null} */ (null);
let authStatus = /** @type {"authenticated" | "unauthenticated" | "checking" | "unknown"} */ (
  "unknown"
);
let authError = "";
let currentAssistantText = "";
let eventSource = /** @type {EventSource | null} */ (null);
let mounted = false;

/** @type {any} */
let chatInstance = null;
/** @type {Element | null} */
let chatContainerEl = null;
let currentStreamMsgId = /** @type {number | null} */ (null);
let streamStarted = false;
/** @type {Set<string>} */
let pendingFileReloads = new Set();

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function mountAiPanel() {
  if (mounted) return;
  mounted = true;
  checkAuth();
}

function rerenderPanel() {
  const { render } = /** @type {any} */ (/** @type {any} */ (globalThis).__jxRightPanelRender) ||
  {};
  if (render) render();
  requestAnimationFrame(() => mountQuikChat());
}

export function registerRightPanelRender(/** @type {Function} */ fn) {
  /** @type {any} */ (globalThis).__jxRightPanelRender = { render: fn };
}

// ─── QuikChat Mount ────────────────────────────────────────────────────────

export function mountQuikChat() {
  const container = rightPanel.querySelector("#ai-quikchat");
  if (!container) return;
  if (chatInstance && chatContainerEl === container) return;

  chatInstance = new quikchat(
    container,
    (/** @type {any} */ _chat, /** @type {string} */ msg) => {
      handleUserSend(msg);
    },
    {
      theme: "quikchat-theme-dark",
      titleArea: { show: false },
      showTimestamps: false,
      messagesArea: { alternating: false },
    },
  );
  chatContainerEl = container;

  replayMessages();

  if (streaming) {
    chatInstance.inputAreaSetEnabled(false);
  }
}

function replayMessages() {
  if (!chatInstance || !messages.length) return;
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
  } catch (err) {
    authStatus = "unauthenticated";
    authError = String(err);
  }
  rerenderPanel();
}

// ─── Messaging ──────────────────────────────────────────────────────────────

/** @param {string} text */
async function handleUserSend(text) {
  if (!text.trim() || streaming) return;

  messages.push({ role: "user", content: text });
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
      await connectStream(/** @type {string} */ (sessionId));
    } else {
      await plat.aiSendMessage(sessionId, text);
    }
  } catch (err) {
    if (chatInstance && currentStreamMsgId != null) {
      chatInstance.messageReplaceContent(currentStreamMsgId, `Error: ${err}`);
    }
    messages.push({ role: "assistant", content: `Error: ${err}` });
    streaming = false;
    if (chatInstance) chatInstance.inputAreaSetEnabled(true);
    rerenderPanel();
  }
}

function stop() {
  if (!sessionId) return;
  const plat = getPlatform();
  plat.aiStopSession(sessionId);
  finishStream();
}

function newChat() {
  if (sessionId) {
    const plat = getPlatform();
    plat.aiDeleteSession(sessionId);
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

async function connectStream(/** @type {string} */ id) {
  disconnectStream();
  const plat = getPlatform();
  const url = await Promise.resolve(plat.aiStreamUrl(id));
  eventSource = new EventSource(url);

  eventSource.addEventListener("stream_event", (e) => {
    try {
      const data = JSON.parse(e.data);
      const evt = data.event;
      if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        const token = evt.delta.text;
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
    } catch {}
  });

  eventSource.addEventListener("assistant", (e) => {
    try {
      handleAssistantMessage(JSON.parse(e.data));
    } catch {}
  });

  eventSource.addEventListener("result", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.result && data.is_error) {
        if (chatInstance && currentStreamMsgId != null) {
          chatInstance.messageReplaceContent(currentStreamMsgId, `Error: ${data.result}`);
        }
        currentAssistantText = `Error: ${data.result}`;
      }
    } catch {}
    finishStream();
  });

  eventSource.addEventListener("done", () => {
    finishStream();
  });

  eventSource.addEventListener("error", (e) => {
    try {
      const data = JSON.parse(/** @type {MessageEvent} */ (e).data);
      if (data.error) {
        if (chatInstance && currentStreamMsgId != null) {
          chatInstance.messageReplaceContent(currentStreamMsgId, `Error: ${data.error}`);
        }
        currentAssistantText = `Error: ${data.error}`;
      }
    } catch {}
    finishStream();
  });

  eventSource.onerror = () => {
    finishStream();
  };
}

function finishStream() {
  if (!streaming) return;
  if (currentAssistantText) {
    messages.push({ role: "assistant", content: currentAssistantText });
    currentAssistantText = "";
  }
  streaming = false;
  currentStreamMsgId = null;
  streamStarted = false;
  if (chatInstance) chatInstance.inputAreaSetEnabled(true);

  if (pendingFileReloads.size) {
    for (const fp of pendingFileReloads) reloadFileInTab(fp);
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

/** @param {any} data */
function handleAssistantMessage(data) {
  const content = data.message?.content || data.content;
  if (!content) return;

  let text = "";
  const toolBlocks = [];

  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolBlocks.push({ tool: block.name, input: block.input });
      if ((block.name === "Edit" || block.name === "Write") && block.input) {
        const fp = block.input.file_path || block.input.path;
        if (fp) pendingFileReloads.add(String(fp));
      }
    }
  }

  if (toolBlocks.length) {
    if (currentAssistantText) {
      messages.push({ role: "assistant", content: currentAssistantText });
    }
    for (const t of toolBlocks) {
      messages.push({ role: "tool", content: "", toolUse: t });
      if (chatInstance) {
        chatInstance.messageAddNew(formatToolLabel(t.tool, t.input), "", "left", "tool");
      }
    }
  }

  currentAssistantText = text;
  if (chatInstance) {
    currentStreamMsgId = chatInstance.messageAddNew(text || "", "", "left", "assistant");
    streamStarted = !!text;
  }
}

// ─── Tool Label Formatting ─────────────────────────────────────────────────

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

// ─── Template ───────────────────────────────────────────────────────────────

/** @returns {import("lit-html").TemplateResult} */
export function renderAiPanelTemplate() {
  if (authStatus === "checking" || authStatus === "unknown") {
    return html`<div class="ai-tab-body">
      <div class="ai-status-center">Checking authentication...</div>
    </div>`;
  }

  if (authStatus === "unauthenticated") {
    return html`
      <div class="ai-tab-body">
        <div class="ai-status-center">
          <sp-icon-artboard style="font-size:32px"></sp-icon-artboard>
          <div>Claude authentication required</div>
          <div style="font-size:11px;color:var(--spectrum-global-color-gray-600)">
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

  return html`
    <div class="ai-tab-body">
      <div class="ai-toolbar">
        ${streaming
          ? html`<sp-action-button size="xs" @click=${stop}>Stop</sp-action-button>`
          : nothing}
        <sp-action-button size="xs" quiet @click=${newChat}>
          <sp-icon-add slot="icon"></sp-icon-add>
          New Chat
        </sp-action-button>
      </div>
      <div id="ai-quikchat"></div>
    </div>
  `;
}
