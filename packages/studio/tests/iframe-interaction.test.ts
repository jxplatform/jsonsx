import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stubRect } from "./harness";
import { measureHits, nearestHit, startInteraction } from "../src/canvas/iframe-interaction";
import type { IframeChannel } from "../src/canvas/iframe-channel";
import type { IframeToParent, ParentToIframe } from "../src/canvas/iframe-protocol";
import type { JxMutableNode } from "@jxsuite/schema/types";

/**
 * Dispatch a pointermove and let the coalescing frame run.
 *
 * `startInteraction` collapses hover + insertion-zone work into one `requestAnimationFrame` (at
 * most one DOM walk / rect measurement per frame no matter how many moves arrive), so a move's
 * effects land on the next frame rather than synchronously.
 */
async function movePointer(target: EventTarget, init: MouseEventInit = {}): Promise<void> {
  target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, ...init }));
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

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

  test("posts hover only when the resolved path changes, and null on leave", async () => {
    const { channel, posts } = fakeChannel();
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 10, y: 5 });
    stop = startInteraction(channel, document);

    await movePointer(inner);
    await movePointer(inner); // Same path → suppressed.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ hit: { path: ["children", 0] }, kind: "hover" });

    document.body.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    expect(posts.at(-1)).toEqual({ hit: null, kind: "hover" });
  });

  test("coalesces a burst of moves into one frame, and measures only on change", async () => {
    const { channel, posts } = fakeChannel();
    const { inner, outer } = stampedTree('["children",0]', { height: 20, width: 100, x: 10, y: 5 });
    // Count rect measurements on the path element the hover resolves to.
    let measures = 0;
    const stubbed = outer.getBoundingClientRect.bind(outer);
    outer.getBoundingClientRect = () => {
      measures += 1;
      return stubbed();
    };
    stop = startInteraction(channel, document);

    // Ten moves inside one frame → one hover post, one measurement.
    for (let i = 0; i < 10; i++) {
      inner.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: i }));
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(posts.filter((p) => p.kind === "hover")).toHaveLength(1);
    expect(measures).toBe(1);

    // Further frames over the SAME element post nothing and measure nothing: the de-dupe key is the
    // Element's data-jx-path, compared before any rect is read.
    await movePointer(inner, { clientX: 99 });
    await movePointer(inner, { clientX: 100 });
    expect(posts.filter((p) => p.kind === "hover")).toHaveLength(1);
    expect(measures).toBe(1);
  });

  test("an inner element's pointerleave is not a canvas leave (capture sees every descendant)", async () => {
    const { channel, posts } = fakeChannel();
    const { inner, outer } = stampedTree('["children",0]', { height: 20, width: 100, x: 10, y: 5 });
    stop = startInteraction(channel, document);

    await movePointer(inner);
    expect(posts).toHaveLength(1);
    // Moving from the inner span to a sibling fires pointerleave on the elements being exited; a
    // Document CAPTURE listener sees those too, and must not read them as "left the canvas".
    inner.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    outer.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    expect(posts).toHaveLength(1);
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

  test("posts insertZones near an edge, deduped, and null past the edge", async () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    stop = startInteraction(channel, document, { getShadowDoc: () => SHADOW });

    // Cursor 5px below the top edge (y=205) → a top-edge zone (insert before, index 1).
    await movePointer(el, { clientX: 50, clientY: 205 });
    const zonePosts = posts.filter((p) => p.kind === "insertZones");
    expect(zonePosts.at(-1)).toMatchObject({
      kind: "insertZones",
      zones: [{ edge: "top", index: 1, insertParentPath: [] }],
    });

    // A second move still near the top edge resolves to the SAME zone key → no new post.
    const before = posts.filter((p) => p.kind === "insertZones").length;
    await movePointer(el, { clientX: 60, clientY: 206 });
    expect(posts.filter((p) => p.kind === "insertZones").length).toBe(before);

    // Moving to mid-element posts a null zone set (clears the parent "+").
    await movePointer(el, { clientX: 50, clientY: 250 });
    expect(posts.findLast((p) => p.kind === "insertZones")).toEqual({
      kind: "insertZones",
      zones: null,
    });
  });

  test("pointerleave posts a single null insertZones (and not again when already cleared)", async () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    stop = startInteraction(channel, document, { getShadowDoc: () => SHADOW });

    await movePointer(el, { clientX: 50, clientY: 205 });
    document.body.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    const nulls = posts.filter((p) => p.kind === "insertZones" && p.zones === null);
    expect(nulls).toHaveLength(1);

    // A second leave while already cleared posts nothing new.
    document.body.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    expect(posts.filter((p) => p.kind === "insertZones" && p.zones === null)).toHaveLength(1);
  });

  test("an inner element's pointerleave never clears the zones", async () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    stop = startInteraction(channel, document, { getShadowDoc: () => SHADOW });

    await movePointer(el, { clientX: 50, clientY: 205 });
    // The stamped element and its container leaving under the cursor are ordinary intra-canvas
    // Boundary crossings — the "+" must survive them (only body/root/document leaves clear it).
    el.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    el.parentElement?.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    expect(posts.some((p) => p.kind === "insertZones" && p.zones === null)).toBe(false);
  });

  test("a gen bump re-posts the same zone (the parent dropped the '+' on the render ack)", async () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    let gen = 4;
    stop = startInteraction(channel, document, { getGen: () => gen, getShadowDoc: () => SHADOW });

    await movePointer(el, { clientX: 50, clientY: 205 });
    expect(posts.filter((p) => p.kind === "insertZones")).toHaveLength(1);

    // Same edge, same key → still deduped while the DOM is unchanged.
    await movePointer(el, { clientX: 60, clientY: 206 });
    expect(posts.filter((p) => p.kind === "insertZones")).toHaveLength(1);

    // A render/patch landed: the parent hid the "+", so the next move must re-post the zone.
    gen = 5;
    await movePointer(el, { clientX: 60, clientY: 207 });
    const zonePosts = posts.filter((p) => p.kind === "insertZones");
    expect(zonePosts).toHaveLength(2);
    expect(zonePosts.at(-1)).toMatchObject({ zones: [{ edge: "top", index: 1 }] });

    // A bump with the cursor mid-element posts NOTHING: the reset models the parent's post-ack
    // State ("+" already hidden), which is exactly what a mid-element cursor resolves to.
    gen = 6;
    await movePointer(el, { clientX: 60, clientY: 250 });
    expect(posts.filter((p) => p.kind === "insertZones")).toHaveLength(2);
  });

  test("no deps → never posts insertZones (hover/hit only)", async () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    stop = startInteraction(channel, document);
    await movePointer(el, { clientX: 50, clientY: 205 });
    document.body.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    expect(posts.some((p) => p.kind === "insertZones")).toBe(false);
  });

  test("a null shadow doc (pre-first-render) suppresses zones even near an edge", async () => {
    const { channel, posts } = fakeChannel();
    const el = stampedSibling('["children",1]', { height: 100, width: 300, x: 0, y: 200 });
    stop = startInteraction(channel, document, { getShadowDoc: () => null });
    await movePointer(el, { clientX: 50, clientY: 205 });
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

describe("preview link interception", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  function stampedAnchor(href: string) {
    const a = document.createElement("a");
    a.setAttribute("href", href);
    a.dataset.jxPath = '["children",0]';
    stubRect(a, { height: 20, width: 100, x: 0, y: 0 });
    const inner = document.createElement("span");
    a.append(inner);
    document.body.append(a);
    return { a, inner };
  }

  test("a preview click reports the href instead of navigating", () => {
    const { channel, posts } = fakeChannel();
    const { inner } = stampedAnchor("/about");
    stop = startInteraction(channel, document, {
      getMode: () => "preview",
      getShadowDoc: () => null,
    });

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    inner.dispatchEvent(event);

    // Prevented, so the canvas iframe is not navigated away (which would destroy the render).
    expect(event.defaultPrevented).toBe(true);
    expect(posts).toContainEqual({ href: "/about", kind: "previewNavigate" });
    // And it is NOT also treated as an element selection.
    expect(posts.some((p) => p.kind === "hit")).toBe(false);
  });

  test("design mode still selects — the runtime de-links anchors there", () => {
    const { channel, posts } = fakeChannel();
    const { inner } = stampedAnchor("/about");
    stop = startInteraction(channel, document, {
      getMode: () => "design",
      getShadowDoc: () => null,
    });

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    inner.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(posts.some((p) => p.kind === "previewNavigate")).toBe(false);
    expect(posts.some((p) => p.kind === "hit")).toBe(true);
  });

  test("an in-page fragment is left to the browser", () => {
    const { channel, posts } = fakeChannel();
    const { inner } = stampedAnchor("#section-2");
    stop = startInteraction(channel, document, {
      getMode: () => "preview",
      getShadowDoc: () => null,
    });

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    inner.dispatchEvent(event);

    // Scrolling within the previewed page is exactly what preview is for.
    expect(event.defaultPrevented).toBe(false);
    expect(posts.some((p) => p.kind === "previewNavigate")).toBe(false);
  });
});

// ─── Preview reports nothing pointable ──────────────────────────────────────────
// Preview is the shipped page: there is no selection, no hover box, no insertion "+" and no Jx
// Element menu, so the frame withholds all four. (The host refuses the same messages independently
// — the canvas bundle ships prebuilt, so neither side relies on the other's build being current.)

describe("preview suppresses the editing affordances", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  function startPreview() {
    const { channel, posts } = fakeChannel();
    stop = startInteraction(channel, document, {
      getMode: () => "preview",
      getShadowDoc: () => ({ children: [{ tagName: "p" }], tagName: "div" }) as JxMutableNode,
    });
    return posts;
  }

  test("a click on a plain element posts no hit", () => {
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 0, y: 0 });
    const posts = startPreview();
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posts).toHaveLength(0);
  });

  test("a pointermove posts neither hover nor insertion zones", async () => {
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 0, y: 0 });
    const posts = startPreview();
    await movePointer(inner, { clientX: 5, clientY: 1 });
    expect(posts).toHaveLength(0);
  });

  test("leaving the canvas posts nothing either", async () => {
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 0, y: 0 });
    const posts = startPreview();
    await movePointer(inner, { clientX: 5, clientY: 1 });
    document.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    expect(posts).toHaveLength(0);
  });

  test("right-click keeps the browser's own menu", () => {
    const { inner } = stampedTree('["children",0]', { height: 20, width: 100, x: 0, y: 0 });
    const posts = startPreview();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    inner.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(posts.some((p) => p.kind === "contextMenu")).toBe(false);
  });
});
