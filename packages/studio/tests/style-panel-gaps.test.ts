/**
 * Gap coverage for src/panels/style-panel.ts: the `_fieldRow` debounced @input handler
 * (clearTimeout + setTimeout body), which the main style-panel suite never exercises.
 *
 * Real 400ms timers are avoided by swapping setTimeout/clearTimeout for synchronous capture stubs
 * around the (synchronous) event dispatch, then invoking the captured callback directly.
 */
import { flush, renderInto } from "./harness";
import { afterEach, describe, expect, mock, test } from "bun:test";

// Stub the stylebook panel so importing style-panel doesn't drag in canvas panning side effects.
mock.module("../src/panels/stylebook-panel", () => ({
  selectStylebookTag: mock(() => {}),
}));

const { _fieldRow } = await import("../src/panels/style-panel");

interface CapturedTimer {
  delay: number | undefined;
  fn: () => void;
  id: number;
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Replace global timers with capture stubs; returns scheduled callbacks and cleared ids. */
function captureTimers(): { cleared: unknown[]; scheduled: CapturedTimer[] } {
  const scheduled: CapturedTimer[] = [];
  const cleared: unknown[] = [];
  let nextId = 1;
  (globalThis as Record<string, unknown>).setTimeout = (fn: () => void, delay?: number) => {
    nextId += 1;
    const id = nextId;
    scheduled.push({ delay, fn, id });
    return id;
  };
  (globalThis as Record<string, unknown>).clearTimeout = (id: unknown) => {
    cleared.push(id);
  };
  return { cleared, scheduled };
}

function restoreTimers(): void {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

afterEach(restoreTimers);

async function renderRow(
  type: string,
  value: string,
  onChange: (v: string | boolean) => void,
): Promise<HTMLElement> {
  // Render with real timers (flush relies on setTimeout), then capture afterwards.
  return await renderInto(_fieldRow("Label", type, value, onChange, "dl-gaps"));
}

function fireInput(c: HTMLElement, value: string): void {
  const field = c.querySelector("sp-textfield") as HTMLElement & { value: string };
  expect(field).toBeTruthy();
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("_fieldRow debounced input", () => {
  test("text input schedules a 400ms debounce and delivers the value on fire", async () => {
    const seen: (string | boolean)[] = [];
    const c = await renderRow("text", "old", (v) => seen.push(v));

    const { scheduled } = captureTimers();
    fireInput(c, "new-value");
    restoreTimers();

    // Handler scheduled but not yet delivered.
    expect(seen).toEqual([]);
    expect(scheduled.length).toBe(1);
    expect(scheduled[0]!.delay).toBe(400);

    scheduled[0]!.fn();
    expect(seen).toEqual(["new-value"]);
  });

  test("rapid inputs clear the prior timer so only the last value is committed", async () => {
    const seen: (string | boolean)[] = [];
    const c = await renderRow("text", "", (v) => seen.push(v));

    const { cleared, scheduled } = captureTimers();
    fireInput(c, "first");
    fireInput(c, "second");
    restoreTimers();

    expect(scheduled.length).toBe(2);
    // The second input clears the first scheduled timer id.
    expect(cleared).toContain(scheduled[0]!.id);

    // Only the surviving (second) timer fires, reading the field's current value.
    scheduled[1]!.fn();
    expect(seen).toEqual(["second"]);
  });

  test("textarea variant uses the same debounced input handler", async () => {
    const seen: (string | boolean)[] = [];
    const c = await renderRow("textarea", "line", (v) => seen.push(v));
    expect(c.querySelector("sp-textfield[multiline]")).toBeTruthy();

    const { scheduled } = captureTimers();
    fireInput(c, "line\nmore");
    restoreTimers();

    expect(scheduled.length).toBe(1);
    scheduled[0]!.fn();
    expect(seen).toEqual(["line\nmore"]);

    await flush();
  });
});
