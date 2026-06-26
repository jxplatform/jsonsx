/**
 * Tests for src/services/document-assistant.ts — the Stack B document AI session.
 *
 * Drives createDocumentAssistant().sendMessage() end-to-end with a scripted streaming client. The
 * AI barrel's createProxyStreamingClient is mocked while createChatState/createToolRegistry stay
 * real, so the full wiring — system prompt, context trim, tool registry, agent loop, persistence —
 * runs without a network. The tool path mutates the live document as one undo step.
 */
import { installMockPlatform, resetWorkspaceWithTab } from "./harness";
import { createChatState, createToolRegistry } from "@jxsuite/ai";
import type { StreamingClient } from "@jxsuite/ai/streaming-client";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/** The normalized stream event the StreamingClient emits (not exported, so derived here). */
type StreamEvent =
  ReturnType<StreamingClient["streamChat"]> extends AsyncGenerator<infer E> ? E : never;

let nextRounds: StreamEvent[][] = [];
let createErrorMessage: string | null = null;
let lastClientOpts: Record<string, unknown> | null = null;

function fakeClient(rounds: StreamEvent[][]): StreamingClient {
  let call = 0;
  return {
    async *streamChat() {
      const events = rounds[call] ?? [{ stopReason: "stop", type: "done" }];
      call += 1;
      for (const e of events) {
        yield e;
      }
    },
  };
}

/** One tool call followed by a tool_calls stop. */
function toolCallRound(id: string, name: string, args: object): StreamEvent[] {
  return [
    { id, name, type: "tool_call_start" },
    { args: JSON.stringify(args), id, type: "tool_call_delta" },
    { id, type: "tool_call_end" },
    { stopReason: "tool_calls", type: "done" },
  ];
}

void mock.module("@jxsuite/ai", () => ({
  createChatState,
  createProxyStreamingClient: (opts: Record<string, unknown>) => {
    lastClientOpts = opts;
    if (createErrorMessage) {
      throw new Error(createErrorMessage);
    }
    return fakeClient(nextRounds);
  },
  createToolRegistry,
}));

const PERSIST_KEY = "jx-ai-chat-history";
const { createDocumentAssistant } = await import("../src/services/document-assistant");

beforeEach(() => {
  installMockPlatform();
  resetWorkspaceWithTab();
  globalThis.localStorage.clear();
  nextRounds = [];
  createErrorMessage = null;
  lastClientOpts = null;
});

afterEach(() => {
  globalThis.localStorage.clear();
});

describe("document-assistant", () => {
  test("streams a text reply and persists the conversation", async () => {
    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-secret");
    globalThis.localStorage.setItem("jx.ai.baseUrl", "http://localhost:11434/v1");
    nextRounds = [
      [
        { content: "Hello there", type: "delta" },
        { stopReason: "stop", type: "done" },
      ],
    ];

    const a = createDocumentAssistant();
    await a.sendMessage("hi");

    expect(a.chatState.status).toBe("idle");
    expect(
      a.chatState.messages.some((m) => m.role === "assistant" && m.content.includes("Hello")),
    ).toBe(true);
    // The streaming client received the stored credentials.
    expect(lastClientOpts?.apiKey).toBe("sk-secret");
    expect(lastClientOpts?.baseUrl).toBe("http://localhost:11434/v1");
    // Persisted before streaming under the shared fallback key, so it holds the user message.
    expect(globalThis.localStorage.getItem(PERSIST_KEY)).toContain("hi");
  });

  test("executes a tool call that mutates the document as a single undo step", async () => {
    nextRounds = [
      toolCallRound("c1", "add_child", {
        index: 1,
        node: { tagName: "span", textContent: "added" },
        parentPath: [],
      }),
      [{ stopReason: "stop", type: "done" }],
    ];

    const a = createDocumentAssistant();
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    });
    await a.sendMessage("add a span");

    const children = tab.doc.document.children as (JxMutableNode | string)[];
    expect(children).toHaveLength(2);
    expect((children[1] as JxMutableNode).tagName).toBe("span");
    expect(tab.history.index).toBe(1); // One undoable transaction (batched)
    expect(a.chatState.status).toBe("idle");
  });

  test("ignores empty input and re-entrant sends while streaming", async () => {
    const a = createDocumentAssistant();
    await a.sendMessage("   ");
    expect(a.chatState.messages).toHaveLength(0);

    a.chatState.status = "streaming";
    await a.sendMessage("blocked");
    expect(a.chatState.messages).toHaveLength(0);
  });

  test("surfaces a streaming-client construction failure as an error", async () => {
    createErrorMessage = "network down";
    const a = createDocumentAssistant();
    await a.sendMessage("hi");
    expect(a.chatState.status).toBe("error");
    expect(a.chatState.error).toContain("network down");
  });

  test("stop() and newChat() reset the session", async () => {
    nextRounds = [
      [
        { content: "x", type: "delta" },
        { stopReason: "stop", type: "done" },
      ],
    ];
    const a = createDocumentAssistant();
    await a.sendMessage("hi");
    expect(a.chatState.messages.length).toBeGreaterThan(0);

    a.stop(); // No active controller → just cancels stream state
    a.newChat();
    expect(a.chatState.messages).toHaveLength(0);
    expect(globalThis.localStorage.getItem(PERSIST_KEY)).toBe("[]");
  });

  test("restores a persisted conversation on creation", () => {
    globalThis.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify([
        { content: "earlier", id: "m1", role: "user", timestamp: 1 },
        { content: "reply", role: "assistant", timestamp: 2 }, // Missing id → synthesized
      ]),
    );
    const a = createDocumentAssistant();
    expect(a.chatState.messages).toHaveLength(2);
    expect(a.chatState.messages[0]!.content).toBe("earlier");
    expect(a.chatState.messages[1]!.id).toBeTruthy();
  });

  test("ignores corrupt or empty persisted history", () => {
    globalThis.localStorage.setItem(PERSIST_KEY, "{not json");
    expect(createDocumentAssistant().chatState.messages).toHaveLength(0);

    globalThis.localStorage.setItem(PERSIST_KEY, "[]");
    expect(createDocumentAssistant().chatState.messages).toHaveLength(0);
  });
});
