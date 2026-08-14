import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  createPanelScheduler,
  isTextInput,
  pendingSchedulers,
} from "../src/panels/panel-scheduler";

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

describe("the withheld render is visible to the author", () => {
  // A panel showing state from before your last edit is correct behaviour; a panel showing it
  // Silently is indistinguishable from one that has stopped working. `data-jx-stale` is the whole
  // Mechanism — every panel already routed through this scheduler inherits the hint.
  //
  // Asserted on the VALUE, not `Object.hasOwn`: happy-dom's DOMStringMap is a proxy without a
  // `getOwnPropertyDescriptor` trap, so `hasOwn` answers false for a key that is demonstrably set.
  test("data-jx-stale is set while a render is withheld and cleared when it lands", async () => {
    const root = document.createElement("div");
    const input = document.createElement("input");
    root.append(input);
    document.body.append(root);
    const scheduler = createPanelScheduler({ render: () => {}, root });
    scheduler.bindFocus();

    scheduler.flushNow();
    expect(root.dataset.jxStale).toBeUndefined();

    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    scheduler.flushNow();
    expect(root.dataset.jxStale).toBe("");

    input.dispatchEvent(new Event("focusout", { bubbles: true }));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(root.dataset.jxStale).toBeUndefined();

    scheduler.unbind();
    root.remove();
  });

  test("unbinding takes the hint with it, so a torn-down panel never keeps the banner", () => {
    const root = document.createElement("div");
    const input = document.createElement("input");
    root.append(input);
    document.body.append(root);
    const scheduler = createPanelScheduler({ render: () => {}, root });
    scheduler.bindFocus();
    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    scheduler.flushNow();
    expect(root.dataset.jxStale).toBe("");

    scheduler.unbind();
    expect(root.dataset.jxStale).toBeUndefined();
    root.remove();
  });
});

// ─── Quiescence (probe.idle() condition 2) ──────────────────────────────────

describe("pendingSchedulers", () => {
  test("a queued frame and a withheld render are reported differently", async () => {
    // They end differently: a queued frame lands on its own, a withheld one waits for a focusout
    // That may never come. A predicate conflating them would either hang or lie.
    const root = document.createElement("div");
    root.id = "frontmatter-panel";
    const input = document.createElement("input");
    root.append(input);
    document.body.append(root);
    const scheduler = createPanelScheduler({ render: () => {}, root });
    scheduler.bindFocus();

    expect(pendingSchedulers()).toEqual([]);

    scheduler.schedule();
    expect(pendingSchedulers()).toEqual(["#frontmatter-panel has a frame queued"]);

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(pendingSchedulers()).toEqual([]);

    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    scheduler.flushNow();
    expect(pendingSchedulers()).toEqual([
      "#frontmatter-panel is withholding a render (a field has focus)",
    ]);

    scheduler.unbind();
    expect(pendingSchedulers()).toEqual([]);
    root.remove();
  });

  test("a root with no id is named by its first class, then by its tag", () => {
    const classed = document.createElement("div");
    classed.className = "browse-view wide";
    const bare = document.createElement("section");
    const a = createPanelScheduler({ render: () => {}, root: classed });
    const b = createPanelScheduler({ render: () => {}, root: bare });
    a.schedule();
    b.schedule();
    expect(pendingSchedulers().toSorted()).toEqual([
      ".browse-view has a frame queued",
      "section has a frame queued",
    ]);
    a.unbind();
    b.unbind();
    expect(pendingSchedulers()).toEqual([]);
  });
});
