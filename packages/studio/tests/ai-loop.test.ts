import "./with-dom.ts";
import { describe, expect, test } from "bun:test";
import { createChatState, createToolRegistry } from "@jxsuite/ai";
import type { ToolRegistry } from "@jxsuite/ai/tools";
import type { StreamEvent, StreamingClient } from "@jxsuite/ai/streaming-client";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { createTab, disposeTab } from "../src/tabs/tab";
import type { Tab } from "../src/tabs/tab";
import { registerAiTools } from "../src/services/ai-tools";
import { runAgentLoop } from "../src/services/tool-executor";
import { answerAsk, pendingAsk, registerAskTool, resetAsk } from "../src/services/ai-ask";

/**
 * A scripted streaming client: each entry in `rounds` is the sequence of StreamEvents to yield on
 * the corresponding streamChat() call. Lets us drive runAgentLoop without a real LLM.
 *
 * @param {object[][]} rounds
 */
function fakeClient(
  rounds: StreamEvent[][],
): StreamingClient & { calls: () => number; sent: () => object[][] } {
  let call = 0;
  const sent: object[][] = [];
  return {
    calls: () => call,
    sent: () => sent,
    async *streamChat(messages: object[]) {
      sent.push(messages);
      const events = rounds[call] ?? [{ type: "done", stopReason: "stop" }];
      call += 1;
      for (const e of events) {
        yield e;
      }
    },
  };
}

/** Emit the event sequence for one tool call followed by a tool_calls stop. */
function toolCallRound(id: string, name: string, args: object): StreamEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, args: JSON.stringify(args) },
    { type: "tool_call_end", id },
    { type: "done", stopReason: "tool_calls" },
  ];
}

function makeTab(doc?: Record<string, unknown>) {
  const document = doc ?? { tagName: "div", children: [{ tagName: "p", textContent: "Hello" }] };
  return createTab({ document, id: "test" });
}

function harness(tab: Tab, validate?: (doc: unknown) => Promise<string[]>) {
  const chatState = createChatState({ model: "test" });
  const toolRegistry = createToolRegistry();
  registerAiTools(toolRegistry, { getTab: () => tab, ...(validate ? { validate } : {}) });
  return { chatState, toolRegistry: toolRegistry as ToolRegistry };
}

describe("ai agent loop — integration", () => {
  test("executes a tool call and mutates the live document", async () => {
    const tab = makeTab();
    const { chatState, toolRegistry } = harness(tab, async () => []);
    const client = fakeClient([
      toolCallRound("c1", "add_child", {
        parentPath: [],
        index: 1,
        node: { tagName: "span", textContent: "added" },
      }),
      [{ type: "done", stopReason: "stop" }],
    ]);

    chatState.sendMessage("add a span");
    await runAgentLoop({ chatState, streamingClient: client, toolRegistry, systemPrompt: "" });

    const children = tab.doc.document.children as (JxMutableNode | string)[];
    expect(children).toHaveLength(2);
    expect((children[1] as JxMutableNode).tagName).toBe("span");
    expect(tab.history.index).toBe(1); // One undoable transaction
    expect(chatState.status).toBe("idle");
    disposeTab(tab);
  });

  test("sends no empty assistant turn, and replays the reasoning it was given", async () => {
    /* Both halves are one provider's contract: DeepSeek's thinking mode 400s on an assistant turn
       with no reasoning_content, and the request used to carry two of them — the placeholder for
       the answer being generated, then the tool-call turn stripped of its reasoning. */
    const tab = makeTab();
    const { chatState, toolRegistry } = harness(tab, async () => []);
    const client = fakeClient([
      [
        { type: "reasoning", content: "They want a span. " },
        { type: "reasoning", content: "add_child does it." },
        ...toolCallRound("c1", "add_child", {
          parentPath: [],
          index: 1,
          node: { tagName: "span", textContent: "added" },
        }),
      ],
      [{ type: "done", stopReason: "stop" }],
    ]);

    chatState.sendMessage("add a span");
    await runAgentLoop({ chatState, streamingClient: client, toolRegistry, systemPrompt: "" });

    const firstRound = client.sent()[0] as { role: string }[];
    expect(firstRound.map((m) => m.role)).toEqual(["user"]);

    const secondRound = client.sent()[1] as { role: string; reasoning_content?: string }[];
    expect(secondRound.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(secondRound[1]!.reasoning_content).toBe("They want a span. add_child does it.");
    disposeTab(tab);
  });

  test("feeds schema errors back so the model can self-correct", async () => {
    const tab = makeTab();
    // Inject a validator that flags the document while the root tagName is "header" (no hyphen),
    // And is happy once it becomes "site-header" — simulating the schema eval signal.
    const validate = async (doc: unknown) =>
      (doc as JxMutableNode).tagName === "header" ? ["(root): invalid custom element tagName"] : [];
    const { chatState, toolRegistry } = harness(tab, validate);

    const client = fakeClient([
      // Round 1: introduce the bad tagName.
      toolCallRound("c1", "set_property", { path: [], key: "tagName", value: "header" }),
      // Round 2: the model reacts to the error and fixes it.
      toolCallRound("c2", "set_property", { path: [], key: "tagName", value: "site-header" }),
      // Round 3: done.
      [{ type: "done", stopReason: "stop" }],
    ]);

    chatState.sendMessage("rename root to header");
    await runAgentLoop({ chatState, streamingClient: client, toolRegistry, systemPrompt: "" });

    expect(tab.doc.document.tagName).toBe("site-header");
    // The first tool result must have surfaced the schema error to the model.
    const toolMsgs = chatState.messages.filter((m) => m.role === "tool");
    expect(toolMsgs[0]!.content).toContain("schema errors");
    expect(toolMsgs[0]!.content).toContain("invalid custom element tagName");
    // The corrected round reported success (no schema errors).
    expect(toolMsgs[1]!.content).toContain('"success":true');
    expect(chatState.status).toBe("idle");
    disposeTab(tab);
  });

  test("a run that hit the round cap AFTER applying changes is not an error (§7.4)", async () => {
    /* Partial success is not failure. `setError` paints the turn red and — in chat-state.ts —
       deletes the streaming message, so a run that made five edits and then hit the cap reported
       as an error that had also erased its own account of the five edits. */
    const tab = makeTab();
    const { chatState, toolRegistry } = harness(tab, async () => []);
    // Every round emits another tool call — the model never stops, but every call SUCCEEDS.
    const client = fakeClient(
      Array.from({ length: 10 }, (_, i) =>
        toolCallRound(`c${i}`, "set_property", { path: [], key: "id", value: `v${i}` }),
      ),
    );

    chatState.sendMessage("loop forever");
    await runAgentLoop({ chatState, streamingClient: client, toolRegistry, systemPrompt: "" });

    expect(client.calls()).toBe(5); // MAX_ROUNDS
    expect(chatState.status).toBe("idle");
    expect(chatState.error).toBeNull();
    const tail = chatState.messages.at(-1)!;
    expect(tail.role).toBe("assistant");
    expect(tail.content).toContain("ran out of tool-call rounds");
    expect(tail.content).toContain("Changes applied so far");
    // And the edits it is telling you about are really there.
    expect((tab.doc.document as Record<string, unknown>).id).toBe("v4");
    disposeTab(tab);
  });

  test("surfaces an upstream stream error and stops", async () => {
    const tab = makeTab();
    const { chatState, toolRegistry } = harness(tab, async () => []);
    const client = fakeClient([[{ type: "error", message: "upstream 500" }]]);

    chatState.sendMessage("hi");
    await runAgentLoop({ chatState, streamingClient: client, toolRegistry, systemPrompt: "" });

    expect(chatState.status).toBe("error");
    expect(chatState.error).toBe("upstream 500");
    expect(client.calls()).toBe(1); // Bailed after the first round
    disposeTab(tab);
  });

  test("summarizes accumulated tool errors (and ignores unknown events) at the round cap", async () => {
    const tab = makeTab();
    const { chatState, toolRegistry } = harness(tab, async () => []);
    // Every round emits an unrecognized event (default switch case) followed by a tool call that
    // Always fails (removing the document root), so errors accumulate until the round cap is hit.
    const client = fakeClient(
      Array.from({ length: 6 }, () => [
        { type: "noop" } as unknown as StreamEvent, // Unknown event → default case
        { type: "tool_call_start", id: "c", name: "remove_node" },
        { type: "tool_call_delta", id: "c", args: JSON.stringify({ path: [] }) },
        { type: "tool_call_end", id: "c" },
        { type: "done", stopReason: "tool_calls" },
      ]),
    );

    chatState.sendMessage("delete everything repeatedly");
    await runAgentLoop({ chatState, streamingClient: client, toolRegistry, systemPrompt: "" });

    expect(chatState.status).toBe("error");
    expect(chatState.error).toContain("ran out of tool-call rounds");
    expect(chatState.error).toContain("Errors encountered");
    expect(chatState.error).toContain("Cannot remove the document root");
    disposeTab(tab);
  });

  test("reports a tool call whose arguments are malformed JSON", async () => {
    const tab = makeTab();
    const { chatState, toolRegistry } = harness(tab, async () => []);
    // Hand-craft a tool call whose accumulated arguments are not valid JSON.
    const client = fakeClient([
      [
        { type: "tool_call_start", id: "c1", name: "set_property" },
        { type: "tool_call_delta", id: "c1", args: "{not json" },
        { type: "tool_call_end", id: "c1" },
        { type: "done", stopReason: "tool_calls" },
      ],
      [{ type: "done", stopReason: "stop" }],
    ]);

    chatState.sendMessage("break it");
    await runAgentLoop({ chatState, streamingClient: client, toolRegistry, systemPrompt: "" });

    const toolMsg = chatState.messages.find((m) => m.role === "tool");
    expect(toolMsg!.content).toContain("Failed to parse arguments");
    expect(chatState.status).toBe("idle");
    disposeTab(tab);
  });
});

// ─── §7.4: the batch follows the tab it edits ────────────────────────────────

describe("cross-tab batching", () => {
  test("a turn that moves to a second document gives BOTH documents a history entry", async () => {
    /* `beginBatch(getTab())` ran once, against whichever tab was active when the loop started,
       and `endBatch()` pushed ITS snapshot. A turn whose tools then edited a second document
       closed the batch against the FIRST tab, so the second document got neither a history
       snapshot nor a collab publish — its edits were simply not undoable. */
    const first = createTab({ document: { children: [], tagName: "div" }, id: "first" });
    const second = createTab({ document: { children: [], tagName: "section" }, id: "second" });
    let current: Tab = first;

    const chatState = createChatState({ model: "test" });
    const toolRegistry = createToolRegistry();
    registerAiTools(toolRegistry, { getTab: () => current, validate: async () => [] });

    const beforeSecond = second.history.snapshots.length;
    const client = fakeClient([
      toolCallRound("a", "set_property", { key: "id", path: [], value: "one" }),
      toolCallRound("b", "set_property", { key: "id", path: [], value: "two" }),
    ]);
    // Between rounds the user (or a tool) moves to the other document.
    const originalStream = client.streamChat.bind(client);
    let round = 0;
    (client as { streamChat: unknown }).streamChat = async function* streamChat(
      ...args: unknown[]
    ) {
      round += 1;
      if (round === 2) {
        current = second;
      }
      yield* (originalStream as (...a: unknown[]) => AsyncGenerator<StreamEvent>)(...args);
    };

    chatState.sendMessage("edit both");
    await runAgentLoop({
      chatState,
      getTab: () => current,
      streamingClient: client as StreamingClient,
      systemPrompt: "",
      toolRegistry: toolRegistry as ToolRegistry,
    });

    expect((second.doc.document as Record<string, unknown>).id).toBe("two");
    expect(second.history.snapshots.length).toBeGreaterThan(beforeSecond);
    disposeTab(first);
    disposeTab(second);
  });
});

describe("ai agent loop — the interactive round budget", () => {
  /**
   * A registry holding just `ask_user`, plus a hook that answers each question as it appears.
   *
   * @param {(n: number) => string} reply - The nth answer, so a test can vary them.
   */
  function askHarness(reply: (n: number) => string = () => "yes") {
    const chatState = createChatState({ model: "test" });
    const toolRegistry = createToolRegistry();
    registerAskTool(toolRegistry);
    // `read_document` is the "work" tool below: a real, registered call that really succeeds, so
    // The budget is measured against work rather than against a tool that was never there.
    const tab = makeTab();
    registerAiTools(toolRegistry, { getTab: () => tab, validate: async () => [] });

    let answered = 0;
    // Settle each question on the microtask after it registers, standing in for a fast reader.
    const tick = setInterval(() => {
      if (pendingAsk()) {
        answered += 1;
        answerAsk(reply(answered));
      }
    }, 0);
    return {
      answered: () => answered,
      chatState,
      stop: () => {
        clearInterval(tick);
        disposeTab(tab);
        resetAsk();
      },
      toolRegistry,
    };
  }

  test("a round that only asked does not spend the work budget", async () => {
    /* MAX_ROUNDS bounds AUTONOMOUS work. A round that ends by blocking on a person cannot advance
       without them, which is the property the cap was ever a proxy for — so a conversation that
       asks three questions must still have its five rounds of work left. */
    const h = askHarness();
    const client = fakeClient([
      toolCallRound("a1", "ask_user", { question: "Which?" }),
      toolCallRound("a2", "ask_user", { question: "And then?" }),
      toolCallRound("a3", "ask_user", { question: "Sure?" }),
      ...Array.from({ length: 10 }, (_, i) => toolCallRound(`w${i}`, "read_document", {})),
    ]);

    h.chatState.sendMessage("ask me things");
    await runAgentLoop({
      chatState: h.chatState,
      streamingClient: client,
      systemPrompt: "",
      toolRegistry: h.toolRegistry as ToolRegistry,
    });
    h.stop();

    expect(h.answered()).toBe(3);
    // Three interactive rounds plus five that did work.
    expect(client.calls()).toBe(8);
  });

  test("a round that asked AND worked spends the budget", async () => {
    // The exemption is for rounds that only wait; a round that also edited is ordinary work.
    const h = askHarness();
    const client = fakeClient(
      Array.from({ length: 10 }, (_, i) => [
        { type: "tool_call_start", id: `a${i}`, name: "ask_user" },
        { type: "tool_call_delta", id: `a${i}`, args: JSON.stringify({ question: "Which?" }) },
        { type: "tool_call_end", id: `a${i}` },
        { type: "tool_call_start", id: `w${i}`, name: "read_document" },
        { type: "tool_call_delta", id: `w${i}`, args: "{}" },
        { type: "tool_call_end", id: `w${i}` },
        { type: "done", stopReason: "tool_calls" },
      ]) as StreamEvent[][],
    );

    h.chatState.sendMessage("ask and work");
    await runAgentLoop({
      chatState: h.chatState,
      streamingClient: client,
      systemPrompt: "",
      toolRegistry: h.toolRegistry as ToolRegistry,
    });
    h.stop();

    expect(client.calls()).toBe(5);
  });

  test("a model that only ever asks still terminates", async () => {
    // The human is the real backstop, but the loop must be provably terminating without them.
    const h = askHarness();
    const client = fakeClient(
      Array.from({ length: 40 }, (_, i) => toolCallRound(`a${i}`, "ask_user", { question: "?" })),
    );

    h.chatState.sendMessage("ask forever");
    await runAgentLoop({
      chatState: h.chatState,
      streamingClient: client,
      systemPrompt: "",
      toolRegistry: h.toolRegistry as ToolRegistry,
    });
    h.stop();

    expect(client.calls()).toBe(25); // MAX_TOTAL_ROUNDS
  });

  test("stopping the turn settles the question instead of hanging the loop", async () => {
    /* The loop AWAITS toolRegistry.execute, and `ask_user`'s promise is resolved by a human. If
       Stop did not reach it, the turn would wait forever on a reader who has left. */
    const chatState = createChatState({ model: "test" });
    const toolRegistry = createToolRegistry();
    registerAskTool(toolRegistry);
    const controller = new AbortController();
    const client = fakeClient([toolCallRound("a1", "ask_user", { question: "Which?" })]);

    chatState.sendMessage("ask me");
    const running = runAgentLoop({
      chatState,
      signal: controller.signal,
      streamingClient: client,
      systemPrompt: "",
      toolRegistry: toolRegistry as ToolRegistry,
    });

    // Let the round reach the tool, then stop the turn the way `assistant.stop` does.
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(pendingAsk()).not.toBeNull();
    controller.abort();

    await running;
    expect(pendingAsk()).toBeNull();
    resetAsk();
  });
});
