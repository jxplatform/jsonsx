import { describe, expect, test } from "bun:test";
import { createChatState } from "@jxsuite/ai";
import type { Message } from "@jxsuite/ai/chat-state";
import { pruneOrphanToolMessages, trimContext } from "../src/services/context-manager";

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

  test("extends the keep window backward to preserve a minimum of user/tool turns", () => {
    const cs = createChatState({ model: "gpt-4" });
    const msgs: Omit<Message, "id" | "timestamp">[] = [];
    // 5 leading user turns, then 20 assistant-only messages — the recent window (KEEP_RECENT=20)
    // Has zero user/tool turns, forcing the backward extension to reach the early user turns.
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: "user", content: longContent(400) });
    }
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: "assistant", content: longContent(400) });
    }
    pushMessages(cs, msgs);

    const result = trimContext(cs, longContent(500));
    expect(result!.droppedCount).toBeGreaterThan(0);
    // At least MIN_USER_TURNS (3) user turns are preserved beyond the recent window.
    const preservedUsers = cs.messages.filter((m) => m.role === "user").length;
    expect(preservedUsers).toBeGreaterThanOrEqual(3);
  });

  test("cannot trim below the minimum turns: warns without dropping", () => {
    const cs = createChatState({ model: "gpt-4" });
    // Only two enormous user messages — over budget, but fewer than MIN_USER_TURNS exist, so the
    // Backward extension reaches index 0 and trimming bails out (keepFrom <= 0).
    pushMessages(cs, [
      { role: "user", content: longContent(5000) },
      { role: "user", content: longContent(5000) },
    ]);

    const result = trimContext(cs, longContent(500));
    expect(result!.droppedCount).toBe(0);
    expect(cs.contextWarning).toBe(true);
    expect(cs.messages.length).toBe(2); // Nothing dropped
  });
});

describe("context-manager — pruneOrphanToolMessages", () => {
  /** An assistant turn that requested one tool call, and the reply that answers it. */
  function pair(callId: string): Omit<Message, "id" | "timestamp">[] {
    return [
      {
        role: "assistant",
        content: "Working on it",
        toolCalls: [{ id: callId, name: "read_file", arguments: "{}" }],
      },
      { role: "tool", content: '{"success":true}', toolCallId: callId },
    ];
  }

  test("a well-formed history is left exactly as it is", () => {
    const cs = createChatState({ model: "gpt-4" });
    pushMessages(cs, [{ role: "user", content: "Read it" }, ...pair("call_1")]);

    expect(pruneOrphanToolMessages(cs)).toEqual({ dropped: 0, sealed: 0 });
    expect(cs.messages.length).toBe(3);
  });

  test("a request with no reply is sealed with a failure, keeping the assistant's text", () => {
    const cs = createChatState({ model: "gpt-4" });
    pushMessages(cs, [
      { role: "user", content: "Ask me" },
      {
        role: "assistant",
        content: "Which pages matter?",
        toolCalls: [{ id: "call_ask", name: "ask_user", arguments: "{}" }],
      },
    ]);

    expect(pruneOrphanToolMessages(cs)).toEqual({ dropped: 0, sealed: 1 });
    expect(cs.messages.length).toBe(3);
    // Sealed IMMEDIATELY after its request — the only position toMessagesArray emits as a pair.
    expect(cs.messages[2]!.role).toBe("tool");
    expect(cs.messages[2]!.toolCallId).toBe("call_ask");
    expect(cs.messages[1]!.content).toBe("Which pages matter?");
    expect(JSON.parse(cs.messages[2]!.content)).toMatchObject({ success: false });
  });

  test("a reply with no request is dropped", () => {
    const cs = createChatState({ model: "gpt-4" });
    // What front-truncation leaves behind: the tail of a pair whose head was sliced off.
    pushMessages(cs, [
      { role: "tool", content: '{"success":true}', toolCallId: "call_gone" },
      { role: "user", content: "Carry on" },
    ]);

    expect(pruneOrphanToolMessages(cs)).toEqual({ dropped: 1, sealed: 0 });
    expect(cs.messages.length).toBe(1);
    expect(cs.messages[0]!.role).toBe("user");
  });

  test("a reply carrying no tool_call_id at all is dropped", () => {
    const cs = createChatState({ model: "gpt-4" });
    pushMessages(cs, [{ role: "tool", content: "{}" }]);

    expect(pruneOrphanToolMessages(cs)).toEqual({ dropped: 1, sealed: 0 });
    expect(cs.messages.length).toBe(0);
  });

  test("seals every unanswered call of a multi-call turn, in order", () => {
    const cs = createChatState({ model: "gpt-4" });
    pushMessages(cs, [
      {
        role: "assistant",
        content: "Two at once",
        toolCalls: [
          { id: "call_a", name: "read_file", arguments: "{}" },
          { id: "call_b", name: "read_file", arguments: "{}" },
        ],
      },
      { role: "tool", content: '{"success":true}', toolCallId: "call_b" },
    ]);

    expect(pruneOrphanToolMessages(cs)).toEqual({ dropped: 0, sealed: 1 });
    expect(cs.messages.map((m) => m.toolCallId)).toEqual([undefined, "call_a", "call_b"]);
  });

  test("repairs both shapes at once and leaves toMessagesArray well-formed", () => {
    const cs = createChatState({ model: "gpt-4" });
    pushMessages(cs, [
      { role: "tool", content: '{"success":true}', toolCallId: "call_sliced" },
      ...pair("call_ok"),
      {
        role: "assistant",
        content: "Still waiting",
        toolCalls: [{ id: "call_open", name: "ask_user", arguments: "{}" }],
      },
    ]);

    expect(pruneOrphanToolMessages(cs)).toEqual({ dropped: 1, sealed: 1 });

    // The property that matters: every tool reply follows the assistant request that declared it.
    const wire = cs.toMessagesArray() as {
      role: string;
      tool_calls?: { id: string }[];
      tool_call_id?: string;
    }[];
    const open = new Set<string>();
    for (const msg of wire) {
      if (msg.tool_calls) {
        for (const call of msg.tool_calls) {
          open.add(call.id);
        }
      } else if (msg.role === "tool") {
        expect(open.has(msg.tool_call_id!)).toBe(true);
        open.delete(msg.tool_call_id!);
      }
    }
    expect(open.size).toBe(0);
  });
});
