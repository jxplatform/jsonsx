import "../../tests/with-dom.ts";
import { describe, expect, test } from "bun:test";
import type { StreamEvent, StreamingClient } from "@jxsuite/ai/streaming-client";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { runTrial, runTask } from "../runner.js";

/**
 * Scripted streaming client — drives the real agent loop without a network call (same shape as the
 * fakeClient in tests/ai-loop.test.js).
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

function toolCallRound(id: string, name: string, args: object): StreamEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, args: JSON.stringify(args) },
    { type: "tool_call_end", id },
    { type: "done", stopReason: "tool_calls" },
  ];
}

const TASK = {
  id: "unit-add-span",
  prompt: "add a span",
  tags: ["unit"],
  initialDoc: { tagName: "div", children: [{ tagName: "p", textContent: "Hello" }] },
};

describe("eval runner", () => {
  test("runs the real loop with a scripted client, grades, and captures the trajectory", async () => {
    const client = fakeClient([
      toolCallRound("c1", "add_child", {
        parentPath: [],
        index: 1,
        node: { tagName: "span", textContent: "added" },
      }),
      [{ type: "done", stopReason: "stop" }],
    ]);

    const trial = await runTrial(TASK, { client });

    // Produced document was mutated by the real ai-tools path.
    const children = (trial.finalDoc as JxMutableNode).children as (JxMutableNode | string)[];
    expect(children).toHaveLength(2);
    expect((children[1] as JxMutableNode).tagName).toBe("span");
    // Graders ran; clean span renders fine.
    expect(trial.render.pass).toBe(true);
    expect(trial.pass).toBe(true);
    // Trajectory captured: one assistant tool-call turn.
    expect(trial.toolCalls).toBe(1);
    expect(trial.loopError).toBeNull();
  });

  test("computes pass@k / pass^k across k trials", async () => {
    const addSpan = (id: string) =>
      toolCallRound(id, "add_child", {
        parentPath: [],
        index: 1,
        node: { tagName: "span", textContent: "x" },
      });
    // One client is reused across trials, so its call counter carries over.
    // Trial 1 consumes rounds[0..1]; trial 2 consumes rounds[2..3].
    const client = fakeClient([
      addSpan("a"),
      [{ type: "done", stopReason: "stop" }],
      addSpan("b"),
      [{ type: "done", stopReason: "stop" }],
    ]);

    const result = await runTask(TASK, { k: 2, client });

    expect(result.k).toBe(2);
    expect(result.passRate).toBe(1);
    expect(result.passAtK).toBe(true);
    expect(result.passHatK).toBe(true);
  });
});
