/**
 * Index.js — AI infrastructure for Jx Suite (`@jxsuite/ai`)
 *
 * Re-exports the core modules: streaming client abstraction, tool registry, and
 * reactive chat state management. Provider-agnostic; no Studio or Jx dependencies.
 *
 * @license MIT
 */

// Re-export from sub-modules so consumers can `import { ... } from "@jxsuite/ai"`.
// Importing individual files instead enables tree-shaking.
export { createToolDefinition, createToolRegistry } from "./tools.js";

export { createChatState } from "./chat-state.js";

export {
  STREAM_EVENT_TYPES,
  createOpenAIStreamingClient,
  createAnthropicStreamingClient,
  createProxyStreamingClient,
} from "./streaming-client.js";

export type {
  AnthropicStreamingClientOptions,
  OpenAIStreamingClientOptions,
  ProxyStreamingClientOptions,
  StreamDeltaEvent,
  StreamDoneEvent,
  StreamErrorEvent,
  StreamEvent,
  StreamReasoningEvent,
  StreamingClient,
  StreamToolCallDeltaEvent,
  StreamToolCallEndEvent,
  StreamToolCallStartEvent,
} from "./streaming-client.js";
