import { describe, expect, test } from "bun:test";
import { createChatState } from "@jxsuite/ai";
import type { Message } from "@jxsuite/ai/chat-state";
import { trimContext } from "../src/services/context-manager";

function longContent(tokens: number) {
  return "x".repeat(tokens * 4);
}

function pushMessages(
  chatState: ReturnType<typeof createChatState>,
  messages: Omit<Message, "id" | "timestamp">[],
) {
  for (const m of messages) {
    chatState.messages.push({
      id: `msg_${chatState.messages.length}`,
      timestamp: Date.now(),
      ...m,
    });
  }
}

describe("context-manager — trimContext", () => {
  test("no trimming when within budget", () => {
    const cs = createChatState({ model: "gpt-4" });
    pushMessages(cs, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);

    const result = trimContext(cs, "System prompt");
    expect(result).not.toBeNull();
    expect(result!.droppedCount).toBe(0);
    expect(result!.estimatedTokens).toBeGreaterThan(0);
    expect(cs.messages.length).toBe(2);
  });

  test("trims oldest messages when over budget", () => {
    const cs = createChatState({ model: "gpt-4" });
    const msgCount = 40;
    const msgs: Omit<Message, "id" | "timestamp">[] = [];
    for (let i = 0; i < msgCount; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: longContent(200),
      });
    }
    pushMessages(cs, msgs);

    const beforeCount = cs.messages.length;
    const result = trimContext(cs, longContent(500));

    expect(result).not.toBeNull();
    expect(result!.droppedCount).toBeGreaterThan(0);
    expect(cs.messages.length).toBeLessThan(beforeCount);
    expect(cs.messages[0]!.content).toContain("truncated");
  });

  test("preserves the most recent messages after trim", () => {
    const cs = createChatState({ model: "gpt-4" });
    const msgs: Omit<Message, "id" | "timestamp">[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg-${i} ${longContent(200)}`,
      });
    }
    pushMessages(cs, msgs);

    trimContext(cs, longContent(500));

    const lastMsg = cs.messages.at(-1);
    expect(lastMsg!.content).toContain("msg-39");
  });

  test("trim does not orphan tool_calls (assistant with tool_calls kept iff tool result kept)", () => {
    const cs = createChatState({ model: "gpt-4" });
    const msgs: Omit<Message, "id" | "timestamp">[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(
        { role: "user", content: longContent(200) },
        { role: "assistant", content: longContent(200) },
      );
    }
    msgs.push(
      { role: "user", content: longContent(200) },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc_1", name: "read_document", arguments: "{}" }],
      },
      { role: "tool", content: '{"success":true}', toolCallId: "tc_1" },
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" },
    );
    pushMessages(cs, msgs);

    trimContext(cs, longContent(500));

    const remaining = cs.messages.filter(
      (m) => m.role !== "user" || !m.content.includes("truncated"),
    );
    const assistantWithTools = remaining.filter((m) => m.toolCalls && m.toolCalls.length > 0);
    for (const atc of assistantWithTools) {
      for (const tc of atc.toolCalls!) {
        const hasResponse = remaining.some((m) => m.role === "tool" && m.toolCallId === tc.id);
        expect(hasResponse).toBe(true);
      }
    }
  });

  test("sets contextWarning when trimming occurs", () => {
    const cs = createChatState({ model: "gpt-4" });
    const msgs: Omit<Message, "id" | "timestamp">[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: longContent(200),
      });
    }
    pushMessages(cs, msgs);

    trimContext(cs, longContent(500));
    expect(cs.contextWarning).toBe(true);
  });

  test("model-aware budget uses correct window size", () => {
    const csSmall = createChatState({ model: "gpt-4" });
    const csLarge = createChatState({ model: "gpt-4o" });

    // The gpt-4 budget: 8192 × 0.8 = 6553 tokens. Fill well past that.
    const msgs: Omit<Message, "id" | "timestamp">[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: longContent(300) });
    }
    pushMessages(csSmall, msgs);
    pushMessages(csLarge, structuredClone(msgs));

    const r1 = trimContext(csSmall, longContent(500));
    const r2 = trimContext(csLarge, longContent(500));

    // The gpt-4 window is 8192, gpt-4o is 128k — same content should trigger trim on gpt-4 but not gpt-4o
    expect(r1!.droppedCount).toBeGreaterThan(0);
    expect(r2!.droppedCount).toBe(0);
  });
});
