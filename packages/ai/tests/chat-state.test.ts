/**
 * Tests for @jxsuite/ai chat-state — reactive store mutations and message export.
 *
 * Focuses on branches and methods not exercised by core.test.ts: early-return guards, tool-result
 * messages, error/cancel partial-message removal, setters, retryLast, and toMessagesArray with
 * tool_calls / tool-role branches.
 *
 * @module @jxsuite/ai/tests
 */

import { describe, it, expect } from "bun:test";
import { createChatState } from "../src/chat-state.ts";
import { toolSuccess } from "../src/tools.ts";

describe("chat-state factory", () => {
  it("defaults to the gpt-4o model when none is supplied", () => {
    const chat = createChatState();
    expect(chat.model).toBe("gpt-4o");
    expect(chat.tokenCount).toBe(0);
    expect(chat.contextWarning).toBe(false);
    expect(chat.error).toBeNull();
  });

  it("uses a custom model from opts", () => {
    const chat = createChatState({ model: "claude-3-5-sonnet" });
    expect(chat.model).toBe("claude-3-5-sonnet");
  });

  it("falls back to the default when an empty model string is given", () => {
    const chat = createChatState({ model: "" });
    expect(chat.model).toBe("gpt-4o");
  });
});

describe("chat-state streaming guards", () => {
  it("ignores beginAssistantTurn while already streaming", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    expect(chat.status).toBe("streaming");
    const before = chat.messages.length;

    chat.beginAssistantTurn();
    expect(chat.messages.length).toBe(before);
  });

  it("ignores appendDelta when not streaming", () => {
    const chat = createChatState();
    chat.appendDelta("ignored");
    expect(chat.streamingContent).toBe("");
    expect(chat.messages.length).toBe(0);
  });

  it("ignores appendDelta after the stream is finished", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi");
    chat.finishStream("stop");
    chat.appendDelta("late");
    expect(chat.messages.at(-1)!.content).toBe("Hi");
    expect(chat.streamingContent).toBe("");
  });

  it("ignores appendReasoning when not streaming", () => {
    const chat = createChatState();
    chat.appendReasoning("ignored");
    expect(chat.messages.length).toBe(0);
  });

  it("ignores appendReasoning after the stream is finished", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendReasoning("thinking");
    chat.finishStream("stop");
    chat.appendReasoning("late");
    expect(chat.messages.at(-1)!.reasoningContent).toBe("thinking");
  });

  it("accumulates reasoning deltas separately from the answer text", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendReasoning("first ");
    chat.appendDelta("Hi!");
    chat.appendReasoning("second");
    expect(chat.messages.at(-1)!.reasoningContent).toBe("first second");
    expect(chat.messages.at(-1)!.content).toBe("Hi!");
    expect(chat.streamingContent).toBe("Hi!");
  });

  it("ignores appendToolCallStart when not streaming", () => {
    const chat = createChatState();
    chat.appendToolCallStart("tc_1", "noop");
    expect(chat.pendingToolCalls.length).toBe(0);
  });
});

describe("chat-state tool-call accumulation", () => {
  it("attaches tool calls to the streaming assistant message", () => {
    const chat = createChatState();
    chat.sendMessage("Add a button");
    chat.appendToolCallStart("tc_1", "addElement");
    chat.appendToolCallDelta("tc_1", '{"tag":"button"}');

    const assistant = chat.messages.at(-1)!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.toolCalls?.length).toBe(1);
    expect(assistant.toolCalls?.[0]!.name).toBe("addElement");
    expect(assistant.toolCalls?.[0]!.arguments).toBe('{"tag":"button"}');
  });

  it("supports multiple tool calls on a single assistant message", () => {
    const chat = createChatState();
    chat.sendMessage("Do two things");
    chat.appendToolCallStart("tc_1", "first");
    chat.appendToolCallStart("tc_2", "second");

    const assistant = chat.messages.at(-1)!;
    expect(assistant.toolCalls?.length).toBe(2);
    expect(chat.pendingToolCalls.length).toBe(2);
  });

  it("ignores appendToolCallDelta for an unknown tool-call id", () => {
    const chat = createChatState();
    chat.sendMessage("hi");
    chat.appendToolCallStart("tc_1", "tool");
    chat.appendToolCallDelta("missing", "should-be-dropped");
    expect(chat.pendingToolCalls[0]!.arguments).toBe("");
  });

  it("appendToolCallEnd is a no-op that does not throw", () => {
    const chat = createChatState();
    chat.sendMessage("hi");
    chat.appendToolCallStart("tc_1", "tool");
    expect(() => chat.appendToolCallEnd("tc_1")).not.toThrow();
  });

  it("updates the result on both the pending list and the message record", () => {
    const chat = createChatState();
    chat.sendMessage("Do something");
    chat.appendToolCallStart("tc_1", "updateStyle");
    chat.appendToolResult("tc_1", toolSuccess(null, "done"));

    expect(chat.pendingToolCalls[0]!.result?.summary).toBe("done");
    const assistant = chat.messages.at(-1)!;
    expect(assistant.toolCalls?.[0]!.result?.summary).toBe("done");
  });

  it("ignores appendToolResult for an unknown tool-call id", () => {
    const chat = createChatState();
    chat.sendMessage("Do something");
    chat.appendToolCallStart("tc_1", "tool");
    chat.appendToolResult("missing", toolSuccess(null, "nope"));
    expect(chat.pendingToolCalls[0]!.result).toBeNull();
  });
});

describe("chat-state pushToolResultMessage", () => {
  it("appends a tool-role message carrying the result content", () => {
    const chat = createChatState();
    chat.pushToolResultMessage("tc_1", "result payload");

    const msg = chat.messages.at(-1)!;
    expect(msg.role).toBe("tool");
    expect(msg.toolCallId).toBe("tc_1");
    expect(msg.content).toBe("result payload");
    expect(typeof msg.id).toBe("string");
    expect(typeof msg.timestamp).toBe("number");
  });
});

describe("chat-state agent loop", () => {
  it("can begin a fresh assistant turn after finishing a stream", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendToolCallStart("tc_1", "tool");
    chat.appendToolCallDelta("tc_1", "{}");
    chat.finishStream("tool_calls");

    chat.pushToolResultMessage("tc_1", "ok");
    chat.beginAssistantTurn();

    expect(chat.status).toBe("streaming");
    expect(chat.pendingToolCalls.length).toBe(0);
    expect(chat.streamingContent).toBe("");
    expect(chat.messages.at(-1)!.role).toBe("assistant");
  });
});

describe("chat-state error and cancel", () => {
  it("removes the partial streaming message on setError", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    expect(chat.messages.filter((m) => m.role === "assistant").length).toBe(1);

    chat.setError("boom");
    expect(chat.status).toBe("error");
    expect(chat.error).toBe("boom");
    expect(chat.streamingContent).toBe("");
    expect(chat.messages.filter((m) => m.role === "assistant").length).toBe(0);
  });

  it("setError is safe when there is no active streaming message", () => {
    const chat = createChatState();
    chat.setError("standalone error");
    expect(chat.status).toBe("error");
    expect(chat.error).toBe("standalone error");
    expect(chat.messages.length).toBe(0);
  });

  it("cancelStream removes the placeholder and resets state", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("partial");
    chat.cancelStream();

    expect(chat.status).toBe("idle");
    expect(chat.error).toBeNull();
    expect(chat.streamingContent).toBe("");
    expect(chat.pendingToolCalls.length).toBe(0);
    expect(chat.messages.filter((m) => m.role === "assistant").length).toBe(0);
  });

  it("cancelStream is safe with no active stream", () => {
    const chat = createChatState();
    chat.cancelStream();
    expect(chat.status).toBe("idle");
    expect(chat.messages.length).toBe(0);
  });
});

describe("chat-state clear and retry", () => {
  it("clearChat resets every field including contextWarning", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi");
    chat.setContextWarning(true);
    chat.setTokenCount(1234);
    chat.finishStream("stop");
    chat.clearChat();

    expect(chat.messages.length).toBe(0);
    expect(chat.status).toBe("idle");
    expect(chat.streamingContent).toBe("");
    expect(chat.pendingToolCalls.length).toBe(0);
    expect(chat.error).toBeNull();
    expect(chat.contextWarning).toBe(false);
  });

  it("retryLast pops the trailing assistant and user messages", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi there");
    chat.finishStream("stop");
    chat.retryLast();

    expect(chat.messages.length).toBe(0);
    expect(chat.status).toBe("idle");
    expect(chat.error).toBeNull();
  });

  it("retryLast keeps earlier turns intact", () => {
    const chat = createChatState();
    chat.sendMessage("First");
    chat.appendDelta("Reply one");
    chat.finishStream("stop");
    chat.sendMessage("Second");
    chat.appendDelta("Reply two");
    chat.finishStream("stop");

    chat.retryLast();

    const remaining = chat.messages.map((m) => m.content);
    expect(remaining).toEqual(["First", "Reply one"]);
  });

  it("retryLast on an empty chat is a no-op", () => {
    const chat = createChatState();
    chat.retryLast();
    expect(chat.messages.length).toBe(0);
    expect(chat.status).toBe("idle");
  });

  it("retryLast clears an error after a failed turn", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.setError("network down");
    chat.retryLast();

    expect(chat.status).toBe("idle");
    expect(chat.error).toBeNull();
    expect(chat.messages.length).toBe(0);
  });
});

describe("chat-state setters", () => {
  it("setModel updates the model", () => {
    const chat = createChatState();
    chat.setModel("gpt-4o-mini");
    expect(chat.model).toBe("gpt-4o-mini");
  });

  it("setTokenCount updates the token count", () => {
    const chat = createChatState();
    chat.setTokenCount(987);
    expect(chat.tokenCount).toBe(987);
  });

  it("setContextWarning toggles the warning flag", () => {
    const chat = createChatState();
    chat.setContextWarning(true);
    expect(chat.contextWarning).toBe(true);
    chat.setContextWarning(false);
    expect(chat.contextWarning).toBe(false);
  });
});

describe("chat-state toMessagesArray", () => {
  it("emits plain user and assistant entries", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi!");
    chat.finishStream("stop");

    const msgs = chat.toMessagesArray() as { role: string; content: unknown }[];
    expect(msgs).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ]);
  });

  it("serializes assistant tool_calls into the LLM function-call shape", () => {
    const chat = createChatState();
    chat.sendMessage("Add a button");
    chat.appendToolCallStart("tc_1", "addElement");
    chat.appendToolCallDelta("tc_1", '{"tag":"button"}');
    chat.finishStream("tool_calls");

    const msgs = chat.toMessagesArray() as {
      role: string;
      content: unknown;
      tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    }[];
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls?.length).toBe(1);
    const call = assistant.tool_calls![0]!;
    expect(call.id).toBe("tc_1");
    expect(call.type).toBe("function");
    expect(call.function.name).toBe("addElement");
    expect(call.function.arguments).toBe('{"tag":"button"}');
  });

  it("preserves assistant text content alongside tool_calls", () => {
    const chat = createChatState();
    chat.sendMessage("Add a button");
    chat.appendDelta("Sure, adding one.");
    chat.appendToolCallStart("tc_1", "addElement");
    chat.appendToolCallDelta("tc_1", "{}");
    chat.finishStream("tool_calls");

    const msgs = chat.toMessagesArray() as { role: string; content: unknown }[];
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("Sure, adding one.");
  });

  it("emits tool-role messages with tool_call_id", () => {
    const chat = createChatState();
    chat.sendMessage("Do it");
    chat.appendToolCallStart("tc_1", "doIt");
    chat.appendToolCallDelta("tc_1", "{}");
    chat.finishStream("tool_calls");
    chat.pushToolResultMessage("tc_1", "completed");

    const msgs = chat.toMessagesArray() as {
      role: string;
      content: unknown;
      tool_call_id?: string;
    }[];
    const toolMsg = msgs.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("tc_1");
    expect(toolMsg.content).toBe("completed");
  });

  it("omits the in-flight assistant placeholder", () => {
    /* The turn being generated by the very request this builds. Sent as a trailing
       {"role":"assistant","content":""}, DeepSeek's thinking mode answered 400 asking for the
       reasoning_content that a turn which has not happened yet cannot have. */
    const chat = createChatState();
    chat.sendMessage("Import that site");

    expect(chat.messages.length).toBe(2);
    expect(chat.toMessagesArray()).toEqual([{ role: "user", content: "Import that site" }]);
  });

  it("omits an assistant turn that ended with neither text nor tool calls", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.finishStream("stop");

    expect(chat.toMessagesArray()).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("replays reasoning_content on the turn that streamed it", () => {
    const chat = createChatState();
    chat.sendMessage("Add a button");
    chat.appendReasoning("The user wants a button.");
    chat.appendToolCallStart("tc_1", "addElement");
    chat.appendToolCallDelta("tc_1", "{}");
    chat.finishStream("tool_calls");
    chat.pushToolResultMessage("tc_1", "done");
    chat.beginAssistantTurn();

    const msgs = chat.toMessagesArray() as { role: string; reasoning_content?: string }[];
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant.reasoning_content).toBe("The user wants a button.");
    // And the next round's placeholder is still not among them.
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("emits no reasoning_content for a provider that streamed none", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("Hi!");
    chat.finishStream("stop");

    const assistant = chat.toMessagesArray().at(-1)!;
    expect(assistant).toEqual({ role: "assistant", content: "Hi!" });
    expect("reasoning_content" in assistant).toBe(false);
  });

  it("treats an assistant message with an empty toolCalls array as plain text", () => {
    const chat = createChatState();
    chat.sendMessage("Hello");
    chat.appendDelta("plain reply");
    // Force an empty (but present) toolCalls array to exercise the length-zero branch.
    chat.messages.at(-1)!.toolCalls = [];
    chat.finishStream("stop");

    const msgs = chat.toMessagesArray() as { role: string; content: unknown }[];
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant).toEqual({ role: "assistant", content: "plain reply" });
  });
});
