/**
 * Two live canvas hosts, one in each pane — the two claims the whole workstream is for.
 *
 * Everything below the grid landed one pane at a time and was true at one pane by inspection. These
 * two are only true with a SECOND live host, and nothing had ever run with one:
 *
 * 1. **One preparation, two posts.** A render pass resolves the document ONCE and fans the result out
 *    to every artboard in that pass — and to no artboard outside it. `preparePassRender` caches on
 *    `(gen, doc)`, and the generations are per-surface now, so the cache key is the thing most
 *    likely to have broken when the second stage arrived: a shared counter would have made pane A's
 *    pass and pane B's collide, and a per-pane counter that reused NUMBERS would have made them
 *    share a cache entry across two different documents.
 * 2. **Unsplit actually releases.** Not that a variable was nulled — that the frames were disposed,
 *    the artboards' reactive scopes were stopped, and the pane's surface record is gone.
 *    `releaseCanvasHosts` returns a count; the count is the assertion.
 *
 * Driven through `panels/pane-grid.ts` rather than against hand-built divs, because the thing under
 * test is the cell lifecycle: a pane appears, mounts frames, and goes away.
 */
import "./with-dom.js";
import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
import { flush, resetStudioState } from "./harness";
import {
  PRIMARY_PANE,
  SECONDARY_PANE,
  closeAllTabs,
  closePane,
  focusPane,
  openTab,
  splitRight,
  workspace,
} from "../src/workspace/workspace";
import { canvasPerf, resetCanvasPerf } from "../src/canvas/canvas-perf";
import { surfaceForPane } from "../src/canvas/surface-registry";
import { DEFAULT_PANE_SPLIT, resetShellSurfaces, shell } from "../src/shell";
import type { CanvasPanel } from "../src/types";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

// ─── Mocks ────────────────────────────────────────────────────────────────────

interface FakeChannel {
  posts: Record<string, unknown>[];
  deliver: (m: Record<string, unknown>) => void;
  /** Whether the host really disposed this channel — the only honest teardown signal there is. */
  disposed?: boolean;
}
const channels: FakeChannel[] = [];

void mock.module("../src/canvas/iframe-channel", () => ({
  postMessageChannel: () => {
    let handler: ((m: Record<string, unknown>) => void) | null = null;
    const rec: FakeChannel = { deliver: (m) => handler?.(m), posts: [] };
    channels.push(rec);
    return {
      dispose: () => {
        rec.disposed = true;
      },
      onMessage: (h: (m: Record<string, unknown>) => void) => {
        handler = h;
        return () => {};
      },
      post: (m: Record<string, unknown>) => rec.posts.push(m),
    };
  },
}));

/* Stubbed for its weight, not its behaviour: the real module pulls `panels/dnd` and the whole
   component-preview renderer, neither of which any assertion here reaches. The stub has to carry
   every export the graph LINKS against or the file fails at import rather than at call time. */
void mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
  renderStylebookMode: () => {},
  selectStylebookTag: () => {},
  stylebookMeta: {},
}));

let resolveCalls = 0;
/** The `documentPath` of the tab each resolution was asked FOR — see the last describe. */
const resolvedFor: (string | null)[] = [];
void mock.module("../src/canvas/canvas-live-render", () => ({
  resolveCanvasDocument: (_doc: unknown, tab: { documentPath?: string } | null) => {
    resolveCalls += 1;
    resolvedFor.push(tab?.documentPath ?? null);
    return Promise.resolve({
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
    });
  },
}));

const { mountIframeCanvas, releaseCanvasHosts } = await import("../src/canvas/iframe-host");
const { applyPatchBatch } = await import("../src/canvas/canvas-patcher");
const grid = await import("../src/panels/pane-grid");

// ─── Fixture ──────────────────────────────────────────────────────────────────

/**
 * Two panes, each drawn by the real reconciler, each showing a Canvas document of its own.
 *
 * The split is the one `⌘\` performs. It only reaches two panes because the kind cap is lifted:
 * `SECONDARY_PANE_KINDS` would have refused these documents outright, and `capToPaneKind` would
 * have rewritten the second one into Code on its way across.
 */
async function splitIntoTwoCanvasPanes() {
  const left = openTab({ document: { tagName: "div" }, documentPath: "/p/a.json", id: "a" });
  const right = openTab({ document: { tagName: "div" }, documentPath: "/p/b.json", id: "b" });
  expect(splitRight()?.id).toBe(SECONDARY_PANE);
  await flush();
  /* Drained to a known zero. Building a cell schedules a render for it (nothing else is keyed on a
     pane APPEARING), and that pass mounts artboards of its own — real behaviour, and noise for
     every count below. Each test then mounts exactly the frames it means to talk about. */
  for (const paneId of [PRIMARY_PANE, SECONDARY_PANE]) {
    const surface = surfaceForPane(paneId);
    releaseCanvasHosts(surface.wrap);
    surface.panels.length = 0;
  }
  channels.length = 0;
  resolveCalls = 0;
  resolvedFor.length = 0;
  resetCanvasPerf();
  return { left, right };
}

/**
 * START an artboard mount without waiting for it, and hand back its channel immediately.
 *
 * `mountIframeCanvas` builds the host and its channel SYNCHRONOUSLY and only then awaits the pass's
 * prepared payload, so the channel is knowable before the promise settles. That is what lets a test
 * interleave two panes' passes the way two rAF-scheduled renders really do — and awaiting each
 * mount in turn, which every case here used to do, is the one ordering in which the prepared-pass
 * cache could not be evicted.
 */
function beginArtboard(paneId: string, gen: number, doc: object, tabId: string) {
  const surface = surfaceForPane(paneId);
  const canvasEl = document.createElement("div");
  surface.wrap.append(canvasEl);
  const mounted = mountIframeCanvas(gen, doc as never, canvasEl, null, tabId);
  return { canvasEl, channel: channels.at(-1)!, mounted, paneId, gen };
}

/** Take a started artboard all the way to `ready` and record it on its pane. */
function settleArtboard(started: ReturnType<typeof beginArtboard>) {
  const { canvasEl, channel, gen, paneId } = started;
  channel.deliver({ kind: "ready" });
  channel.deliver({ gen, kind: "renderComplete" });
  surfaceForPane(paneId).panels.push({ canvas: canvasEl, ready: true } as unknown as CanvasPanel);
  return { canvasEl, channel };
}

/** Mount one artboard of `gen` onto a pane's stage and take it all the way to `ready`. */
async function mountArtboard(paneId: string, gen: number, doc: object, tabId: string) {
  const started = beginArtboard(paneId, gen, doc, tabId);
  await started.mounted;
  return settleArtboard(started);
}

const renders = (channel: FakeChannel) => channel.posts.filter((p) => p.kind === "render");
const patches = (channel: FakeChannel) => channel.posts.filter((p) => p.kind === "patch");

beforeEach(() => {
  channels.length = 0;
  resolveCalls = 0;
  document.body.innerHTML = `<div id="app"><div id="pane-grid"></div></div>`;
  resetStudioState();
  closeAllTabs();
  resetCanvasPerf();
  shell.paneSplit = DEFAULT_PANE_SPLIT;
  grid.mount();
});

afterEach(() => {
  grid.unmount();
  resetShellSurfaces();
  closeAllTabs();
  document.body.innerHTML = "";
});

// ─── 1 · One preparation, two posts ───────────────────────────────────────────

describe("one preparation, two posts", () => {
  test("a pass resolves once, posts to every artboard in it, and to none outside it", async () => {
    const { left, right } = await splitIntoTwoCanvasPanes();

    // The side pane's host, from its own earlier pass. It is the host that must NOT be posted to.
    const side = await mountArtboard(SECONDARY_PANE, 1, { tagName: "div" }, right.id);
    resetCanvasPerf();
    resolveCalls = 0;

    // The primary's pass: two artboards of ONE generation over ONE document, which is what a
    // Two-breakpoint Design render is.
    const doc = { tagName: "div" };
    const wide = await mountArtboard(PRIMARY_PANE, 2, doc, left.id);
    const narrow = await mountArtboard(PRIMARY_PANE, 2, doc, left.id);

    // THE claim. One resolution, one preparation, two posts — the fan-out denominator is the pass,
    // Not the artboard, and the second pane's existence does not add a third of either.
    expect(resolveCalls).toBe(1);
    expect(canvasPerf.renderPreparations).toBe(1);
    expect(canvasPerf.hostRenderPosts).toBe(2);
    console.log(
      `[two-pane hosts] one pass over two artboards, with a third host live in the side pane: ` +
        `${resolveCalls} resolve, ${canvasPerf.renderPreparations} preparation, ` +
        `${canvasPerf.hostRenderPosts} host posts`,
    );
    expect(renders(wide.channel)).toHaveLength(1);
    expect(renders(narrow.channel)).toHaveLength(1);
    expect(renders(side.channel)).toHaveLength(1); // Its own, from gen 1 — not this pass's.
    for (const post of [...renders(wide.channel), ...renders(narrow.channel)]) {
      expect(post).toMatchObject({ gen: 2 });
    }
  });

  test("…and still resolves once when the OTHER pane's pass interleaves with it", async () => {
    /* **The case above cannot fail, and this is the one it was standing in for.**
       It awaits each mount in turn, which is the single ordering in which one pass can never be
       evicted from the prepared-pass cache — and the cache was ONE slot, replaced whenever `gen`
       differed. Both stages schedule through rAF and `mountIframeCanvas` awaits inside the loop,
       so two passes interleave at every await: the primary's second artboard came back to a slot
       the side pane had claimed, re-resolved and re-serialized a document that had been prepared
       moments earlier, and evicted the side pane's in turn. Three resolutions for three artboards,
       which is exactly the per-artboard fan-out the cache exists to remove.

       The three mounts below are STARTED before any of them is awaited, in the order
       primary · side · primary — the second pane's whole contribution, in three lines. */
    const { left, right } = await splitIntoTwoCanvasPanes();
    const doc = { tagName: "div" };
    const sideDoc = { tagName: "section" };

    const wide = beginArtboard(PRIMARY_PANE, 2, doc, left.id);
    const side = beginArtboard(SECONDARY_PANE, 3, sideDoc, right.id);
    const narrow = beginArtboard(PRIMARY_PANE, 2, doc, left.id);
    await Promise.all([wide.mounted, side.mounted, narrow.mounted]);
    for (const started of [wide, side, narrow]) {
      settleArtboard(started);
    }

    // Two passes, two documents, three artboards: two resolutions and two preparations.
    console.log(
      `[two-pane hosts] interleaved primary·side·primary over 3 artboards: ` +
        `${resolveCalls} resolve(s), ${canvasPerf.renderPreparations} preparation(s), ` +
        `${canvasPerf.hostRenderPosts} host posts`,
    );
    expect(resolveCalls).toBe(2);
    expect(canvasPerf.renderPreparations).toBe(2);
    expect(canvasPerf.hostRenderPosts).toBe(3);
    // The primary's two artboards were fed from ONE payload — same object, by identity.
    const [wideRender] = renders(wide.channel);
    const [narrowRender] = renders(narrow.channel);
    expect(wideRender!.doc).toBe(narrowRender!.doc);
    // And the side pane's is a different pass's, with its own generation.
    expect(renders(side.channel)[0]).toMatchObject({ gen: 3 });
    expect(wideRender).toMatchObject({ gen: 2 });
  });

  test("a single mutation is ONE patch, fanned to the artboards showing that document", async () => {
    const { left, right } = await splitIntoTwoCanvasPanes();
    const doc = { tagName: "div" };
    const wide = await mountArtboard(PRIMARY_PANE, 2, doc, left.id);
    const narrow = await mountArtboard(PRIMARY_PANE, 2, doc, left.id);
    const side = await mountArtboard(SECONDARY_PANE, 3, { tagName: "div" }, right.id);
    resetCanvasPerf();
    resolveCalls = 0;

    applyPatchBatch(left, [{ op: "set-text", path: ["children", 0] }], {
      docOps: [
        {
          forward: { key: "textContent", op: "set-key", path: ["children", 0], value: "X" },
          inverse: { key: "textContent", op: "set-key", path: ["children", 0], value: "y" },
        },
      ],
      fmOps: [],
      invertible: true,
      ops: [{ op: "set-text", path: ["children", 0] }],
    });

    // Counted once however many artboards it reached — `patchedOps` measures MUTATIONS, so a
    // Two-breakpoint canvas must not look twice as busy as a one-breakpoint one.
    expect(canvasPerf.patchedOps).toBe(1);
    // And it did reach both of the primary's, and neither escalated to a render.
    expect(patches(wide.channel)).toHaveLength(1);
    expect(patches(narrow.channel)).toHaveLength(1);
    expect(canvasPerf.renderPreparations).toBe(0);
    expect(resolveCalls).toBe(0);
    // The side pane is showing a different document. A patch it folded into its shadow doc would
    // Be a foreign edit — the bug `surfaceShowingTab` and the per-host `tabId` gate exist to stop.
    expect(patches(side.channel)).toHaveLength(0);
    console.log(
      `[two-pane hosts] one mutation, two live panes: ${canvasPerf.patchedOps} patchedOps, ` +
        `${canvasPerf.renderPreparations} preparations, ` +
        `${patches(wide.channel).length + patches(narrow.channel).length} patch posts to the ` +
        `primary, ${patches(side.channel).length} to the side pane`,
    );
  });

  test("one pane's pass does not invalidate the other's — the generation split, as behaviour", async () => {
    /* `renderGeneration` was module-wide. Pane A opening a pass bumped it while pane B's deferred
       artboards were still queued, so B's panels never reached `ready` and every edit in B
       escalated to a full render, permanently. The values are still globally unique, because
       `preparePassRender` caches by generation identity. */
    const { left, right } = await splitIntoTwoCanvasPanes();
    const primary = surfaceForPane(PRIMARY_PANE);
    const secondary = surfaceForPane(SECONDARY_PANE);

    const { nextRenderGeneration } = await import("../src/canvas/surface-registry");
    secondary.renderGeneration = nextRenderGeneration();
    const side = await mountArtboard(SECONDARY_PANE, secondary.renderGeneration, {}, right.id);

    // The primary opens its own pass, after the side pane's.
    primary.renderGeneration = nextRenderGeneration();
    await mountArtboard(PRIMARY_PANE, primary.renderGeneration, {}, left.id);

    // The side pane's pass is still the current one THERE, so its artboard is still live.
    expect(secondary.renderGeneration).not.toBe(primary.renderGeneration);
    expect(secondary.panels.every((panel) => panel.ready)).toBe(true);
    expect(side.channel.disposed).toBeFalsy();
  });
});

// ─── 1b · The frame survives everything that is not a teardown ────────────────

describe("a live frame survives the grid", () => {
  test("a reconcile, a splitter drag and a focus flip move no node and drop no channel", async () => {
    /* The reason the cells are a KEYED `repeat` and the splitter is part of the template. Every one
       of these three is a pass through the grid's one effect, and re-parenting is not a move for an
       `<iframe>`: it reloads, dropping its `iframe-channel` connection, its shadow document and
       every panel that had reached `ready`. Zero childList mutations on the grid is the structural
       version of the comment the old imperative reconciler carried. */
    const { left, right } = await splitIntoTwoCanvasPanes();
    const home = await mountArtboard(PRIMARY_PANE, 1, {}, left.id);
    const side = await mountArtboard(SECONDARY_PANE, 2, {}, right.id);
    const homeFrame = home.canvasEl.querySelector("iframe");
    const sideFrame = side.canvasEl.querySelector("iframe");
    expect(homeFrame).toBeTruthy();

    const gridEl = document.querySelector("#pane-grid") as HTMLElement;
    Object.defineProperty(gridEl, "clientWidth", { configurable: true, value: 1000 });
    const observer = new MutationObserver(() => {});
    observer.observe(gridEl, { childList: true });

    // 1 · A bare reconcile, twice.
    grid.reconcile();
    grid.reconcile();
    // 2 · A multi-step splitter drag — five `shell.paneSplit` writes, five passes through the
    // Effect. This is the gesture that used to remove and re-insert the handle on every move.
    const splitter = gridEl.querySelector(".pane-splitter") as HTMLElement;
    splitter.dispatchEvent(new PointerEvent("pointerdown", { clientX: 500, clientY: 0 }));
    for (const clientX of [520, 560, 600, 620, 640]) {
      splitter.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY: 0 }));
    }
    splitter.dispatchEvent(new PointerEvent("pointerup", { clientX: 640, clientY: 0 }));
    // 3 · A focus flip, both ways, each followed by a pass.
    focusPane(SECONDARY_PANE);
    grid.reconcile();
    focusPane(PRIMARY_PANE);
    grid.reconcile();

    const removed: string[] = [];
    const added: string[] = [];
    for (const record of observer.takeRecords()) {
      for (const node of record.removedNodes) {
        removed.push(node.nodeName.toLowerCase());
      }
      for (const node of record.addedNodes) {
        added.push(node.nodeName.toLowerCase());
      }
    }
    observer.disconnect();
    expect(removed).toEqual([]);
    expect(added).toEqual([]);

    // The frames themselves: same node, same parent, same channel.
    expect(home.canvasEl.querySelector("iframe")).toBe(homeFrame);
    expect(side.canvasEl.querySelector("iframe")).toBe(sideFrame);
    expect(homeFrame!.isConnected).toBe(true);
    expect(sideFrame!.isConnected).toBe(true);
    expect(home.channel.disposed).toBeFalsy();
    expect(side.channel.disposed).toBeFalsy();
    // And the drag really did land — this is not a test that passes by nothing happening.
    expect(shell.paneSplit).toBeCloseTo(0.64, 5);
    console.log(
      `[two-pane hosts] two live frames through 2 reconciles, a 5-step drag and 2 focus flips: ` +
        `${added.length} node(s) added, ${removed.length} removed, paneSplit ${shell.paneSplit}`,
    );
  });
});

// ─── 2 · Unsplit actually releases ────────────────────────────────────────────

describe("unsplit actually releases", () => {
  test("the frames are disposed, the scopes stopped, and the surface record is gone", async () => {
    const { left, right } = await splitIntoTwoCanvasPanes();
    await mountArtboard(PRIMARY_PANE, 1, {}, left.id);
    const wide = await mountArtboard(SECONDARY_PANE, 2, {}, right.id);
    const narrow = await mountArtboard(SECONDARY_PANE, 2, {}, right.id);

    const sideCell = grid.cellForPane(SECONDARY_PANE)!;
    const sideStage = sideCell.stage;
    // Two artboards, each holding a render `EffectScope`. Dropping the panel records is not enough:
    // A scope that is not stopped goes on reacting to the document and repainting DOM that is gone.
    const sidePanels = surfaceForPane(SECONDARY_PANE).panels;
    /* Reduced to exactly the two artboards this test mounted. The grid schedules a render for a
       cell it has just built, and that pass mounts panels of its own — real, and beside the point
       here, where the subject is what a DISPOSE does to the records it finds. */
    sidePanels.splice(
      0,
      sidePanels.length,
      ...[wide, narrow].map(
        ({ canvasEl }) =>
          ({ canvas: canvasEl, ready: true, renderScope: { stop: () => {} } }) as never,
      ),
    );
    expect(sidePanels).toHaveLength(2);

    // The count, taken the way the app takes it — BEFORE the cell is removed, while the frames are
    // Still reachable from the stage. This is the assertion the whole teardown turns on.
    const wouldRelease = releaseCanvasHosts(sideStage);
    expect(wouldRelease).toBe(2);
    console.log(`[two-pane hosts] unsplit released ${wouldRelease} host(s) from the side pane`);
    expect(wide.channel.disposed).toBe(true);
    expect(narrow.channel.disposed).toBe(true);
    // Re-mount them so the real path — `closePane` → reconcile → `cell.dispose()` — does the work.
    const remounted = [
      await mountArtboard(SECONDARY_PANE, 4, {}, right.id),
      await mountArtboard(SECONDARY_PANE, 4, {}, right.id),
    ];

    closePane(SECONDARY_PANE);
    await flush();

    // The cell is gone, and with it the stage, the frames and the record.
    expect(grid.cellForPane(SECONDARY_PANE)).toBeNull();
    expect(sideCell.root.isConnected).toBe(false);
    for (const { channel, canvasEl } of remounted) {
      expect(channel.disposed).toBe(true);
      expect(canvasEl.querySelector("iframe")).toBeNull();
      expect(canvasEl.querySelector(".jx-canvas-iframe-overlay")).toBeNull();
    }
    // Nothing left under that stage to release — the second call is the proof the first was real.
    expect(releaseCanvasHosts(sideStage)).toBe(0);
    // The surface record was disposed, so it no longer names the panels of a pane that is gone.
    expect(surfaceForPane(SECONDARY_PANE).panels).toHaveLength(0);
    expect(surfaceForPane(SECONDARY_PANE).wrap).toBeNull();
    // And the survivor is untouched: its cell, its stage and its live host are all still standing.
    expect(workspace.panes).toHaveLength(1);
    const primaryStage = grid.cellForPane(PRIMARY_PANE)!.stage;
    expect(surfaceForPane(PRIMARY_PANE).wrap).toBe(primaryStage);
    expect(primaryStage.querySelector("iframe")).toBeTruthy();
  });

  test("the released pane's scopes really stop — not `panels.length = 0` and a leak", async () => {
    const { left, right } = await splitIntoTwoCanvasPanes();
    await mountArtboard(PRIMARY_PANE, 1, {}, left.id);
    await mountArtboard(SECONDARY_PANE, 2, {}, right.id);

    let stopped = 0;
    let primaryStopped = 0;
    const sidePanels = surfaceForPane(SECONDARY_PANE).panels;
    const panel = { ready: true, renderScope: { stop: () => (stopped += 1) } } as never;
    sidePanels.splice(0, sidePanels.length, panel);
    const primaryPanels = surfaceForPane(PRIMARY_PANE).panels;
    const primaryPanel = {
      ready: true,
      renderScope: { stop: () => (primaryStopped += 1) },
    } as never;
    primaryPanels.splice(0, primaryPanels.length, primaryPanel);

    closePane(SECONDARY_PANE);
    await flush();

    expect(stopped).toBe(1);
    expect((panel as { renderScope: unknown }).renderScope).toBeNull();
    // Unsplitting is a LAYOUT action. It must not tear down the pane that stays.
    expect(primaryStopped).toBe(0);
    expect((primaryPanel as { renderScope: unknown }).renderScope).not.toBeNull();
  });
});

// ─── 5 · A click in a canvas is a click in a PANE ─────────────────────────────

describe("a click inside an artboard focuses the pane that mounted it", () => {
  /*
   * `panels/pane-grid.ts` moves the pane focus on a `pointerdown` anywhere in a cell, and that
   * listener structurally cannot see this one: the canvas is a cross-origin `<iframe>`, so the
   * pointer event is delivered in the frame's own realm. The `hit` message IS that pointerdown,
   * re-posted across the channel, and until now the handler wrote `hostTab(state).session.selection`
   * — correctly, the pane's own tab — and left the keyboard where it was. The result was a node
   * selected in the side pane that the Inspector, the block action bar and the overlays effect all
   * refused to show, because every one of them answers for the FOCUSED pane.
   */
  async function sideArtboardWithPrimaryFocused() {
    const { right } = await splitIntoTwoCanvasPanes();
    const side = await mountArtboard(SECONDARY_PANE, 1, { tagName: "div" }, right.id);
    focusPane(PRIMARY_PANE);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    return { right, side };
  }

  test("a `hit` in the side pane's frame moves the keyboard there", async () => {
    const { right, side } = await sideArtboardWithPrimaryFocused();

    side.channel.deliver({
      hit: { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
      kind: "hit",
    });

    console.log(
      `[two-pane] clicked the SIDE pane's canvas: focus=${workspace.activePaneId} ` +
        `selection=${JSON.stringify(right.session.selection)}`,
    );
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    // And the selection it made is now one the Inspector will actually be asked about.
    expect(right.session.selection).toEqual([["children", 0]]);
  });

  test("a `layoutHit` counts too — layout chrome is still canvas", async () => {
    const { side } = await sideArtboardWithPrimaryFocused();

    side.channel.deliver({
      hit: {
        layoutFile: "layouts/base.json",
        layoutPath: ["children", 0],
        rect: { height: 20, width: 100, x: 0, y: 0 },
        tagName: "header",
      },
      kind: "layoutHit",
    });

    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
  });

  test("a click in the pane that already has focus leaves the MRU order alone", async () => {
    /* The handler runs on every hit, so it has to be free when it has nothing to do. `focusPane`
       returns early for the pane that already has focus — otherwise every canvas click would
       rewrite the order `⌃Tab` walks. */
    const { left } = await splitIntoTwoCanvasPanes();
    const home = await mountArtboard(PRIMARY_PANE, 1, { tagName: "div" }, left.id);
    focusPane(PRIMARY_PANE);
    workspace.mruOrder = ["b", "a"];

    home.channel.deliver({
      hit: { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
      kind: "hit",
    });

    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.mruOrder).toEqual(["b", "a"]);
  });
});

// ─── 6 · The document is resolved FOR a tab ───────────────────────────────────

describe("a pass tells the resolver which tab it is for", () => {
  test("each pane's artboard resolves against its OWN tab, whichever has focus", async () => {
    /* The parameter exists because `resolveCanvasDocument` used to open with `activeTab.value`.
       `mountIframeCanvas` derives it from the canvas element by default — the `paneOfContainer`
       route — and `canvas-render.ts` passes `tabOfPane(surface.paneId)` explicitly. */
    await splitIntoTwoCanvasPanes();
    focusPane(PRIMARY_PANE);

    await mountArtboard(SECONDARY_PANE, 1, { tagName: "div" }, "b");
    await mountArtboard(PRIMARY_PANE, 2, { tagName: "div" }, "a");

    console.log(`[two-pane] resolutions were asked for: ${JSON.stringify(resolvedFor)}`);
    expect(resolvedFor).toEqual(["/p/b.json", "/p/a.json"]);
  });
});
