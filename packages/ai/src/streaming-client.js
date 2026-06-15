/**
 * Streaming-client.js — Provider-agnostic streaming LLM client abstraction
 *
 * Defines the StreamingClient interface (as JSDoc typedefs), the StreamEvent union type,
 * and concrete implementations for OpenAI and Anthropic. Designed upfront so switching
 * providers is a new implementation, not a refactor.
 *
 * @license MIT
 * @module @jxsuite/ai/streaming-client
 */

// ─── Type definitions ────────────────────────────────────────────────────────

/**
 * All possible stream event types.
 *
 * @readonly
 * @enum {string}
 */
export const STREAM_EVENT_TYPES = /** @type {const} */ ({
  DELTA: "delta",
  TOOL_CALL_START: "tool_call_start",
  TOOL_CALL_DELTA: "tool_call_delta",
  TOOL_CALL_END: "tool_call_end",
  DONE: "done",
  ERROR: "error",
});

/**
 * A single event from the streaming chat pipeline.
 *
 * @typedef {StreamDeltaEvent
 *   | StreamToolCallStartEvent
 *   | StreamToolCallDeltaEvent
 *   | StreamToolCallEndEvent
 *   | StreamDoneEvent
 *   | StreamErrorEvent} StreamEvent
 */

/**
 * A text content delta from the LLM.
 *
 * @typedef {{
 *   type: "delta";
 *   content: string;
 * }} StreamDeltaEvent
 */

/**
 * Start of a tool call within the stream.
 *
 * @typedef {{
 *   type: "tool_call_start";
 *   id: string;
 *   name: string;
 * }} StreamToolCallStartEvent
 */

/**
 * Incremental partial JSON argument fragment for an in-progress tool call.
 *
 * @typedef {{
 *   type: "tool_call_delta";
 *   id: string;
 *   args: string;
 * }} StreamToolCallDeltaEvent
 */

/**
 * Completion of a tool call (all argument fragments received).
 *
 * @typedef {{
 *   type: "tool_call_end";
 *   id: string;
 * }} StreamToolCallEndEvent
 */

/**
 * The stream has ended. `stopReason` indicates why.
 *
 * @typedef {{
 *   type: "done";
 *   stopReason: string;
 * }} StreamDoneEvent
 */

/**
 * An error occurred during streaming.
 *
 * @typedef {{
 *   type: "error";
 *   message: string;
 *   code?: string;
 * }} StreamErrorEvent
 */

// ─── StreamingClient interface (documented typedef) ─────────────────────────

/**
 * A streaming LLM client. Implementations handle provider-specific SSE formats and emit normalized
 * StreamEvents.
 *
 * @interface StreamingClient
 */

/**
 * @function StreamingClient#streamChat
 * @param {object[]} messages - Conversation messages in OpenAI format
 * @param {object[]} tools - Tool definitions in OpenAI function-calling format
 * @param {string} systemPrompt - System prompt text
 * @param {AbortSignal} signal - AbortSignal for cancellation
 * @returns {AsyncGenerator<StreamEvent>} Async generator of stream events
 */

// ─── OpenAI implementation ───────────────────────────────────────────────────

/**
 * Creates an OpenAI-compatible streaming client that fetches from a given base URL with the
 * provided API key, transforms OpenAI SSE into normalized StreamEvents, and accumulates partial
 * tool call argument JSON.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - OpenAI-compatible API base URL (e.g. "https://api.openai.com/v1")
 * @param {string} opts.apiKey - API key
 * @param {string} [opts.model] - Default model if not specified per-request
 * @returns {StreamingClient}
 */
export function createOpenAIStreamingClient({ baseUrl, apiKey, model = "gpt-4o" }) {
  /**
   * @param {object[]} messages
   * @param {object[]} tools
   * @param {string} systemPrompt
   * @param {AbortSignal} signal
   * @yields {StreamEvent} Normalized stream events.
   * @returns {AsyncGenerator<StreamEvent>}
   */
  async function* streamChat(messages, tools, systemPrompt, signal) {
    const url = `${baseUrl}/chat/completions`;
    const body = {
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (/** @type {Error} */ (error).name === "AbortError") {
        yield { type: "done", stopReason: "cancelled" };
        return;
      }
      yield {
        type: "error",
        message: `Network error: ${/** @type {Error} */ (error).message}`,
      };
      return;
    }

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        /* Ignore */
      }
      yield {
        type: "error",
        message: `API error ${response.status}: ${errorBody || response.statusText}`,
        code: String(response.status),
      };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", message: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    /** @type {Map<string, { id: string; name: string; args: string }>} */
    const pendingToolCalls = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) {
            continue;
          }

          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") {
            // Emit any pending tool call ends before done
            for (const id of pendingToolCalls.keys()) {
              yield { type: "tool_call_end", id };
            }
            pendingToolCalls.clear();
            yield { type: "done", stopReason: "stop" };
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            continue; // Skip unparseable chunks
          }

          const choice = parsed.choices?.[0];
          if (!choice) {
            continue;
          }

          const { delta } = choice;
          if (!delta) {
            continue;
          }

          // Text content
          if (delta.content) {
            yield { type: "delta", content: delta.content };
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = pendingToolCalls.get(tc.index);

              if (tc.id) {
                // First appearance of this tool call
                const entry = {
                  id: tc.id,
                  name: tc.function?.name || "",
                  args: tc.function?.arguments || "",
                };
                pendingToolCalls.set(tc.index, entry);

                yield { type: "tool_call_start", id: tc.id, name: entry.name };

                if (entry.args) {
                  yield { type: "tool_call_delta", id: tc.id, args: entry.args };
                }
              } else if (existing && tc.function?.arguments) {
                // Subsequent argument fragment
                existing.args += tc.function.arguments;
                yield {
                  type: "tool_call_delta",
                  id: existing.id,
                  args: tc.function.arguments,
                };
              }
            }
          }

          // Finish reason
          if (choice.finish_reason === "tool_calls") {
            // Emit pending tool call ends
            for (const tc of pendingToolCalls.values()) {
              yield { type: "tool_call_end", id: tc.id };
            }
            pendingToolCalls.clear();
            yield { type: "done", stopReason: "tool_calls" };
            return;
          }

          if (choice.finish_reason === "stop" || choice.finish_reason === "length") {
            // Emit any pending tool call ends
            for (const tc of pendingToolCalls.values()) {
              yield { type: "tool_call_end", id: tc.id };
            }
            pendingToolCalls.clear();
            yield {
              type: "done",
              stopReason: choice.finish_reason === "length" ? "length" : "stop",
            };
            return;
          }
        }
      }

      // Stream ended without explicit finish_reason
      for (const tc of pendingToolCalls.values()) {
        yield { type: "tool_call_end", id: tc.id };
      }
      pendingToolCalls.clear();
      yield { type: "done", stopReason: "stop" };
    } catch (error) {
      reader.cancel();
      if (/** @type {Error} */ (error).name === "AbortError") {
        yield { type: "done", stopReason: "cancelled" };
        return;
      }
      yield {
        type: "error",
        message: `Stream error: ${/** @type {Error} */ (error).message}`,
      };
    }
  }

  return { streamChat };
}

// ─── Anthropic implementation (stub for v1) ──────────────────────────────────

/**
 * Creates an Anthropic-compatible streaming client. Stub for v1 — throws on use. Full
 * implementation in v2 handles Anthropic's content_block delta model.
 *
 * @param {object} _opts
 * @param {string} _opts.baseUrl
 * @param {string} _opts.apiKey
 * @returns {StreamingClient}
 */
export function createAnthropicStreamingClient({ baseUrl: _, apiKey: __ }) {
  /**
   * @yields {StreamEvent} Normalized stream events.
   * @returns {AsyncGenerator<StreamEvent>}
   */
  async function* streamChat() {
    yield {
      type: "error",
      message: "Anthropic provider is not yet implemented (planned for v2). Use OpenAI.",
      code: "NOT_IMPLEMENTED",
    };
  }

  return { streamChat };
}

// ─── Proxy implementation ────────────────────────────────────────────────────

/**
 * Creates a streaming client that POSTs to a same-origin (or platform-resolved) proxy endpoint
 * which already speaks the normalized StreamEvent SSE format (e.g. `/__studio/ai/chat`, see
 * `@jxsuite/server/ai-api`). No API key handling here — the proxy owns provider credentials.
 *
 * @param {object} opts
 * @param {string} opts.chatUrl - URL to POST `{ messages, tools, systemPrompt, model }` to
 * @param {string} [opts.model] - Default model if not specified per-request
 * @param {string} [opts.apiKey] - Optional client-supplied key, sent as the `X-Api-Key` header
 * @param {string} [opts.baseUrl] - Optional OpenAI-compatible base URL, sent as `X-Api-Base-URL`
 * @returns {StreamingClient}
 */
export function createProxyStreamingClient({ chatUrl, model = "gpt-4o", apiKey, baseUrl }) {
  /**
   * @param {object[]} messages
   * @param {object[]} tools
   * @param {string} systemPrompt
   * @param {AbortSignal} signal
   * @yields {StreamEvent} Normalized stream events.
   * @returns {AsyncGenerator<StreamEvent>}
   */
  async function* streamChat(messages, tools, systemPrompt, signal) {
    /** @type {Record<string, string>} */
    const headers = { "Content-Type": "application/json" };
    // Client-supplied key (e.g. from Studio settings) — the proxy also falls back to OPENAI_API_KEY.
    if (apiKey) {
      headers["X-Api-Key"] = apiKey;
    }
    // Optional OpenAI-compatible endpoint override (local LLM, OpenRouter, Azure, …).
    if (baseUrl) {
      headers["X-Api-Base-URL"] = baseUrl;
    }

    let response;
    try {
      response = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ messages, tools, systemPrompt, model }),
        signal,
      });
    } catch (error) {
      if (/** @type {Error} */ (error).name === "AbortError") {
        yield { type: "done", stopReason: "cancelled" };
        return;
      }
      yield {
        type: "error",
        message: `Network error: ${/** @type {Error} */ (error).message}`,
      };
      return;
    }

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        /* Ignore */
      }
      yield {
        type: "error",
        message: `API error ${response.status}: ${errorBody || response.statusText}`,
        code: String(response.status),
      };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", message: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) {
            continue;
          }

          const dataStr = trimmed.slice(6);
          let event;
          try {
            event = JSON.parse(dataStr);
          } catch {
            continue; // Skip unparseable chunks
          }

          yield /** @type {StreamEvent} */ (event);

          if (event.type === "done" || event.type === "error") {
            return;
          }
        }
      }
    } catch (error) {
      reader.cancel();
      if (/** @type {Error} */ (error).name === "AbortError") {
        yield { type: "done", stopReason: "cancelled" };
        return;
      }
      yield {
        type: "error",
        message: `Stream error: ${/** @type {Error} */ (error).message}`,
      };
    }
  }

  return { streamChat };
}
