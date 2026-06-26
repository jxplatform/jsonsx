import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stubRect } from "./harness";
import { measureHits, nearestHit, startInteraction } from "../src/canvas/iframe-interaction";
import type { IframeChannel } from "../src/canvas/iframe-channel";
import type { IframeToParent, ParentToIframe } from "../src/canvas/iframe-protocol";

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
