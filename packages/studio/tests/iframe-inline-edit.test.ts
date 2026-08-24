/**
 * In-iframe inline editing — runs the contenteditable session inside the canvas iframe and posts
 * the serializable results to the parent. Verifies the dblclick trigger, editStart/editCommit
 * posting, `enterEdit` re-entry, the non-editable guard, and teardown.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { startIframeInlineEdit } from "../src/canvas/iframe-inline-edit";
import { startIframeSlashBridge } from "../src/canvas/iframe-slash";
import {
  isEditing,
  openSlashMenu,
  setSlashController,
  stopEditing,
} from "../src/editor/inline-edit";
import { caretInto } from "./harness";
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

/**
 * Click into `el`: a pointerdown (which is what opens a prop-bound nested host) followed by the
 * caret landing inside it. There is no "enter edit" gesture any more — activation is a consequence
 * of where the caret is, so this is the whole interaction.
 */
function clickInto(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  caretInto(el);
}

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

/**
 * Every editing host listens on the DOCUMENT for `selectionchange`, so one left attached would
 * react to a later test's caret and deactivate its block. Booting through here guarantees teardown
 * even for tests that throw before their own `stop()`.
 */
const teardowns: (() => void)[] = [];
function boot(...args: Parameters<typeof startIframeInlineEdit>) {
  const stop = startIframeInlineEdit(...args);
  let stopped = false;
  const once = () => {
    if (!stopped) {
      stopped = true;
      stop();
    }
  };
  teardowns.push(once);
  return once;
}

afterEach(() => {
  while (teardowns.length > 0) {
    teardowns.pop()!();
  }
  if (isEditing()) {
    stopEditing();
  }
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("startIframeInlineEdit", () => {
  test("a click into an editable element activates it and posts editStart", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    clickInto(el);
    // The block is ACTIVE, but it is not itself contenteditable — the canvas container is the
    // Single editing host, which is what lets the caret cross block boundaries.
    expect(el.dataset.jxActiveBlock).toBe("");
    expect(el.hasAttribute("contenteditable")).toBe(false);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 0] });
    stop();
  });

  test("committing the session posts editCommit with the serialized content", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    clickInto(el);
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

  test("an enterEdit message puts the caret in the given path", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    deliver({ kind: "enterEdit", path: ["children", 0] });
    expect(el.dataset.jxActiveBlock).toBe("");
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 0] });
    stop();
  });

  test("a click into a non-editable element does nothing", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer("div"); // <div> is not an editable block.
    const stop = boot(channel, container);

    clickInto(el);
    expect(posts).toEqual([]);
    expect(isEditing()).toBe(false);
    stop();
  });

  test("teardown removes the listener and stops an active session", () => {
    const { channel } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    clickInto(el);
    expect(isEditing()).toBe(true);
    stop();
    expect(isEditing()).toBe(false);
  });
});

// ─── Session lifecycle: commit-on-click-away + the parent endEdit message ───────

describe("flushEdits", () => {
  test("commits the caret's pending text, then acknowledges", async () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container, el } = editableContainer();
    boot(channel, container);

    clickInto(el);
    el.textContent = "Half a sentence";
    // The idle tick has not fired yet — the document knows nothing about this text.
    posts.length = 0;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    deliver({ kind: "flushEdits", reqId: 42 });

    const commitIdx = posts.findIndex((p) => p.kind === "editCommit");
    const ackIdx = posts.findIndex((p) => p.kind === "flushComplete");
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    // Ordering is the contract: a parent that has seen the ack has already applied the text.
    expect(commitIdx).toBeLessThan(ackIdx);
    expect(posts[commitIdx]).toMatchObject({
      inPlace: true,
      path: ["children", 0],
      textContent: "Half a sentence",
    });
    expect(posts[ackIdx]).toEqual({ kind: "flushComplete", reqId: 42 });
  });

  test("acknowledges even with nothing pending, so a save never hangs", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container } = editableContainer();
    boot(channel, container);
    posts.length = 0;

    deliver({ kind: "flushEdits", reqId: 7 });
    expect(posts).toEqual([{ kind: "flushComplete", reqId: 7 }]);
  });
});

describe("session lifecycle", () => {
  test("moving the caret OUT of a block commits it", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const other = document.createElement("div"); // Not an editable block.
    container.append(other);
    const stop = boot(channel, container);

    clickInto(el);
    el.textContent = "Edited";
    posts.length = 0;
    clickInto(other);

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

  test("moving the caret to ANOTHER block commits the first and activates the second", () => {
    // The heart of fluid editing: no teardown, no re-entry gesture — just the caret moving.
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const second = document.createElement("p");
    second.dataset.jxPath = serializeJxPath(["children", 1]);
    second.textContent = "Second";
    container.append(second);
    const stop = boot(channel, container);

    clickInto(el);
    el.textContent = "Edited";
    posts.length = 0;
    clickInto(second);

    expect(posts).toContainEqual({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "Edited",
    });
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 1] });
    expect(isEditing()).toBe(true);
    expect(second.dataset.jxActiveBlock).toBe("");
    expect(el.dataset.jxActiveBlock).toBeUndefined();
    stop();
  });

  test("the caret moving WITHIN a block does not commit it", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    clickInto(el);
    posts.length = 0;
    caretInto(el, 3);

    expect(isEditing()).toBe(true);
    expect(posts.some((p) => p.kind === "editCommit" || p.kind === "editEnd")).toBe(false);
    stop();
  });

  test("an endEdit message commits and ends a live session (no-op without one)", () => {
    const { channel, deliver, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    // No session yet — nothing happens.
    deliver({ kind: "endEdit" });
    expect(posts).toEqual([]);

    clickInto(el);
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
    const stop = boot(channel, container);

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
    const stop = boot(channel, container);

    try {
      clickInto(el);
      // Caret at the very start → the "/" trigger sees empty text-before and opens the menu.
      const range = document.createRange();
      range.setStart(el.firstChild!, 0);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      /* Dispatched at the CONTAINER, which is where a real "/" lands: the container is the editing
         host, so it is the focused element and every keydown's target. This case used to dispatch
         at the block and pass, because the engine's listener was bound there — the one place a
         keystroke never arrives. That is why the shot of this menu spent a release quarantined. */
      container.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "/" }));
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
    const stop = boot(channel, container);

    clickInto(el);
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

  test("a selection outside any editable block posts no snapshot", () => {
    const { channel, posts } = fakeChannel();
    const { container } = editableContainer();
    // A <div> is not an editable block, so a caret in it activates nothing.
    const chrome = document.createElement("div");
    chrome.textContent = "not a block";
    container.append(chrome);
    const stop = boot(channel, container);

    caretInto(chrome);
    expect(lastSnapshot(posts)).toBeUndefined();
    expect(isEditing()).toBe(false);
    stop();
  });

  test("entering an edit posts an initial (collapsed-caret) snapshot", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    clickInto(el);
    const snap = lastSnapshot(posts)!;
    expect(snap).toBeDefined();
    expect(snap.path).toEqual(["children", 0]);
    stop();
  });

  test("teardown removes the selection listeners (no snapshot after stop)", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    clickInto(el);
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
    const stop = boot(channel, container);

    clickInto(el);
    posts.length = 0;
    selectContents(el.querySelector("strong")!.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));
    expect(lastSnapshot(posts)!.activeTags).toContain("strong");
    stop();
  });

  test("(b) a selection with one endpoint outside <strong> does NOT report 'strong'", () => {
    const { channel, posts } = fakeChannel();
    const { container, el } = richContainer("<strong>bold</strong>plain");
    const stop = boot(channel, container);

    clickInto(el);
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
    const stop = boot(channel, container);

    clickInto(el);
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
    const stop = boot(channel, container);

    clickInto(el);
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
    const stop = boot(channel, container);

    clickInto(el);
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
    const stop = boot(channel, container);

    clickInto(el);
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
    const stop = boot(channel, container);

    deliver({ intent: { command: "bold" }, kind: "applyFormat" });
    expect(lastSnapshot(posts)).toBeUndefined();
    stop();
  });

  test("link intent creates a link via execCommand stub; href:null unwraps an <a>", () => {
    const { channel, deliver } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    clickInto(el);
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
    const stop = boot(channel, container);

    clickInto(el);
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
    const stop = boot(channel, container);

    clickInto(el);
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
    const stop = boot(channel, container);

    // Enter editing with only a collapsed caret (no non-empty range cached) → highlight deleted.
    clickInto(el);
    expect(map.has("jx-pending-format")).toBe(false);
    expect(built).toHaveLength(0); // Nothing painted for an empty range.

    stop();
    restore();
  });

  test("applyFormat does not throw when the cached range was detached by a re-render", () => {
    const { channel, deliver } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);

    clickInto(el);
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
  test("a click into marked internals starts a plain session and posts editStart with prop", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
    expect(h3.isContentEditable).toBe(true);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 1], prop: "title" });
    stop();
  });

  test("committing posts editCommitProp with the instance path, prop, and value", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
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
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 1], prop: "title" });
    stop();
  });

  test("a forwarded format chord is refused in a prop session", () => {
    /* "Formatting is off" is the documented rule here, and inertifying the chord inside the frame
       is only half of it: a caret-scoped ⌘B is ALSO forwarded to the parent, matched by the
       shortcut registry, and posted straight back as an applyFormat intent. That route bypasses the
       keydown entirely and used to run toggleInlineFormat on the plaintext-only host. */
    const { channel, deliver } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
    selectContents(h3.firstChild!);
    document.dispatchEvent(new Event("selectionchange"));

    deliver({ intent: { command: "bold" }, kind: "applyFormat" });

    expect(h3.querySelector("strong")).toBeNull();
    expect(h3.textContent).toBe("Local");
    stop();
  });

  test("a NUMERIC prop is refused — the session would retype it as a string", () => {
    /* The commit posts `textContent`, so editing `count: 3` wrote `"3"`, after which
       `${count * 2}` is `"33"`. Objects were already excluded; the scalars a component actually
       declares were not. They stay editable in the properties panel, which knows their type. */
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: 3 as unknown as string });
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
    expect(posts.filter((p) => p.kind === "editStart")).toEqual([]);
    stop();
  });

  test("a BOOLEAN prop is refused for the same reason", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: true as unknown as string });
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
    expect(posts.filter((p) => p.kind === "editStart")).toEqual([]);
    stop();
  });

  test("a plain string prop is still editable", () => {
    // The guard must not have swallowed the ordinary case it sits in front of.
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
    expect(posts).toContainEqual({ kind: "editStart", path: ["children", 1], prop: "title" });
    stop();
  });

  test("a host without data-jx-path is blocked (definition internals have no write-back target)", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, host, shadowDoc } = propBoundContainer({ title: "Local" });
    delete host.dataset.jxPath;
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
    expect(h3.isContentEditable).toBe(false);
    expect(posts).toHaveLength(0);
    stop();
  });

  test("template-valued and $ref-valued raw props are blocked", () => {
    for (const raw of ["${$defs.headline}", { $ref: "#/$defs/x" }]) {
      const { channel, posts } = fakeChannel();
      const { container, h3, shadowDoc } = propBoundContainer({ title: raw });
      const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

      clickInto(h3);
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
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
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
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
    // Blocked: the prop is template-valued. The ancestor <li> must not be rich-edited as a
    // Consolation prize — that would let typing overwrite the whole component instance.
    expect(posts).toHaveLength(0);
    expect(isEditing()).toBe(false);
    expect(li.dataset.jxActiveBlock).toBeUndefined();
    stop();
  });

  test("the caret leaving a prop editable commits it", () => {
    const { channel, posts } = fakeChannel();
    const { container, h3, shadowDoc } = propBoundContainer({ title: "Local" });
    const outside = document.createElement("div");
    container.append(outside);
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
    h3.textContent = "Changed";
    clickInto(outside);

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
    const stop = boot(channel, container, { getShadowDoc: () => shadowDoc });

    clickInto(h3);
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

// ─── The slash menu's two doors ───────────────────────────────────────────────

/**
 * The gesture and the command, in the realm where the caret is.
 *
 * The "/" trigger was recognised by a `keydown` listener `editor/inline-edit.ts` bound to the
 * BLOCK, and the editing host is the container — so it never fired, for anyone, and typing "/" in
 * the canvas inserted a slash and nothing else. The manifest's `slash-menu-shot` recorded the
 * symptom as "the slash controller does not respond to a synthetic keydown"; the truth was that
 * nothing responded to a real one either.
 */
describe("the slash menu", () => {
  /** Boot a frame with a live caret and a controller that records what it is shown. */
  function bootWithCaret() {
    const shows: { filter: string; showFilter?: boolean }[] = [];
    let open = false;
    setSlashController({
      dismiss: () => {
        open = false;
      },
      isOpen: () => open,
      show: (_el, filter, cbs) => {
        open = true;
        shows.push({
          filter,
          ...(cbs.showFilter === undefined ? {} : { showFilter: cbs.showFilter }),
        });
      },
    });
    const { channel, deliver, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);
    clickInto(el);
    return { container, deliver, el, posts, shows, stop };
  }

  /** Put the caret at `offset` in the block's first text node. */
  function caretAt(el: HTMLElement, offset: number) {
    const range = document.createRange();
    range.setStart(el.firstChild!, offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const slashAt = (container: HTMLElement) =>
    container.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "/" }));

  const nextFrame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });

  afterEach(() => {
    setSlashController({ dismiss: () => {}, isOpen: () => false, show: () => {} });
  });

  test('"/" at the start of a block opens it — at the HOST, where the keystroke is', async () => {
    const { container, el, shows } = bootWithCaret();
    caretAt(el, 0);
    slashAt(container);
    await nextFrame();
    expect(shows).toHaveLength(1);
    expect(shows[0]).toEqual({ filter: "" });
  });

  test('"/" mid-word is punctuation, not a menu', async () => {
    // "and/or" must not ambush the author. The engine still owns what a slash MEANS; only the
    // Listener moved.
    const { container, el, shows } = bootWithCaret();
    caretAt(el, 3);
    slashAt(container);
    await nextFrame();
    expect(shows).toEqual([]);
  });

  test("a keydown at the BLOCK opens nothing — which is the whole defect, pinned", async () => {
    // The block is a descendant of the editing host, and an event dispatched at a descendant never
    // Reaches a listener on it. This case exists so the trigger cannot quietly move back.
    const { el, shows } = bootWithCaret();
    caretAt(el, 0);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    await nextFrame();
    expect(shows).toEqual([]);
  });

  test("the openSlash message opens it by name, with its own filter field", () => {
    const { deliver, shows } = bootWithCaret();
    deliver({ kind: "openSlash" });
    expect(shows).toEqual([{ filter: "", showFilter: true }]);
  });

  test("the frame's controller CARRIES showFilter across the bridge", async () => {
    /* The option is set inside the frame and the menu is drawn by the parent, so a boundary that
       forgets it loses the field silently — the menu still appears, just with no way past fifteen
       blocks but scrolling. Found in a real browser, not here: the unit path stops at the
       controller, and the controller was doing its job. This asserts the POST. */
    const { channel, posts } = fakeChannel();
    const { container, el } = editableContainer();
    const stop = boot(channel, container);
    clickInto(el);
    /* The bridge takes its OWN channel: `fakeChannel` holds a single `onMessage` handler, so
       registering the bridge on the same one would replace the inline-edit handler and the
       `openSlash` message would never arrive. The engine's session is module state, so driving
       `openSlashMenu` directly is the same call the message handler makes. */
    const bridge = fakeChannel();
    const stopBridge = startIframeSlashBridge(bridge.channel, container.ownerDocument);
    openSlashMenu({ anchored: false });
    await Promise.resolve();
    const show = bridge.posts.find((p) => p.kind === "slashShow");
    expect(show).toBeDefined();
    expect((show as { showFilter?: boolean }).showFilter).toBe(true);
    stopBridge();
    stop();
    expect(posts.length).toBeGreaterThanOrEqual(0);
  });

  test("an unanchored menu is not re-filtered from the document, so typing cannot dismiss it", () => {
    // The filter would be derived from the text before the caret, where there is no "/" at all —
    // `refreshSlashMenu` would find none and dismiss the menu on the first character typed.
    const { container, deliver, shows } = bootWithCaret();
    deliver({ kind: "openSlash" });
    container.dispatchEvent(new Event("input", { bubbles: true }));
    expect(shows).toHaveLength(1);
  });

  test("teardown takes both listeners with it", async () => {
    const { container, el, shows, stop } = bootWithCaret();
    caretAt(el, 0);
    stop();
    slashAt(container);
    await nextFrame();
    expect(shows).toEqual([]);
  });
});
