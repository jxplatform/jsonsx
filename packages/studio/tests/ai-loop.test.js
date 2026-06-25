import "./with-dom.ts";
import { describe, expect, test } from "bun:test";
import { createChatState, createToolRegistry } from "@jxsuite/ai";
import { createTab, disposeTab } from "../src/tabs/tab";
import { registerAiTools } from "../src/services/ai-tools";
import { runAgentLoop } from "../src/services/tool-executor";

/**
 * A scripted streaming client: each entry in `rounds` is the sequence of StreamEvents to yield on
 * the corresponding streamChat() call. Lets us drive runAgentLoop without a real LLM.
 *
 * @param {object[][]} rounds
 */
function fakeClient(rounds) {
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
function toolCallRound(id, name, args) {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, args: JSON.stringify(args) },
    { type: "tool_call_end", id },
    { type: "done", stopReason: "tool_calls" },
  ];
}

function makeTab(doc) {
  const document = doc ?? { tagName: "div", children: [{ tagName: "p", textContent: "Hello" }] };
  return createTab({ document, id: "test" });
}

function harness(tab, validate) {
  const chatState = createChatState({ model: "test" });
  const toolRegistry = createToolRegistry();
  registerAiTools(toolRegistry, { getTab: () => tab, ...(validate ? { validate } : {}) });
  return { chatState, toolRegistry };
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

    const { children } = tab.doc.document;
    expect(children).toHaveLength(2);
    expect(children[1].tagName).toBe("span");
    expect(tab.history.index).toBe(1); // One undoable transaction
    expect(chatState.status).toBe("idle");
    disposeTab(tab);
  });

  test("feeds schema errors back so the model can self-correct", async () => {
    const tab = makeTab();
    // Inject a validator that flags the document while the root tagName is "header" (no hyphen),
    // And is happy once it becomes "site-header" — simulating the schema eval signal.
    const validate = async (doc) =>
      doc.tagName === "header" ? ["(root): invalid custom element tagName"] : [];
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
    expect(toolMsgs[0].content).toContain("schema errors");
    expect(toolMsgs[0].content).toContain("invalid custom element tagName");
    // The corrected round reported success (no schema errors).
    expect(toolMsgs[1].content).toContain('"success":true');
    expect(chatState.status).toBe("idle");
    disposeTab(tab);
  });

  test("gives up with an error after the round cap when tools never stop", async () => {
    const tab = makeTab();
    const { chatState, toolRegistry } = harness(tab, async () => []);
    // Every round emits another tool call — the model never stops.
    const client = fakeClient(
      Array.from({ length: 10 }, (_, i) =>
        toolCallRound(`c${i}`, "set_property", { path: [], key: "id", value: `v${i}` }),
      ),
    );

    chatState.sendMessage("loop forever");
    await runAgentLoop({ chatState, streamingClient: client, toolRegistry, systemPrompt: "" });

    expect(client.calls()).toBe(5); // MAX_ROUNDS
    expect(chatState.status).toBe("error");
    expect(chatState.error).toContain("ran out of tool-call rounds");
    disposeTab(tab);
  });
});
