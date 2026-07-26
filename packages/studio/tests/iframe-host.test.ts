import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { flush, resetStudioState, resetWorkspaceWithTab, stubRect } from "./harness";
import { activeTab } from "../src/workspace/workspace";
import { reactive } from "../src/reactivity";
import { canvasPanels, canvasWrap, initShellRefs, registerRenderer } from "../src/store";
import { clearDragGhost, setDragGhost } from "../src/panels/drag-ghost";
import type { WireDocOp } from "../src/canvas/iframe-protocol";
import type { CanvasPanel } from "../src/types";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

// ─── Mocks: capture the channel and stub the parent-side resolver ───────────────

interface FakeChannel {
  opts: Record<string, unknown>;
  posts: Record<string, unknown>[];
  deliver: (m: Record<string, unknown>) => void;
}
const channels: FakeChannel[] = [];

void mock.module("../src/canvas/iframe-channel", () => ({
  postMessageChannel: (opts: Record<string, unknown>) => {
    let handler: ((m: Record<string, unknown>) => void) | null = null;
    const rec: FakeChannel = { deliver: (m) => handler?.(m), opts, posts: [] };
    channels.push(rec);
    return {
      dispose: () => {},
      onMessage: (h: (m: Record<string, unknown>) => void) => {
        handler = h;
        return () => {};
      },
      post: (m: Record<string, unknown>) => {
        rec.posts.push(m);
        // Exercise the host's real target (iframe.contentWindow?.postMessage) for coverage; it's a
        // No-op against a detached happy-dom iframe.
        (opts.target as { postMessage: (m: unknown, o: string) => void }).postMessage(
          m,
          opts.targetOrigin as string,
        );
      },
    };
  },
}));

// The host now imports applyDropInstruction (panels/dnd → stylebook-panel); stub it light.
void mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
}));

const DEFAULT_RESOLVED = {
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
};
let resolved: Record<string, unknown> = structuredClone(DEFAULT_RESOLVED);
let resolveCalls = 0;
void mock.module("../src/canvas/canvas-live-render", () => ({
  resolveCanvasDocument: () => {
    resolveCalls += 1;
    return Promise.resolve(resolved);
  },
}));

const {
  adoptDragSession,
  beginDragSession,
  clearDropIndicator,
  commitActiveEditSession,
  currentDragSession,
  endDragSession,
  getActiveEditHost,
  getEditBarAnchorRect,
  getEditSnapshot,
  hostDragGeometry,
  hostForCanvas,
  INSERT_HIDE_DELAY,
  liveDragHostAt,
  mountIframeCanvas,
  mountStylebookCanvas,
  panToStylebookTag,
  postApplyFormat,
  postColorSchemeToLiveHosts,
  postDragMessage,
  postSiteStyleToLiveHosts,
  postPatchToHosts,
  postStyleUpdateToStylebookHosts,
  requestCanvasEval,
  sawIframeDragOver,
  setCanvasContextMenuHandler,
  setCanvasSlashHandler,
  setIframePatchEscalation,
  setNativeDragEnterHandler,
  setInsertZoneClickHandler,
  setStylebookHitHandler,
  setToolbarRefresh,
} = await import("../src/canvas/iframe-host");
const { flushCanvasEdits } = await import("../src/canvas/iframe-host");

beforeEach(() => {
  channels.length = 0;
  document.body.innerHTML = "";
  resolved = structuredClone(DEFAULT_RESOLVED);
  resolveCalls = 0;
});

describe("mountIframeCanvas", () => {
  test("creates one authenticated iframe and posts the resolved doc on ready", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);

    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);

    const iframe = canvasEl.querySelector("iframe");
    expect(iframe).toBeTruthy();
    const src0 = iframe!.getAttribute("src")!;
    expect(src0.startsWith("/packages/studio/canvas.html?")).toBe(true);
    const q0 = new URL(src0, location.href).searchParams;
    expect(q0.get("parentOrigin")).toBe(location.origin);
    expect(q0.get("token")).toBeTruthy();
    expect(channels).toHaveLength(1);
    // Not ready yet → the render is queued, not posted.
    expect(channels[0]!.posts).toHaveLength(0);

    channels[0]!.deliver({ kind: "ready" });
    expect(channels[0]!.posts).toHaveLength(1);
    expect(channels[0]!.posts[0]).toMatchObject({ gen: 1, kind: "render", mode: "design" });
  });

  test("the render message carries the active tab's forced preview scheme (auto → null)", async () => {
    resetWorkspaceWithTab();
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });
    expect(channels[0]!.posts[0]).toMatchObject({ colorScheme: null, kind: "render" });

    activeTab.value!.session.ui.previewColorScheme = "dark";
    await mountIframeCanvas(2, { tagName: "div" } as never, canvasEl);
    expect(channels[0]!.posts[1]).toMatchObject({ colorScheme: "dark", kind: "render" });
  });

  test("postSiteStyleToLiveHosts pushes the project style to ready page hosts", async () => {
    resetStudioState({
      projectConfig: {
        $media: { "--dark": "(prefers-color-scheme: dark)" },
        style: { "--brand": "#0f0" },
      } as never,
    });
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });

    postSiteStyleToLiveHosts();
    expect(channels[0]!.posts.at(-1)).toEqual({
      kind: "siteStyleUpdate",
      media: { "--dark": "(prefers-color-scheme: dark)" },
      siteStyle: { "--brand": "#0f0" },
    });
  });

  test("postColorSchemeToLiveHosts posts setColorScheme to ready hosts only", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);

    // Not ready yet — nothing posts.
    postColorSchemeToLiveHosts("dark");
    expect(channels[0]!.posts).toHaveLength(0);

    channels[0]!.deliver({ kind: "ready" });
    postColorSchemeToLiveHosts("dark");
    expect(channels[0]!.posts.at(-1)).toEqual({ kind: "setColorScheme", scheme: "dark" });

    postColorSchemeToLiveHosts(null);
    expect(channels[0]!.posts.at(-1)).toEqual({ kind: "setColorScheme", scheme: null });
  });

  test("uses the platform's canvasUrl when set, default otherwise", async () => {
    const g = globalThis as unknown as {
      __jxPlatform?: { canvasUrl?: string } | undefined;
    };
    const saved = g.__jxPlatform;
    // With a platform that sets canvasUrl, the iframe boots from that URL.
    g.__jxPlatform = { canvasUrl: "/__studio__/canvas.html" } as never;
    try {
      const canvasEl = document.createElement("div");
      document.body.append(canvasEl);
      await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
      const iframe = canvasEl.querySelector("iframe")!;
      const src1 = iframe.getAttribute("src")!;
      expect(src1.startsWith("/__studio__/canvas.html?")).toBe(true);
      const q1 = new URL(src1, location.href).searchParams;
      expect(q1.get("parentOrigin")).toBe(location.origin);
      expect(q1.get("token")).toBeTruthy();
    } finally {
      g.__jxPlatform = saved;
    }
  });

  test("a relative canvasUrl keeps the iframe same-origin (channel origin === location.origin)", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);

    const iframe = canvasEl.querySelector("iframe")!;
    const src = iframe.getAttribute("src")!;
    // The src attribute stays RELATIVE (path-only, no scheme://host) — byte-identical same-origin.
    expect(src.startsWith("/packages/studio/canvas.html?")).toBe(true);
    const u = new URL(src, location.href);
    expect(u.searchParams.get("parentOrigin")).toBe(location.origin);
    expect(u.searchParams.get("token")).toBeTruthy();
    // IframeOrigin === location.origin → the channel accepts/targets the parent's own origin.
    expect(channels[0]!.opts.acceptOrigin).toBe(location.origin);
    expect(channels[0]!.opts.targetOrigin).toBe(location.origin);
  });

  test("a cross-origin canvasUrl carrying ?win=7 preserves win and appends parentOrigin+token", async () => {
    const g = globalThis as unknown as { __jxPlatform?: { canvasUrl?: string } | undefined };
    const saved = g.__jxPlatform;
    g.__jxPlatform = {
      canvasUrl: "http://127.0.0.1:54321/__studio__/canvas.html?win=7",
    } as never;
    try {
      const canvasEl = document.createElement("div");
      document.body.append(canvasEl);
      await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
      const iframe = canvasEl.querySelector("iframe")!;
      const src = iframe.getAttribute("src")!;
      // Absolute loopback origin is emitted verbatim (cross-origin), with all three query params.
      const u = new URL(src);
      expect(u.origin).toBe("http://127.0.0.1:54321");
      expect(u.searchParams.get("win")).toBe("7");
      expect(u.searchParams.get("parentOrigin")).toBe(location.origin);
      expect(u.searchParams.get("token")).toBeTruthy();
      // Channel accepts/targets the loopback origin, NOT the parent's views:// origin.
      expect(channels[0]!.opts.acceptOrigin).toBe("http://127.0.0.1:54321");
      expect(channels[0]!.opts.targetOrigin).toBe("http://127.0.0.1:54321");
    } finally {
      g.__jxPlatform = saved;
    }
  });

  test("an http(s) parent passes parentOrigin (strict, same-origin) — the channel stays gateable", async () => {
    // The default happy-dom parent is http://localhost:3000 → parentOrigin round-trips and is passed.
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    const src = canvasEl.querySelector("iframe")!.getAttribute("src")!;
    const u = new URL(src, location.href);
    expect(u.searchParams.get("parentOrigin")).toBe(location.origin);
  });

  test("a NON-http(s) parent (views://) OMITS parentOrigin so the iframe falls to '*'+token", async () => {
    // Simulate the electrobun shell: the parent doc is on a custom scheme (views://) whose origin may
    // Not surface as a postMessage event.origin. The host must OMIT parentOrigin so the iframe falls
    // Back to acceptOrigin '*' + the shared token rather than silently stalling. The parent side here
    // Stays STRICT — it accepts/targets the real loopback iframeOrigin (asserted below).
    const g = globalThis as unknown as { __jxPlatform?: { canvasUrl?: string } | undefined };
    const saved = g.__jxPlatform;
    g.__jxPlatform = { canvasUrl: "http://127.0.0.1:54321/__studio__/canvas.html" } as never;
    const realLocation = globalThis.location;
    // Override location with a views:// (non-http) parent for this test only.
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "views://studio/index.html", origin: "views://studio", protocol: "views:" },
    });
    try {
      const canvasEl = document.createElement("div");
      await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
      const src = canvasEl.querySelector("iframe")!.getAttribute("src")!;
      const u = new URL(src);
      // ParentOrigin is OMITTED (the iframe-entry side then falls back to '*'); token still present.
      expect(u.searchParams.has("parentOrigin")).toBe(false);
      expect(u.searchParams.get("token")).toBeTruthy();
      // The PARENT channel stays STRICT: it accepts/targets the real loopback origin, not views://.
      expect(channels[0]!.opts.acceptOrigin).toBe("http://127.0.0.1:54321");
      expect(channels[0]!.opts.targetOrigin).toBe("http://127.0.0.1:54321");
    } finally {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: realLocation,
      });
      g.__jxPlatform = saved;
    }
  });

  test("JSON round-trips the doc so non-cloneable values (functions) are dropped", async () => {
    resolved = {
      ...DEFAULT_RESOLVED,
      renderDoc: { children: ["hi"], onClick: () => {}, tagName: "div" },
    };
    const canvasEl = document.createElement("div");
    await mountIframeCanvas(1, {} as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });

    const posted = channels[0]!.posts[0] as { doc: Record<string, unknown> };
    expect(posted.doc.onClick).toBeUndefined();
    expect(posted.doc.tagName).toBe("div");
    expect(posted.doc.children).toEqual(["hi"]);
  });

  test("posts the raw page doc as the iframe's shadow doc (patch source-of-truth)", async () => {
    const canvasEl = document.createElement("div");
    // The raw doc differs from the resolved render doc — it's what forward ops are recorded against.
    await mountIframeCanvas(1, { children: ["raw"], tagName: "section" } as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });

    const posted = channels[0]!.posts[0] as { doc: unknown; shadowDoc: unknown };
    expect(posted.shadowDoc).toEqual({ children: ["raw"], tagName: "section" });
    // It's a clone, not the resolved render doc (which the live-render mock returns as DEFAULT_RESOLVED).
    expect(posted.doc).toEqual(DEFAULT_RESOLVED.renderDoc);
  });

  test("reuses a single iframe + channel across re-renders of the same canvas", async () => {
    const canvasEl = document.createElement("div");
    await mountIframeCanvas(1, {} as never, canvasEl);
    await mountIframeCanvas(2, {} as never, canvasEl);
    expect(canvasEl.querySelectorAll("iframe")).toHaveLength(1);
    expect(channels).toHaveLength(1);
  });

  test("sets the iframe width to the breakpoint widthPx, and 100% when null", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);

    // A breakpoint panel passes its explicit width → the iframe's layout viewport is that wide, so
    // The real @media inside the iframe evaluates against the breakpoint width.
    await mountIframeCanvas(1, {} as never, canvasEl, 768);
    const iframe = canvasEl.querySelector("iframe")!;
    expect(iframe.style.width).toBe("768px");
    // The rest of cssText is untouched (fixed-height viewport; content scrolls inside).
    expect(iframe.style.minHeight).toBe("480px");
    expect(iframe.style.height).toBe("100%");

    // A full-width / edit-mode / git-diff panel (null width) falls back to 100%, reusing the iframe.
    await mountIframeCanvas(2, {} as never, canvasEl, null);
    expect(canvasEl.querySelectorAll("iframe")).toHaveLength(1);
    expect(iframe.style.width).toBe("100%");
  });

  test("posts immediately (no queue) once the iframe is ready", async () => {
    const canvasEl = document.createElement("div");
    await mountIframeCanvas(1, {} as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });
    channels[0]!.posts.length = 0;

    await mountIframeCanvas(7, {} as never, canvasEl);
    expect(channels[0]!.posts).toHaveLength(1);
    expect(channels[0]!.posts[0]).toMatchObject({ gen: 7 });
  });

  test("non-ready messages are ignored for the render queue", async () => {
    const canvasEl = document.createElement("div");
    await mountIframeCanvas(1, {} as never, canvasEl);
    channels[0]!.deliver({ kind: "renderComplete", gen: 1 });
    expect(channels[0]!.posts.some((p) => p.kind === "render")).toBe(false);
  });
});

// ─── Interaction: selection + overlays from posted geometry (Phase 2) ───────────

type Msg = Record<string, unknown>;

async function mountReady(): Promise<HTMLElement> {
  const canvasEl = document.createElement("div");
  document.body.append(canvasEl);
  // Mount for the active tab (when one exists) and ack the render so the host adopts the tab
  // Identity — doc-mutating bridge messages (editCommit/editSplit/editInsert/dropResult) route by
  // The host's tabId, never by activeTab at message time.
  await mountIframeCanvas(1, {} as never, canvasEl, null, activeTab.value?.id ?? null);
  channels[0]!.deliver({ kind: "ready" });
  channels[0]!.deliver({ gen: 1, kind: "renderComplete" });
  return canvasEl;
}

describe("iframe canvas interaction", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  test("a hit selects the node and draws the selection box from the posted rect", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
      kind: "hit",
    });

    expect(activeTab.value?.session.selection).toEqual(["children", 0]);
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");
    expect(sel.style.left).toBe("10px");
    expect(sel.style.top).toBe("5px");
    expect(sel.style.width).toBe("100px");
    expect(sel.style.height).toBe("20px");
  });

  test("hover draws the hover box unless it coincides with the selection", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    const hover = canvasEl.querySelector(".overlay-hover") as HTMLElement;

    // A different node → hover box shown.
    channels[0]!.deliver({
      hit: { path: ["children", 1], rect: { height: 8, width: 40, x: 2, y: 3 } },
      kind: "hover",
    });
    expect(hover.style.display).toBe("block");
    expect(hover.style.left).toBe("2px");

    // The selected node → suppressed.
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hover",
    });
    expect(hover.style.display).toBe("none");

    // Cleared on leave.
    channels[0]!.deliver({
      hit: { path: ["children", 1], rect: { height: 8, width: 40, x: 2, y: 3 } },
      kind: "hover",
    });
    channels[0]!.deliver({ hit: null, kind: "hover" });
    expect(hover.style.display).toBe("none");
  });

  test("an external selection change asks the iframe to measure it; geometry redraws", async () => {
    const tab = resetWorkspaceWithTab();
    const canvasEl = await mountReady();
    channels[0]!.posts.length = 0; // Drop the initial render post.

    // Selection set from outside the canvas (e.g. the layers panel).
    tab.session.selection = ["children", 2];
    await flush();
    const measure = channels[0]!.posts.find((p) => p.kind === "measure") as Msg | undefined;
    expect(measure).toMatchObject({ kind: "measure", paths: [["children", 2]] });

    const reqId = measure!.reqId as number;
    channels[0]!.deliver({
      hits: [{ path: ["children", 2], rect: { height: 12, width: 30, x: 7, y: 8 } }],
      kind: "geometry",
      reqId,
    });
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");
    expect(sel.style.left).toBe("7px");

    // A stale geometry reply (wrong reqId) is ignored.
    channels[0]!.deliver({ hits: [], kind: "geometry", reqId: reqId - 1 });
    expect(sel.style.display).toBe("block");

    // The matching reqId with no hit clears the box.
    tab.session.selection = ["children", 3];
    await flush();
    const measure2 = channels[0]!.posts.findLast((p) => p.kind === "measure") as Msg;
    channels[0]!.deliver({ hits: [], kind: "geometry", reqId: measure2.reqId as number });
    expect(sel.style.display).toBe("none");
  });

  test("clearing the selection hides the box without a round-trip", async () => {
    const tab = resetWorkspaceWithTab();
    const canvasEl = await mountReady();
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");

    tab.session.selection = null;
    await flush();
    expect(sel.style.display).toBe("none");
  });

  test("renderComplete re-measures the current selection", async () => {
    const tab = resetWorkspaceWithTab();
    await mountReady();
    tab.session.selection = ["children", 1];
    await flush();
    channels[0]!.posts.length = 0;

    channels[0]!.deliver({ gen: 1, kind: "renderComplete" });
    expect(channels[0]!.posts.some((p) => p.kind === "measure")).toBe(true);
  });
});

// ─── Data-scope bridge: iframe → parent S.canvas.scope for the data-explorer ─────

describe("iframe canvas dataScope bridge", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  test("a non-stale dataScope adopts scope into S.canvas and re-renders the left panel", async () => {
    let leftRenders = 0;
    registerRenderer("leftPanel", () => {
      leftRenders += 1;
    });
    await mountReady();
    // Record the DOM's gen (mirrors the real renderComplete → lastRenderedGen path).
    channels[0]!.deliver({ gen: 1, kind: "renderComplete" });
    leftRenders = 0;

    channels[0]!.deliver({
      gen: 1,
      kind: "dataScope",
      scope: { posts: [{ title: "a" }], title: "Home" },
    });

    // The iframe's resolved scope now lives in the parent canvas state (data-explorer reads it).
    expect(activeTab.value!.session.canvas.scope).toEqual({
      posts: [{ title: "a" }],
      title: "Home",
    });
    // The left panel (which hosts the data-explorer) re-rendered to reflect the new scope.
    expect(leftRenders).toBe(1);
  });

  test("a STALE-gen dataScope is ignored (scope unchanged, no re-render)", async () => {
    let leftRenders = 0;
    registerRenderer("leftPanel", () => {
      leftRenders += 1;
    });
    await mountReady();
    channels[0]!.deliver({ gen: 4, kind: "renderComplete" });
    activeTab.value!.session.canvas.scope = null;
    leftRenders = 0;

    // Gen 3 != lastRenderedGen (4) → a snapshot from a superseded render must not clobber scope.
    channels[0]!.deliver({
      gen: 3,
      kind: "dataScope",
      scope: { title: "STALE" },
    });

    expect(activeTab.value!.session.canvas.scope).toBeNull();
    expect(leftRenders).toBe(0);
  });
});

// ─── Live expression eval bridge (M6): evalExpr → evalResult over the channel ────

describe("live expression eval bridge (requestCanvasEval)", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  const EXPRS = [{ id: "0", node: { operator: "+", target: 1, value: 1 } }];

  test("posts evalExpr (reqId + rendered gen) and resolves with the iframe's results", async () => {
    await mountReady();
    const tabId = activeTab.value!.id;
    channels[0]!.posts.length = 0;

    const promise = requestCanvasEval(tabId, EXPRS, ["children", 0]);
    const posted = channels[0]!.posts.find((p) => p.kind === "evalExpr") as Msg;
    expect(posted).toMatchObject({
      contextPath: ["children", 0],
      exprs: EXPRS,
      gen: 1,
      kind: "evalExpr",
    });

    channels[0]!.deliver({
      gen: 1,
      kind: "evalResult",
      reqId: posted.reqId,
      results: [{ id: "0", values: [["", "2"]] }],
    });
    expect(await promise).toEqual([{ id: "0", values: [["", "2"]] }]);
  });

  test("a STALE-gen reply resolves null (values from a superseded render never paint)", async () => {
    await mountReady();
    const tabId = activeTab.value!.id;
    const promise = requestCanvasEval(tabId, EXPRS, null);
    const posted = channels[0]!.posts.find((p) => p.kind === "evalExpr") as Msg;

    // A newer render acks before the reply lands — the reply's gen is now stale.
    channels[0]!.deliver({ gen: 2, kind: "renderComplete" });
    channels[0]!.deliver({
      gen: 1,
      kind: "evalResult",
      reqId: posted.reqId,
      results: [{ id: "0", values: [["", "2"]] }],
    });
    expect(await promise).toBeNull();
  });

  test("resolves null when no live host renders the tab's document", async () => {
    // No mount at all → immediate null (the caller falls back to the snapshot synchronously).
    expect(await requestCanvasEval("test-tab", EXPRS, null)).toBeNull();
    // A null tabId (override docs like git-diff) can never be eval-targeted.
    await mountReady();
    expect(await requestCanvasEval(null, EXPRS, null)).toBeNull();
  });

  test("resolves null when no reply lands within the timeout", async () => {
    await mountReady();
    const tabId = activeTab.value!.id;
    const result = await requestCanvasEval(tabId, EXPRS, null, 10);
    expect(result).toBeNull();
    // A late reply after the timeout is dropped without effect (its resolver is gone).
    const posted = channels[0]!.posts.find((p) => p.kind === "evalExpr") as Msg;
    channels[0]!.deliver({
      gen: 1,
      kind: "evalResult",
      reqId: posted.reqId,
      results: [{ id: "0", values: [["", "2"]] }],
    });
  });

  test("an unknown reqId reply is ignored", async () => {
    await mountReady();
    channels[0]!.deliver({ gen: 1, kind: "evalResult", reqId: 999_999, results: [] });
    // Nothing to assert beyond "no throw" — no pending resolver existed.
  });
});

// ─── Cross-frame surgical patch bridge (Phase 3a) ───────────────────────────────

describe("iframe canvas patch bridge", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  const OPS: WireDocOp[] = [
    { key: "textContent", op: "set-key", path: ["children", 0], value: "hi" },
  ];

  test("postPatchToHosts posts the forward ops to every ready host and counts them", async () => {
    await mountReady();
    channels[0]!.posts.length = 0;

    const count = postPatchToHosts(OPS, 7, activeTab.value?.id ?? null);
    expect(count).toBe(1);
    expect(channels[0]!.posts).toContainEqual({ forwardOps: OPS, gen: 7, kind: "patch" });
  });

  test("postPatchToHosts returns 0 when no host is ready, so the caller escalates", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, {} as never, canvasEl);
    // No `ready` delivered → the host can't apply a patch yet.
    expect(postPatchToHosts(OPS, 1, activeTab.value?.id ?? null)).toBe(0);
    expect(channels[0]!.posts.some((p) => p.kind === "patch")).toBe(false);
  });

  test("postPatchToHosts drops a host whose iframe has been disconnected", async () => {
    const canvasEl = await mountReady();
    canvasEl.remove(); // Detach the canvas → the iframe is no longer connected.
    expect(postPatchToHosts(OPS, 1, activeTab.value?.id ?? null)).toBe(0);
  });

  test("patchComplete re-measures the current selection", async () => {
    const tab = resetWorkspaceWithTab();
    await mountReady();
    tab.session.selection = ["children", 0];
    await flush();
    channels[0]!.posts.length = 0;

    channels[0]!.deliver({ gen: 1, kind: "patchComplete" });
    expect(channels[0]!.posts.some((p) => p.kind === "measure")).toBe(true);
  });

  test("patchError escalates to a full render via the injected fallback", async () => {
    let escalated = 0;
    setIframePatchEscalation(() => {
      escalated += 1;
    });
    await mountReady();
    channels[0]!.deliver({ gen: 1, kind: "patchError", message: "nope" });
    expect(escalated).toBe(1);
  });

  test("forwardKey re-dispatches a synthetic keydown on the editor document", async () => {
    await mountReady();
    const seen: KeyboardEvent[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e);
    document.addEventListener("keydown", onKey);
    channels[0]!.deliver({
      event: {
        altKey: false,
        code: "KeyZ",
        ctrlKey: true,
        key: "z",
        metaKey: false,
        shiftKey: false,
      },
      kind: "forwardKey",
    });
    document.removeEventListener("keydown", onKey);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe("z");
    expect(seen[0]!.ctrlKey).toBe(true);
    expect(seen[0]!.code).toBe("KeyZ");
  });
});

// ─── Inline-edit bridge: the iframe runs the session, the parent applies (Phase 4b) ─────

describe("iframe canvas inline-edit bridge", () => {
  const docChildren = () =>
    activeTab.value!.doc.document.children as { tagName?: string; textContent?: string }[];

  beforeEach(() => {
    resetWorkspaceWithTab({ children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" });
  });

  test("editCommit applies the committed content to the live document", async () => {
    await mountReady();
    channels[0]!.deliver({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "Edited",
    });
    expect(docChildren()[0]!.textContent).toBe("Edited");
  });

  test("flushCanvasEdits asks the frame to commit, and resolves on its acknowledgement", async () => {
    // A save must never serialize the document while the words the author just typed are still
    // Sitting in the caret's block waiting for the idle tick.
    await mountReady();
    channels[0]!.posts.length = 0;
    const done = flushCanvasEdits(activeTab.value!.id);

    const req = channels[0]!.posts.find((p) => p.kind === "flushEdits") as
      | { reqId: number }
      | undefined;
    expect(req).toBeDefined();

    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // Still waiting on the frame.

    channels[0]!.deliver({ kind: "flushComplete", reqId: req!.reqId });
    await done;
    expect(settled).toBe(true);
  });

  test("flushCanvasEdits resolves immediately when no frame renders that tab", async () => {
    await mountReady();
    channels[0]!.posts.length = 0;
    await flushCanvasEdits("some-other-tab");
    expect(channels[0]!.posts.some((p) => p.kind === "flushEdits")).toBe(false);
  });

  test("flushCanvasEdits gives up after its timeout rather than hanging the save", async () => {
    // A wedged frame must not be able to block saving.
    await mountReady();
    await flushCanvasEdits(activeTab.value!.id, 10);
  });

  test("a stale flushComplete is ignored", async () => {
    await mountReady();
    channels[0]!.deliver({ kind: "flushComplete", reqId: 999_999 });
    // No throw, no state change — the reqId map simply has no entry.
    expect(true).toBe(true);
  });

  test("editSplit applies and re-enters on the new paragraph once the DOM acks", async () => {
    await mountReady();
    channels[0]!.posts.length = 0;
    channels[0]!.deliver({
      after: { textContent: "lo" },
      before: { textContent: "Hi" },
      kind: "editSplit",
      path: ["children", 0],
    });
    expect(docChildren()).toHaveLength(2);
    expect(docChildren()[1]).toMatchObject({ tagName: "p", textContent: "lo" });
    // Re-entry is DEFERRED until the iframe acks the DOM that contains the new paragraph — an
    // Immediate enterEdit would race an escalated async full render.
    expect(channels[0]!.posts.some((p) => p.kind === "enterEdit")).toBe(false);
    channels[0]!.deliver({ gen: 1, kind: "patchComplete" });
    expect(channels[0]!.posts).toContainEqual({ kind: "enterEdit", path: ["children", 1] });
  });

  test("editSplit re-entry flushes on an ESCALATED renderComplete at a bumped gen", async () => {
    await mountReady();
    channels[0]!.posts.length = 0;
    channels[0]!.deliver({
      after: { textContent: "lo" },
      before: { textContent: "Hi" },
      kind: "editSplit",
      path: ["children", 0],
    });
    // A patchError must NOT flush (the escalation's render is still coming)…
    channels[0]!.deliver({ gen: 1, kind: "patchError", message: "x" });
    expect(channels[0]!.posts.some((p) => p.kind === "enterEdit")).toBe(false);
    // …the escalated full render (bumped gen) does.
    channels[0]!.deliver({ gen: 2, kind: "renderComplete" });
    expect(channels[0]!.posts).toContainEqual({ kind: "enterEdit", path: ["children", 1] });
  });

  test("editSplit re-entry is suppressed when the host's tab is no longer active", async () => {
    const { openTab } = await import("../src/workspace/workspace");
    await mountReady();
    channels[0]!.deliver({
      after: { textContent: "lo" },
      before: { textContent: "Hi" },
      kind: "editSplit",
      path: ["children", 0],
    });
    // The split landed in the originating tab, but the user has since switched tabs — re-entering
    // Would target a different document's DOM.
    openTab({ document: { tagName: "div" }, id: "other-tab" });
    channels[0]!.posts.length = 0;
    channels[0]!.deliver({ gen: 1, kind: "patchComplete" });
    expect(channels[0]!.posts.some((p) => p.kind === "enterEdit")).toBe(false);
  });

  test("editInsert applies and re-enters on the resulting path once the DOM acks", async () => {
    await mountReady();
    channels[0]!.posts.length = 0;
    channels[0]!.deliver({
      cmd: { tag: "h2" },
      commitData: { textContent: "Hi" },
      kind: "editInsert",
      path: ["children", 0],
    });
    expect(docChildren()[1]!.tagName).toBe("h2");
    channels[0]!.deliver({ gen: 1, kind: "patchComplete" });
    expect(channels[0]!.posts).toContainEqual({ kind: "enterEdit", path: ["children", 1] });
  });

  test("a preview-mode mount clears a pending re-entry", async () => {
    await mountReady();
    const canvasEl = document.body.querySelector("div")!;
    channels[0]!.deliver({
      after: { textContent: "lo" },
      before: { textContent: "Hi" },
      kind: "editSplit",
      path: ["children", 0],
    });
    (resolved.mapperCtx as { canvasMode: string }).canvasMode = "preview";
    await mountIframeCanvas(2, {} as never, canvasEl, null, activeTab.value?.id ?? null);
    channels[0]!.posts.length = 0;
    channels[0]!.deliver({ gen: 2, kind: "renderComplete" });
    expect(channels[0]!.posts.some((p) => p.kind === "enterEdit")).toBe(false);
  });

  test("editCommit routes to the ORIGINATING tab when it races a tab switch (the bleed)", async () => {
    const { openTab, workspace } = await import("../src/workspace/workspace");
    const tabA = activeTab.value!;
    await mountReady();
    // The user switches to tab B; the host is re-mounted for B but the iframe has NOT acked yet —
    // Its DOM (and any live edit session) still belongs to tab A.
    const tabB = openTab({
      document: { children: [{ tagName: "p", textContent: "B text" }], tagName: "div" },
      id: "tab-b",
    });
    const canvasEl = document.body.querySelector("div")!;
    await mountIframeCanvas(2, {} as never, canvasEl, null, tabB.id);
    // The in-flight commit from tab A's session drains BEFORE renderComplete(2) on the FIFO.
    channels[0]!.deliver({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "A text edited",
    });
    // Tab A got the edit; tab B is untouched.
    expect((tabA.doc.document.children as { textContent?: string }[])[0]!.textContent).toBe(
      "A text edited",
    );
    expect((tabB.doc.document.children as { textContent?: string }[])[0]!.textContent).toBe(
      "B text",
    );
    // After the ack flips the identity, commits route to tab B.
    channels[0]!.deliver({ gen: 2, kind: "renderComplete" });
    channels[0]!.deliver({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "B text edited",
    });
    expect((tabB.doc.document.children as { textContent?: string }[])[0]!.textContent).toBe(
      "B text edited",
    );
    expect(workspace.activeTabId).toBe("tab-b");
  });

  test("editCommit is dropped when the originating tab has been closed", async () => {
    const { closeAllTabs, openTab } = await import("../src/workspace/workspace");
    await mountReady();
    closeAllTabs();
    const fresh = openTab({
      document: { children: [{ tagName: "p", textContent: "fresh" }], tagName: "div" },
      id: "fresh-tab",
    });
    // The host still carries the CLOSED tab's identity — the late commit must go nowhere.
    channels[0]!.deliver({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "ghost",
    });
    expect((fresh.doc.document.children as { textContent?: string }[])[0]!.textContent).toBe(
      "fresh",
    );
  });

  test("editCommitProp persists into the instance's $props on the live document", async () => {
    resetWorkspaceWithTab({
      children: [{ $props: { title: "Local" }, tagName: "x-card" }],
      tagName: "div",
    });
    await mountReady();
    channels[0]!.deliver({
      kind: "editCommitProp",
      path: ["children", 0],
      prop: "title",
      value: "Regional",
    });
    const card = (activeTab.value!.doc.document.children as { $props?: { title?: string } }[])[0]!;
    expect(card.$props?.title).toBe("Regional");
  });

  test("editCommitProp routes to the ORIGINATING tab when it races a tab switch", async () => {
    const { openTab } = await import("../src/workspace/workspace");
    resetWorkspaceWithTab({
      children: [{ $props: { title: "A title" }, tagName: "x-card" }],
      tagName: "div",
    });
    const tabA = activeTab.value!;
    await mountReady();
    // Switch to tab B; the host re-mounts for B but the iframe has NOT acked — the in-flight
    // Prop commit still belongs to tab A's session (FIFO drains it before renderComplete(2)).
    const tabB = openTab({
      document: { children: [{ $props: { title: "B title" }, tagName: "x-card" }], tagName: "div" },
      id: "tab-b-prop",
    });
    const canvasEl = document.body.querySelector("div")!;
    await mountIframeCanvas(2, {} as never, canvasEl, null, tabB.id);
    channels[0]!.deliver({
      kind: "editCommitProp",
      path: ["children", 0],
      prop: "title",
      value: "A edited",
    });
    const propOf = (t: typeof tabA) =>
      (t.doc.document.children as { $props?: { title?: string } }[])[0]!.$props?.title;
    expect(propOf(tabA)).toBe("A edited");
    expect(propOf(tabB)).toBe("B title");
  });

  test("editStart carries the prop into getEditSnapshot; editEnd clears it", async () => {
    await mountReady();
    channels[0]!.deliver({ kind: "editStart", path: ["children", 0], prop: "title" });
    expect(getEditSnapshot()).toMatchObject({ editing: true, editingProp: "title" });
    channels[0]!.deliver({ kind: "editEnd" });
    expect(getEditSnapshot()).toMatchObject({ editing: false, editingProp: null });
  });
});

// ─── Format-toolbar bridge: editing state + snapshot + applyFormat (Phase 4b-2) ──

describe("iframe canvas format-toolbar bridge", () => {
  let refreshCount = 0;

  beforeEach(() => {
    resetWorkspaceWithTab();
    refreshCount = 0;
    setToolbarRefresh(() => {
      refreshCount += 1;
    });
  });

  /** End any active edit session so module-global `activeEditHost` starts clean per test. */
  function endActiveSession() {
    const host = getActiveEditHost();
    if (host) {
      // Find this host's channel and deliver an editEnd through it.
      for (const ch of channels) {
        ch.deliver({ kind: "editEnd" });
      }
    }
  }

  test("editStart sets editing, makes the active host, and calls the refresh spy", async () => {
    await mountReady();
    expect(getEditSnapshot().editing).toBe(false);

    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    expect(getEditSnapshot().editing).toBe(true);
    expect(getActiveEditHost()).not.toBeNull();
    expect(refreshCount).toBeGreaterThan(0);
    endActiveSession();
  });

  test("selectionChanged stores the snapshot and drops a stale (<= seq) one", async () => {
    await mountReady();
    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });

    channels[0]!.deliver({
      activeTags: ["strong"],
      collapsed: false,
      kind: "selectionChanged",
      link: { active: false, href: null },
      localScope: null,
      path: ["children", 0],
      rect: { height: 10, width: 20, x: 1, y: 2 },
      seq: 2,
    });
    expect(getEditSnapshot().snapshot?.activeTags).toEqual(["strong"]);

    // A stale (lower seq) snapshot is ignored.
    channels[0]!.deliver({
      activeTags: ["em"],
      collapsed: false,
      kind: "selectionChanged",
      link: { active: false, href: null },
      localScope: null,
      path: ["children", 0],
      rect: null,
      seq: 1,
    });
    expect(getEditSnapshot().snapshot?.activeTags).toEqual(["strong"]);
    endActiveSession();
  });

  test("editEnd clears editing and the active host; a superseded editEnd is ignored", async () => {
    await mountReady();
    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    expect(getEditSnapshot().editing).toBe(true);

    channels[0]!.deliver({ kind: "editEnd" });
    expect(getEditSnapshot().editing).toBe(false);
    expect(getActiveEditHost()).toBeNull();

    // A second (superseded) editEnd is a no-op (does not throw, stays cleared).
    refreshCount = 0;
    channels[0]!.deliver({ kind: "editEnd" });
    expect(refreshCount).toBe(0);
  });

  test("postApplyFormat posts an applyFormat intent to the active edit host", async () => {
    await mountReady();
    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    channels[0]!.posts.length = 0;

    postApplyFormat({ command: "bold" });
    expect(channels[0]!.posts).toContainEqual({ intent: { command: "bold" }, kind: "applyFormat" });
    endActiveSession();
  });

  test("postApplyFormat is a no-op when no session is active", async () => {
    await mountReady();
    channels[0]!.posts.length = 0;
    postApplyFormat({ command: "bold" });
    expect(channels[0]!.posts.some((p) => p.kind === "applyFormat")).toBe(false);
  });

  test("getEditBarAnchorRect adds the iframe viewport offset to the snapshot rect", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    stubRect(iframe, { height: 480, left: 100, top: 50, width: 800 });

    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    channels[0]!.deliver({
      activeTags: [],
      collapsed: false,
      kind: "selectionChanged",
      link: { active: false, href: null },
      localScope: null,
      path: ["children", 0],
      rect: { height: 12, width: 30, x: 7, y: 8 },
      seq: 1,
    });

    expect(getEditBarAnchorRect()).toEqual({ height: 12, left: 107, top: 58, width: 30 });
    endActiveSession();
  });

  test("getEditBarAnchorRect returns null with no active edit host", async () => {
    await mountReady();
    expect(getEditBarAnchorRect()).toBeNull();
  });

  test("getEditBarAnchorRect falls back to the last selection rect + iframe offset", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    stubRect(iframe, { height: 480, left: 200, top: 60, width: 800 });

    // A hit stores lastSelectionRect (overlay-local) on the host.
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 14, width: 40, x: 5, y: 9 } },
      kind: "hit",
    });
    // Editing with a snapshot that has a NULL rect → anchor falls back to lastSelectionRect.
    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    channels[0]!.deliver({
      activeTags: [],
      collapsed: true,
      kind: "selectionChanged",
      link: { active: false, href: null },
      localScope: null,
      path: ["children", 0],
      rect: null,
      seq: 1,
    });

    expect(getEditBarAnchorRect()).toEqual({ height: 14, left: 205, top: 69, width: 40 });
    endActiveSession();
  });

  test("getEditBarAnchorRect positions from the active panel's selection rect when NOT editing", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    stubRect(iframe, { height: 480, left: 200, top: 60, width: 800 });
    // The structural bar (badge/move/convert) must position on a plain selection with no edit
    // Session: register the panel so the host resolves via getActivePanel, deliver a hit (no
    // EditStart), and confirm the anchor comes from the host's lastSelectionRect + iframe offset.
    canvasPanels.push({ canvas: canvasEl, mediaName: "base" } as unknown as CanvasPanel);
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 14, width: 40, x: 5, y: 9 } },
      kind: "hit",
    });

    expect(getActiveEditHost()).toBeNull();
    expect(getEditBarAnchorRect()).toEqual({ height: 14, left: 205, top: 69, width: 40 });
    canvasPanels.length = 0;
  });

  test("multi-panel: editStart on host B (not the active-media A) reflects B everywhere", async () => {
    const canvasA = await mountReady();
    const chA = channels[0]!;
    const canvasB = document.createElement("div");
    document.body.append(canvasB);
    await mountIframeCanvas(1, {} as never, canvasB);
    const chB = channels[1]!;
    chB.deliver({ kind: "ready" });

    // A starts editing, then B takes over.
    chA.deliver({ kind: "editStart", path: ["children", 0] });
    chB.deliver({ kind: "editStart", path: ["children", 1] });

    expect(getEditSnapshot().editing).toBe(true);

    chB.posts.length = 0;
    postApplyFormat({ command: "italic" });
    // The intent goes to B (the active edit host), not A.
    expect(chB.posts).toContainEqual({ intent: { command: "italic" }, kind: "applyFormat" });
    expect(chA.posts.some((p) => p.kind === "applyFormat")).toBe(false);

    canvasA.remove();
    canvasB.remove();
    endActiveSession();
  });
});

describe("cross-frame drag session (Phase 4c)", () => {
  beforeEach(() => {
    resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "a" }],
      tagName: "div",
    });
  });

  /** Mount + ready a host and record the render gen via renderComplete. */
  async function readyHostAt(gen: number): Promise<{ canvasEl: HTMLElement; host: AnyHost }> {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ gen, kind: "renderComplete" });
    const host = hostForCanvas(canvasEl) as unknown as AnyHost;
    return { canvasEl, host };
  }

  test("beginDragSession bumps the seq, retains data, and posts dragStart with the host gen", async () => {
    const { host } = await readyHostAt(4);
    channels[0]!.posts.length = 0;
    const seq = beginDragSession(
      host,
      { type: "block" },
      { fragment: { tagName: "hr" }, type: "block" },
    );
    expect(seq).toBe(currentDragSession());
    expect(channels[0]!.posts).toContainEqual({
      dragSeq: seq,
      gen: 4,
      kind: "dragStart",
      src: { type: "block" },
    });
    endDragSession(seq);
  });

  test("posts a structured-cloneable dragStart even when src.path is a reactive proxy", async () => {
    // The ⠿ handle fed the LIVE selection (a Vue reactive proxy array) into the drag source; the
    // Real postMessage structured-clones the message and threw DataCloneError, killing the whole
    // Handle drag before the iframe ever saw a dragStart. Test channels pass by reference, so
    // Assert cloneability explicitly at the wire.
    const { host } = await readyHostAt(4);
    channels[0]!.posts.length = 0;
    const proxyPath = reactive(["children", 2]) as unknown as (string | number)[];
    const seq = beginDragSession(
      host,
      { path: proxyPath, type: "tree-node" },
      { path: proxyPath, type: "tree-node" },
    );
    const msg = channels[0]!.posts.find((p) => (p as { kind?: string }).kind === "dragStart") as {
      src: { path: (string | number)[] };
    };
    // The wire src survives the same clone the real channel performs, and carries the plain path.
    expect(() => structuredClone(msg)).not.toThrow();
    expect(msg.src.path).toEqual(["children", 2]);
    endDragSession(seq);
  });

  test("dropResult applies the drop through applyDropInstruction with the retained source data", async () => {
    const { host } = await readyHostAt(4);
    const seq = beginDragSession(
      host,
      { type: "block" },
      { fragment: { tagName: "hr" }, type: "block" },
    );
    // Fresh, non-stale dropResult: reorder-below child 0 → insert at index 1.
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 4,
      instruction: "reorder-below",
      kind: "dropResult",
      targetPath: ["children", 0],
    });
    const doc = activeTab.value!.doc.document;
    const kids = doc.children as { tagName: string }[];
    expect(kids.length).toBe(2);
    expect(kids[1]!.tagName).toBe("hr");
  });

  test("dropResult with a stale dragSeq is dropped (no mutation)", async () => {
    const { host } = await readyHostAt(4);
    const seq = beginDragSession(
      host,
      { type: "block" },
      { fragment: { tagName: "hr" }, type: "block" },
    );
    channels[0]!.deliver({
      dragSeq: seq + 99,
      gen: 4,
      instruction: "reorder-below",
      kind: "dropResult",
      targetPath: ["children", 0],
    });
    expect((activeTab.value!.doc.document.children as unknown[]).length).toBe(1);
    endDragSession(seq);
  });

  test("dropResult with a stale gen is dropped (no mutation)", async () => {
    const { host } = await readyHostAt(4);
    const seq = beginDragSession(
      host,
      { type: "block" },
      { fragment: { tagName: "hr" }, type: "block" },
    );
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 3, // != host.lastRenderedGen (4)
      instruction: "reorder-below",
      kind: "dropResult",
      targetPath: ["children", 0],
    });
    expect((activeTab.value!.doc.document.children as unknown[]).length).toBe(1);
    endDragSession(seq);
  });

  test("a null-instruction dropResult is a no-op and releases the retained data", async () => {
    const { host } = await readyHostAt(4);
    const seq = beginDragSession(
      host,
      { type: "block" },
      { fragment: { tagName: "hr" }, type: "block" },
    );
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 4,
      instruction: null,
      kind: "dropResult",
      targetPath: null,
    });
    expect((activeTab.value!.doc.document.children as unknown[]).length).toBe(1);
  });

  test("dragOver (matching seq+gen) is accepted; a stale one is ignored — neither throws", async () => {
    const { host } = await readyHostAt(4);
    const seq = beginDragSession(
      host,
      { type: "block" },
      { fragment: { tagName: "hr" }, type: "block" },
    );
    // No assertion on drawing this slice; just exercise both stale-gates without throwing.
    channels[0]!.deliver({ dragSeq: seq, gen: 4, kind: "dragOver", preview: null });
    channels[0]!.deliver({ dragSeq: seq, gen: 3, kind: "dragOver", preview: null });
    channels[0]!.deliver({ dragSeq: seq + 1, gen: 4, kind: "dragOver", preview: null });
    expect((activeTab.value!.doc.document.children as unknown[]).length).toBe(1);
    endDragSession(seq);
  });

  test("liveDragHostAt resolves the host whose iframe rect contains the cursor", async () => {
    const { canvasEl, host } = await readyHostAt(1);
    const iframe = canvasEl.querySelector("iframe")!;
    stubRect(iframe, { height: 100, left: 200, top: 50, width: 300 });
    expect(liveDragHostAt({ x: 250, y: 80 })).toBe(host as never);
    expect(liveDragHostAt({ x: 10, y: 10 })).toBeNull();
  });

  test("hostDragGeometry derives the EMPIRICAL scale from rect.width / iframe.clientWidth", async () => {
    const { canvasEl } = await readyHostAt(1);
    const iframe = canvasEl.querySelector("iframe")! as HTMLIFrameElement;
    stubRect(iframe, { height: 240, left: 10, top: 20, width: 600 });
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 300 });
    const host = hostForCanvas(canvasEl) as unknown as AnyHost;
    const geo = hostDragGeometry(host);
    expect(geo.scale).toBe(2); // 600 / 300
    expect(geo.rect.left).toBe(10);
    expect(geo.rect.top).toBe(20);
  });

  test("postDragMessage forwards to the host channel", async () => {
    const { host } = await readyHostAt(1);
    channels[0]!.posts.length = 0;
    postDragMessage(host, { cursor: { x: 1, y: 2 }, dragSeq: 1, kind: "dragMove" });
    expect(channels[0]!.posts).toContainEqual({
      cursor: { x: 1, y: 2 },
      dragSeq: 1,
      kind: "dragMove",
    });
  });

  /** The host's overlay drop-indicator box (Phase 4c). */
  const indicator = (canvasEl: HTMLElement) =>
    canvasEl.querySelector(".canvas-drop-indicator") as HTMLElement;

  test("dragOver with a preview draws the indicator at scale=1 (no double-scale)", async () => {
    const { canvasEl, host } = await readyHostAt(4);
    const seq = beginDragSession(host, { type: "block" }, { fragment: {}, type: "block" });
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 4,
      kind: "dragOver",
      preview: {
        edge: "top",
        instruction: "reorder-above",
        referenceRect: { height: 30, width: 120, x: 10, y: 40 },
        targetPath: ["children", 0],
      },
    });
    const box = indicator(canvasEl);
    expect(box.style.display).toBe("block");
    // The canvasRectToParent scale=1 map is straight through (D-2): top is the rect y, not y*zoom.
    expect(box.style.top).toBe("40px");
    expect(box.style.left).toBe("10px");
    expect(box.className).toContain("line");
    endDragSession(seq);
  });

  test("dragOver with a null preview hides the indicator", async () => {
    const { canvasEl, host } = await readyHostAt(4);
    const seq = beginDragSession(host, { type: "block" }, { fragment: {}, type: "block" });
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 4,
      kind: "dragOver",
      preview: {
        edge: "inside",
        instruction: "make-child",
        referenceRect: { height: 30, width: 120, x: 10, y: 40 },
        targetPath: ["children", 0],
      },
    });
    channels[0]!.deliver({ dragSeq: seq, gen: 4, kind: "dragOver", preview: null });
    expect(indicator(canvasEl).style.display).toBe("none");
    endDragSession(seq);
  });

  test("dropResult clears the indicator after applying", async () => {
    const { canvasEl, host } = await readyHostAt(4);
    const seq = beginDragSession(
      host,
      { type: "block" },
      { fragment: { tagName: "hr" }, type: "block" },
    );
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 4,
      kind: "dragOver",
      preview: {
        edge: "top",
        instruction: "reorder-above",
        referenceRect: { height: 30, width: 120, x: 10, y: 40 },
        targetPath: ["children", 0],
      },
    });
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 4,
      instruction: "reorder-below",
      kind: "dropResult",
      targetPath: ["children", 0],
    });
    expect(indicator(canvasEl).style.display).toBe("none");
  });

  test("dragEnd (iframe-originated cancel) clears the indicator + releases the retained data", async () => {
    const { canvasEl, host } = await readyHostAt(4);
    const seq = beginDragSession(
      host,
      { path: ["children", 0], type: "tree-node" },
      { path: ["children", 0], type: "tree-node" },
    );
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 4,
      kind: "dragOver",
      preview: {
        edge: "inside",
        instruction: "make-child",
        referenceRect: { height: 30, width: 120, x: 10, y: 40 },
        targetPath: ["children", 0],
      },
    });
    channels[0]!.deliver({ dragSeq: seq, kind: "dragEnd" });
    expect(indicator(canvasEl).style.display).toBe("none");
    // The retained data was released — a late non-stale dropResult applies nothing.
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 4,
      instruction: "reorder-below",
      kind: "dropResult",
      targetPath: ["children", 0],
    });
    expect((activeTab.value!.doc.document.children as unknown[]).length).toBe(1);
  });

  test("adoptDragSession sets the seq + retains data so a matching dropResult applies", async () => {
    const { host } = await readyHostAt(4);
    // Adopt an iframe-driven session at seq 77 (no dragStart posted), then a matching dropResult.
    // Use a block fragment so the drop INSERTS (a tree-node move of a node below itself is a no-op).
    const seq = adoptDragSession(
      host,
      { type: "block" },
      { fragment: { tagName: "hr" }, type: "block" },
      77,
    );
    expect(seq).toBe(77);
    expect(currentDragSession()).toBe(77);
    channels[0]!.deliver({
      dragSeq: 77,
      gen: 4,
      instruction: "reorder-below",
      kind: "dropResult",
      targetPath: ["children", 0],
    });
    // The retained (adopted) source data drove the insert — the dropResult applied.
    expect((activeTab.value!.doc.document.children as unknown[]).length).toBe(2);
  });

  test("flow-3 dragOver WITH a cursor moves the ghost to the forward-converted position", async () => {
    const { canvasEl, host } = await readyHostAt(4);
    const iframe = canvasEl.querySelector("iframe")! as HTMLIFrameElement;
    // Scale = rect.width / clientWidth = 600 / 300 = 2; rect left/top = 10/20.
    stubRect(iframe, { height: 240, left: 10, top: 20, width: 600 });
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 300 });

    const seq = adoptDragSession(
      host,
      { path: ["children", 0], type: "tree-node" },
      { path: ["children", 0], type: "tree-node" },
      88,
    );
    // Show the ghost so moveDragGhost (no-op while hidden) actually positions it.
    setDragGhost("p", 0, 0);
    channels[0]!.deliver({
      cursor: { x: 100, y: 50 },
      dragSeq: seq,
      gen: 4,
      kind: "dragOver",
      preview: null,
    });
    const ghost = document.querySelector(".jx-drag-ghost") as HTMLElement;
    // Forward-convert iframe→parent: x*scale+left = 100*2+10 = 210; y*scale+top = 50*2+20 = 120.
    expect(ghost.style.left).toBe("210px");
    expect(ghost.style.top).toBe("120px");
    clearDragGhost();
    endDragSession(seq);
  });

  test("sawIframeDragOver: only a cursor-carrying dragOver marks the session iframe-driven", async () => {
    const { host } = await readyHostAt(4);
    const seq = beginDragSession(host, { type: "block" }, { fragment: {}, type: "block" });
    // A cursor-less dragOver is a reply to a parent-forwarded dragMove — not iframe-driven.
    channels[0]!.deliver({ dragSeq: seq, gen: 4, kind: "dragOver", preview: null });
    expect(sawIframeDragOver(seq)).toBe(false);
    // A cursor-carrying one means the iframe drives the stream from its own native events.
    channels[0]!.deliver({
      cursor: { x: 5, y: 5 },
      dragSeq: seq,
      gen: 4,
      kind: "dragOver",
      preview: null,
    });
    expect(sawIframeDragOver(seq)).toBe(true);
    expect(sawIframeDragOver(seq + 1)).toBe(false);
    endDragSession(seq);
  });

  test("nativeDragEnter routes to the installed coordinator handler with the host", async () => {
    const { host } = await readyHostAt(4);
    const seen: unknown[] = [];
    setNativeDragEnterHandler((h) => seen.push(h));
    channels[0]!.deliver({ kind: "nativeDragEnter" });
    expect(seen).toEqual([host as never]);
    setNativeDragEnterHandler(() => {});
  });

  test("clearDropIndicator hides the host's indicator", async () => {
    const { canvasEl, host } = await readyHostAt(4);
    const seq = beginDragSession(host, { type: "block" }, { fragment: {}, type: "block" });
    channels[0]!.deliver({
      dragSeq: seq,
      gen: 4,
      kind: "dragOver",
      preview: {
        edge: "inside",
        instruction: "make-child",
        referenceRect: { height: 30, width: 120, x: 10, y: 40 },
        targetPath: ["children", 0],
      },
    });
    clearDropIndicator(host);
    expect(indicator(canvasEl).style.display).toBe("none");
    endDragSession(seq);
  });
});

// ─── Cross-origin insertion "+" affordance ──────────────────────────────────────

describe("iframe canvas insertion '+' affordance", () => {
  beforeEach(() => {
    resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "a" }],
      tagName: "div",
    });
    // Reset the injected handler so a leak from one test never fires in another.
    setInsertZoneClickHandler(() => {});
  });

  /** The host's overlay insertion "+" button. */
  const plus = (canvasEl: HTMLElement) =>
    canvasEl.querySelector(".insertion-helper") as HTMLButtonElement;

  const topZone = {
    edge: "top" as const,
    index: 1,
    insertParentPath: ["children", 0] as (string | number)[],
    rect: { height: 0, width: 300, x: 10, y: 200 },
  };

  test("an insertZones post draws the '+' at scale=1, centered on the anchor box", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ kind: "insertZones", zones: [topZone] });
    const btn = plus(canvasEl);
    expect(btn.style.display).toBe("grid");
    expect(btn.classList.contains("visible")).toBe(true);
    expect(btn.dataset.edge).toBe("top");
    // CanvasRectToParent at scale=1 is straight-through (D-2); center = x + width/2 = 10 + 150 = 160.
    expect(btn.style.left).toBe("160px");
    expect(btn.style.top).toBe("200px");
  });

  test("a null/empty zones post keeps the '+' (grace timer) rather than hiding immediately", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ kind: "insertZones", zones: [topZone] });
    expect(plus(canvasEl).style.display).toBe("grid");
    // The cursor crossed mid-element on its way to the button — the "+" must NOT vanish at once.
    channels[0]!.deliver({ kind: "insertZones", zones: null });
    expect(plus(canvasEl).style.display).toBe("grid");
  });

  test("clicking the '+' runs the injected handler with the button + captured zone", async () => {
    const canvasEl = await mountReady();
    const seen: { btn: HTMLElement; zone: unknown }[] = [];
    setInsertZoneClickHandler((btn, zone) => seen.push({ btn, zone }));
    channels[0]!.deliver({ kind: "insertZones", zones: [topZone] });

    plus(canvasEl).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.btn).toBe(plus(canvasEl));
    expect(seen[0]!.zone).toEqual(topZone);
  });

  test("clicking the '+' with no captured zone is a no-op (does not call the handler)", async () => {
    const canvasEl = await mountReady();
    let calls = 0;
    setInsertZoneClickHandler(() => {
      calls += 1;
    });
    // No insertZones delivered → insertZone is null → click bails before the handler.
    plus(canvasEl).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toBe(0);
  });

  test("renderComplete clears the '+' (its anchored rect/path is now stale)", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ kind: "insertZones", zones: [topZone] });
    expect(plus(canvasEl).style.display).toBe("grid");
    channels[0]!.deliver({ gen: 1, kind: "renderComplete" });
    expect(plus(canvasEl).style.display).toBe("none");
  });

  test("patchComplete also clears the '+'", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ kind: "insertZones", zones: [topZone] });
    channels[0]!.deliver({ gen: 1, kind: "patchComplete" });
    expect(plus(canvasEl).style.display).toBe("none");
  });

  /** Wait past the grace timer (plus slack) so a pending hide has definitely run — or been skipped. */
  const pastGrace = () =>
    new Promise((resolve) => {
      setTimeout(resolve, INSERT_HIDE_DELAY + 80);
    });

  test("a null zones post while the cursor sits ON the '+' never hides it", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ kind: "insertZones", zones: [topZone] });
    const btn = plus(canvasEl);

    // Real ordering (verified in Chrome): the cursor reaching the button fires its mouseenter
    // Synchronously, and only THEN does the iframe's leave-driven `null` arrive over the async
    // Bridge — so a cancel-on-mouseenter alone gets re-armed and yanks the "+" mid-click.
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    channels[0]!.deliver({ kind: "insertZones", zones: null });
    await pastGrace();

    expect(btn.style.display).toBe("grid");
    expect(btn.classList.contains("visible")).toBe(true);
  });

  test("the '+' still hides once the cursor moves off it", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ kind: "insertZones", zones: [topZone] });
    const btn = plus(canvasEl);
    btn.dispatchEvent(new MouseEvent("mouseenter"));
    channels[0]!.deliver({ kind: "insertZones", zones: null });

    btn.dispatchEvent(new MouseEvent("mouseleave"));
    await pastGrace();
    expect(btn.style.display).toBe("none");
    expect(btn.classList.contains("visible")).toBe(false);
  });

  test("a null zones post with the cursor elsewhere hides the '+' after the grace delay", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ kind: "insertZones", zones: [topZone] });
    channels[0]!.deliver({ kind: "insertZones", zones: null });
    expect(plus(canvasEl).style.display).toBe("grid");
    await pastGrace();
    expect(plus(canvasEl).style.display).toBe("none");
  });

  test("a fresh insertZones post after a clear re-shows the '+' (cancels any pending hide)", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ kind: "insertZones", zones: [topZone] });
    channels[0]!.deliver({ kind: "insertZones", zones: null }); // Arms the grace timer.
    // A new zone immediately re-shows and cancels the pending hide.
    channels[0]!.deliver({
      kind: "insertZones",
      zones: [{ ...topZone, edge: "bottom", index: 2 }],
    });
    const btn = plus(canvasEl);
    expect(btn.style.display).toBe("grid");
    expect(btn.dataset.edge).toBe("bottom");
  });
});

// ─── Host viewport plumbing: contentHeight + forwardWheel + catcher neutralize ──

describe("iframe canvas host viewport plumbing", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  test("contentHeight sizes the host iframe element to the document height; a page keeps the 480px floor", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    channels[0]!.deliver({ fragment: false, height: 1234, kind: "contentHeight" });
    expect(iframe.style.height).toBe("1234px");
    // A page keeps the pre-measurement floor (empty/short pages stay a usable canvas).
    expect(iframe.style.minHeight).toBe("480px");
  });

  test("contentHeight drops the 480px floor for a component definition (fragment) so it hugs content", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    // The iframe mounts with the pre-measurement floor in its cssText.
    expect(iframe.style.minHeight).toBe("480px");
    channels[0]!.deliver({ fragment: true, height: 300, kind: "contentHeight" });
    expect(iframe.style.height).toBe("300px");
    expect(iframe.style.minHeight).toBe("0px");
  });

  test("contentHeight pins the viewport to the SCALED height under edit-mode content zoom", async () => {
    const canvasEl = await mountReady();
    const viewport = canvasEl.parentElement!;
    const iframe = canvasEl.querySelector("iframe")!;
    // The counter-scale applyEditZoom writes on the canvas element; the resolved iframe height is
    // Read back via offsetHeight (happy-dom performs no layout, so define it).
    canvasEl.style.transform = "scale(2)";
    Object.defineProperty(iframe, "offsetHeight", { configurable: true, value: 900 });

    channels[0]!.deliver({ fragment: false, height: 900, kind: "contentHeight" });
    expect(viewport.style.height).toBe("1800px");

    // Back at scale 1 (or design mode, where the transform lives on an ancestor instead) the
    // Viewport returns to auto height.
    canvasEl.style.transform = "";
    channels[0]!.deliver({ fragment: false, height: 900, kind: "contentHeight" });
    expect(viewport.style.height).toBe("");
  });

  test("forwardWheel re-dispatches a wheel on canvasWrap with the deltas and mapped cursor", async () => {
    // RedispatchWheel reads { rect, scale } = hostDragGeometry(state): scale = rect.width /
    // Iframe.clientWidth = 600 / 300 = 2, and rect left/top = 10/20. So clientX = left + x*scale =
    // 10 + 100*2 = 210 and clientY = top + y*scale = 20 + 50*2 = 120 (happy-dom drops the MouseEvent
    // Mixin props on a WheelEvent, so only the deltas/type/target are asserted off the live event).
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")! as HTMLIFrameElement;
    stubRect(iframe, { height: 240, left: 10, top: 20, width: 600 });
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 300 });

    // CanvasWrap is the live binding initShellRefs() populates from #canvas-wrap; the host dispatches
    // The synthetic wheel on it so the editor's zoom/pan handler fires.
    const wrap = document.createElement("div");
    wrap.id = "canvas-wrap";
    document.body.append(wrap);
    initShellRefs();
    expect(canvasWrap).toBe(wrap);

    const seen: WheelEvent[] = [];
    const onWheel = (event: Event) => seen.push(event as WheelEvent);
    canvasWrap.addEventListener("wheel", onWheel);
    channels[0]!.deliver({
      ctrlKey: true,
      deltaX: 4,
      deltaY: 7,
      kind: "forwardWheel",
      metaKey: false,
      shiftKey: false,
      x: 100,
      y: 50,
    });
    canvasWrap.removeEventListener("wheel", onWheel);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe("wheel");
    expect(seen[0]!.deltaX).toBe(4);
    expect(seen[0]!.deltaY).toBe(7);
  });
});

/** Opaque host handle for the drag-session API tests (its internals aren't asserted directly). */
type AnyHost = Parameters<typeof beginDragSession>[0];

// ─── Zoom-aware anchor math (D-2 empirical scale on the fixed-position toolbar) ──

describe("getEditBarAnchorRect zoom scaling", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  test("scales the snapshot rect by the empirical zoom before adding the iframe offset", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    // Empirical scale: rect.width / clientWidth = 600 / 300 → 2 (design mode zoomed to 200%).
    stubRect(iframe, { height: 480, left: 100, top: 50, width: 600 });
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 300 });

    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    channels[0]!.deliver({
      activeTags: [],
      collapsed: false,
      kind: "selectionChanged",
      link: { active: false, href: null },
      localScope: null,
      path: ["children", 0],
      rect: { height: 12, width: 30, x: 7, y: 8 },
      seq: 1,
    });

    expect(getEditBarAnchorRect()).toEqual({ height: 24, left: 114, top: 66, width: 60 });
    channels[0]!.deliver({ kind: "editEnd" });
  });

  test("scales the lastSelectionRect fallback the same way (plain selection, no session)", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    stubRect(iframe, { height: 480, left: 100, top: 50, width: 600 });
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 300 });
    canvasPanels.push({ canvas: canvasEl, mediaName: "base" } as unknown as CanvasPanel);

    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 14, width: 40, x: 5, y: 9 } },
      kind: "hit",
    });

    expect(getEditBarAnchorRect()).toEqual({ height: 28, left: 110, top: 68, width: 80 });
    canvasPanels.length = 0;
  });
});

// ─── Hit-driven panel activation (the bar anchors to the panel you clicked) ─────

describe("hit → activeMedia", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  test("a hit in a breakpoint panel makes it the active panel; base maps to null", async () => {
    const canvasA = await mountReady();
    const canvasB = document.createElement("div");
    document.body.append(canvasB);
    await mountIframeCanvas(1, {} as never, canvasB, null, activeTab.value!.id);
    channels[1]!.deliver({ kind: "ready" });
    canvasPanels.push(
      { canvas: canvasA, mediaName: "base" } as unknown as CanvasPanel,
      { canvas: canvasB, mediaName: "sm" } as unknown as CanvasPanel,
    );

    channels[1]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    expect(activeTab.value!.session.ui.activeMedia).toBe("sm");

    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    expect(activeTab.value!.session.ui.activeMedia).toBeNull();
    canvasPanels.length = 0;
  });

  test("a git-diff panel hit never poisons the style-panel media context", async () => {
    const canvasEl = await mountReady();
    activeTab.value!.session.ui.activeMedia = "sm";
    canvasPanels.push({
      canvas: canvasEl,
      mediaName: "git-diff-current",
    } as unknown as CanvasPanel);

    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    expect(activeTab.value!.session.ui.activeMedia).toBe("sm");
    canvasPanels.length = 0;
  });
});

// ─── Tab identity bookkeeping details ───────────────────────────────────────────

describe("host tab-identity bookkeeping", () => {
  const firstChildText = (t: { doc: { document: { children?: unknown } } }) =>
    (t.doc.document.children as { textContent?: string }[])[0]!.textContent;

  beforeEach(() => {
    resetWorkspaceWithTab({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" });
  });

  test("patchComplete does NOT flip the host's tab identity", async () => {
    const { openTab } = await import("../src/workspace/workspace");
    const tabA = activeTab.value!;
    const canvasEl = await mountReady();
    const tabB = openTab({
      document: { children: [{ tagName: "p", textContent: "B" }], tagName: "div" },
      id: "tab-b2",
    });
    await mountIframeCanvas(2, {} as never, canvasEl, null, tabB.id);
    // A patch ack for the new gen must not adopt the pending identity…
    channels[0]!.deliver({ gen: 2, kind: "patchComplete" });
    channels[0]!.deliver({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "still A",
    });
    expect(firstChildText(tabA)).toBe("still A");
    expect(firstChildText(tabB)).toBe("B");
  });

  test("renderError prunes the pending identity — a later matching ack cannot adopt it", async () => {
    const { openTab } = await import("../src/workspace/workspace");
    const tabA = activeTab.value!;
    const canvasEl = await mountReady();
    const tabB = openTab({
      document: { children: [{ tagName: "p", textContent: "B" }], tagName: "div" },
      id: "tab-b3",
    });
    await mountIframeCanvas(2, {} as never, canvasEl, null, tabB.id);
    channels[0]!.deliver({ gen: 2, kind: "renderError", message: "boom" });
    channels[0]!.deliver({ gen: 2, kind: "renderComplete" });
    channels[0]!.deliver({
      children: null,
      kind: "editCommit",
      path: ["children", 0],
      textContent: "routed to A",
    });
    expect(firstChildText(tabA)).toBe("routed to A");
    expect(firstChildText(tabB)).toBe("B");
  });

  test("postPatchToHosts skips hosts rendering another tab's document", async () => {
    await mountReady();
    channels[0]!.posts.length = 0;
    const ops: WireDocOp[] = [
      { key: "textContent", op: "set-key", path: ["children", 0], value: "x" },
    ];
    expect(postPatchToHosts(ops, 1, "some-other-tab")).toBe(0);
    expect(channels[0]!.posts.some((p) => p.kind === "patch")).toBe(false);
    // …while the owning tab's patches go through.
    expect(postPatchToHosts(ops, 1, activeTab.value!.id)).toBe(1);
  });

  test("commitActiveEditSession posts endEdit to the active edit host only while editing", async () => {
    await mountReady();
    commitActiveEditSession();
    expect(channels[0]!.posts.some((p) => p.kind === "endEdit")).toBe(false);

    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    commitActiveEditSession();
    expect(channels[0]!.posts.some((p) => p.kind === "endEdit")).toBe(true);
    channels[0]!.deliver({ kind: "editEnd" });
  });
});

// ─── Slash-menu + context-menu bridge cases (host-side coordinate conversion) ────

describe("slash/context bridge messages", () => {
  interface SlashShown {
    rect: { left: number; top: number; bottom: number; width: number; height: number };
    filter: string;
    onSelect: (cmd: { label: string; tag: string; description: string }) => void;
    onDismiss: () => void;
  }

  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  test("slashShow converts the rect by the empirical scale + offset; select/dismiss round-trip", async () => {
    const shown: SlashShown[] = [];
    const navs: string[] = [];
    let dismissed = 0;
    setCanvasSlashHandler({
      dismiss: () => {
        dismissed += 1;
      },
      nav: (key) => navs.push(key),
      show: (req) => shown.push(req as SlashShown),
    });
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    stubRect(iframe, { height: 480, left: 100, top: 50, width: 600 });
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 300 });

    channels[0]!.deliver({
      filter: "he",
      kind: "slashShow",
      rect: { height: 12, width: 30, x: 10, y: 20 },
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      filter: "he",
      rect: { bottom: 114, height: 24, left: 120, top: 90, width: 60 },
    });

    channels[0]!.posts.length = 0;
    shown[0]!.onSelect({ description: "d", label: "Paragraph", tag: "p" });
    expect(channels[0]!.posts).toContainEqual({
      cmd: { description: "d", label: "Paragraph", tag: "p" },
      kind: "slashSelect",
    });
    shown[0]!.onDismiss();
    expect(channels[0]!.posts).toContainEqual({ kind: "slashDismissed" });

    channels[0]!.deliver({ key: "ArrowDown", kind: "slashNav" });
    expect(navs).toEqual(["ArrowDown"]);
    channels[0]!.deliver({ kind: "slashDismiss" });
    expect(dismissed).toBe(1);
  });

  test("contextMenu converts coords, passes the path (or null), and a hit dismisses", async () => {
    const shows: { path: (string | number)[] | null; clientX: number; clientY: number }[] = [];
    let dismissed = 0;
    setCanvasContextMenuHandler({
      dismiss: () => {
        dismissed += 1;
      },
      show: (args) => shows.push(args),
    });
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    stubRect(iframe, { height: 480, left: 100, top: 50, width: 600 });
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 300 });

    channels[0]!.deliver({ kind: "contextMenu", path: ["children", 1], x: 5, y: 7 });
    expect(shows[0]).toEqual({ clientX: 110, clientY: 64, path: ["children", 1] });

    channels[0]!.deliver({ kind: "contextMenu", path: null, x: 1, y: 1 });
    expect(shows[1]!.path).toBeNull();

    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    expect(dismissed).toBe(1);
  });
});

// ─── Stylebook host capability: tag-addressed hits, live styleUpdate, pan ────────

const { serializeJxPath } = await import("../src/canvas/path-mapping");

describe("stylebook host capability", () => {
  // Card → preview → specimen root (p) → nested child (b), mirroring buildStylebookDoc's shape.
  const CARD_PATH = ["children", 0, "children", 1, "children", 0];
  const SPECIMEN_PATH = [...CARD_PATH, "children", 0, "children", 0];
  const NESTED_PATH = [...SPECIMEN_PATH, "children", 0];

  function makeGenerated() {
    return {
      doc: { attributes: { class: "sb-root" }, children: [], tagName: "div" } as never,
      pathToTag: new Map([
        [serializeJxPath(CARD_PATH), "p"],
        [serializeJxPath([...CARD_PATH, "children", 0]), "p"],
        [serializeJxPath(SPECIMEN_PATH), "p"],
        [serializeJxPath(NESTED_PATH), "p b"],
      ]),
      tagToCardPath: new Map<string, (string | number)[]>([["p", CARD_PATH]]),
    };
  }

  async function mountStylebookReady(widthPx: number | null = 480) {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    mountStylebookCanvas(9, makeGenerated(), canvasEl, widthPx);
    const channel = channels.at(-1)!;
    channel.deliver({ kind: "ready" });
    channel.deliver({ gen: 9, kind: "renderComplete" });
    await flush();
    return { canvasEl, channel };
  }

  beforeEach(() => {
    resetWorkspaceWithTab();
    canvasPanels.length = 0;
    setStylebookHitHandler(() => {});
  });

  test("mountStylebookCanvas posts the pre-generated doc as a stylebook render — no resolveCanvasDocument, no siteStyle, fixed width", async () => {
    const { canvasEl, channel } = await mountStylebookReady(768);
    expect(resolveCalls).toBe(0);
    const render = channel.posts.find((p) => p.kind === "render")!;
    expect(render).toMatchObject({ gen: 9, kind: "render", mode: "stylebook", siteStyle: null });
    expect((render.mapperCtx as { canvasMode: string }).canvasMode).toBe("stylebook");
    // Doc and shadowDoc are independent plain clones (fake channels pass by reference).
    expect(render.doc).toEqual(render.shadowDoc as never);
    expect(render.doc).not.toBe(render.shadowDoc);
    const iframe = canvasEl.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.width).toBe("768px");
  });

  test("a null width mounts full-width (the no-$media single panel)", async () => {
    const { canvasEl } = await mountStylebookReady(null);
    const iframe = canvasEl.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.width).toBe("100%");
  });

  test("a specimen hit decodes to its tag (nearest mapped ancestor), routes to the handler with the panel's media, draws a labelled box, and never writes session.selection", async () => {
    const hits: [string | null, string | null][] = [];
    setStylebookHitHandler((tag, media) => hits.push([tag, media]));
    const { canvasEl, channel } = await mountStylebookReady();
    canvasPanels.push({ canvas: canvasEl, mediaName: "sm" } as unknown as CanvasPanel);

    // A hit on an UNMAPPED descendant of the nested <b> trims pairwise up to "p b".
    channel.deliver({
      hit: {
        path: [...NESTED_PATH, "children", 2],
        rect: { height: 20, width: 100, x: 10, y: 5 },
      },
      kind: "hit",
    });
    expect(hits).toEqual([["p b", "sm"]]);
    expect(activeTab.value?.session.selection).toBeNull();
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");
    expect((sel.querySelector(".overlay-label") as HTMLElement).textContent).toBe("<p b>");

    // Chrome (unmapped all the way up) → null tag, box cleared.
    channel.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    expect(hits).toEqual([
      ["p b", "sm"],
      [null, "sm"],
    ]);
    expect(sel.style.display).toBe("none");
  });

  test("hover decodes to a tag and suppresses the box over the SELECTED tag", async () => {
    const { canvasEl, channel } = await mountStylebookReady();
    activeTab.value!.session.ui.stylebookSelection = "p";
    await flush();
    const hover = canvasEl.querySelector(".overlay-hover") as HTMLElement;

    channel.deliver({
      hit: { path: SPECIMEN_PATH, rect: { height: 8, width: 40, x: 2, y: 3 } },
      kind: "hover",
    });
    expect(hover.style.display).toBe("none");

    channel.deliver({
      hit: { path: NESTED_PATH, rect: { height: 8, width: 40, x: 2, y: 3 } },
      kind: "hover",
    });
    expect(hover.style.display).toBe("block");

    channel.deliver({ hit: null, kind: "hover" });
    expect(hover.style.display).toBe("none");
  });

  test("insertZones and contextMenu are inert on stylebook hosts", async () => {
    const shows: unknown[] = [];
    setCanvasContextMenuHandler({ dismiss: () => {}, show: (a) => shows.push(a) });
    const { canvasEl, channel } = await mountStylebookReady();

    channel.deliver({
      kind: "insertZones",
      zones: [
        {
          index: 0,
          parentPath: [],
          position: "before",
          rect: { height: 10, width: 10, x: 0, y: 0 },
          refPath: ["children", 0],
        },
      ],
    });
    const plus = canvasEl.querySelector(".insertion-helper") as HTMLElement;
    expect(plus.style.display).toBe("none");

    channel.deliver({ kind: "contextMenu", path: SPECIMEN_PATH, x: 5, y: 7 });
    expect(shows).toHaveLength(0);

    setCanvasContextMenuHandler({ dismiss: () => {}, show: () => {} });
  });

  test("the selection watcher measures the selected tag's CARD; the geometry reply draws the labelled box", async () => {
    const { canvasEl, channel } = await mountStylebookReady();
    channel.posts.length = 0;

    activeTab.value!.session.ui.stylebookSelection = "p";
    await flush();
    const measure = channel.posts.find((p) => p.kind === "measure") as Msg;
    expect(measure).toMatchObject({ kind: "measure", paths: [CARD_PATH] });

    channel.deliver({
      hits: [{ path: CARD_PATH, rect: { height: 40, width: 200, x: 12, y: 30 } }],
      kind: "geometry",
      reqId: measure.reqId as number,
    });
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");
    expect(sel.style.left).toBe("12px");
    expect((sel.querySelector(".overlay-label") as HTMLElement).textContent).toBe("<p>");

    // A tag with no card in this host's doc clears the box without a round-trip.
    channel.posts.length = 0;
    activeTab.value!.session.ui.stylebookSelection = "table";
    await flush();
    expect(channel.posts.some((p) => p.kind === "measure")).toBe(false);
    expect(sel.style.display).toBe("none");
  });

  test("postStyleUpdateToStylebookHosts gen-tags per stylebook host and skips page hosts", async () => {
    // A regular page host first (channels[0]) …
    await mountReady();
    // … then a live stylebook host (channels[1]).
    const { channel } = await mountStylebookReady();
    channels[0]!.posts.length = 0;
    channel.posts.length = 0;

    const posted = postStyleUpdateToStylebookHosts({
      "& .element-card-preview p": { color: "blue" },
    });
    expect(posted).toBe(1);
    const update = channel.posts.find((p) => p.kind === "styleUpdate")!;
    // Tagged with the host's last RENDERED gen (9), so a stale update is dropped iframe-side.
    expect(update).toMatchObject({ gen: 9, kind: "styleUpdate" });
    expect(channels[0]!.posts.some((p) => p.kind === "styleUpdate")).toBe(false);
  });

  test("postStyleUpdateToStylebookHosts returns 0 with no live stylebook host (caller falls back to a full render)", async () => {
    await mountReady();
    expect(postStyleUpdateToStylebookHosts({})).toBe(0);
  });

  test("panToStylebookTag measures the card via a dedicated reqId whose geometry reply pans instead of drawing the selection", async () => {
    const wrap = document.createElement("div");
    wrap.id = "canvas-wrap";
    document.body.append(wrap);
    initShellRefs();

    const { canvasEl, channel } = await mountStylebookReady();
    canvasPanels.push({ canvas: canvasEl, mediaName: null } as unknown as CanvasPanel);
    channel.posts.length = 0;

    panToStylebookTag("p");
    const measure = channel.posts.find((p) => p.kind === "measure") as Msg;
    expect(measure).toMatchObject({ kind: "measure", paths: [CARD_PATH] });

    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    channel.deliver({
      hits: [{ path: CARD_PATH, rect: { height: 40, width: 200, x: 12, y: 500 } }],
      kind: "geometry",
      reqId: measure.reqId as number,
    });
    // The pan branch consumed the reply — the selection box was not (re)drawn from it.
    expect(sel.style.display).toBe("none");

    // An unknown tag posts nothing.
    channel.posts.length = 0;
    panToStylebookTag("nope");
    expect(channel.posts).toHaveLength(0);
  });

  test("a later page mount on the same canvas clears the stylebook capability", async () => {
    const hits: unknown[] = [];
    setStylebookHitHandler((tag) => hits.push(tag));
    const { canvasEl, channel } = await mountStylebookReady();

    await mountIframeCanvas(10, {} as never, canvasEl, null, activeTab.value!.id);
    channel.deliver({ gen: 10, kind: "renderComplete" });

    channel.deliver({
      hit: { path: SPECIMEN_PATH, rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    // Routed as a normal document hit: session.selection written, no stylebook decode.
    expect(hits).toHaveLength(0);
    expect(activeTab.value?.session.selection).toEqual(SPECIMEN_PATH);
  });
});
