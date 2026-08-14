import "./with-dom.ts";
import { describe, expect, test } from "bun:test";
import { createChatState, createToolRegistry } from "@jxsuite/ai";
import type { ToolRegistry } from "@jxsuite/ai/tools";
import type { StreamingClient } from "@jxsuite/ai/streaming-client";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { createTab, disposeTab } from "../src/tabs/tab";
import type { Tab } from "../src/tabs/tab";
import { registerAiTools } from "../src/services/ai-tools";
import { runAgentLoop } from "../src/services/tool-executor";

/** The normalized stream event the StreamingClient emits (not exported, so derived here). */
type StreamEvent =
  ReturnType<StreamingClient["streamChat"]> extends AsyncGenerator<infer E> ? E : never;

/**
 * A scripted streaming client: each entry in `rounds` is the sequence of StreamEvents to yield on
 * the corresponding streamChat() call. Lets us drive runAgentLoop without a real LLM.
 *
 * @param {object[][]} rounds
 */
function fakeClient(rounds: StreamEvent[][]): StreamingClient & { calls: () => number } {
  let call = 0;
  return {
    calls: () => call,
    async *streamChat() {
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
