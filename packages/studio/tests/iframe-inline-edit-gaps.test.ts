/**
 * Iframe inline-edit gaps — dblclicks on unstamped trees (findPropBoundTarget/findEditableTarget
 * walk to null), a prop-bound marker with no custom-element owner, the permissive shadow-doc
 * contract when no accessor is provided, and the mode gate on the parent's enterEdit message.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { fakeChannelPair } from "../src/canvas/iframe-channel";
import { startIframeInlineEdit } from "../src/canvas/iframe-inline-edit";
import { isEditing, stopEditing } from "../src/editor/inline-edit";
import { beforeInput, caretInto } from "./harness";
import type { IframeToParent, ParentToIframe } from "../src/canvas/iframe-protocol";

let teardown: (() => void) | undefined;

function boot(opts?: Parameters<typeof startIframeInlineEdit>[2]) {
  const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
  const fromIframe: IframeToParent[] = [];
  pair.parent.onMessage((m) => fromIframe.push(m));
  const container = document.createElement("div");
  document.body.append(container);
  teardown =
    opts === undefined
      ? startIframeInlineEdit(pair.iframe, container)
      : startIframeInlineEdit(pair.iframe, container, opts);
  return { container, fromIframe, pair };
}

/** Click into `el` — pointerdown (opens a prop-bound nested host) then the caret landing inside. */
function clickInto(el: Element) {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  caretInto(el as HTMLElement);
}

afterEach(() => {
  if (isEditing()) {
    stopEditing();
  }
  teardown?.();
  teardown = undefined;
  document.body.innerHTML = "";
});

describe("dblclick target walks", () => {
  test("a dblclick on a fully unstamped tree starts nothing", () => {
    const { container, fromIframe, pair } = boot();
    const outer = document.createElement("div");
    const inner = document.createElement("span");
    inner.textContent = "plain";
    outer.append(inner);
    container.append(outer);

    clickInto(inner);
    pair.flush();
    expect(isEditing()).toBe(false);
    expect(fromIframe.some((m) => m.kind === "editStart")).toBe(false);
  });

  test("a prop-bound marker without a custom-element owner is blocked", () => {
    const { container, fromIframe, pair } = boot();
    // The marker sits under plain divs only — ownerInstanceOf walks to null.
    const wrap = document.createElement("div");
    const marker = document.createElement("span");
    marker.dataset.jxBoundProp = "title";
    marker.textContent = "Card title";
    wrap.append(marker);
    container.append(wrap);

    clickInto(marker);
    pair.flush();
    expect(isEditing()).toBe(false);
    expect(fromIframe.some((m) => m.kind === "editStart")).toBe(false);
  });

  test("without a shadow-doc accessor, a prop-bound session starts permissively", () => {
    const { container, fromIframe, pair } = boot(); // No opts → getShadowDoc absent.
    const host = document.createElement("x-card");
    host.dataset.jxPath = '["children",0]';
    const marker = document.createElement("span");
    marker.dataset.jxBoundProp = "title";
    marker.textContent = "Card title";
    host.append(marker);
    container.append(host);

    clickInto(marker);
    pair.flush();
    expect(isEditing()).toBe(true);
    const start = fromIframe.find((m) => m.kind === "editStart") as
      | { path: unknown; prop?: string }
      | undefined;
    expect(start).toMatchObject({ path: ["children", 0], prop: "title" });
    stopEditing();
  });
});

describe("range caching triggers", () => {
  test("mouseup, keyup, and blur all re-cache the live range during a session", () => {
    const { container, fromIframe, pair } = boot();
    const p = document.createElement("p");
    p.dataset.jxPath = '["children",0]';
    p.textContent = "cache me";
    container.append(p);
    clickInto(p);
    pair.flush();
    expect(isEditing()).toBe(true);

    // A non-collapsed selection inside the editable, then each aggressive cache trigger.
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" }));
    document.dispatchEvent(new Event("blur", { bubbles: true }));
    pair.flush();

    // The session survived the triggers and posted at least the entry snapshot.
    expect(isEditing()).toBe(true);
    expect(fromIframe.some((m) => m.kind === "selectionChanged")).toBe(true);
    stopEditing();
  });
});

describe("Enter splits the block", () => {
  test("Enter mid-text posts editSplit with the before/after halves", () => {
    const { container, fromIframe, pair } = boot();
    const p = document.createElement("p");
    p.dataset.jxPath = '["children",0]';
    p.textContent = "before|after";
    container.append(p);
    clickInto(p);
    pair.flush();
    expect(isEditing()).toBe(true);

    // Enter reaches the editing host as `beforeinput`/insertParagraph, not as a keydown — the
    // Chokepoint is the one place structural intent is recognised.
    caretInto(p, "before|".length);
    const prevented = beforeInput(p, "insertParagraph");
    pair.flush();

    // The browser must NOT be allowed to split the DOM itself; the document model does it.
    expect(prevented).toBe(true);
    const split = fromIframe.find((m) => m.kind === "editSplit") as
      | { path: unknown; before: unknown; after: unknown }
      | undefined;
    expect(split).toBeDefined();
    expect(split!.path).toEqual(["children", 0]);
    expect(split!.before).toEqual({ textContent: "before|" });
    expect(split!.after).toEqual({ textContent: "after" });
  });

  test("Shift+Enter stays inside the block and is left to the browser", () => {
    const { container, fromIframe, pair } = boot();
    const p = document.createElement("p");
    p.dataset.jxPath = '["children",0]';
    p.textContent = "one line";
    container.append(p);
    clickInto(p);
    caretInto(p, 3);

    const prevented = beforeInput(p, "insertLineBreak");
    pair.flush();

    expect(prevented).toBe(false);
    expect(fromIframe.some((m) => m.kind === "editSplit")).toBe(false);
  });
});

describe("enterEdit mode gate", () => {
  test("a parent enterEdit is refused outside design/edit modes", () => {
    const { container, fromIframe, pair } = boot({ getMode: () => "stylebook" });
    const p = document.createElement("p");
    p.dataset.jxPath = '["children",0]';
    p.textContent = "specimen";
    container.append(p);

    pair.parent.post({ kind: "enterEdit", path: ["children", 0] });
    pair.flush();
    expect(isEditing()).toBe(false);
    expect(fromIframe.some((m) => m.kind === "editStart")).toBe(false);
  });
});
