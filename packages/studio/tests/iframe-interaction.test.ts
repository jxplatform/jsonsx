import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stubRect } from "./harness";
import { measureHits, nearestHit, startInteraction } from "../src/canvas/iframe-interaction";
import type { IframeChannel } from "../src/canvas/iframe-channel";
import type { IframeToParent, ParentToIframe } from "../src/canvas/iframe-protocol";
import type { JxMutableNode } from "@jxsuite/schema/types";

// A channel stub that only needs `post` (startInteraction never reads incoming messages).
function fakeChannel() {
  const posts: IframeToParent[] = [];
  const channel = {
    dispose: () => {},
    onMessage: () => () => {},
    post: (m: IframeToParent) => posts.push(m),
  } as unknown as IframeChannel<IframeToParent, ParentToIframe>;
  return { channel, posts };
}

/** Build `<div data-jx-path><span></span></div>`, both stubbed with rects, appended to the body. */
function stampedTree(path: string, rect: Partial<DOMRect>) {
  const outer = document.createElement("div");
  outer.dataset.jxPath = path;
  stubRect(outer, rect);
  const inner = document.createElement("span");
  stubRect(inner, rect);
  outer.append(inner);
  document.body.append(outer);
  return { inner, outer };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("nearestHit", () => {
  test("walks up to the nearest data-jx-path element and returns its rect", () => {
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 10, y: 5 });
    const hit = nearestHit(inner);
    expect(hit).toEqual({
      path: ["children", 0],
      rect: { height: 20, width: 100, x: 10, y: 5 },
    });
  });

  test("returns null when no ancestor carries a path", () => {
    const lonely = document.createElement("div");
    document.body.append(lonely);
    expect(nearestHit(lonely)).toBeNull();
  });

  test("returns null for a non-Element target", () => {
    expect(nearestHit(null)).toBeNull();
    expect(nearestHit(document.createTextNode("x") as unknown as EventTarget)).toBeNull();
  });
});

describe("measureHits", () => {
  test("resolves each found path to its current rect and omits missing ones", () => {
    stampedTree('["children",0]', { height: 8, width: 40, x: 1, y: 2 });
    stampedTree('["children",1]', { height: 9, width: 50, x: 3, y: 4 });
    const hits = measureHits([
      ["children", 0],
      ["children", 1],
      ["children", 99], // No node → omitted.
    ]);
    expect(hits).toEqual([
      { path: ["children", 0], rect: { height: 8, width: 40, x: 1, y: 2 } },
      { path: ["children", 1], rect: { height: 9, width: 50, x: 3, y: 4 } },
    ]);
  });

  test("returns an empty array when nothing matches", () => {
    expect(measureHits([["children", 0]])).toEqual([]);
  });
});

describe("startInteraction", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test("posts a hit on click, resolved to the nearest path", () => {
    const { channel, posts } = fakeChannel();
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 10, y: 5 });
    stop = startInteraction(channel, document);
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posts).toEqual([
      {
        hit: { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
        kind: "hit",
      },
    ]);
  });

  test("does not post a hit when the click misses every path", () => {
    const { channel, posts } = fakeChannel();
    const lonely = document.createElement("div");
    document.body.append(lonely);
    stop = startInteraction(channel, document);
    lonely.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posts).toHaveLength(0);
  });

  test("posts hover only when the resolved path changes, and null on leave", () => {
    const { channel, posts } = fakeChannel();
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 10, y: 5 });
    stop = startInteraction(channel, document);

    inner.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    inner.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })); // Same path → suppressed.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ hit: { path: ["children", 0] }, kind: "hover" });

    document.body.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    expect(posts.at(-1)).toEqual({ hit: null, kind: "hover" });
  });

  test("teardown removes the listeners", () => {
    const { channel, posts } = fakeChannel();
    const { inner } = stampedTree('["children",0]', { height: 1, width: 1, x: 0, y: 0 });
    stop = startInteraction(channel, document);
    stop();
    stop = undefined;
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posts).toHaveLength(0);
  });
});

describe("startInteraction — insertion '+' zones (deps)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  const SHADOW = { children: [], tagName: "div" } as unknown as JxMutableNode;

  /** A stamped sibling whose DOM parent is a block container (column layout → top/bottom edges). */
  function stampedSibling(path: string, rect: Partial<DOMRect>) {
    const outer = document.createElement("div");
    outer.dataset.jxPath = path;
    stubRect(outer, rect);
    const parent = document.createElement("section"); // Block layout by default.
    parent.append(outer);
    document.body.append(parent);
    return outer;
  }

  test("posts insertZones near an edge, deduped, and null past the edge", () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    stop = startInteraction(channel, document, { getShadowDoc: () => SHADOW });

    // Cursor 5px below the top edge (y=205) → a top-edge zone (insert before, index 1).
    el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 205 }));
    const zonePosts = posts.filter((p) => p.kind === "insertZones");
    expect(zonePosts.at(-1)).toMatchObject({
      kind: "insertZones",
      zones: [{ edge: "top", index: 1, insertParentPath: [] }],
    });

    // A second move still near the top edge resolves to the SAME zone key → no new post.
    const before = posts.filter((p) => p.kind === "insertZones").length;
    el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 60, clientY: 206 }));
    expect(posts.filter((p) => p.kind === "insertZones").length).toBe(before);

    // Moving to mid-element posts a null zone set (clears the parent "+").
    el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 250 }));
    expect(posts.findLast((p) => p.kind === "insertZones")).toEqual({
      kind: "insertZones",
      zones: null,
    });
  });

  test("pointerleave posts a single null insertZones (and not again when already cleared)", () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    stop = startInteraction(channel, document, { getShadowDoc: () => SHADOW });

    el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 205 }));
    document.body.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    const nulls = posts.filter((p) => p.kind === "insertZones" && p.zones === null);
    expect(nulls).toHaveLength(1);

    // A second leave while already cleared posts nothing new.
    document.body.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    expect(posts.filter((p) => p.kind === "insertZones" && p.zones === null)).toHaveLength(1);
  });

  test("no deps → never posts insertZones (hover/hit only)", () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    stop = startInteraction(channel, document);
    el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 205 }));
    document.body.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    expect(posts.some((p) => p.kind === "insertZones")).toBe(false);
  });

  test("a null shadow doc (pre-first-render) suppresses zones even near an edge", () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    stop = startInteraction(channel, document, { getShadowDoc: () => null });
    el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 205 }));
    // ZonesKey resolves to "none" (null zones) → posted once as null, never a real zone.
    expect(posts.some((p) => p.kind === "insertZones" && p.zones !== null)).toBe(false);
  });
});

// ─── Context menu forwarding (right-click → parent Jx menu) ─────────────────────

describe("contextmenu forwarding", () => {
  test("right-click on a stamped element preventDefaults and posts contextMenu with the path", () => {
    const { channel, posts } = fakeChannel();
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 10, y: 5 });
    const stop = startInteraction(channel, document);

    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    inner.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
    const msg = posts.find((p) => p.kind === "contextMenu");
    expect(msg).toMatchObject({ kind: "contextMenu", path: ["children", 0] });
    stop();
  });

  test("right-click on empty space still suppresses the browser menu (path null)", () => {
    const { channel, posts } = fakeChannel();
    const lonely = document.createElement("div");
    document.body.append(lonely);
    const stop = startInteraction(channel, document);

    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    lonely.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
    expect(posts.find((p) => p.kind === "contextMenu")).toMatchObject({ path: null });
    stop();
  });

  test("right-click INSIDE the active editable keeps the native menu (no post)", async () => {
    const { channel, posts } = fakeChannel();
    const { outer } = stampedTree('["children",0]', { height: 20, width: 100, x: 10, y: 5 });
    const stop = startInteraction(channel, document);

    const { startEditing, stopEditing } = await import("../src/editor/inline-edit");
    startEditing(outer, ["children", 0], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
    try {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      outer.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(posts.some((p) => p.kind === "contextMenu")).toBe(false);
    } finally {
      stopEditing();
    }
    stop();
  });

  test("teardown removes the contextmenu listener", () => {
    const { channel, posts } = fakeChannel();
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 10, y: 5 });
    const stop = startInteraction(channel, document);
    stop();

    inner.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(posts.some((p) => p.kind === "contextMenu")).toBe(false);
  });
});
