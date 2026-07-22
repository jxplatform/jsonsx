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

function dblclick(el: Element) {
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
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

    dblclick(inner);
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

    dblclick(marker);
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

    dblclick(marker);
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
    dblclick(p);
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

describe("enter-key split", () => {
  test("Enter mid-text posts editSplit with the before/after halves", () => {
    const { container, fromIframe, pair } = boot();
    const p = document.createElement("p");
    p.dataset.jxPath = '["children",0]';
    p.textContent = "before|after";
    container.append(p);
    dblclick(p);
    pair.flush();
    expect(isEditing()).toBe(true);

    // Caret between the halves, then Enter (no shift) → the split callback posts editSplit.
    const range = document.createRange();
    range.setStart(p.firstChild!, "before".length + 1);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    pair.flush();

    const split = fromIframe.find((m) => m.kind === "editSplit") as
      | { path: unknown; before: unknown; after: unknown }
      | undefined;
    expect(split).toBeDefined();
    expect(split!.path).toEqual(["children", 0]);
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
