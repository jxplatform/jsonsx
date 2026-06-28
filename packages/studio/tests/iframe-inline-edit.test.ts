/**
 * In-iframe inline editing — runs the contenteditable session inside the canvas iframe and posts
 * the serializable results to the parent. Verifies the dblclick trigger, editStart/editCommit
 * posting, `enterEdit` re-entry, the non-editable guard, and teardown.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { startIframeInlineEdit } from "../src/canvas/iframe-inline-edit";
import { isEditing, resumeBlurClose, stopEditing } from "../src/editor/inline-edit";
import { serializeJxPath } from "../src/canvas/path-mapping";
import type {
  ApplyFormatIntent,
  IframeToParent,
  ParentToIframe,
  SelectionSnapshot,
} from "../src/canvas/iframe-protocol";

function fakeChannel() {
  const posts: IframeToParent[] = [];
  let handler: ((m: ParentToIframe) => void) | null = null;
  const channel = {
    dispose() {
      // Unused by these tests.
    },
    onMessage(h: (m: ParentToIframe) => void) {
      handler = h;
      return () => {
        handler = null;
      };
    },
    post(m: IframeToParent) {
      posts.push(m);
    },
  } as never;
  return { channel, deliver: (m: ParentToIframe) => handler?.(m), posts };
}

function editableContainer(tag = "p") {
  const container = document.createElement("div");
  const el = document.createElement(tag);
  el.dataset.jxPath = serializeJxPath(["children", 0]);
  el.textContent = "Hello";
  container.append(el);
  document.body.append(container);
  return { container, el };
}

const dblclick = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

/** Select the full contents of `node` (sets the live Selection used by buildSnapshot). */
function selectContents(node: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

/** Collapse the live selection to a caret at the end of `node`. */
function caretAtEnd(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The last selectionChanged snapshot posted, if any. */
function lastSnapshot(posts: IframeToParent[]): SelectionSnapshot | undefined {
  return posts.findLast((p) => p.kind === "selectionChanged") as SelectionSnapshot | undefined;
}

afterEach(() => {
  if (isEditing()) {
    stopEditing();
  }
  resumeBlurClose();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("startIframeInlineEdit", () => {
  test("double-click on an editable element starts editing and posts editStart", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    expect(el.isContentEditable).toBe(true);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 0] });
    stop();
  });

  test("committing the session posts editCommit with the serialized content", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    el.textContent = "Edited";
    stopEditing();

    expect(posts).toContainEqual({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "Edited",
    });
    stop();
  });

  test("an enterEdit message re-enters editing on the given path", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    deliver({ kind: "enterEdit", path: ["children", 0] });
    expect(el.isContentEditable).toBe(true);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 0] });
    stop();
  });

  test("double-click on a non-editable element does nothing", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer("div"); // <div> is not an editable block.
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    expect(posts).toEqual([]);
    expect(isEditing()).toBe(false);
    stop();
  });

  test("teardown removes the listener and stops an active session", () => {
    const { channel } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    expect(isEditing()).toBe(true);
    stop();
    expect(isEditing()).toBe(false);
  });
});

// ─── Selection snapshot + applyFormat bridge (Phase 4b-2) ────────────────────
//
// Realm isolation is STRUCTURAL, not unit-proven: the session engine + inline-link are bundled into
// The iframe and use ambient window/document, so at runtime `window === iframe.contentWindow`. Under
// Happy-dom there is one shared global; the cross-realm focus behavior (a parent-toolbar click
// Blurring the iframe; CSS Custom Highlight painting) is CDP-verified, not asserted here. Where a
// Test passes ONLY because happy-dom can't model real focus/realm behavior it is flagged inline.

/** Build a container whose editable `<p>` wraps the given inner HTML. */
function richContainer(innerHTML: string) {
  const container = document.createElement("div");
  const el = document.createElement("p");
  el.dataset.jxPath = serializeJxPath(["children", 0]);
  el.innerHTML = innerHTML;
  container.append(el);
  document.body.append(container);
  return { container, el };
}

describe("selection snapshot + applyFormat", () => {
  test("a selectionchange while editing posts a snapshot (path/collapsed/rect-shape)", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    posts.length = 0;
    selectContents(el.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));

    const snap = lastSnapshot(posts)!;
    expect(snap).toBeDefined();
    expect(snap.path).toEqual(["children", 0]);
    expect(snap.collapsed).toBe(false);
    expect(snap.localScope).toBeNull();
    // Rect SHAPE (happy-dom returns a zero rect for ranges — assert keys, not values).
    expect(snap.rect).toHaveProperty("x");
    expect(snap.rect).toHaveProperty("width");
    stop();
  });

  test("selectionchange is gated when not editing (no snapshot)", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    selectContents(el.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));
    expect(lastSnapshot(posts)).toBeUndefined();
    stop();
  });

  test("entering an edit posts an initial (collapsed-caret) snapshot", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    const snap = lastSnapshot(posts)!;
    expect(snap).toBeDefined();
    expect(snap.path).toEqual(["children", 0]);
    stop();
  });

  test("teardown removes the selection listeners (no snapshot after stop)", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    stop();
    posts.length = 0;
    selectContents(el.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));
    expect(lastSnapshot(posts)).toBeUndefined();
  });

  // ─── isTagActiveInSelection: two-endpoint coverage ────────────────────────

  test("(a) a selection fully inside <strong> reports 'strong' active", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = richContainer("<strong>bold</strong>");
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    posts.length = 0;
    selectContents(el.querySelector("strong")!.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));
    expect(lastSnapshot(posts)!.activeTags).toContain("strong");
    stop();
  });

  test("(b) a selection with one endpoint outside <strong> does NOT report 'strong'", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = richContainer("<strong>bold</strong>plain");
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    posts.length = 0;
    // Anchor inside <strong>, focus in the trailing plain text node.
    const range = document.createRange();
    range.setStart(el.querySelector("strong")!.firstChild!, 0);
    range.setEnd(el.lastChild!, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(lastSnapshot(posts)!.activeTags).not.toContain("strong");
    stop();
  });

  test("(c) a collapsed caret inside <strong> reports 'strong' active + collapsed", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = richContainer("<strong>bold</strong>");
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    posts.length = 0;
    caretAtEnd(el.querySelector("strong")!.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));
    const snap = lastSnapshot(posts)!;
    expect(snap.activeTags).toContain("strong");
    expect(snap.collapsed).toBe(true);
    stop();
  });

  test("link state surfaces in the snapshot when the caret is inside an <a>", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = richContainer(`<a href="https://x">go</a>`);
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    posts.length = 0;
    selectContents(el.querySelector("a")!.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));
    const snap = lastSnapshot(posts)!;
    expect(snap.link).toEqual({ active: true, href: "https://x" });
    expect(snap.activeTags).toContain("a");
    stop();
  });

  // ─── REAL blur-event survival (the core cross-realm-survival assertion) ────

  test("a real blur during a live session does not end it; applyFormat bold then applies", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    selectContents(el.firstChild!);
    document.dispatchEvent(new Event("selectionchange")); // Caches the non-empty range.

    // Real blur: the parent toolbar took focus across the bridge. suspendBlurClose (set on
    // EditStart) must neutralize the 150ms stopEditing. NOTE: happy-dom shares one realm, so this
    // Proves the suspend flag wiring, not real cross-realm focus loss (CDP-verified).
    el.dispatchEvent(new FocusEvent("blur"));
    expect(isEditing()).toBe(true);

    posts.length = 0;
    const intent: ApplyFormatIntent = { command: "bold" };
    deliver({ intent, kind: "applyFormat" });

    expect(isEditing()).toBe(true);
    expect(el.querySelector("strong")).not.toBeNull();
    // Re-emitted snapshot drives the parent refresh.
    expect(lastSnapshot(posts)).toBeDefined();
    stop();
  });

  // ─── applyFormat variants ─────────────────────────────────────────────────

  test("applyFormat re-emits a snapshot after applying", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    selectContents(el.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));
    posts.length = 0;
    deliver({ intent: { command: "italic" }, kind: "applyFormat" });
    expect(el.querySelector("em")).not.toBeNull();
    expect(lastSnapshot(posts)).toBeDefined();
    stop();
  });

  test("applyFormat is a no-op when no session is active", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    deliver({ intent: { command: "bold" }, kind: "applyFormat" });
    expect(lastSnapshot(posts)).toBeUndefined();
    stop();
  });

  test("link intent creates a link via execCommand stub; href:null unwraps an <a>", () => {
    const { channel, deliver } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    selectContents(el.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));

    const calls: unknown[][] = [];
    (document as unknown as Record<string, unknown>).execCommand = (...args: unknown[]) => {
      calls.push(args);
      return true;
    };
    deliver({ intent: { command: "link", href: "https://made" }, kind: "applyFormat" });
    // Stub-level: createLink wiring (happy-dom has no execCommand, so no real <a> is created).
    expect(calls).toEqual([["createLink", false, "https://made"]]);
    delete (document as unknown as Record<string, unknown>).execCommand;

    // Now with an existing <a>, href:null unwraps it (real DOM).
    el.innerHTML = `<a href="https://x">link</a>`;
    selectContents(el.querySelector("a")!.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));
    deliver({ intent: { command: "link", href: null }, kind: "applyFormat" });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("link");
    stop();
  });

  test("insertData intent inserts a token via the execCommand insertText stub", () => {
    const { channel, deliver } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    caretAtEnd(el.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));

    const calls: unknown[][] = [];
    (document as unknown as Record<string, unknown>).execCommand = (...args: unknown[]) => {
      calls.push(args);
      return true;
    };
    deliver({ intent: { command: "insertData", token: "state.title" }, kind: "applyFormat" });
    expect(calls).toEqual([["insertText", false, "${state.title}"]]);
    delete (document as unknown as Record<string, unknown>).execCommand;
    stop();
  });

  // ─── CSS Custom Highlight (D-A), feature-detected ─────────────────────────
  //
  // The real selection-viz is Chromium-only; happy-dom lacks `Highlight`/`CSS.highlights` so the
  // Production path is a silent no-op there. These tests STUB both so the set/clear branches run —
  // The visual correctness itself is CDP-verified, not asserted here.

  /**
   * Install stubs for the CSS Custom Highlight API and return the highlights map plus a restore fn.
   * `globalThis.CSS` is read-only under happy-dom, so override it via defineProperty.
   */
  function installHighlightStub(): {
    map: Map<string, unknown>;
    built: Range[];
    restore: () => void;
  } {
    const g = globalThis as unknown as { Highlight?: unknown; CSS?: unknown };
    const built: Range[] = [];
    const map = new Map<string, unknown>();
    const prevCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    g.Highlight = class {
      constructor(range: Range) {
        built.push(range);
      }
    };
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { highlights: map },
      writable: true,
    });
    return {
      built,
      map,
      restore: () => {
        delete g.Highlight;
        if (prevCss) {
          Object.defineProperty(globalThis, "CSS", prevCss);
        } else {
          delete g.CSS;
        }
      },
    };
  }

  test("paints the cached range into CSS.highlights and injects the ::highlight rule", () => {
    const { built, map, restore } = installHighlightStub();
    const { channel } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    selectContents(el.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));

    expect(map.has("jx-pending-format")).toBe(true);
    expect(built.length).toBeGreaterThan(0);
    expect(document.querySelector("#jx-pending-format-style")).not.toBeNull();

    // Teardown clears the highlight.
    stop();
    expect(map.has("jx-pending-format")).toBe(false);
    restore();
  });

  test("clears the highlight when the cached range is empty", () => {
    const { built, map, restore } = installHighlightStub();
    map.set("jx-pending-format", {}); // Pre-seed so we can observe the delete.
    const { channel } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    // Enter editing with only a collapsed caret (no non-empty range cached) → highlight deleted.
    dblclick(el);
    expect(map.has("jx-pending-format")).toBe(false);
    expect(built).toHaveLength(0); // Nothing painted for an empty range.

    stop();
    restore();
  });

  test("applyFormat does not throw when the cached range was detached by a re-render", () => {
    const { channel, deliver } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    selectContents(el.firstChild!);
    document.dispatchEvent(new Event("selectionchange")); // Caches a range into el.

    // Simulate a re-render: replace the editable's content so the cached range is disconnected.
    el.innerHTML = "fresh";
    // The session's activeEl is still `el` (still connected), but the cached range's container is not.
    expect(() => deliver({ intent: { command: "bold" }, kind: "applyFormat" })).not.toThrow();
    stop();
  });
});
