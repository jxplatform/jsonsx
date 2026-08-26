/**
 * Src/services/ai-ask.ts — the assistant's pause. The agent loop awaits toolRegistry.execute, so a
 * tool that returns a pending promise suspends the turn; these cover the four ways one settles and
 * the two results that are easy to get backwards (a skip succeeds, a stop fails).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createToolRegistry } from "@jxsuite/ai";
import {
  answerAsk,
  askUser,
  cancelAsk,
  isAwaitingAnswer,
  pendingAsk,
  registerAskTool,
  resetAsk,
  skipAsk,
} from "../src/services/ai-ask";
import { beginToolCall, beginTurnSignal, endTurnSignal } from "../src/services/ai-turn-signal";

function ask(overrides: Partial<Parameters<typeof askUser>[0]> = {}) {
  return askUser({ context: "", id: "call_1", options: [], question: "Which?", ...overrides });
}

beforeEach(() => {
  resetAsk();
  endTurnSignal();
});

afterEach(() => {
  resetAsk();
  endTurnSignal();
});

describe("ai-ask — the store", () => {
  test("registers a question and suspends until it is answered", async () => {
    const pending = ask({ context: "3 pages look alike", options: ["Merge", "Keep"] });
    expect(isAwaitingAnswer()).toBe(true);
    expect(pendingAsk()).toEqual({
      context: "3 pages look alike",
      id: "call_1",
      options: ["Merge", "Keep"],
      question: "Which?",
    });

    expect(answerAsk("Merge")).toBe(true);
    expect(await pending).toEqual({ answer: "Merge", skipped: false });
    expect(isAwaitingAnswer()).toBe(false);
    expect(pendingAsk()).toBeNull();
  });

  test("a skip settles as skipped, not as an answer", async () => {
    const pending = ask();
    expect(skipAsk()).toBe(true);
    expect(await pending).toEqual({ answer: null, skipped: true });
  });

  test("cancelAsk settles as neither answered nor skipped", async () => {
    const pending = ask();
    cancelAsk();
    expect(await pending).toEqual({ answer: null, skipped: false });
    expect(isAwaitingAnswer()).toBe(false);
  });

  test("answering, skipping and cancelling with nothing pending are no-ops", () => {
    expect(answerAsk("hello")).toBe(false);
    expect(skipAsk()).toBe(false);
    expect(() => cancelAsk()).not.toThrow();
  });

  test("a turn stopped before the question registers settles it immediately", async () => {
    // The window between the model emitting the call and the tool running is real, and a promise
    // Registered into an already-dead turn would never be settled by anything.
    const controller = new AbortController();
    controller.abort();
    beginTurnSignal(controller.signal);

    expect(await ask()).toEqual({ answer: null, skipped: false });
    expect(isAwaitingAnswer()).toBe(false);
  });

  test("aborting the turn settles the outstanding question", async () => {
    const controller = new AbortController();
    beginTurnSignal(controller.signal);
    const pending = ask();
    expect(isAwaitingAnswer()).toBe(true);

    controller.abort();
    expect(await pending).toEqual({ answer: null, skipped: false });
    expect(isAwaitingAnswer()).toBe(false);
  });

  test("an answered question stops listening to its turn's signal", async () => {
    const controller = new AbortController();
    beginTurnSignal(controller.signal);
    const pending = ask();
    answerAsk("Merge");
    await pending;

    // A stale listener here would cancel whatever question came next.
    const second = ask({ id: "call_2" });
    controller.abort();
    expect(await second).toEqual({ answer: null, skipped: false });
  });

  test("resetAsk settles an outstanding question and clears the store", async () => {
    const pending = ask();
    resetAsk();
    expect(await pending).toEqual({ answer: null, skipped: false });
    expect(pendingAsk()).toBeNull();
  });
});

describe("ai-ask — the tool", () => {
  function registry() {
    const reg = createToolRegistry();
    registerAskTool(reg);
    return reg;
  }

  test("is advertised with a question, options and context", () => {
    const def = registry().getDefinition("ask_user")!;
    expect(def.name).toBe("ask_user");
    const props = (def.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).toSorted()).toEqual(["context", "options", "question"]);
    expect((def.parameters as { required: string[] }).required).toEqual(["question"]);
  });

  test("an answer comes back as a success carrying the user's words", async () => {
    const reg = registry();
    beginToolCall("call_abc");
    const running = reg.execute("ask_user", { options: ["A", "B"], question: "Which?" });
    // The tool call's own id, so the transcript's card and this question are the same thing.
    expect(pendingAsk()?.id).toBe("call_abc");

    answerAsk("Neither — do C instead");
    const result = await running;
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ answer: "Neither — do C instead", skipped: false });
    expect(result.summary).toContain("Neither — do C instead");
  });

  test("a skip is a SUCCESS — 'you decide' is a real answer", async () => {
    /* Reporting it as an error would have the model apologise for having asked a fair question,
       and would end the turn on the error path, which deletes the streaming message. */
    const reg = registry();
    beginToolCall("call_skip");
    const running = reg.execute("ask_user", { question: "Which?" });
    skipAsk();

    const result = await running;
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ answer: null, skipped: true });
    expect(result.summary).toContain("best judgment");
  });

  test("a stopped turn is a failure", async () => {
    const reg = registry();
    beginToolCall("call_stop");
    const running = reg.execute("ask_user", { question: "Which?" });
    cancelAsk();

    const result = await running;
    expect(result.success).toBe(false);
    expect(result.error).toContain("stopped");
  });

  test("refuses a blank question rather than showing an empty card", async () => {
    const reg = registry();
    const result = await reg.execute("ask_user", { question: "   " });
    expect(result.success).toBe(false);
    expect(isAwaitingAnswer()).toBe(false);
  });

  test("refuses a second question while one is outstanding", async () => {
    const reg = registry();
    beginToolCall("call_first");
    const first = reg.execute("ask_user", { question: "First?" });

    const second = await reg.execute("ask_user", { question: "Second?" });
    expect(second.success).toBe(false);
    expect(second.error).toContain("already waiting");
    // The first is untouched.
    expect(pendingAsk()?.question).toBe("First?");

    answerAsk("done");
    await first;
  });

  test("options are cleaned and capped at six", async () => {
    // The registry's validator only checks that it IS an array — what is inside is this tool's job.
    const reg = registry();
    beginToolCall("call_opts");
    const running = reg.execute("ask_user", {
      options: ["a", "", "  ", "b", "c", "d", "e", "f", "g", 7],
      question: "Which?",
    });
    expect(pendingAsk()?.options).toEqual(["a", "b", "c", "d", "e", "f"]);
    answerAsk("a");
    await running;
  });

  test("a wholly mistyped call still renders a question rather than throwing", async () => {
    /* Driven through the definition rather than the registry, because `validate()` refuses these
       shapes first. It is a "lightweight structural check, not a JSON Schema validator" though —
       `strict: false` skips it entirely, and a caller may register this tool into a registry of
       their own — so the tool cannot assume its arguments were checked. */
    const def = registry().getDefinition("ask_user")!;
    beginToolCall("call_loose");
    const running = def.execute({ context: 42, options: "not an array", question: "Which?" });
    expect(pendingAsk()).toEqual({
      context: "",
      id: "call_loose",
      options: [],
      question: "Which?",
    });
    answerAsk("a");
    await running;
  });

  test("a question with no id still registers, so a bare registry can use the tool", async () => {
    const def = registry().getDefinition("ask_user")!;
    endTurnSignal();
    const running = def.execute({ question: "Which?" });
    expect(pendingAsk()?.id).toBe("");
    answerAsk("a");
    await running;
  });
});
