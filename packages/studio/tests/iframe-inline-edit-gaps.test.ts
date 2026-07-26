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
import { beforeInput, caretInto, selectAcross } from "./harness";
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

describe("block merges", () => {
  /** Two stamped paragraphs in the container, ready to be joined. */
  function twoBlocks(container: HTMLElement) {
    const first = document.createElement("p");
    first.dataset.jxPath = '["children",0]';
    first.textContent = "First";
    const second = document.createElement("p");
    second.dataset.jxPath = '["children",1]';
    second.textContent = "Second";
    container.append(first, second);
    return { first, second };
  }

  test("Backspace at a block start posts a merge onto the previous block", () => {
    const { container, fromIframe, pair } = boot();
    const { second } = twoBlocks(container);
    clickInto(second);
    caretInto(second, 0);

    const prevented = beforeInput(second, "deleteContentBackward");
    pair.flush();

    expect(prevented).toBe(true);
    expect(fromIframe.find((m) => m.kind === "editMerge")).toEqual({
      fromPath: ["children", 1],
      intoPath: ["children", 0],
      kind: "editMerge",
    });
  });

  test("Delete at a block end pulls the NEXT block up into this one", () => {
    const { container, fromIframe, pair } = boot();
    const { first } = twoBlocks(container);
    clickInto(first);
    caretInto(first, "First".length);

    const prevented = beforeInput(first, "deleteContentForward");
    pair.flush();

    expect(prevented).toBe(true);
    // Same join, approached from the other side: the earlier block always survives.
    expect(fromIframe.find((m) => m.kind === "editMerge")).toEqual({
      fromPath: ["children", 1],
      intoPath: ["children", 0],
      kind: "editMerge",
    });
  });

  test("Backspace in the FIRST block posts nothing — there is nothing to join onto", () => {
    const { container, fromIframe, pair } = boot();
    const { first } = twoBlocks(container);
    clickInto(first);
    caretInto(first, 0);

    const prevented = beforeInput(first, "deleteContentBackward");
    pair.flush();

    // Still suppressed: letting the browser act would restructure the DOM behind the model's back.
    expect(prevented).toBe(true);
    expect(fromIframe.some((m) => m.kind === "editMerge")).toBe(false);
  });

  test("Delete at the END of the last block posts nothing", () => {
    const { container, fromIframe, pair } = boot();
    const { second } = twoBlocks(container);
    clickInto(second);
    caretInto(second, "Second".length);

    beforeInput(second, "deleteContentForward");
    pair.flush();
    expect(fromIframe.some((m) => m.kind === "editMerge")).toBe(false);
  });

  test("a merge flushes uncommitted text first, so nothing typed is lost", () => {
    const { container, fromIframe, pair } = boot();
    const { first, second } = twoBlocks(container);
    clickInto(first);
    first.textContent = "First edited";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    // Move to the second block WITHOUT waiting for the idle tick, then merge back.
    clickInto(second);
    second.textContent = "Second edited";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    caretInto(second, 0);
    beforeInput(second, "deleteContentBackward");
    pair.flush();

    const commits = fromIframe.filter((m) => m.kind === "editCommit") as {
      textContent: string | null;
    }[];
    // The block being merged away had its typed text committed before the join.
    expect(commits.some((c) => c.textContent === "Second edited")).toBe(true);
    expect(fromIframe.some((m) => m.kind === "editMerge")).toBe(true);
  });
});

describe("cross-block range edits", () => {
  /** Four stamped paragraphs. */
  function fourBlocks(container: HTMLElement) {
    const els = ["AAAA", "BBBB", "CCCC", "DDDD"].map((t, i) => {
      const p = document.createElement("p");
      p.dataset.jxPath = JSON.stringify(["children", i]);
      p.textContent = t;
      container.append(p);
      return p;
    });
    return els;
  }

  test("deleting a selection across blocks posts the range with the blocks between", () => {
    const { container, fromIframe, pair } = boot();
    const els = fourBlocks(container);
    clickInto(els[0]!);
    selectAcross(els[0]!.firstChild!, 2, els[3]!.firstChild!, 2);

    const prevented = beforeInput(els[0]!, "deleteContentBackward");
    pair.flush();

    expect(prevented).toBe(true);
    expect(fromIframe.find((m) => m.kind === "editRangeReplace")).toEqual({
      between: [
        ["children", 1],
        ["children", 2],
      ],
      from: { offset: 2, path: ["children", 0] },
      kind: "editRangeReplace",
      text: "",
      to: { offset: 2, path: ["children", 3] },
    });
  });

  test("typing over a cross-block selection carries the typed text", () => {
    const { container, fromIframe, pair } = boot();
    const els = fourBlocks(container);
    clickInto(els[0]!);
    selectAcross(els[0]!.firstChild!, 1, els[1]!.firstChild!, 3);

    beforeInput(els[0]!, "insertText", "Z");
    pair.flush();

    expect(fromIframe.find((m) => m.kind === "editRangeReplace")).toMatchObject({
      between: [],
      text: "Z",
    });
  });

  test("a cut across blocks collapses the range", () => {
    const { container, fromIframe, pair } = boot();
    const els = fourBlocks(container);
    clickInto(els[1]!);
    selectAcross(els[1]!.firstChild!, 0, els[2]!.firstChild!, 4);

    beforeInput(els[1]!, "deleteByCut");
    pair.flush();

    expect(fromIframe.some((m) => m.kind === "editRangeReplace")).toBe(true);
  });

  test("a selection inside ONE block is left to the browser", () => {
    const { container, fromIframe, pair } = boot();
    const els = fourBlocks(container);
    clickInto(els[0]!);
    selectAcross(els[0]!.firstChild!, 1, els[0]!.firstChild!, 3);

    const prevented = beforeInput(els[0]!, "deleteContentBackward");
    pair.flush();

    expect(prevented).toBe(false);
    expect(fromIframe.some((m) => m.kind === "editRangeReplace")).toBe(false);
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
