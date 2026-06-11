import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { createPanelScheduler, isTextInput } from "../src/panels/panel-scheduler";

describe("isTextInput", () => {
  test("detects native inputs and Spectrum text controls", () => {
    expect(isTextInput(document.createElement("input"))).toBe(true);
    expect(isTextInput(document.createElement("textarea"))).toBe(true);
    expect(isTextInput(document.createElement("sp-textfield"))).toBe(true);
    expect(isTextInput(document.createElement("sp-number-field"))).toBe(true);
    expect(isTextInput(document.createElement("div"))).toBe(false);
    expect(isTextInput(null)).toBe(false);
  });
});

describe("panel scheduler", () => {
  test("flushNow renders when not editing", () => {
    const root = document.createElement("div");
    let renders = 0;
    const s = createPanelScheduler({ render: () => (renders += 1), root });
    s.flushNow();
    expect(renders).toBe(1);
  });

  test("defers render while a text input is focused, then flushes on blur", async () => {
    const root = document.createElement("div");
    const input = document.createElement("input");
    root.append(input);
    document.body.append(root);
    let renders = 0;
    const s = createPanelScheduler({ render: () => (renders += 1), root });
    s.bindFocus();

    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(s.isEditing()).toBe(true);

    s.flushNow(); // Deferred because a field is focused
    expect(renders).toBe(0);

    input.dispatchEvent(new Event("focusout", { bubbles: true }));
    // Focusout schedules a flush via rAF — wait two frames.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(renders).toBe(1);
    s.unbind();
    root.remove();
  });

  test("blockWhile predicate defers the render", () => {
    const root = document.createElement("div");
    let blocked = true;
    let renders = 0;
    const s = createPanelScheduler({
      blockWhile: () => blocked,
      render: () => (renders += 1),
      root,
    });
    s.flushNow();
    expect(renders).toBe(0);
    blocked = false;
    s.flushNow();
    expect(renders).toBe(1);
  });
});
