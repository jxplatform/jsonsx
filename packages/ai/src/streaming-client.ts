/**
 * Streaming-client.js — Provider-agnostic streaming LLM client abstraction
 *
 * Defines the StreamingClient interface, the StreamEvent union every implementation yields,
 * and concrete implementations for OpenAI and Anthropic. Designed upfront so switching
 * providers is a new implementation, not a refactor.
 *
 * The union and its seven members are exported because they are the contract a third-party Studio
 * backend implements for the `ai/chat` route, not an internal detail — see the docs page below.
 *
 * @license MIT
 * @module @jxsuite/ai/streaming-client
 * @docs extending/embedding/backend-protocol
 */

import type { ProblemDetails } from "@jxsuite/protocol";

export type StreamEvent =
  | StreamDeltaEvent
  | StreamReasoningEvent
  | StreamToolCallStartEvent
  | StreamToolCallDeltaEvent
  | StreamToolCallEndEvent
  | StreamDoneEvent
  | StreamErrorEvent;

export interface StreamDeltaEvent {
  type: "delta";
  content: string;
}

/**
 * A chain-of-thought fragment from a thinking model — OpenAI-compatible providers stream it as
 * `reasoning_content` (DeepSeek, Volcengine) or `reasoning` (OpenRouter) beside `content`.
 *
 * It is a SEPARATE event rather than a `delta` because it is not part of the answer and must not be
 * rendered as one — but it is part of the turn, and DeepSeek's thinking mode requires every prior
 * turn's reasoning back on any request carrying `tools`. A client that drops these frames replays a
 * history the provider rejects with 400 `The reasoning_content in the thinking mode must be passed
 * back to the API`, so a backend implementing this route MUST forward them.
 */
export interface StreamReasoningEvent {
  type: "reasoning";
  content: string;
}

export interface StreamToolCallStartEvent {
  type: "tool_call_start";
  id: string;
  name: string;
}

export interface StreamToolCallDeltaEvent {
  type: "tool_call_delta";
  id: string;
  args: string;
}

export interface StreamToolCallEndEvent {
  type: "tool_call_end";
  id: string;
}

export interface StreamDoneEvent {
  type: "done";
  stopReason: string;
}

/**
 * A failure that arrived mid-stream.
 *
 * **This is the one place RFC 9457 could not simply replace what was here**, and the reason is
 * structural: a problem document is a _response body_, and by the time this frame is written the
 * response has already begun with a 200. Nothing can change the status any more. So the adoption is
 * that the frame CARRIES a problem rather than being replaced by one — `problem` is the machine
 * half (a `type` a client can key on), `message` stays the human half every existing reader already
 * shows, and `code` remains for the providers that send one.
 */
export interface StreamErrorEvent {
  type: "error";
  message: string;
  code?: string;
  /** RFC 9457 problem document describing the failure, when the producer knows its type. */
  problem?: ProblemDetails;
}

/**
 * A streaming LLM client. Implementations handle provider-specific SSE formats and emit normalized
 * StreamEvents.
 */
export interface StreamingClient {
  streamChat: (
    messages: object[],
    tools: object[],
    systemPrompt: string,
    signal: AbortSignal,
  ) => AsyncGenerator<StreamEvent>;
}

/** OpenAI chat-completions request body, built incrementally below. */
interface OpenAIChatRequestBody {
  model: string;
  messages: object[];
  stream: boolean;
  stream_options: { include_usage: boolean };
  temperature?: number;
  tools?: object[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
}

/** A tool-call fragment inside an OpenAI streaming `delta`. */
interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** A single OpenAI chat-completions streaming chunk (the JSON after `data: `). */
interface OpenAIStreamChunk {
  choices?: {
    index?: number;
    delta?: {
      content?: string;
      /** Thinking models' chain-of-thought: DeepSeek/Volcengine spell it this way… */
      reasoning_content?: string;
      /** …and OpenRouter this way. Both carry the same thing. */
      reasoning?: string;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
}

/** Error response body — the proxy's flat `{ error: "..." }` or OpenAI's `{ error: { message } }`. */
interface ErrorResponseBody {
  error?: string | { message?: string; code?: string; type?: string };
  /**
   * The proxy's machine code, alongside its human `error` — `cf_reconnect_required` and friends.
   *
   * A backend that knows WHY it refused says so here, and a client can only act on the reason it is
   * given: the whole point of the code is that the Reconnect affordance appears without the user
   * reading a sentence and deciding what it meant.
   */
  code?: string;
}

// ─── Type definitions ────────────────────────────────────────────────────────

/**
 * All possible stream event types.
 *
 * @readonly
 * @enum {string}
 */
export const STREAM_EVENT_TYPES = {
  DELTA: "delta",
  REASONING: "reasoning",
  TOOL_CALL_START: "tool_call_start",
  TOOL_CALL_DELTA: "tool_call_delta",
  TOOL_CALL_END: "tool_call_end",
  DONE: "done",
  ERROR: "error",
} as const;

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
 * @param {number} [opts.temperature] - Sampling temperature, forwarded only when defined. Omit for
 *   reasoning models (GPT-5.x, o-series) that reject a custom temperature; set 0 for
 *   near-deterministic eval runs.
 * @returns {StreamingClient}
 */
export interface OpenAIStreamingClientOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  temperature?: number | undefined;
}

export function createOpenAIStreamingClient({
  baseUrl,
  apiKey,
  model = "gpt-4o",
  temperature,
}: OpenAIStreamingClientOptions): StreamingClient {
  /**
   * @param {object[]} messages
   * @param {object[]} tools
   * @param {string} systemPrompt
   * @param {AbortSignal} signal
   * @yields {StreamEvent} Normalized stream events.
   * @returns {AsyncGenerator<StreamEvent>}
   */
  async function* streamChat(
    messages: object[],
    tools: object[],
    systemPrompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const url = `${baseUrl}/chat/completions`;
    const body: OpenAIChatRequestBody = {
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      stream: true,
      stream_options: { include_usage: true },
    };

    // Forwarded only when provided — reasoning models (GPT-5.x, o-series) reject a custom
    // Temperature, so callers that target those models simply leave it undefined.
    if (temperature !== undefined) {
      body.temperature = temperature;
    }

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
      if ((error as Error).name === "AbortError") {
        yield { type: "done", stopReason: "cancelled" };
        return;
      }
      yield {
        type: "error",
        message: `Network error: ${(error as Error).message}`,
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
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();

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
            for (const tc of pendingToolCalls.values()) {
              yield { type: "tool_call_end", id: tc.id };
            }
            pendingToolCalls.clear();
            yield { type: "done", stopReason: "stop" };
            return;
          }

          let parsed: OpenAIStreamChunk;
          try {
            parsed = JSON.parse(dataStr) as OpenAIStreamChunk;
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

          // Chain-of-thought, under either of the two names providers give it.
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === "string" && reasoning) {
            yield { type: "reasoning", content: reasoning };
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
      void reader.cancel();
      if ((error as Error).name === "AbortError") {
        yield { type: "done", stopReason: "cancelled" };
        return;
      }
      yield {
        type: "error",
        message: `Stream error: ${(error as Error).message}`,
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
export interface AnthropicStreamingClientOptions {
  baseUrl: string;
  apiKey: string;
}

export function createAnthropicStreamingClient(
  _opts: AnthropicStreamingClientOptions,
): StreamingClient {
  /**
   * @yields {StreamEvent} Normalized stream events.
   * @returns {AsyncGenerator<StreamEvent>}
   */
  async function* streamChat(): AsyncGenerator<StreamEvent> {
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
export interface ProxyStreamingClientOptions {
  chatUrl: string;
  model?: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export function createProxyStreamingClient({
  chatUrl,
  model = "gpt-4o",
  apiKey,
  baseUrl,
}: ProxyStreamingClientOptions): StreamingClient {
  /**
   * @param {object[]} messages
   * @param {object[]} tools
   * @param {string} systemPrompt
   * @param {AbortSignal} signal
   * @yields {StreamEvent} Normalized stream events.
   * @returns {AsyncGenerator<StreamEvent>}
   */
  async function* streamChat(
    messages: object[],
    tools: object[],
    systemPrompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
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
      if ((error as Error).name === "AbortError") {
        yield { type: "done", stopReason: "cancelled" };
        return;
      }
      yield {
        type: "error",
        message: `Network error: ${(error as Error).message}`,
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
      // Try to extract a clean message from JSON error bodies (e.g. the proxy's
      // { error: "..." } shape or OpenAI's { error: { message: "..." } }).
      let cleanMessage = errorBody || response.statusText;
      /* The body's machine code beats the status. `code` was `String(response.status)`
         unconditionally, so a proxy answering 401 `{ code: "cf_reconnect_required" }` reached the
         client as `"401"` — indistinguishable from a bad BYOK key, and the one reading that would
         have put a Reconnect button on screen was thrown away at the only place it arrived. */
      let machineCode = "";
      try {
        const parsed = JSON.parse(errorBody) as ErrorResponseBody;
        if (typeof parsed.error === "string") {
          cleanMessage = parsed.error;
        } else if (parsed.error?.message) {
          cleanMessage = parsed.error.message;
        }
        if (typeof parsed.code === "string" && parsed.code) {
          machineCode = parsed.code;
        }
      } catch {
        /* Not JSON — use the raw body. */
      }
      yield {
        type: "error",
        message: cleanMessage,
        code: machineCode || String(response.status),
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
          let event: StreamEvent;
          try {
            event = JSON.parse(dataStr) as StreamEvent;
          } catch {
            continue; // Skip unparseable chunks
          }

          yield event;

          if (event.type === "done" || event.type === "error") {
            return;
          }
        }
      }
    } catch (error) {
      void reader.cancel();
      if ((error as Error).name === "AbortError") {
        yield { type: "done", stopReason: "cancelled" };
        return;
      }
      yield {
        type: "error",
        message: `Stream error: ${(error as Error).message}`,
      };
    }
  }

  return { streamChat };
}
