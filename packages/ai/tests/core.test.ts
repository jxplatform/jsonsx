/**
 * Tests for @jxsuite/ai — tool registry, chat state, and streaming client.
 *
 * @module @jxsuite/ai/tests
 */

import { describe, it, expect } from "bun:test";
import { effect } from "@vue/reactivity";
import { createToolDefinition, createToolRegistry, toolSuccess } from "../src/tools.js";
import { createChatState } from "../src/chat-state.js";
import {
  STREAM_EVENT_TYPES,
  createOpenAIStreamingClient,
  createAnthropicStreamingClient,
} from "../src/streaming-client.js";

// ─── Tool Registry ──────────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  it("registers and lists tools", () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "greet",
        description: "Greet someone",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        execute: (args) => toolSuccess(`Hello, ${(args as { name: string }).name}!`),
      }),
    );

    const tools = registry.list();
    expect(tools.length).toBe(1);
    expect(tools[0]!.name).toBe("greet");
  });

  it("lists tools in LLM format", () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "greet",
        description: "Greet someone",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        execute: () => toolSuccess("ok"),
      }),
    );

    const llmTools = registry.listForLLM();
    expect(llmTools.length).toBe(1);
    expect((llmTools[0] as { type: string }).type).toBe("function");
    expect((llmTools[0] as { function: { name: string } }).function.name).toBe("greet");
  });

  it("validates required arguments", () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "greet",
        description: "Greet someone",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        execute: () => toolSuccess("ok"),
      }),
    );

    const valid = registry.validate("greet", { name: "World" });
    expect(valid.valid).toBe(true);

    const invalid = registry.validate("greet", {});
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toBeDefined();
    expect(invalid.errors?.[0]).toContain("name");
  });

  it("validates argument types (rejects non-numeric strings for number)", () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "setAge",
        description: "Set age",
        parameters: {
          type: "object",
          properties: { age: { type: "number" } },
          required: ["age"],
        },
        execute: () => toolSuccess("ok"),
      }),
    );

    // Non-numeric string should fail
    const invalid = registry.validate("setAge", { age: "not a number" });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors?.[0]).toContain("non-numeric");

    // Numeric string should coerce
    const coerced = registry.validate("setAge", { age: "42" });
    expect(coerced.valid).toBe(true);

    // Actual number should work
    const valid = registry.validate("setAge", { age: 42 });
    expect(valid.valid).toBe(true);
  });

  it("rejects unknown tools", () => {
    const registry = createToolRegistry();
    const valid = registry.validate("nonexistent", {});
    expect(valid.valid).toBe(false);
    expect(valid.errors?.[0]).toContain("Unknown tool");
  });

  it("executes tools and returns results", async () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "add",
        description: "Add two numbers",
        parameters: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        execute: (args) => {
          const { a, b } = args as { a: number; b: number };
          return toolSuccess(a + b, `Sum: ${a + b}`);
        },
      }),
    );

    const result = await registry.execute("add", { a: 1, b: 2 });
    expect(result.success).toBe(true);
    expect(result.data).toBe(3);
    expect(result.summary).toBe("Sum: 3");
  });

  it("returns error for execution failures", async () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "fail",
        description: "Always fails",
        parameters: { type: "object", properties: {} },
        execute: () => {
          throw new Error("Boom");
        },
      }),
    );

    const result = await registry.execute("fail", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Boom");
  });

  it("respects strict: false (skips validation)", async () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "lenient",
        description: "Lenient tool",
        parameters: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
        strict: false,
        execute: (args) => toolSuccess((args as { x?: string }).x || "default"),
      }),
    );

    // Should pass even though x is missing (strict: false skips validation)
    const result = await registry.execute("lenient", {});
    expect(result.success).toBe(true);
  });
});

// ─── Chat State ──────────────────────────────────────────────────────────────

describe("ChatState", () => {
  it("starts with empty messages and idle status", () => {
    const chat = createChatState();
    expect(chat.messages.length).toBe(0);
    expect(chat.status).toBe("idle");
  });

  it("adds a user message on send and sets streaming status", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");

    expect(chat.messages.length).toBe(2); // User + placeholder assistant
    expect(chat.messages[0]!.role).toBe("user");
    expect(chat.messages[0]!.content).toBe("Hello");
    expect(chat.messages[1]!.role).toBe("assistant");
    expect(chat.status).toBe("streaming");
  });

  it("appends deltas to streaming message", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi ");
    chat.appendDelta("there!");

    expect(chat.streamingContent).toBe("Hi there!");
    expect(chat.messages[1]!.content).toBe("Hi there!");
  });

  it("tracks tool calls during streaming", () => {
    const chat = createChatState();
    chat.sendMessage("Add a button");
    chat.appendToolCallStart("tc_1", "addElement");
    chat.appendToolCallDelta("tc_1", '{"tagName":"button"');
    chat.appendToolCallDelta("tc_1", "}");
    chat.appendToolCallEnd("tc_1");

    expect(chat.pendingToolCalls.length).toBe(1);
    expect(chat.pendingToolCalls[0]!.name).toBe("addElement");
    expect(chat.pendingToolCalls[0]!.arguments).toBe('{"tagName":"button"}');
  });

  it("attaches tool results", () => {
    const chat = createChatState();
    chat.sendMessage("Do something");
    chat.appendToolCallStart("tc_1", "updateStyle");
    chat.appendToolCallEnd("tc_1");
    chat.appendToolResult("tc_1", toolSuccess(null, "Updated 1 property"));

    expect(chat.pendingToolCalls[0]!.result).toBeDefined();
    expect(chat.pendingToolCalls[0]!.result?.summary).toBe("Updated 1 property");
  });

  it("finishes stream and clears streaming state", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi");
    chat.finishStream("stop");

    expect(chat.status).toBe("idle");
    expect(chat.streamingContent).toBe("");
  });

  it("sets error state", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.setError("Network error");

    expect(chat.status).toBe("error");
    expect(chat.error).toBe("Network error");
  });

  it("cancels stream and removes empty placeholder", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    // No content appended — cancel should remove the placeholder
    chat.cancelStream();

    expect(chat.status).toBe("idle");
    // The placeholder should be removed (no content, no tool calls)
    // Only the user message should remain
    const assistantMessages = chat.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(0);
  });

  it("clears all messages", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi");
    chat.finishStream("stop");
    chat.clearChat();

    expect(chat.messages.length).toBe(0);
  });

  it("retries last message", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi there");
    chat.finishStream("stop");
    chat.retryLast();

    expect(chat.messages.length).toBe(0);
    expect(chat.status).toBe("idle");
  });

  it("converts to messages array for LLM API", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi!");
    chat.finishStream("stop");

    const msgs = chat.toMessagesArray();
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe("Hello");
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content).toBe("Hi!");
  });

  it("ignores sendMessage while streaming", () => {
    const chat = createChatState();
    chat.sendMessage("First");
    chat.sendMessage("Second"); // Should be ignored

    // Only 2 messages: user "First" + placeholder assistant
    expect(chat.messages.filter((m) => m.role === "user").length).toBe(1);
  });

  it("notifies reactive effects on streaming appendDelta (messages[i].content)", () => {
    const chat = createChatState();

    let effectCount = 0;
    let lastContent = "";

    effect(() => {
      // Track the streaming message's content so the effect re-runs on every delta.
      const msgs = chat.messages;
      if (msgs.length > 0) {
        lastContent = msgs.at(-1)!.content;
      }
      // Track status changes too so effect re-runs on sendMessage/finishStream.
      void chat.status;
      effectCount += 1;
    });

    // Initial effect run
    expect(effectCount).toBe(1);

    chat.sendMessage("Hello");
    // SendMessage creates user msg + placeholder assistant → at least one more effect run
    expect(effectCount).toBeGreaterThanOrEqual(2);
    const afterSend = effectCount;

    chat.appendDelta("Hi ");
    // AppendDelta must notify effects — content changed
    expect(effectCount).toBeGreaterThan(afterSend);
    expect(lastContent).toBe("Hi ");
    const afterFirstDelta = effectCount;

    chat.appendDelta("there!");
    expect(effectCount).toBeGreaterThan(afterFirstDelta);
    expect(lastContent).toBe("Hi there!");
  });
});

// ─── Streaming Client ────────────────────────────────────────────────────────

describe("StreamingClient", () => {
  it("exports event type constants", () => {
    expect(STREAM_EVENT_TYPES.DELTA).toBe("delta");
    expect(STREAM_EVENT_TYPES.TOOL_CALL_START).toBe("tool_call_start");
    expect(STREAM_EVENT_TYPES.TOOL_CALL_DELTA).toBe("tool_call_delta");
    expect(STREAM_EVENT_TYPES.TOOL_CALL_END).toBe("tool_call_end");
    expect(STREAM_EVENT_TYPES.DONE).toBe("done");
    expect(STREAM_EVENT_TYPES.ERROR).toBe("error");
  });

  it("OpenAI client factory creates an object with streamChat method", () => {
    const client = createOpenAIStreamingClient({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
    });

    expect(typeof client.streamChat).toBe("function");
  });

  it("Anthropic client stub returns error event", async () => {
    const client = createAnthropicStreamingClient({
      baseUrl: "https://api.anthropic.com",
      apiKey: "test-key",
    });

    const events = [];
    for await (const event of client.streamChat([], [], "", new AbortController().signal)) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("error");
    expect((events[0] as { message: string }).message).toContain("not yet implemented");
  });
});
