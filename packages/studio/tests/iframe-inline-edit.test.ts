/**
 * In-iframe inline editing — runs the contenteditable session inside the canvas iframe and posts
 * the serializable results to the parent. Verifies the dblclick trigger, editStart/editCommit
 * posting, `enterEdit` re-entry, the non-editable guard, and teardown.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { startIframeInlineEdit } from "../src/canvas/iframe-inline-edit";
import {
  isEditing,
  resumeBlurClose,
  setSlashController,
  stopEditing,
} from "../src/editor/inline-edit";
import type { SlashCommand } from "../src/editor/inline-edit";
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

// ─── Session lifecycle: commit-on-click-away + the parent endEdit message ───────

describe("session lifecycle", () => {
  test("a pointerdown OUTSIDE the active editable commits and ends the session", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const other = document.createElement("div");
    container.append(other);
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    el.textContent = "Edited";
    posts.length = 0;
    other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(isEditing()).toBe(false);
    expect(posts).toContainEqual({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "Edited",
    });
    expect(posts).toContainEqual({ kind: "editEnd" });
    stop();
  });

  test("a pointerdown INSIDE the active editable keeps the session alive", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    dblclick(el);
    posts.length = 0;
    el.firstChild!.parentElement!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(isEditing()).toBe(true);
    expect(posts.some((p) => p.kind === "editCommit" || p.kind === "editEnd")).toBe(false);
    stop();
  });

  test("an endEdit message commits and ends a live session (no-op without one)", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    // No session yet — nothing happens.
    deliver({ kind: "endEdit" });
    expect(posts).toEqual([]);

    dblclick(el);
    el.textContent = "Committed by parent";
    posts.length = 0;
    deliver({ kind: "endEdit" });

    expect(isEditing()).toBe(false);
    expect(posts).toContainEqual({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "Committed by parent",
    });
    expect(posts).toContainEqual({ kind: "editEnd" });
    stop();
  });
});

// ─── Guard paths + the slash-insert bridge ───────────────────────────────────

describe("guards and inserts", () => {
  test("mouseup/keyup/selectionchange without a session are guarded no-ops", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    document.dispatchEvent(new Event("selectionchange"));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

    expect(posts).toEqual([]);
    expect(isEditing()).toBe(false);
    stop();
  });

  test("a slash-menu insert posts editInsert with the commit data", async () => {
    const selects: ((cmd: SlashCommand) => void)[] = [];
    setSlashController({
      dismiss: () => {},
      isOpen: () => false,
      show: (_anchor, _filter, cbs) => {
        selects.push(cbs.onSelect);
      },
    });
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = startIframeInlineEdit(channel, container);

    try {
      dblclick(el);
      // Caret at the very start → the "/" trigger sees empty text-before and opens the menu.
      const range = document.createRange();
      range.setStart(el.firstChild!, 0);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
      expect(selects).toHaveLength(1);

      posts.length = 0;
      selects[0]!({ description: "Horizontal rule", label: "Divider", tag: "hr" });

      const insertPost = posts.find((p) => p.kind === "editInsert")!;
      expect(insertPost).toMatchObject({ cmd: { tag: "hr" }, path: ["children", 0] });
      expect(insertPost.commitData).toBeDefined();
      // The insert ends the session (the parent re-enters after the re-render).
      expect(posts).toContainEqual({ kind: "editEnd" });
      expect(isEditing()).toBe(false);
    } finally {
      setSlashController({ dismiss: () => {}, isOpen: () => false, show: () => {} });
      stop();
    }
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

// ─── Prop-bound (plain) sessions ─────────────────────────────────────────────

/**
 * A rendered component instance: stamped host (`data-jx-path`) whose UNSTAMPED internals contain a
 * runtime-marked prop-bound h3 (`data-jx-bound-prop`), plus the matching raw shadow doc.
 */
function propBoundContainer(rawProps?: Record<string, unknown>) {
  const container = document.createElement("div");
  const host = document.createElement("x-card");
  host.dataset.jxPath = serializeJxPath(["children", 1]);
  const wrap = document.createElement("div");
  const h3 = document.createElement("h3");
  h3.dataset.jxBoundProp = "title";
  h3.textContent = "Local";
  wrap.append(h3);
  host.append(wrap);
  container.append(host);
  document.body.append(container);
  const shadowDoc = {
    children: [{ tagName: "p" }, { tagName: "x-card", ...(rawProps ? { $props: rawProps } : {}) }],
    tagName: "main",
  } as never;
  return { container, h3, host, shadowDoc };
}

describe("prop-bound inline editing", () => {
  test("double-click on marked internals starts a plain session and posts editStart with prop", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    const stop = startIframeInlineEdit(channel, container, { getShadowDoc: () => shadowDoc });

    dblclick(h3);
    expect(h3.isContentEditable).toBe(true);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 1], prop: "title" });
    stop();
  });

  test("committing posts editCommitProp with the instance path, prop, and value", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    const stop = startIframeInlineEdit(channel, container, { getShadowDoc: () => shadowDoc });

    dblclick(h3);
    h3.textContent = "Regional";
    stopEditing();

    expect(posts).toContainEqual({
      kind: "editCommitProp",
      path: ["children", 1],
      prop: "title",
      value: "Regional",
    });
    expect(posts.some((p) => p.kind === "editCommit")).toBe(false);
    expect(posts).toContainEqual({ kind: "editEnd" });
    stop();
  });

  test("an unset raw prop is editable (the commit ADDS the instance override)", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer();
    const stop = startIframeInlineEdit(channel, container, { getShadowDoc: () => shadowDoc });

    dblclick(h3);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 1], prop: "title" });
    stop();
  });

  test("a host without data-jx-path is blocked (definition internals have no write-back target)", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, host, shadowDoc } = propBoundContainer({ title: "Local" });
    delete host.dataset.jxPath;
    const stop = startIframeInlineEdit(channel, container, { getShadowDoc: () => shadowDoc });

    dblclick(h3);
    expect(h3.isContentEditable).toBe(false);
    expect(posts).toHaveLength(0);
    stop();
  });

  test("template-valued and $ref-valued raw props are blocked", () => {
    for (const raw of ["${$defs.headline}", { $ref: "#/$defs/x" }]) {
      const { channel, posts } = fakeChannel();
      const { container, h3, shadowDoc } = propBoundContainer({ title: raw });
      const stop = startIframeInlineEdit(channel, container, { getShadowDoc: () => shadowDoc });

      dblclick(h3);
      expect(h3.isContentEditable).toBe(false);
      expect(posts).toHaveLength(0);
      stop();
      document.body.innerHTML = "";
    }
  });

  test("a marker owned by a nested path-less custom element is blocked, not misattributed", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    // Interpose an inner (unstamped) custom element between the marker and the stamped host: the
    // Prop belongs to the INNER instance, whose $props live in a definition document — blocked.
    const inner = document.createElement("y-inner");
    h3.replaceWith(inner);
    inner.append(h3);
    const stop = startIframeInlineEdit(channel, container, { getShadowDoc: () => shadowDoc });

    dblclick(h3);
    expect(h3.isContentEditable).toBe(false);
    expect(posts).toHaveLength(0);
    stop();
  });

  test("a prop-bound hit never falls through to rich-edit an ancestor page editable", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, host, shadowDoc } = propBoundContainer({ title: "${$defs.x}" });
    // Nest the (blocked) instance inside a page-level editable block.
    const li = document.createElement("li");
    li.dataset.jxPath = serializeJxPath(["children", 0]);
    host.replaceWith(li);
    li.append(host);
    const stop = startIframeInlineEdit(channel, container, { getShadowDoc: () => shadowDoc });

    dblclick(h3);
    expect(li.isContentEditable).toBe(false);
    expect(posts).toHaveLength(0);
    stop();
  });

  test("pointerdown outside the active prop editable commits the session", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    const stop = startIframeInlineEdit(channel, container, { getShadowDoc: () => shadowDoc });

    dblclick(h3);
    h3.textContent = "Changed";
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));

    expect(posts).toContainEqual({
      kind: "editCommitProp",
      path: ["children", 1],
      prop: "title",
      value: "Changed",
    });
    stop();
  });

  test("a parent endEdit message commits a live prop session", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    const stop = startIframeInlineEdit(channel, container, { getShadowDoc: () => shadowDoc });

    dblclick(h3);
    h3.textContent = "Via endEdit";
    deliver({ kind: "endEdit" });

    expect(posts).toContainEqual({
      kind: "editCommitProp",
      path: ["children", 1],
      prop: "title",
      value: "Via endEdit",
    });
    expect(isEditing()).toBe(false);
    stop();
  });
});
