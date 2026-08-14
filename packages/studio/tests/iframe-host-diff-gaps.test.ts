/**
 * Iframe-host seams that only a SECOND host, a RELEASED host or an inactive one can reach.
 *
 * Every case below is a fan-out that has to name its target rather than acting on "the canvas": the
 * eval blocker `probe.idle()` reads, the focused-tab preference in `hostForPath`, the per-request
 * ownership `releaseHost` settles by, the stylebook's refusal of layout chrome, the stage a
 * forwarded wheel is replayed on, the root a colour-scheme push is scoped to, the keymap prune, and
 * the caret-owning host `postOpenSlash` asks.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  flush,
  resetStudioState,
  resetWorkspaceWithTab,
  standUpPaneGrid,
  stubRect,
  tearDownPaneGrids,
} from "./harness";
import { activateTab, openTab, workspace } from "../src/workspace/workspace";
import { setLayoutSelection, shell } from "../src/shell";
import type { LayoutHit } from "../src/canvas/iframe-protocol";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

// ─── Mocks (mirrors iframe-host-gaps.test.ts): capture channels, stub the resolver ───

interface FakeChannel {
  posts: Record<string, unknown>[];
  disposed: boolean;
  deliver: (m: Record<string, unknown>) => void;
}
const channels: FakeChannel[] = [];

void mock.module("../src/canvas/iframe-channel", () => ({
  postMessageChannel: (opts: Record<string, unknown>) => {
    let handler: ((m: Record<string, unknown>) => void) | null = null;
    const rec: FakeChannel = { deliver: (m) => handler?.(m), disposed: false, posts: [] };
    channels.push(rec);
    return {
      dispose: () => {
        rec.disposed = true;
      },
      onMessage: (h: (m: Record<string, unknown>) => void) => {
        handler = h;
        return () => {};
      },
      post: (m: Record<string, unknown>) => {
        rec.posts.push(m);
      },
      target: opts.target,
    };
  },
}));

void mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
}));

void mock.module("../src/canvas/canvas-live-render", () => ({
  resolveCanvasDocument: () =>
    Promise.resolve({
      docBase: "http://localhost:3000/doc.json",
      mapperCtx: {
        arrayPaths: [],
        canvasMode: "design",
        layoutWrapped: false,
        pageContentOffset: null,
        pageContentPrefix: null,
      },
      renderDoc: { children: ["hi"], tagName: "div" },
      siteStyle: null,
    }),
}));

const {
  canvasIdleBlockers,
  canvasPointAt,
  dragHostTab,
  flushCanvasEdits,
  hostForCanvas,
  mountIframeCanvas,
  mountStylebookCanvas,
  postColorSchemeToLiveHosts,
  postOpenSlash,
  publishKeymap,
  releaseCanvasHosts,
  requestCanvasEval,
  setKeymapSource,
} = await import("../src/canvas/iframe-host");

/** A settled canvas's own quiescence report — nothing outstanding on the frame's side. */
const QUIET = { animations: 0, fonts: true, images: 0, kind: "idle" as const };

/** One expression to preview, and the reply the frame would send for it. */
const EXPRS = [{ id: "e1", node: { operator: "+" } }];
const EVAL_RESULTS = [{ id: "e1", values: [["$", "2"]] as [string, string][] }];

const LAYOUT_HIT: LayoutHit = {
  className: "site-header",
  layoutFile: "layouts/base.json",
  layoutPath: ["children", 0],
  rect: { height: 21, width: 110, x: 24, y: 12 },
  tagName: "header",
};

const STYLEBOOK_GENERATED = () => ({
  doc: { children: [{ children: ["Hi"], tagName: "h1" }], tagName: "div" } as never,
  pathToTag: new Map([['["children",0]', "h1"]]),
  tagToCardPath: new Map([["h1", ["children", 0] as (string | number)[]]]),
});

/** Mount one page host inside `parent` and take it all the way to "has acked its render". */
async function mountReady(
  opts: { gen?: number; parent?: HTMLElement; tabId?: string | null } = {},
): Promise<{ canvasEl: HTMLElement; channel: FakeChannel }> {
  const { gen = 1, parent = document.body, tabId = null } = opts;
  const canvasEl = document.createElement("div");
  parent.append(canvasEl);
  await mountIframeCanvas(gen, { tagName: "div" } as never, canvasEl, null, tabId);
  const channel = channels.at(-1)!;
  channel.deliver({ kind: "ready" });
  // The tab identity is adopted on the ACK, never at mount time.
  channel.deliver({ gen, kind: "renderComplete" });
  return { canvasEl, channel };
}

/** A detached root a host can be mounted under, so a scoped call can name it. */
function makeRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

/** Every post of one kind a channel received. */
function postsOfKind(channel: FakeChannel, kind: string): Record<string, unknown>[] {
  return channel.posts.filter((post) => post.kind === kind);
}

/** What a promise settled with — or the sentinel, when it has not settled at all. */
const PENDING = "still-pending";
function raceSettled<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([
    promise,
    new Promise<typeof PENDING>((resolve) => {
      setTimeout(() => resolve(PENDING), 50);
    }),
  ]);
}

beforeEach(() => {
  // Release before emptying the body: a host is only truly gone when its channel is disposed.
  releaseCanvasHosts(document.body);
  channels.length = 0;
  document.body.innerHTML = "";
  tearDownPaneGrids();
  resetStudioState();
  resetWorkspaceWithTab(undefined, { id: "tab-focused" });
});

// ─── The eval blocker probe.idle() reads ─────────────────────────────────────

describe("canvasIdleBlockers and expression evals", () => {
  test("an in-flight expression eval is named as a blocker until its reply lands", async () => {
    const { channel } = await mountReady({ tabId: "tab-focused" });
    channel.deliver({ ...QUIET, gen: 1 });
    expect(canvasIdleBlockers()).toEqual([]);

    // A long timeout so nothing but the reply can settle it: the blocker must come from the
    // Pending map, not from a race with the fallback timer.
    const pending = requestCanvasEval("tab-focused", EXPRS, null, 60_000);
    expect(canvasIdleBlockers()).toEqual(["canvas: 1 expression eval(s) in flight"]);

    const request = postsOfKind(channel, "evalExpr").at(-1)!;
    channel.deliver({ gen: 1, kind: "evalResult", reqId: request.reqId, results: EVAL_RESULTS });
    expect(await pending).toEqual(EVAL_RESULTS);
    expect(canvasIdleBlockers()).toEqual([]);
  });
});

// ─── hostForPath prefers the host rendering the FOCUSED tab ──────────────────

describe("hostForPath", () => {
  test("a point is measured in the focused tab's host, not in the first ready one", async () => {
    const side = openTab({ document: { tagName: "div" }, id: "tab-side" });
    activateTab("tab-focused");
    expect(workspace.tabs.get(side.id)).toBeTruthy();

    // Mounted FIRST, so it is what `hostForPath`'s fallback would answer with.
    const other = await mountReady({ tabId: "tab-side" });
    const focused = await mountReady({ tabId: "tab-focused" });
    for (const host of [other, focused]) {
      const iframe = host.canvasEl.querySelector("iframe")!;
      Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 100 });
    }
    // Distinct offsets, so the resolved point says WHICH frame answered.
    stubRect(other.canvasEl.querySelector("iframe")!, {
      height: 100,
      left: 500,
      top: 500,
      width: 100,
    });
    stubRect(focused.canvasEl.querySelector("iframe")!, {
      height: 100,
      left: 10,
      top: 20,
      width: 100,
    });
    await flush(1);

    const pending = canvasPointAt(["children", 0]);
    expect(postsOfKind(other.channel, "measure")).toHaveLength(0);
    const measure = postsOfKind(focused.channel, "measure").at(-1)!;
    expect(measure.paths).toEqual([["children", 0]]);

    focused.channel.deliver({
      hits: [{ path: ["children", 0], rect: { height: 4, width: 6, x: 1, y: 2 } }],
      kind: "geometry",
      reqId: measure.reqId,
    });
    // Left = 10 + 1, top = 20 + 2 at scale 1 — the FOCUSED frame's offset.
    expect(await pending).toEqual({ height: 4, left: 11, top: 22, width: 6, x: 14, y: 24 });
  });
});

// ─── The one public reader on the opaque drag handle ─────────────────────────

describe("dragHostTab", () => {
  test("answers the tab the DRAG TARGET renders, not the focused one", async () => {
    const side = openTab({
      document: { tagName: "div" },
      documentPath: "/project/side.json",
      id: "tab-side",
    });
    activateTab("tab-focused");
    const { canvasEl } = await mountReady({ tabId: side.id });

    // Read field by field: a tab is a reactive proxy, so identity compares the handler.
    const host = hostForCanvas(canvasEl)!;
    expect(dragHostTab(host)?.id).toBe("tab-side");
    expect(dragHostTab(host)?.documentPath).toBe("/project/side.json");
  });

  test("a host with no tab identity (an override doc) answers null", async () => {
    const { canvasEl } = await mountReady({ tabId: null });
    expect(dragHostTab(hostForCanvas(canvasEl)!)).toBeNull();
  });
});

// ─── releaseHost settles what the released host was owed, and only that ──────

describe("releaseCanvasHosts settles the released host's in-flight work", () => {
  test("a pending eval resolves null; another host's stays in flight", async () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    const a = await mountReady({ parent: rootA, tabId: "tab-a" });
    const b = await mountReady({ parent: rootB, tabId: "tab-b" });
    expect(postsOfKind(a.channel, "evalExpr")).toHaveLength(0);

    const evalA = requestCanvasEval("tab-a", EXPRS, null, 60_000);
    const evalB = requestCanvasEval("tab-b", EXPRS, null, 60_000);
    expect(releaseCanvasHosts(rootA)).toBe(1);

    expect(await raceSettled(evalA)).toBeNull();
    expect(await raceSettled(evalB)).toBe(PENDING);

    // …and B settles the same way when ITS pane goes.
    expect(releaseCanvasHosts(rootB)).toBe(1);
    expect(await raceSettled(evalB)).toBeNull();
    expect(b.channel.disposed).toBe(true);
  });

  test("a pending flush resolves; another host's stays in flight", async () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    const a = await mountReady({ parent: rootA, tabId: "tab-a" });
    await mountReady({ parent: rootB, tabId: "tab-b" });

    const flushA = flushCanvasEdits("tab-a", 60_000);
    const flushB = flushCanvasEdits("tab-b", 60_000);
    expect(postsOfKind(a.channel, "flushEdits")).toHaveLength(1);
    expect(releaseCanvasHosts(rootA)).toBe(1);

    // A save must not hang on a frame that no longer exists…
    expect(await raceSettled(flushA)).toBeUndefined();
    // …and must not be told the OTHER pane has flushed when it has not.
    expect(await raceSettled(flushB)).toBe(PENDING);

    expect(releaseCanvasHosts(rootB)).toBe(1);
    expect(await raceSettled(flushB)).toBeUndefined();
  });

  test("a pending measure answers null instead of waiting out its timeout", async () => {
    const rootA = makeRoot();
    const { channel } = await mountReady({ parent: rootA, tabId: "tab-focused" });
    channel.deliver({ ...QUIET, gen: 1 });

    const pending = canvasPointAt(["children", 0]);
    expect(postsOfKind(channel, "measure")).toHaveLength(1);
    expect(canvasIdleBlockers()).toEqual(["canvas[tab-focused]: 1 measure(s) in flight"]);

    expect(releaseCanvasHosts(rootA)).toBe(1);
    // The measure's own timeout is 500ms; settling inside the 50ms race is the release doing it.
    expect(await raceSettled(pending)).toBeNull();
    expect(canvasIdleBlockers()).toEqual([]);
  });
});

// ─── Layout chrome is a PAGE concept ─────────────────────────────────────────

describe("layoutHit", () => {
  test("a stylebook host ignores it; a page host adopts it", async () => {
    setLayoutSelection(null);
    const bookEl = document.createElement("div");
    document.body.append(bookEl);
    mountStylebookCanvas(1, STYLEBOOK_GENERATED(), bookEl, null);
    const book = channels.at(-1)!;
    book.deliver({ kind: "ready" });

    book.deliver({ hit: LAYOUT_HIT, kind: "layoutHit" });
    expect(shell.layoutSelection).toBeNull();
    const bookBox = bookEl.querySelector(".overlay-selection") as HTMLElement;
    expect(bookBox.style.display).toBe("none");

    // The same message in a page host is the click the layout panel exists for.
    const page = await mountReady({ tabId: "tab-focused" });
    page.channel.deliver({ hit: LAYOUT_HIT, kind: "layoutHit" });
    expect(shell.layoutSelection?.layoutFile).toBe("layouts/base.json");
    expect(shell.layoutSelection?.tagName).toBe("header");
    const pageBox = page.canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(pageBox.style.display).toBe("block");
    expect(pageBox.style.left).toBe("24px");
  });
});

// ─── A forwarded wheel is replayed on the stage the FRAME is mounted on ──────

describe("forwardWheel", () => {
  const WHEEL = {
    ctrlKey: false,
    deltaX: 4,
    deltaY: 7,
    kind: "forwardWheel",
    metaKey: false,
    shiftKey: false,
    x: 100,
    y: 50,
  };

  test("replays on the stage containing the frame", async () => {
    const surface = standUpPaneGrid("primary");
    const { canvasEl, channel } = await mountReady({ parent: surface.wrap });
    const iframe = canvasEl.querySelector("iframe")!;
    stubRect(iframe, { height: 240, left: 10, top: 20, width: 600 });
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 300 });

    const seen: WheelEvent[] = [];
    const onWheel = (event: Event) => seen.push(event as WheelEvent);
    surface.wrap.addEventListener("wheel", onWheel);
    channel.deliver(WHEEL);
    surface.wrap.removeEventListener("wheel", onWheel);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.deltaX).toBe(4);
    expect(seen[0]!.deltaY).toBe(7);
  });

  test("a frame inside no stage at all drops the wheel instead of throwing", async () => {
    // Mounted straight into the body: no registered surface contains this artboard, which is what
    // A frame between pane teardowns looks like.
    const { channel } = await mountReady();
    const seen: Event[] = [];
    const onWheel = (event: Event) => seen.push(event);
    document.addEventListener("wheel", onWheel, true);
    try {
      // Without the guard this is `undefined.dispatchEvent` — a TypeError thrown at the frame.
      expect(() => channel.deliver(WHEEL)).not.toThrow();
    } finally {
      document.removeEventListener("wheel", onWheel, true);
    }
    expect(seen).toHaveLength(0);
  });
});

// ─── The colour-scheme push is per-TAB, so it is scoped to one stage ─────────

describe("postColorSchemeToLiveHosts", () => {
  test("a scoped push reaches the named root's host and no other", async () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    const a = await mountReady({ parent: rootA, tabId: "tab-a" });
    const b = await mountReady({ parent: rootB, tabId: "tab-b" });

    postColorSchemeToLiveHosts("dark", rootA);
    expect(postsOfKind(a.channel, "setColorScheme")).toEqual([
      { kind: "setColorScheme", scheme: "dark" },
    ]);
    // B's tab never asked for Dark, and B's own control would go on saying Auto.
    expect(postsOfKind(b.channel, "setColorScheme")).toEqual([]);

    // Unscoped, both hosts hear it — so the skip above was the root gate, not readiness.
    postColorSchemeToLiveHosts("light");
    expect(postsOfKind(a.channel, "setColorScheme").at(-1)).toEqual({
      kind: "setColorScheme",
      scheme: "light",
    });
    expect(postsOfKind(b.channel, "setColorScheme")).toEqual([
      { kind: "setColorScheme", scheme: "light" },
    ]);
  });
});

// ─── The caret lives in the other realm; this one can only ask ───────────────

describe("postOpenSlash", () => {
  test("asks the host that owns the caret, and nothing at all once the session ends", async () => {
    const { channel } = await mountReady({ tabId: "tab-focused" });
    channel.deliver({ kind: "editStart", path: ["children", 0] });

    postOpenSlash();
    expect(postsOfKind(channel, "openSlash")).toEqual([{ kind: "openSlash" }]);

    // The session ends → there is no caret to open a menu at, which is when the command refuses.
    channel.deliver({ kind: "editEnd" });
    postOpenSlash();
    expect(postsOfKind(channel, "openSlash")).toHaveLength(1);
  });
});

// ─── The keymap fan-out prunes what it cannot reach ──────────────────────────

describe("publishKeymap", () => {
  test("a disconnected frame is dropped from the live set, not merely skipped", async () => {
    const table = { chords: [{ chord: "mod+b", scope: "caret" as const }], mac: false };
    setKeymapSource(() => table);
    try {
      const { canvasEl, channel } = await mountReady();
      // The frame is handed the table on `ready`, and again on every publish while it is live.
      expect(postsOfKind(channel, "keymap")).toHaveLength(1);
      publishKeymap();
      expect(postsOfKind(channel, "keymap")).toHaveLength(2);

      canvasEl.remove();
      publishKeymap();
      expect(postsOfKind(channel, "keymap")).toHaveLength(2);

      // Re-attached, it STILL hears nothing: the prune removed it from the live set for good.
      document.body.append(canvasEl);
      publishKeymap();
      expect(postsOfKind(channel, "keymap")).toHaveLength(2);
    } finally {
      setKeymapSource(undefined as never);
    }
  });
});
