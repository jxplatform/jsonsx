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
      void handleUserSend(msg);
    },
    {
      messagesArea: { alternating: false },
      showTimestamps: false,
      theme: "quikchat-theme-dark",
      titleArea: { show: false },
    },
  );
  chatContainerEl = container;

  replayMessages();

  if (streaming) {
    chatInstance?.inputAreaSetEnabled(false);
  }
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
  if (!sessionId) {
    return;
  }
  const plat = getPlatform();
  void plat.aiStopSession(sessionId);
  finishStream();
}

function newChat() {
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
      <div
        id="ai-quikchat"
        ${ref((el) => {
          _quikChatEl = (el as HTMLElement | null) || null;
        })}
      ></div>
    </div>
  `;
}
