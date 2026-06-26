/**
 * Chat-state.js — Provider-agnostic reactive chat state management
 *
 * Manages the lifecycle of a chat conversation: messages, streaming status,
 * tool calls, and errors. Built on @vue/reactivity for fine-grained updates.
 * No Studio or Jx dependencies — reusable in any chat UI context.
 *
 * @license MIT
 * @module @jxsuite/ai/chat-state
 */

import { reactive } from "@vue/reactivity";

import type { ToolResult } from "./tools.ts";

export type ChatState = "idle" | "streaming" | "error";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRecord[];
  toolCallId?: string;
  timestamp: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  result?: ToolResult | null;
}

export interface ChatStore {
  messages: Message[];
  status: ChatState;
  streamingContent: string;
  pendingToolCalls: ToolCallRecord[];
  error: string | null;
  model: string;
  tokenCount: number;
  contextWarning: boolean;
}

// ─── Types ───────────────────────────────────────────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0;

/** @returns {string} */
function uid() {
  _idCounter += 1;
  return `msg_${Date.now()}_${_idCounter}`;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a reactive chat state store.
 *
 * @param {object} [opts]
 * @param {string} [opts.model] - Default model name
 * @returns {ChatStore & {
 *   sendMessage: (text: string) => void;
 *   beginAssistantTurn: () => void;
 *   appendDelta: (content: string) => void;
 *   appendToolCallStart: (id: string, name: string) => void;
 *   appendToolCallDelta: (id: string, args: string) => void;
 *   appendToolCallEnd: (id: string) => void;
 *   appendToolResult: (id: string, result: ToolResult) => void;
 *   pushToolResultMessage: (toolCallId: string, content: string) => void;
 *   finishStream: (stopReason: string) => void;
 *   setError: (message: string) => void;
 *   cancelStream: () => void;
 *   clearChat: () => void;
 *   retryLast: () => void;
 *   setModel: (model: string) => void;
 *   setTokenCount: (count: number) => void;
 *   setContextWarning: (warning: boolean) => void;
 *   toMessagesArray: () => object[];
 * }}
 */
export function createChatState(opts: { model?: string } = {}) {
  const model = opts.model || "gpt-4o";

  const store = reactive<ChatStore>({
    messages: [],
    status: "idle",
    streamingContent: "",
    pendingToolCalls: [],
    error: null,
    model,
    tokenCount: 0,
    contextWarning: false,
  });

  let _streamingMessage: Message | null = null;

  /**
   * Add a user message and prepare for streaming response.
   *
   * @param {string} text
   */
  function sendMessage(text: string) {
    if (store.status === "streaming") {
      return;
    }

    const userMsg = {
      id: uid(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    } as Message;
    store.messages.push(userMsg);

    beginAssistantTurn();
  }

  /**
   * Prepare for a new streaming assistant response without adding a user message. Used by the agent
   * loop to start the next round after appending tool result messages.
   */
  function beginAssistantTurn() {
    if (store.status === "streaming") {
      return;
    }

    store.error = null;
    store.streamingContent = "";
    store.pendingToolCalls = [];

    // Set status BEFORE pushing the placeholder so reactive effects see "streaming" when the
    // Push triggers them — otherwise the effect renders the empty placeholder as a finalized msg.
    store.status = "streaming";

    // Create placeholder assistant message for streaming content
    _streamingMessage = {
      id: uid(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    } as Message;
    store.messages.push(_streamingMessage);
    /*
     * Re-read through the reactive proxy so appendDelta / appendToolCallStart mutations notify
     * effects (e.g. watchAssistant in ai-panel.ts). _streamingMessage now holds the proxied
     * version, not the raw object pushed above.
     */
    _streamingMessage = store.messages.at(-1) ?? null;
  }

  /**
   * Append a `tool` role message carrying a tool call's result, ready to be sent back to the LLM on
   * the next round.
   *
   * @param {string} toolCallId
   * @param {string} content
   */
  function pushToolResultMessage(toolCallId: string, content: string) {
    store.messages.push({
      id: uid(),
      role: "tool",
      toolCallId,
      content,
      timestamp: Date.now(),
    } as Message);
  }

  /**
   * Append a text delta to the streaming assistant message.
   *
   * @param {string} content
   */
  function appendDelta(content: string) {
    if (store.status !== "streaming" || !_streamingMessage) {
      return;
    }
    store.streamingContent += content;
    _streamingMessage.content = store.streamingContent;
  }

  /**
   * Start tracking a tool call within the stream.
   *
   * @param {string} id
   * @param {string} name
   */
  function appendToolCallStart(id: string, name: string) {
    if (store.status !== "streaming") {
      return;
    }
    const tc = {
      id,
      name,
      arguments: "",
      result: null,
    } as ToolCallRecord;
    store.pendingToolCalls.push(tc);

    if (_streamingMessage) {
      if (!_streamingMessage.toolCalls) {
        _streamingMessage.toolCalls = [];
      }
      _streamingMessage.toolCalls.push(tc);
    }
  }

  /**
   * Append a partial argument fragment to a pending tool call.
   *
   * @param {string} id
   * @param {string} args
   */
  function appendToolCallDelta(id: string, args: string) {
    const tc = store.pendingToolCalls.find((t) => t.id === id);
    if (tc) {
      tc.arguments += args;
    }
  }

  /**
   * Mark a tool call as complete (all arguments received).
   *
   * @param {string} _id
   */
  function appendToolCallEnd(_id: string) {
    // Tool call is complete — arguments are fully accumulated.
    // The caller should parse the arguments JSON and execute the tool.
    // Tool results are attached via appendToolResult().
  }

  /**
   * Attach a result to a pending tool call.
   *
   * @param {string} id
   * @param {ToolResult} result
   */
  function appendToolResult(id: string, result: ToolResult) {
    const tc = store.pendingToolCalls.find((t) => t.id === id);
    if (tc) {
      tc.result = result;
    }
    // Also update in the message record
    if (_streamingMessage?.toolCalls) {
      const mtc = _streamingMessage.toolCalls.find((t) => t.id === id);
      if (mtc) {
        mtc.result = result;
      }
    }
  }

  /**
   * Finalize the streaming response.
   *
   * @param {string} _stopReason
   */
  function finishStream(_stopReason: string) {
    store.status = "idle";
    store.streamingContent = "";
    store.pendingToolCalls = [];
    _streamingMessage = null;
  }

  /**
   * Set the chat state to error with a message.
   *
   * @param {string} message
   */
  function setError(message: string) {
    store.status = "error";
    store.error = message;
    store.streamingContent = "";
    // Remove the partial streaming message — it may contain incomplete tool_calls
    // That would poison the conversation history on the next send.
    if (_streamingMessage) {
      const idx = store.messages.lastIndexOf(_streamingMessage);
      if (idx !== -1) {
        store.messages.splice(idx, 1);
      }
    }
    _streamingMessage = null;
  }

  /** Cancel the current stream. Resets streaming state. */
  function cancelStream() {
    // Always remove the partial streaming message — it may contain
    // Incomplete tool_calls that would poison the conversation history on retry.
    if (_streamingMessage) {
      const idx = store.messages.lastIndexOf(_streamingMessage);
      if (idx !== -1) {
        store.messages.splice(idx, 1);
      }
    }
    store.status = "idle";
    store.streamingContent = "";
    store.pendingToolCalls = [];
    _streamingMessage = null;
    store.error = null;
  }

  /** Clear the entire chat history. */
  function clearChat() {
    store.messages.length = 0;
    store.status = "idle";
    store.streamingContent = "";
    store.pendingToolCalls = [];
    store.error = null;
    store.contextWarning = false;
    _streamingMessage = null;
  }

  /** Retry the last user message (remove last assistant + user, then the caller re-sends). */
  function retryLast() {
    // Remove the last assistant message
    while (store.messages.length > 0 && store.messages.at(-1)!.role !== "user") {
      store.messages.pop();
    }
    // Remove the last user message (caller will re-send)
    if (store.messages.length > 0 && store.messages.at(-1)!.role === "user") {
      store.messages.pop();
    }
    store.status = "idle";
    store.error = null;
  }

  /**
   * Set the model name.
   *
   * @param {string} m
   */
  function setModel(m: string) {
    store.model = m;
  }

  /**
   * Set the approximate token count for context management.
   *
   * @param {number} count
   */
  function setTokenCount(count: number) {
    store.tokenCount = count;
  }

  /**
   * Set the context overflow warning flag.
   *
   * @param {boolean} warning
   */
  function setContextWarning(warning: boolean) {
    store.contextWarning = warning;
  }

  /**
   * Convert the current chat state to an array suitable for sending to an LLM API. Includes the
   * system prompt as the first message and all conversation turns.
   *
   * @returns {object[]}
   */
  function toMessagesArray() {
    const out = [];

    for (const msg of store.messages) {
      if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        });
      } else if (msg.role === "tool") {
        out.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        });
      } else {
        out.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    return out;
  }

  return Object.assign(store, {
    sendMessage,
    beginAssistantTurn,
    appendDelta,
    appendToolCallStart,
    appendToolCallDelta,
    appendToolCallEnd,
    appendToolResult,
    pushToolResultMessage,
    finishStream,
    setError,
    cancelStream,
    clearChat,
    retryLast,
    setModel,
    setTokenCount,
    setContextWarning,
    toMessagesArray,
  });
}
