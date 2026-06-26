/**
 * Tests for the @jxsuite/ai barrel (src/index.ts) — asserts the public API surface is re-exported.
 *
 * @module @jxsuite/ai/tests
 */

import { describe, it, expect } from "bun:test";
import * as ai from "../src/index.js";

describe("@jxsuite/ai barrel", () => {
  it("re-exports the chat-state, tool, and streaming-client public API", () => {
    expect(typeof ai.createChatState).toBe("function");
    expect(typeof ai.createToolRegistry).toBe("function");
    expect(typeof ai.createToolDefinition).toBe("function");
    expect(typeof ai.createOpenAIStreamingClient).toBe("function");
    expect(typeof ai.createAnthropicStreamingClient).toBe("function");
    expect(typeof ai.createProxyStreamingClient).toBe("function");
    expect(ai.STREAM_EVENT_TYPES).toBeDefined();
  });
});
