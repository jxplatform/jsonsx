/**
 * Ai-panel.js — Claude AI Assistant tab for the right panel
 *
 * Renders as a tab in the right panel alongside Properties/Events/Style. Uses the Claude Agent SDK
 * via server endpoints for streaming agentic responses.
 */

import { html, nothing } from "lit-html";
import { getPlatform } from "../platform.js";
import { rightPanel } from "../store.js";
import { userMessage, assistantMessage, toolUseBlock } from "./ai-message.js";

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
let inputText = "";
let authStatus = /** @type {"authenticated" | "unauthenticated" | "checking" | "unknown"} */ (
  "unknown"
);
let authError = "";
let currentAssistantText = "";
let eventSource = /** @type {EventSource | null} */ (null);
let mounted = false;

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function mountAiPanel() {
  if (mounted) return;
  mounted = true;
  checkAuth();
}

/** Force a re-render of ONLY the right panel (when AI state changes). */
function rerenderPanel() {
  const { render } = /** @type {any} */ (/** @type {any} */ (globalThis).__jxRightPanelRender) ||
  {};
  if (render) render();
}

/** Register the right panel's render fn so we can call it on AI state changes */
export function registerRightPanelRender(/** @type {Function} */ fn) {
  /** @type {any} */ (globalThis).__jxRightPanelRender = { render: fn };
}

// ─── Auth ───────────────────────────────────────────────────────────────────

async function checkAuth() {
  authStatus = "checking";
  try {
    const plat = getPlatform();
    const result = await plat.aiAuthStatus();
    authStatus = result.authenticated ? "authenticated" : "unauthenticated";
    authError = result.error || "";
  } catch (err) {
    authStatus = "unauthenticated";
    authError = String(err);
  }
}

// ─── Messaging ──────────────────────────────────────────────────────────────

async function send() {
  const text = inputText.trim();
  if (!text || streaming) return;

  messages.push({ role: "user", content: text });
  inputText = "";
  streaming = true;
  currentAssistantText = "";

  const ta = rightPanel.querySelector(".ai-input-area textarea");
  if (ta) /** @type {HTMLTextAreaElement} */ (ta).value = "";

  rerenderPanel();

  const plat = getPlatform();

  try {
    if (!sessionId) {
      const result = await plat.aiCreateSession({ message: text });
      sessionId = result.id;
      connectStream(/** @type {string} */ (sessionId));
    } else {
      await plat.aiSendMessage(sessionId, text);
    }
  } catch (err) {
    messages.push({ role: "assistant", content: `Error: ${err}` });
    streaming = false;
    rerenderPanel();
  }
}

function stop() {
  if (!sessionId) return;
  const plat = getPlatform();
  plat.aiStopSession(sessionId);
  streaming = false;
  if (currentAssistantText) {
    messages.push({ role: "assistant", content: currentAssistantText });
    currentAssistantText = "";
  }
  disconnectStream();
  rerenderPanel();
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
  rerenderPanel();
}

// ─── SSE Stream ─────────────────────────────────────────────────────────────

function connectStream(/** @type {string} */ id) {
  disconnectStream();
  const plat = getPlatform();
  const url = plat.aiStreamUrl(id);
  eventSource = new EventSource(url);

  eventSource.addEventListener("assistant", (e) => {
    try {
      handleAssistantMessage(JSON.parse(e.data));
    } catch {}
  });

  eventSource.addEventListener("result", (e) => {
    try {
      const data = JSON.parse(e.data);
      handleAssistantMessage(data);
    } catch {}
    finishStream();
  });

  eventSource.addEventListener("done", () => {
    finishStream();
  });

  eventSource.addEventListener("error", () => {
    streaming = false;
    rerenderPanel();
  });

  eventSource.onerror = () => {
    streaming = false;
    rerenderPanel();
  };
}

function finishStream() {
  if (!streaming) return;
  if (currentAssistantText) {
    messages.push({ role: "assistant", content: currentAssistantText });
    currentAssistantText = "";
  }
  streaming = false;
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
    }
  }

  if (toolBlocks.length) {
    if (currentAssistantText) {
      messages.push({ role: "assistant", content: currentAssistantText });
      currentAssistantText = "";
    }
    for (const t of toolBlocks) {
      messages.push({ role: "tool", content: "", toolUse: t });
    }
  }

  currentAssistantText = text;
  rerenderPanel();
  scrollToBottom();
}

// ─── UI Helpers ─────────────────────────────────────────────────────────────

function scrollToBottom() {
  requestAnimationFrame(() => {
    const el = rightPanel.querySelector(".ai-messages");
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/** @param {KeyboardEvent} e */
function handleKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

/** @param {Event} e */
function handleInput(e) {
  inputText = /** @type {HTMLTextAreaElement} */ (e.target).value;
  const btn = rightPanel.querySelector(".ai-send-btn");
  if (btn) /** @type {HTMLButtonElement} */ (btn).disabled = streaming || !inputText.trim();
}

// ─── Template ───────────────────────────────────────────────────────────────

/**
 * Returns the lit-html template for the AI assistant tab body.
 *
 * @returns {import("lit-html").TemplateResult}
 */
export function renderAiPanelTemplate() {
  if (authStatus === "checking" || authStatus === "unknown") {
    return html`<div class="ai-auth-prompt">Checking authentication...</div>`;
  }

  if (authStatus === "unauthenticated") {
    return html`
      <div class="ai-auth-prompt">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        <div>Claude authentication required</div>
        <div style="font-size:11px">Run the following in your terminal:</div>
        <code>npx @anthropic-ai/claude-code login</code>
        ${authError
          ? html`<div style="color:var(--danger);font-size:11px">${authError}</div>`
          : nothing}
        <button class="ai-send-btn" style="margin-top:8px" @click=${checkAuth}>Retry</button>
      </div>
    `;
  }

  return html`
    <div class="ai-tab-body">
      <div class="ai-header">
        <span class="ai-header-title">Assistant</span>
        <sp-action-button size="xs" quiet @click=${newChat} title="New Chat">
          <svg
            slot="icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </sp-action-button>
      </div>
      <div class="ai-messages">
        ${messages.length === 0 && !streaming
          ? html`<div style="color:var(--fg-dim);text-align:center;padding:24px;font-size:11px">
              Ask Claude to help with your project.
            </div>`
          : nothing}
        ${messages.map((msg) => {
          if (msg.role === "user") return userMessage(msg.content);
          if (msg.role === "tool" && msg.toolUse) return toolUseBlock(msg.toolUse);
          return assistantMessage(msg.content);
        })}
        ${streaming && currentAssistantText
          ? assistantMessage(currentAssistantText, true)
          : nothing}
      </div>
      ${streaming
        ? html`<div style="padding:4px 8px">
            <button class="ai-stop-btn" @click=${stop}>Stop</button>
          </div>`
        : nothing}
      <div class="ai-input-area">
        <textarea
          rows="1"
          placeholder="Ask Claude..."
          .value=${inputText}
          @input=${handleInput}
          @keydown=${handleKeydown}
          ?disabled=${streaming}
        ></textarea>
        <button class="ai-send-btn" @click=${send} ?disabled=${streaming || !inputText.trim()}>
          Send
        </button>
      </div>
    </div>
  `;
}
