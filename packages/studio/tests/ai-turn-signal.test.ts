/**
 * The ambient turn signal: the slot `runAgentLoop` publishes so a tool can learn its turn was
 * stopped, because `ToolRegistry.execute` has nowhere to pass one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { beginTurnSignal, endTurnSignal, turnSignal } from "../src/services/ai-turn-signal";

afterEach(() => {
  endTurnSignal();
});

describe("ai-turn-signal", () => {
  test("is undefined outside a turn", () => {
    expect(turnSignal()).toBeUndefined();
  });

  test("publishes the turn's signal and clears it", () => {
    const controller = new AbortController();
    beginTurnSignal(controller.signal);
    expect(turnSignal()).toBe(controller.signal);
    endTurnSignal();
    expect(turnSignal()).toBeUndefined();
  });

  test("a published signal aborts through the slot", () => {
    const controller = new AbortController();
    beginTurnSignal(controller.signal);
    expect(turnSignal()?.aborted).toBe(false);
    controller.abort();
    expect(turnSignal()?.aborted).toBe(true);
  });

  test("a turn opened with no signal leaves tools uncancellable rather than throwing", () => {
    beginTurnSignal();
    expect(turnSignal()).toBeUndefined();
  });

  test("a second turn replaces the first signal", () => {
    const first = new AbortController();
    const second = new AbortController();
    beginTurnSignal(first.signal);
    beginTurnSignal(second.signal);
    expect(turnSignal()).toBe(second.signal);
  });
});
