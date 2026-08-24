import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  flush,
  registerPrimaryStage,
  resetStudioState,
  resetWorkspaceWithTab,
  stubRect,
} from "./harness";
import {
  activateTab,
  activeTab,
  PRIMARY_PANE,
  SECONDARY_PANE,
  workspace,
} from "../src/workspace/workspace";
import { reactive } from "../src/reactivity";
import { resetProjectShell, shell } from "../src/shell";
import { initShellRefs, registerRenderer } from "../src/store";
import { activeCanvasSurface, surfaceForPane } from "../src/canvas/canvas-surface";
import { canvasPerf, resetCanvasPerf } from "../src/canvas/canvas-perf";
import { clearDragGhost, setDragGhost } from "../src/panels/drag-ghost";
import type { WireDocOp } from "../src/canvas/iframe-protocol";
import type { CanvasPanel } from "../src/types";
import type { Tab } from "../src/tabs/tab";
import { registerCanvasSurface } from "../src/canvas/surface-registry";

/* The panels of the FOCUSED pane's stage. Panels belong to a pane's surface now, not to the
   app (`src/canvas/canvas-surface.ts`); the array identity is stable, so a module-level
   binding still sees what the render mutated. */
const canvasPanels = activeCanvasSurface().panels;

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

// ─── Mocks: capture the channel and stub the parent-side resolver ───────────────

interface FakeChannel {
  opts: Record<string, unknown>;
  posts: Record<string, unknown>[];
  deliver: (m: Record<string, unknown>) => void;
  /** Whether the host really disposed this channel — the only honest teardown signal there is. */
  disposed?: boolean;
}
const channels: FakeChannel[] = [];

void mock.module("../src/canvas/iframe-channel", () => ({
  postMessageChannel: (opts: Record<string, unknown>) => {
    let handler: ((m: Record<string, unknown>) => void) | null = null;
    const rec: FakeChannel = { deliver: (m) => handler?.(m), opts, posts: [] };
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
  adoptCanvasPreviewMode,
  adoptDragSession,
  allowAutoRequestsOnNextRender,
  beginDragSession,
  canvasIdleBlockers,
  clearDropIndicator,
  commitActiveEditSession,
  currentDragSession,
  endDragSession,
  getEditBarAnchorRect,
  getEditSnapshot,
  hostDragGeometry,
  hostForCanvas,
  INSERT_HIDE_DELAY,
  isCaretActive,
  liveDragHostAt,
  mountIframeCanvas,
  mountStylebookCanvas,
  panToStylebookTag,
  postApplyFormat,
  postColorSchemeToLiveHosts,
  postLocaleToLiveHosts,
  postDragMessage,
  postSiteStyleToLiveHosts,
  postPatchToHosts,
  postStyleUpdateToStylebookHosts,
  releaseCanvasHosts,
  requestCanvasEval,
  sawIframeDragOver,
  setCanvasContextMenuHandler,
  setCanvasPointerDownHandler,
  setCanvasSlashHandler,
  setIframePatchEscalation,
  setFileDropHandler,
  setNativeDragEnterHandler,
  setInsertZoneClickHandler,
  setStylebookHitHandler,
  setToolbarRefresh,
} = await import("../src/canvas/iframe-host");
const { flushCanvasEdits } = await import("../src/canvas/iframe-host");
const { needsReleaseReconcile } = await import("../src/canvas/iframe-host");

beforeEach(() => {
  channels.length = 0;
  document.body.innerHTML = "";
  resolved = structuredClone(DEFAULT_RESOLVED);
  resolveCalls = 0;
  resetProjectShell();
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

  test("a preview link opens externally instead of navigating the canvas", async () => {
    const { setPreviewNavigateHandler } = await import("../src/canvas/preview-navigate");
    resetWorkspaceWithTab();
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });

    const opened: string[] = [];
    setPreviewNavigateHandler((url) => opened.push(url));
    try {
      channels[0]!.deliver({ href: "/about", kind: "previewNavigate" });
      // Resolved against the CANVAS's origin (the project's own), not the editor shell's deep path.
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain("/about");
      expect(opened[0]!.startsWith("http")).toBe(true);
    } finally {
      setPreviewNavigateHandler(null);
    }
  });

  test("a javascript: preview href is refused, not opened", async () => {
    const { setPreviewNavigateHandler } = await import("../src/canvas/preview-navigate");
    resetWorkspaceWithTab();
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });
    const opened: string[] = [];
    setPreviewNavigateHandler((url) => opened.push(url));
    try {
      // The shell is the opener, so a javascript:/data: URL would execute in the EDITOR's origin.
      // oxlint-disable-next-line no-script-url -- asserting this scheme is REFUSED is the point
      channels[0]!.deliver({ href: "javascript:alert(1)", kind: "previewNavigate" });
      channels[0]!.deliver({ href: "data:text/html,<b>x</b>", kind: "previewNavigate" });
      expect(opened).toHaveLength(0);
      // Ordinary web and contact schemes still go through.
      channels[0]!.deliver({ href: "mailto:hi@example.com", kind: "previewNavigate" });
      expect(opened).toEqual(["mailto:hi@example.com"]);
    } finally {
      setPreviewNavigateHandler(null);
    }
  });

  test("Data-panel Refresh arms allowAutoRequests for exactly one render", async () => {
    resetWorkspaceWithTab();
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);

    // Unarmed: edit/design renders omit the flag, so the runtime keeps auto-requests suppressed.
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });
    const first = channels[0]!.posts.find((p) => p.kind === "render") as Record<string, unknown>;
    expect(first.allowAutoRequests).toBeUndefined();

    // Armed by Refresh: the NEXT render of THAT pane carries it.
    allowAutoRequestsOnNextRender(PRIMARY_PANE);
    await mountIframeCanvas(2, { tagName: "div" } as never, canvasEl);
    const renders = channels[0]!.posts.filter((p) => p.kind === "render") as Record<
      string,
      unknown
    >[];
    expect(renders.at(-1)!.allowAutoRequests).toBe(true);

    // One-shot: a later render (e.g. an escalation) must not inherit it.
    await mountIframeCanvas(3, { tagName: "div" } as never, canvasEl);
    const after = channels[0]!.posts.filter((p) => p.kind === "render") as Record<
      string,
      unknown
    >[];
    expect(after.at(-1)!.allowAutoRequests).toBeUndefined();
  });

  /*
   * The P8 fan-out. A design canvas draws one artboard per breakpoint and every one of them renders
   * the SAME document; resolving it per artboard cost N layout merges, 2N whole-document JSON round
   * trips, and — on a dynamic route — N POSTs to `/__jx_resolve__`. A render pass is one generation,
   * so the generation is what says "these mounts are the same render".
   */
  describe("render fan-out across the hosts of one pass", () => {
    /** Three artboards of one pass, mounted the way canvas-render mounts them. */
    async function mountPass(gen: number, doc: unknown, tabId: string | null = null) {
      const els: HTMLElement[] = [];
      for (let i = 0; i < 3; i++) {
        const el = document.createElement("div");
        document.body.append(el);
        els.push(el);
        await mountIframeCanvas(gen, doc as never, el, 360 + i * 360, tabId);
      }
      for (const channel of channels) {
        channel.deliver({ kind: "ready" });
      }
      return els;
    }

    test("resolves the document once and posts it to every host", async () => {
      resetCanvasPerf();
      const doc = { tagName: "div" };
      await mountPass(7, doc);

      expect(resolveCalls).toBe(1);
      expect(canvasPerf.renderPreparations).toBe(1);
      expect(canvasPerf.hostRenderPosts).toBe(3);
      // Every host got a real render at the pass's generation — the shared resolution is fanned
      // Out, not swallowed by the first artboard.
      expect(channels).toHaveLength(3);
      for (const channel of channels) {
        expect(channel.posts.filter((p) => p.kind === "render")).toHaveLength(1);
        expect(channel.posts.at(-1)).toMatchObject({ gen: 7, kind: "render", mode: "design" });
      }
      // `prepareRender` is what a profiling run reads: passes, not panels.
      expect(canvasPerf.timings.prepareRender?.count).toBe(1);
    });

    test("the next generation resolves again — a pass is never reused across renders", async () => {
      const doc = { tagName: "div" };
      await mountPass(1, doc);
      expect(resolveCalls).toBe(1);
      await mountPass(2, doc);
      expect(resolveCalls).toBe(2);
    });

    test("two documents under one generation (git-diff) each resolve", async () => {
      const before = { tagName: "section" };
      const after = { tagName: "article" };
      const el = document.createElement("div");
      const el2 = document.createElement("div");
      document.body.append(el, el2);
      await mountIframeCanvas(4, before as never, el, 800, null);
      await mountIframeCanvas(4, after as never, el2, 800, null);
      // Identity, not generation, is what distinguishes them — the diff stage renders two different
      // Documents side by side in one pass.
      expect(resolveCalls).toBe(2);
    });

    test("the same document mounted for a different tab resolves again", async () => {
      // `editableTags` is derived from the tab's source format, so a payload prepared for one tab
      // Must never be handed to another.
      const doc = { tagName: "div" };
      const el = document.createElement("div");
      const el2 = document.createElement("div");
      document.body.append(el, el2);
      await mountIframeCanvas(5, doc as never, el, null, "tab-a");
      await mountIframeCanvas(5, doc as never, el2, null, "tab-b");
      expect(resolveCalls).toBe(2);
    });

    test("Refresh's allowAutoRequests reaches every artboard of the pass, then nothing", async () => {
      resetWorkspaceWithTab();
      // Armed once, "the next render" means the whole pass. Consuming the flag per host meant
      // Whichever artboard mounted first swallowed it and the rest kept auto-requests suppressed —
      // The Data activity's Refresh refreshed one artboard out of N.
      allowAutoRequestsOnNextRender(PRIMARY_PANE);
      await mountPass(11, { tagName: "div" });
      for (const channel of channels) {
        expect(channel.posts.at(-1)).toMatchObject({ allowAutoRequests: true, kind: "render" });
      }

      // Still one-shot: the pass after it carries nothing.
      channels.length = 0;
      await mountPass(12, { tagName: "div" });
      for (const channel of channels) {
        expect((channel.posts.at(-1) as Record<string, unknown>).allowAutoRequests).toBeUndefined();
      }
    });

    /*
     * The arm is one PANE's, not one pass's and not the app's.
     *
     * Per-host was wrong because one Refresh mounts N artboards and the first swallowed the flag.
     * Per-pass was wrong one pane further out: two panes are two passes, both scheduled through rAF
     * and both awaiting inside their mount loop, so whichever reached `preparePassRender` first
     * took an arm the other pane's Refresh had set — the Data activity's Refresh refreshed a pane
     * nobody had pressed it in, and left its own suppressed.
     */
    test("Refresh arms ONE pane — the other pane's pass cannot claim it", async () => {
      resetWorkspaceWithTab();
      const wrap = document.createElement("div");
      document.body.append(wrap);
      surfaceForPane(SECONDARY_PANE).wrap = wrap;
      const sideEl = document.createElement("div");
      wrap.append(sideEl);
      const primaryEl = document.createElement("div");
      document.body.append(primaryEl);

      allowAutoRequestsOnNextRender(SECONDARY_PANE);
      // The FOCUSED pane renders first and must not consume the side pane's arm.
      await mountIframeCanvas(21, { tagName: "div" } as never, primaryEl, null, null);
      const chPrimary = channels.at(-1)!;
      chPrimary.deliver({ kind: "ready" });
      await mountIframeCanvas(22, { tagName: "aside" } as never, sideEl, null, null);
      const chSide = channels.at(-1)!;
      chSide.deliver({ kind: "ready" });
      const primaryPost = chPrimary.posts.at(-1) as Record<string, unknown>;
      const sidePost = chSide.posts.at(-1) as Record<string, unknown>;

      console.log(
        `[iframe-host] Refresh armed ${SECONDARY_PANE}: primary=${String(primaryPost.allowAutoRequests)} ` +
          `side=${String(sidePost.allowAutoRequests)}`,
      );
      expect(primaryPost.allowAutoRequests).toBeUndefined();
      expect(sidePost.allowAutoRequests).toBe(true);
      surfaceForPane(SECONDARY_PANE).wrap = undefined as never;
    });

    test("a colour-scheme flip between artboards is not baked into the shared payload", async () => {
      resetWorkspaceWithTab();
      const doc = { tagName: "div" };
      const first = document.createElement("div");
      const second = document.createElement("div");
      document.body.append(first, second);
      await mountIframeCanvas(9, doc as never, first, null, null);
      activeTab.value!.session.ui.previewColorScheme = "dark";
      await mountIframeCanvas(9, doc as never, second, null, null);
      for (const channel of channels) {
        channel.deliver({ kind: "ready" });
      }
      // One resolution, but the scheme is read per post.
      expect(resolveCalls).toBe(1);
      expect(channels[0]!.posts.at(-1)).toMatchObject({ colorScheme: null });
      expect(channels[1]!.posts.at(-1)).toMatchObject({ colorScheme: "dark" });
    });
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

  /*
   * The scheme a render posts belongs to the tab being RENDERED, not to the tab with the keyboard.
   *
   * `session.ui.previewColorScheme` is a per-TAB choice, and this is verbatim the defect
   * `postColorSchemeToLiveHosts` was given a `root` for — the PUSH path was scoped to one stage and
   * the RENDER path was not. Worse than the push, because the per-pane effect in `studio.ts` only
   * re-runs when the scheme CHANGES: nothing repaired the side pane afterwards, so every later
   * re-render silently reverted it while its own Auto/Light/Dark control went on saying otherwise.
   */
  describe("the colour scheme a render posts is the RENDERED tab's", () => {
    /** A side tab with its own scheme, and a focused tab with a different one. */
    async function twoSchemes(side: "light" | "dark" | "auto", focused: "light" | "dark" | "auto") {
      resetWorkspaceWithTab();
      const { openTab } = await import("../src/workspace/workspace");
      const focusedTab = activeTab.value!;
      const sideTab = openTab({ document: { tagName: "div" }, id: "tab-scheme-side" });
      activateTab(focusedTab.id);
      focusedTab.session.ui.previewColorScheme = focused;
      sideTab.session.ui.previewColorScheme = side;
      return { focusedTab, sideTab };
    }

    test("a page mount posts its own tab's scheme, not the focused tab's", async () => {
      const { sideTab } = await twoSchemes("dark", "auto");
      const canvasEl = document.createElement("div");
      document.body.append(canvasEl);
      // The VIEW tab, exactly as `canvas-render.ts` passes it.
      await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl, null, sideTab.id, sideTab);
      channels.at(-1)!.deliver({ kind: "ready" });
      const posted = channels.at(-1)!.posts.at(-1);
      console.log(
        `[iframe-host] side=dark focused=auto → side render posts colorScheme=` +
          `${JSON.stringify((posted as Record<string, unknown>).colorScheme)}`,
      );
      expect(posted).toMatchObject({ colorScheme: "dark", kind: "render" });
    });

    test("and posts null for its own Auto tab while the focused tab is forced dark", async () => {
      const { sideTab } = await twoSchemes("auto", "dark");
      const canvasEl = document.createElement("div");
      document.body.append(canvasEl);
      await mountIframeCanvas(2, { tagName: "div" } as never, canvasEl, null, sideTab.id, sideTab);
      channels.at(-1)!.deliver({ kind: "ready" });
      expect(channels.at(-1)!.posts.at(-1)).toMatchObject({ colorScheme: null, kind: "render" });
    });

    test("a stylebook mount resolves its tab from the stage it is mounted into", async () => {
      const { sideTab } = await twoSchemes("light", "dark");
      // `mountStylebookCanvas` takes no tab — the specimen has no tab identity — so the route is
      // The STAGE: `tabOfContainer(canvasEl)` → `paneOfContainer` → `stageContaining`.
      const { focusPane, splitRight } = await import("../src/workspace/workspace");
      activateTab(sideTab.id);
      expect(splitRight()?.id).toBe(SECONDARY_PANE);
      focusPane(PRIMARY_PANE);
      const wrap = document.createElement("div");
      document.body.append(wrap);
      surfaceForPane(SECONDARY_PANE).wrap = wrap;
      const canvasEl = document.createElement("div");
      wrap.append(canvasEl);

      mountStylebookCanvas(
        3,
        { doc: { tagName: "div" }, pathToTag: new Map(), tagToCardPath: new Map() } as never,
        canvasEl,
        null,
      );
      channels.at(-1)!.deliver({ kind: "ready" });
      expect(channels.at(-1)!.posts.at(-1)).toMatchObject({ colorScheme: "light", kind: "render" });
      surfaceForPane(SECONDARY_PANE).wrap = undefined as never;
    });
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

  /*
   * The direction rides with the tag rather than being derived in the frame: the frame would have
   * to carry the script table to work it out, and the answer is already known on this side.
   */
  test("postLocaleToLiveHosts carries the direction with the tag, to ready hosts only", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);

    postLocaleToLiveHosts("ar");
    expect(channels[0]!.posts).toHaveLength(0);

    channels[0]!.deliver({ kind: "ready" });
    postLocaleToLiveHosts("ar");
    expect(channels[0]!.posts.at(-1)).toEqual({ dir: "rtl", kind: "setLocale", locale: "ar" });

    postLocaleToLiveHosts(null);
    expect(channels[0]!.posts.at(-1)).toEqual({ dir: "ltr", kind: "setLocale", locale: null });

    /* Scoped, for the reason the scheme post is: the side pane's control must not re-language the
       primary pane's document. */
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    const before = channels[0]!.posts.length;
    postLocaleToLiveHosts("fr", elsewhere);
    expect(channels[0]!.posts).toHaveLength(before);
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

  /* The fallback, which for most of its life was a literal `/packages/studio/canvas.html` — the
     repo dev server's path, baked into a browser bundle, correct on one host out of four. It
     resolves against the ENTRY's directory now, so it is right everywhere rather than accidentally
     unused because every other host overrode it. tests/with-dom.ts anchors the entry at the url the
     dev server really serves it from, so the answer here is byte-identical to the old literal. */
  test("with no canvasUrl the default resolves beside the bundle", async () => {
    const g = globalThis as unknown as { __jxPlatform?: unknown };
    const saved = g.__jxPlatform;
    g.__jxPlatform = { id: "devserver" } as never;
    try {
      const canvasEl = document.createElement("div");
      document.body.append(canvasEl);
      await mountIframeCanvas(41, { tagName: "div" } as never, canvasEl);
      const src = canvasEl.querySelector("iframe")!.getAttribute("src")!;
      expect(src.startsWith("/packages/studio/canvas.html?")).toBe(true);
    } finally {
      g.__jxPlatform = saved;
    }
  });

  /* Electrobun resolves its canvasUrl over RPC inside activate(), and the fallback must NOT be
     mounted while it waits. Before the fallback was anchored it did not matter — the old literal
     resolved to nothing servable under views://, so an early frame just failed. Now it resolves,
     to a canvas.html electrobun really stages, and an early frame would boot the canvas bundle
     inside the shell's app-privileged origin in a CEF instance running
     disable-site-isolation-trials. The cross-origin loopback canvas exists so that cannot happen. */
  test("a platform that defers its canvasUrl gets about:blank, not the bundle-relative default", async () => {
    const g = globalThis as unknown as { __jxPlatform?: unknown };
    const saved = g.__jxPlatform;
    g.__jxPlatform = { canvasUrlDeferred: true, id: "desktop" } as never;
    try {
      const canvasEl = document.createElement("div");
      document.body.append(canvasEl);
      await mountIframeCanvas(42, { tagName: "div" } as never, canvasEl);
      const src = canvasEl.querySelector("iframe")!.getAttribute("src")!;
      expect(src.startsWith("about:blank")).toBe(true);
      expect(src).not.toContain("canvas.html");
    } finally {
      g.__jxPlatform = saved;
    }
  });

  test("a deferred platform that has since resolved its url uses it", async () => {
    const g = globalThis as unknown as { __jxPlatform?: unknown };
    const saved = g.__jxPlatform;
    g.__jxPlatform = {
      canvasUrl: "http://127.0.0.1:5111/__studio__/canvas.html",
      canvasUrlDeferred: true,
      id: "desktop",
    } as never;
    try {
      const canvasEl = document.createElement("div");
      document.body.append(canvasEl);
      await mountIframeCanvas(43, { tagName: "div" } as never, canvasEl);
      const src = canvasEl.querySelector("iframe")!.getAttribute("src")!;
      expect(src.startsWith("http://127.0.0.1:5111/__studio__/canvas.html?")).toBe(true);
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
  // Inside the pane's stage, which is where an artboard really lives — the forwarded wheel is
  // Replayed on the stage that CONTAINS the frame. `beforeEach` empties the body, so the stage is
  // Re-attached here rather than assumed.
  // A FRESH stage per mount. The surface record outlives `beforeEach`'s `innerHTML = ""`, so
  // Reusing the last one would leave every previous test's artboard still inside it.
  const stage = document.createElement("div");
  stage.className = "pane-stage";
  stage.dataset.jxRegion = "pane.primary";
  document.body.append(stage);
  registerCanvasSurface(PRIMARY_PANE, stage);
  stage.append(canvasEl);
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

    expect(activeTab.value?.session.selection).toEqual([["children", 0]]);
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");
    expect(sel.style.left).toBe("10px");
    expect(sel.style.top).toBe("5px");
    expect(sel.style.width).toBe("100px");
    expect(sel.style.height).toBe("20px");
  });

  /*
   * The parent's only proof that the author is back on the canvas — `studio.ts` injects the block
   * action bar's suppression release here. {@link focusHostPane} cannot serve: `focusPane` returns
   * early when the pane already has focus, which is the ordinary case AND the one the release
   * exists for (clicking the element that is already selected posts the same path back, so the
   * parent's render path has nothing to compare).
   */
  test("both canvas pointerdown messages report to the injected handler", async () => {
    await mountReady();
    let fired = 0;
    setCanvasPointerDownHandler(() => {
      fired += 1;
    });
    try {
      channels[0]!.deliver({ kind: "paneFocus" });
      expect(fired).toBe(1);
      // `hit` reports too, for the same reason it also calls `focusHostPane`: the canvas bundle
      // Ships prebuilt, so a frame whose build predates `paneFocus` still has to be heard.
      channels[0]!.deliver({
        hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
        kind: "hit",
      });
      expect(fired).toBe(2);
    } finally {
      setCanvasPointerDownHandler(null);
    }
    // Unregistered, the messages are still handled — they just report to nobody.
    channels[0]!.deliver({ kind: "paneFocus" });
    expect(fired).toBe(2);
  });

  test("a ctrl/cmd-click ACCUMULATES instead of replacing (§6.5)", async () => {
    await mountReady();
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
      kind: "hit",
    });
    channels[0]!.deliver({
      additive: true,
      hit: { path: ["children", 1], rect: { height: 20, width: 100, x: 10, y: 40 } },
      kind: "hit",
    });
    expect(activeTab.value?.session.selection).toEqual([
      ["children", 0],
      ["children", 1],
    ]);
  });

  test("an additive click on an already-selected node removes it from the set", async () => {
    await mountReady();
    activeTab.value!.session.selection = [
      ["children", 0],
      ["children", 1],
    ];
    channels[0]!.deliver({
      additive: true,
      hit: { path: ["children", 1], rect: { height: 20, width: 100, x: 10, y: 40 } },
      kind: "hit",
    });
    expect(activeTab.value?.session.selection).toEqual([["children", 0]]);
  });

  test("a multi-selection measures every path and draws the others as co-selection boxes", async () => {
    const canvasEl = await mountReady();
    activeTab.value!.session.selection = [
      ["children", 0],
      ["children", 1],
    ];
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const measure = channels[0]!.posts.findLast((p) => p.kind === "measure") as
      | { paths: (string | number)[][]; reqId: number }
      | undefined;
    // The PRIMARY is posted first, so the reply can be matched by path rather than by position.
    expect(measure?.paths).toEqual([
      ["children", 1],
      ["children", 0],
    ]);
    channels[0]!.deliver({
      hits: [
        { path: ["children", 1], rect: { height: 20, width: 100, x: 10, y: 40 } },
        { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
      ],
      kind: "geometry",
      reqId: measure!.reqId,
    });
    const sel = canvasEl.querySelector(
      ".overlay-selection:not(.overlay-coselection)",
    ) as HTMLElement;
    expect(sel.style.top).toBe("40px");
    const co = canvasEl.querySelectorAll(".overlay-coselection");
    expect(co).toHaveLength(1);
    expect((co[0] as HTMLElement).style.top).toBe("5px");
  });

  test("a selection of ONE draws no co-selection box at all", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
      kind: "hit",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const measure = channels[0]!.posts.findLast((p) => p.kind === "measure") as
      | { paths: (string | number)[][]; reqId: number }
      | undefined;
    expect(measure?.paths).toEqual([["children", 0]]);
    channels[0]!.deliver({
      hits: [{ path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } }],
      kind: "geometry",
      reqId: measure!.reqId,
    });
    expect(canvasEl.querySelectorAll(".overlay-coselection")).toHaveLength(0);
  });

  test("a layoutHit selects the layout chrome, clears the document selection, and labels the box", async () => {
    const { setLayoutSelection } = await import("../src/shell");
    setLayoutSelection(null);
    const canvasEl = await mountReady();

    // Select a real node first — the layout hit has to retire it, not sit beside it.
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
      kind: "hit",
    });
    expect(activeTab.value?.session.selection).toEqual([["children", 0]]);

    channels[0]!.deliver({
      hit: {
        className: "",
        layoutFile: "layouts/base.json",
        layoutPath: ["children", 0, "children", 0],
        rect: { height: 21, width: 110, x: 24, y: 12 },
        tagName: "a",
      },
      kind: "layoutHit",
    });

    // Read through the reactive record field by field: `shell.layoutSelection` is a proxy, so
    // Structural matchers compare the handler rather than the hit.
    expect(shell.layoutSelection?.layoutFile).toBe("layouts/base.json");
    expect(shell.layoutSelection?.layoutPath).toEqual(["children", 0, "children", 0]);
    expect(shell.layoutSelection?.tagName).toBe("a");
    expect(activeTab.value?.session.selection).toEqual([]);
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("block");
    expect(sel.style.left).toBe("24px");

    // And selecting a document node again clears the layout selection.
    channels[0]!.deliver({
      hit: { path: ["children", 1], rect: { height: 20, width: 100, x: 10, y: 5 } },
      kind: "hit",
    });
    expect(shell.layoutSelection).toBeNull();
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
    tab.session.selection = [["children", 2]];
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
    tab.session.selection = [["children", 3]];
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

    tab.session.selection = [];
    await flush();
    expect(sel.style.display).toBe("none");
  });

  test("renderComplete re-measures the current selection", async () => {
    const tab = resetWorkspaceWithTab();
    await mountReady();
    tab.session.selection = [["children", 1]];
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

  test("postPatchToHosts posts the forward ops with the STAGE's own generation, and counts them", async () => {
    const canvasEl = await mountReady();
    channels[0]!.posts.length = 0;
    /* The generation is resolved from the artboard's own stage, so the artboard has to be ON one.
       `postPatchToHosts` used to take the number as a parameter and a caller with two panes had
       only one to give. */
    const surface = surfaceForPane(PRIMARY_PANE);
    surface.panels.push({ canvas: canvasEl, ready: true } as unknown as CanvasPanel);
    surface.renderGeneration = 7;

    const count = postPatchToHosts(OPS, activeTab.value?.id ?? null);
    expect(count).toBe(1);
    expect(channels[0]!.posts).toContainEqual({ forwardOps: OPS, gen: 7, kind: "patch" });
    surface.panels.length = 0;
  });

  test("postPatchToHosts returns 0 when no host is ready, so the caller escalates", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, {} as never, canvasEl);
    // No `ready` delivered → the host can't apply a patch yet.
    expect(postPatchToHosts(OPS, activeTab.value?.id ?? null)).toBe(0);
    expect(channels[0]!.posts.some((p) => p.kind === "patch")).toBe(false);
  });

  test("postPatchToHosts drops a host whose iframe has been disconnected", async () => {
    const canvasEl = await mountReady();
    canvasEl.remove(); // Detach the canvas → the iframe is no longer connected.
    expect(postPatchToHosts(OPS, activeTab.value?.id ?? null)).toBe(0);
  });

  test("patchComplete re-measures the current selection", async () => {
    const tab = resetWorkspaceWithTab();
    await mountReady();
    tab.session.selection = [["children", 0]];
    await flush();
    channels[0]!.posts.length = 0;

    channels[0]!.deliver({ gen: 1, kind: "patchComplete" });
    expect(channels[0]!.posts.some((p) => p.kind === "measure")).toBe(true);
  });

  test("patchError escalates the PANE whose frame reported it", async () => {
    const escalated: string[] = [];
    setIframePatchEscalation((paneId) => {
      escalated.push(paneId);
    });
    const canvasEl = await mountReady();
    // In the app this artboard is always in some pane's stage — that is what names the pane.
    canvasPanels.push({ canvas: canvasEl, mediaName: "base" } as unknown as CanvasPanel);

    channels[0]!.deliver({ gen: 1, kind: "patchError", message: "nope" });
    expect(escalated).toEqual([PRIMARY_PANE]);
    canvasPanels.length = 0;
  });

  test("patchError from a frame no pane still claims escalates nothing", async () => {
    // The panel list was already replaced by a newer pass, so that pass IS the full render — a
    // Global schedule here would rebuild a stage that is not stale.
    const escalated: string[] = [];
    setIframePatchEscalation((paneId) => {
      escalated.push(paneId);
    });
    await mountReady();
    channels[0]!.deliver({ gen: 1, kind: "patchError", message: "nope" });
    expect(escalated).toEqual([]);
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

  test("a format-backed tab ships its caret vocabulary with the render", async () => {
    // Which tags hold a caret is a property of the DOCUMENT, so it rides with the render rather
    // Than being baked into the frame.
    const { seedMarkdownFormat } = await import("./format-fixture");
    const { setFormats } = await import("../src/format/format-host");
    seedMarkdownFormat();
    resetWorkspaceWithTab({ children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" });
    activeTab.value!.doc.sourceFormat = "Markdown";

    await mountReady();
    const render = channels[0]!.posts.find((p) => p.kind === "render") as
      | { editableTags?: Record<string, boolean> }
      | undefined;
    expect(render?.editableTags).toBeDefined();
    // Markdown's own verdicts: a paragraph holds a caret, a blockquote holds paragraphs, and a
    // Link is markup inside a block rather than a block.
    expect(render!.editableTags!.p).toBe(true);
    expect(render!.editableTags!.blockquote).toBe(false);
    expect(render!.editableTags!.a).toBe(false);
    // Tags markdown never mentions are left to the studio's own metadata.
    expect(render!.editableTags!.figcaption).toBeUndefined();
    setFormats([]);
  });

  test("a native tab ships none — the built-in vocabulary answers alone", async () => {
    const { setFormats } = await import("../src/format/format-host");
    setFormats([]);
    resetWorkspaceWithTab({ children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" });
    await mountReady();
    const render = channels[0]!.posts.find((p) => p.kind === "render") as
      | { editableTags?: unknown }
      | undefined;
    expect(render).toBeDefined();
    expect(render!.editableTags).toBeUndefined();
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

  /*
   * "No longer active" and "no longer shown here" are the same question with one stage and
   * different questions with two, and the test above cannot tell them apart: `openTab` moves the
   * pane's displayed tab AND the focus in one step, so it passes either way.
   *
   * This is the case that separates them. The side pane still displays the tab it owes a caret to;
   * the primary merely holds focus. Asking the focus drops the caret the user is mid-word in.
   */
  test("a host still showing its tab re-enters, even when the other pane has focus", async () => {
    const { focusPane, openTab, splitRight } = await import("../src/workspace/workspace");
    await mountReady();

    // A SECOND host, in the secondary pane's own stage — the pane that will lose focus. The first
    // Host stays in the primary, which is what `mountReady` registers.
    const sideTab = openTab({
      document: { tagName: "div" },
      documentPath: "side.json",
      id: "side-tab",
    });
    activateTab(sideTab.id);
    splitRight();
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);

    const sideStage = document.createElement("div");
    sideStage.className = "pane-stage";
    sideStage.dataset.jxRegion = "pane.secondary";
    document.body.append(sideStage);
    registerCanvasSurface(SECONDARY_PANE, sideStage);
    const sideCanvas = document.createElement("div");
    sideStage.append(sideCanvas);
    await mountIframeCanvas(1, {} as never, sideCanvas, null, sideTab.id);
    const side = channels.at(-1)!;
    side.deliver({ kind: "ready" });
    side.deliver({ gen: 1, kind: "renderComplete" });

    side.deliver({
      after: { textContent: "lo" },
      before: { textContent: "Hi" },
      kind: "editSplit",
      path: ["children", 0],
    });

    // Focus leaves for the primary. The side pane still DISPLAYS the tab this host owes a caret to.
    focusPane(PRIMARY_PANE);
    expect(workspace.activeTabId).not.toBe(sideTab.id);
    side.posts.length = 0;
    side.deliver({ gen: 1, kind: "patchComplete" });

    expect(side.posts).toContainEqual({ kind: "enterEdit", path: ["children", 1] });
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
    const canvasEl = await mountReady();
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
    const { openTab } = await import("../src/workspace/workspace");
    const tabA = activeTab.value!;
    const canvasEl = await mountReady();
    // The user switches to tab B; the host is re-mounted for B but the iframe has NOT acked yet —
    // Its DOM (and any live edit session) still belongs to tab A.
    const tabB = openTab({
      document: { children: [{ tagName: "p", textContent: "B text" }], tagName: "div" },
      id: "tab-b",
    });
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

  test("an in-place prop commit is echo-suppressed — the caret must survive it", async () => {
    // A $props change re-renders the whole instance, which would tear out the nested editing host
    // The user is typing in. This is why the suppression exists, and the next test is why it needs
    // Undoing on release.
    resetWorkspaceWithTab({
      children: [{ $props: { title: "Local" }, tagName: "x-card" }],
      tagName: "div",
    });
    await mountReady();
    channels[0]!.posts.length = 0;
    channels[0]!.deliver({
      inPlace: true,
      kind: "editCommitProp",
      path: ["children", 0],
      prop: "title",
      value: "Regional",
    });
    expect(channels[0]!.posts.filter((m) => m.kind === "patch")).toEqual([]);
  });

  describe("re-rendering the instance when the release commit no-ops", () => {
    /* The tick wrote and its patch was suppressed so the caret would survive; the release then
       posts the SAME string, the apply legitimately declines to transact, and — before this — no
       patch was ever generated. The canvas kept showing pre-edit output while the document held the
       new value: empty a heading and it stays visibly empty, and any second place the component
       renders that prop keeps the old text.

       The decision is tested here rather than the post: postPatchToHosts needs a resolvable stage
       that this harness does not build, and it is covered on its own. What was wrong is the state
       machine — three conditions that have to agree. */
    const AT = '["children",0]';

    test("a suppressed in-place commit followed by a no-op release reconciles", () => {
      expect(needsReleaseReconcile(false, AT, AT)).toBe(true);
    });

    test("a release that DID transact is not reconciled — its own patch already ran", () => {
      expect(needsReleaseReconcile(true, AT, AT)).toBe(false);
    });

    test("a release with nothing suppressed behind it reconciles nothing", () => {
      // Type-and-leave inside the idle window: there was never a suppressed render to make good.
      expect(needsReleaseReconcile(false, null, AT)).toBe(false);
    });

    test("a suppressed commit on a DIFFERENT instance does not reconcile this one", () => {
      // Two prop sessions in a row: the pending path must be matched, not merely present, or
      // Releasing the second would rebuild the first.
      expect(needsReleaseReconcile(false, '["children",1]', AT)).toBe(false);
    });
  });

  test("editCommitProp routes to the ORIGINATING tab when it races a tab switch", async () => {
    const { openTab } = await import("../src/workspace/workspace");
    resetWorkspaceWithTab({
      children: [{ $props: { title: "A title" }, tagName: "x-card" }],
      tagName: "div",
    });
    const tabA = activeTab.value!;
    const canvasEl = await mountReady();
    // Switch to tab B; the host re-mounts for B but the iframe has NOT acked — the in-flight
    // Prop commit still belongs to tab A's session (FIFO drains it before renderComplete(2)).
    const tabB = openTab({
      document: { children: [{ $props: { title: "B title" }, tagName: "x-card" }], tagName: "div" },
      id: "tab-b-prop",
    });
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
    // An editEnd delivered to a channel with no session is a no-op, so this needs no guard.
    for (const ch of channels) {
      ch.deliver({ kind: "editEnd" });
    }
  }

  test("editStart sets editing, makes the active host, and calls the refresh spy", async () => {
    await mountReady();
    expect(getEditSnapshot().editing).toBe(false);

    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    expect(getEditSnapshot().editing).toBe(true);
    expect(getEditSnapshot().editing).toBe(true);
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
    expect(getEditSnapshot().editing).toBe(false);

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

    expect(getEditSnapshot().editing).toBe(false);
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

  test("forwardWheel re-dispatches a wheel on wrap with the deltas and mapped cursor", async () => {
    // RedispatchWheel reads { rect, scale } = hostDragGeometry(state): scale = rect.width /
    // Iframe.clientWidth = 600 / 300 = 2, and rect left/top = 10/20. So clientX = left + x*scale =
    // 10 + 100*2 = 210 and clientY = top + y*scale = 20 + 50*2 = 120 (happy-dom drops the MouseEvent
    // Mixin props on a WheelEvent, so only the deltas/type/target are asserted off the live event).
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")! as HTMLIFrameElement;
    stubRect(iframe, { height: 240, left: 10, top: 20, width: 600 });
    Object.defineProperty(iframe, "clientWidth", { configurable: true, value: 300 });

    /* The wheel is replayed on the stage the FRAME is mounted on, resolved through the artboard
       that owns it — not on "the canvas", which was the focused pane's and is why a wheel out of an
       unfocused pane's iframe used to pan the other one. */
    const { wrap } = surfaceForPane(PRIMARY_PANE);

    const seen: WheelEvent[] = [];
    const onWheel = (event: Event) => seen.push(event as WheelEvent);
    wrap.addEventListener("wheel", onWheel);
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
    wrap.removeEventListener("wheel", onWheel);

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
    // Ack the render for the same reason `mountReady` does: the breakpoint a hit activates is
    // Written onto the tab THIS host renders, and a host adopts that identity on `renderComplete`.
    channels[1]!.deliver({ gen: 1, kind: "renderComplete" });
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

// ─── A hit in an UNFOCUSED pane writes to that pane's document ──────────────────

/* The moment two panes exist, "the tab" stops being one thing. Every doc-touching branch of the
   host's message switch already resolved its target from `state.tabId` — the tab whose document
   THIS iframe's DOM reflects — but three did not: the breakpoint a hit activates, the selection a
   hit sets, and the selection a layoutHit clears. Those three read `activeTab`, so a click in the
   pane the keyboard is NOT in wrote to the other pane's document. That is a data bug, not a layout
   one: the Style panel then edits a compound block belonging to a page nobody clicked. */
describe("hit routing across panes", () => {
  const secondaryPanels = surfaceForPane(SECONDARY_PANE).panels;

  beforeEach(() => {
    resetWorkspaceWithTab({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" });
    secondaryPanels.length = 0;
  });

  /** A live host in the side pane rendering its own tab, with the primary's tab still focused. */
  async function mountBackgroundHost(): Promise<{ tabA: Tab; tabB: Tab; canvasEl: HTMLElement }> {
    const { openTab } = await import("../src/workspace/workspace");
    const tabA = activeTab.value!;
    const tabB = openTab({
      document: { children: [{ tagName: "p", textContent: "B" }], tagName: "div" },
      id: "tab-side-pane",
    });
    // `openTab` focuses what it opens; the point of the test is that the keyboard is elsewhere.
    activateTab(tabA.id);
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, {} as never, canvasEl, null, tabB.id);
    channels[0]!.deliver({ kind: "ready" });
    channels[0]!.deliver({ gen: 1, kind: "renderComplete" });
    return { canvasEl, tabA, tabB };
  }

  test("the breakpoint follows the clicked pane, not the focused one", async () => {
    const { canvasEl, tabA, tabB } = await mountBackgroundHost();
    secondaryPanels.push({ canvas: canvasEl, mediaName: "sm" } as unknown as CanvasPanel);
    // A distinct value rather than the default, so "untouched" cannot be confused with "written
    // The same null the hit would have written".
    tabA.session.ui.activeMedia = "lg";

    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });

    expect(tabB.session.ui.activeMedia).toBe("sm");
    expect(tabA.session.ui.activeMedia).toBe("lg");
  });

  test("the selection a hit sets lands on the host's tab, never on the focused tab", async () => {
    const { tabA, tabB } = await mountBackgroundHost();

    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });

    expect(tabB.session.selection).toEqual([["children", 0]]);
    expect(tabA.session.selection).toEqual([]);
  });

  test("a layoutHit clears the host tab's selection and leaves the focused tab's alone", async () => {
    const { tabA, tabB } = await mountBackgroundHost();
    tabA.session.selection = [["children", 0]];
    tabB.session.selection = [["children", 0]];

    channels[0]!.deliver({
      hit: {
        layoutFile: "layouts/base.json",
        path: ["$layout", "children", 0],
        rect: { height: 1, width: 1, x: 0, y: 0 },
      },
      kind: "layoutHit",
    });

    expect(tabB.session.selection).toEqual([]);
    expect(tabA.session.selection).toEqual([["children", 0]]);
  });

  test("a dataScope snapshot is filed under the tab the host rendered", async () => {
    const { tabA, tabB } = await mountBackgroundHost();

    channels[0]!.deliver({ gen: 1, kind: "dataScope", scope: { posts: "3 items" } });

    expect(tabB.session.canvas.scope).toEqual({ posts: "3 items" });
    expect(tabA.session.canvas.scope).toBeNull();
  });

  /*
   * A RIGHT-click was the one gesture that still edited the other pane's document.
   *
   * `contextmenu` does not fire `click`, so `hit` — where the pane focus moves — never arrives, and
   * `contextMenu` was the only message a right-click delivered. `editor/canvas-context-menu.ts`
   * reads `activeTab.value?.doc.document` to bubble the path, and `editor/context-menu.ts` then
   * WRITES `tab.session.selection = [path]` on that document before deciding which rows to show.
   * So a right-click in the side pane moved the primary pane's selection to a path from a different
   * document and built Duplicate/Delete/Wrap against it — and when the focused document had no such
   * path, the menu returned early and the right-click did nothing at all, silently.
   */
  /**
   * {@link mountBackgroundHost}, plus the real second pane the focus can actually move into.
   *
   * `focusPane` is a lookup in `workspace.panes` — with one pane there is nowhere for the focus to
   * go, and every one of these assertions would pass by accident.
   */
  async function mountSplitBackgroundHost() {
    const { focusPane, openTab, splitRight } = await import("../src/workspace/workspace");
    const tabA = activeTab.value!;
    const tabB = openTab({
      document: { children: [{ tagName: "p", textContent: "B" }], tagName: "div" },
      id: "tab-side-pane",
    });
    // `splitRight` carries the FOCUSED tab into the new pane, so the split happens while tabB is.
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    focusPane(PRIMARY_PANE);
    activateTab(tabA.id);

    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, {} as never, canvasEl, null, tabB.id);
    channels[0]!.deliver({ kind: "ready" });
    channels[0]!.deliver({ gen: 1, kind: "renderComplete" });
    secondaryPanels.push({ canvas: canvasEl, mediaName: "base" } as unknown as CanvasPanel);
    return { canvasEl, tabA, tabB };
  }

  test("a right-click in the side pane focuses it before the menu is built", async () => {
    const { tabA } = await mountSplitBackgroundHost();
    const paths: unknown[] = [];
    setCanvasContextMenuHandler({
      dismiss: () => {},
      // Read the focus AT SHOW TIME — this is exactly what the real handler does.
      show: (arg) => paths.push([workspace.activePaneId, activeTab.value?.id, arg.path]),
    });

    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    channels[0]!.deliver({ kind: "contextMenu", path: ["children", 0], x: 5, y: 7 });

    console.log(`[iframe-host] right-click in the side pane → ${JSON.stringify(paths)}`);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    expect(paths).toEqual([[SECONDARY_PANE, "tab-side-pane", ["children", 0]]]);
    expect(tabA.id).not.toBe("tab-side-pane");
    setCanvasContextMenuHandler({ dismiss: () => {}, show: () => {} });
  });

  /*
   * The other half of the same seam. `hit` is not posted in PREVIEW at all (a click there is a
   * click on the page), and in edit/design it is only posted when the click lands ON a
   * `[data-jx-path]` node — so a Preview pane could not be focused by clicking what it is showing,
   * and an artboard's empty margin focused nothing either. `paneFocus` carries nothing but "a
   * pointer went down in this frame", which is why it is safe to send from preview.
   */
  test("`paneFocus` focuses the pane, and is not refused by a preview host", async () => {
    const { canvasEl, tabA } = await mountSplitBackgroundHost();
    // Re-mount this host in PREVIEW: every message in `PREVIEW_BLOCKED` is dropped from it —
    // `hit` and `contextMenu` among them — and this one must survive that gate.
    (resolved.mapperCtx as { canvasMode: string }).canvasMode = "preview";
    await mountIframeCanvas(2, {} as never, canvasEl, null, "tab-side-pane");
    activateTab(tabA.id);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);

    // A click on a node would be a `hit`, and preview refuses it — so this is the ONLY signal.
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 1, width: 1, x: 0, y: 0 } },
      kind: "hit",
    });
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);

    channels[0]!.deliver({ kind: "paneFocus" });
    console.log(`[iframe-host] paneFocus from a PREVIEW host → focus=${workspace.activePaneId}`);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
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
    const canvasEl = await mountReady();
    channels[0]!.posts.length = 0;
    // On a STAGE, because the generation a patch carries is the stage's — see the finding-9 test
    // In `canvas-idle.test.ts` for what a host with no resolvable stage is answered with now.
    canvasPanels.push({ canvas: canvasEl, ready: true } as unknown as CanvasPanel);
    const ops: WireDocOp[] = [
      { key: "textContent", op: "set-key", path: ["children", 0], value: "x" },
    ];
    expect(postPatchToHosts(ops, "some-other-tab")).toBe(0);
    expect(channels[0]!.posts.some((p) => p.kind === "patch")).toBe(false);
    // …while the owning tab's patches go through.
    expect(postPatchToHosts(ops, activeTab.value!.id)).toBe(1);
    canvasPanels.length = 0;
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
    expect(activeTab.value?.session.selection).toEqual([]);
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
    shell.stylebook.selection = "p";
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

    shell.stylebook.selection = "p";
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
    shell.stylebook.selection = "table";
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
    registerPrimaryStage();

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
    expect(activeTab.value?.session.selection).toEqual([SPECIMEN_PATH]);
  });
});

// ─── External file drops (flow 5) ─────────────────────────────────────────────

describe("external file drop dispatch", () => {
  const hit = (tagName: string) => ({
    path: ["children", 0],
    rect: { height: 20, width: 100, x: 10, y: 5 },
    tagName,
  });
  const preview = () => ({
    edge: "top",
    instruction: "reorder-above",
    referenceRect: { height: 20, width: 100, x: 0, y: 40 },
    targetPath: ["children", 1],
  });

  beforeEach(() => {
    resetWorkspaceWithTab();
    setFileDropHandler(() => {});
  });

  test("hovering an image shows the replace highlight, not the insert indicator", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ hit: hit("img"), kind: "fileDragOver", preview: preview() });

    const replace = canvasEl.querySelector(".canvas-replace-target") as HTMLElement;
    const drop = canvasEl.querySelector(".canvas-drop-indicator") as HTMLElement;
    expect(replace.style.display).toBe("block");
    // The two answer different questions; showing both at once would be ambiguous.
    expect(drop.style.display).toBe("none");
  });

  test("hovering anything else shows the insert indicator", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ hit: hit("div"), kind: "fileDragOver", preview: preview() });

    expect((canvasEl.querySelector(".canvas-replace-target") as HTMLElement).style.display).toBe(
      "none",
    );
    expect((canvasEl.querySelector(".canvas-drop-indicator") as HTMLElement).style.display).toBe(
      "block",
    );
  });

  test("fileDragLeave clears both affordances", async () => {
    const canvasEl = await mountReady();
    channels[0]!.deliver({ hit: hit("img"), kind: "fileDragOver", preview: preview() });
    channels[0]!.deliver({ kind: "fileDragLeave" });

    expect((canvasEl.querySelector(".canvas-replace-target") as HTMLElement).style.display).toBe(
      "none",
    );
    expect((canvasEl.querySelector(".canvas-drop-indicator") as HTMLElement).style.display).toBe(
      "none",
    );
  });

  test("fileDrop routes the files, hit and preview to the injected handler", async () => {
    const calls: Msg[] = [];
    setFileDropHandler((tab, files, dropHit, dropPreview) => {
      calls.push({ dropHit, dropPreview, files, tab });
    });
    const canvasEl = await mountReady();
    const file = new File(["x"], "a.png");

    channels[0]!.deliver({ files: [file], hit: hit("img"), kind: "fileDrop", preview: preview() });

    expect(calls).toHaveLength(1);
    // The drop routes to the host's OWN tab, not activeTab at message time.
    expect(calls[0]!.tab).toBe(activeTab.value);
    expect(calls[0]!.files).toEqual([file]);
    expect(calls[0]!.dropHit).toMatchObject({ tagName: "img" });
    // The affordance clears on drop, before the async upload starts.
    expect((canvasEl.querySelector(".canvas-replace-target") as HTMLElement).style.display).toBe(
      "none",
    );
  });

  test("a specimen catalog is never a file-drop target", async () => {
    const calls: Msg[] = [];
    setFileDropHandler((_tab, files) => {
      calls.push({ files });
    });
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    mountStylebookCanvas(
      9,
      { doc: { children: [], tagName: "div" }, pathToTag: new Map(), tagToCardPath: new Map() },
      canvasEl,
      480,
    );
    const channel = channels.at(-1)!;
    channel.deliver({ kind: "ready" });
    channel.deliver({ gen: 9, kind: "renderComplete" });

    channel.deliver({ hit: hit("img"), kind: "fileDragOver", preview: preview() });
    channel.deliver({ files: [new File(["x"], "a.png")], hit: null, kind: "fileDrop" });

    expect(calls).toEqual([]);
    expect((canvasEl.querySelector(".canvas-replace-target") as HTMLElement).style.display).toBe(
      "none",
    );
  });

  test("the canvas gutter accepts a file drop and appends to the root", async () => {
    const calls: Msg[] = [];
    setFileDropHandler((_tab, files, dropHit, dropPreview) => {
      calls.push({ dropHit, dropPreview, files });
    });
    const canvasEl = await mountReady();
    const file = new File(["x"], "a.png");

    const over = new MouseEvent("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", {
      value: { dropEffect: "none", files: [], types: ["Files"] },
    });
    canvasEl.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    const drop = new MouseEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file], types: ["Files"] } });
    canvasEl.dispatchEvent(drop);

    expect(calls).toHaveLength(1);
    // No position resolved on the gutter — the handler appends to the document root.
    expect(calls[0]!.dropHit).toBeNull();
    expect(calls[0]!.dropPreview).toBeNull();
  });

  test("a non-file drag over the gutter is left alone", async () => {
    const canvasEl = await mountReady();
    const over = new MouseEvent("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: { types: ["text/plain"] } });
    canvasEl.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
  });
});

// ─── Caret.active across the bridge ─────────────────────────────────────────────
// The inline-edit session runs inside the cross-origin canvas frame, so the parent bundle's own
// IsEditing() is permanently false. The host derives the answer from the three messages the bridge
// Already carries, and the editor's ⌘C/⌘X/⌘V guard reads it.

describe("isCaretActive", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  test("false with no session", async () => {
    await mountReady();
    expect(isCaretActive()).toBe(false);
  });

  test("editStart opens it and editEnd closes it", async () => {
    await mountReady();
    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    expect(isCaretActive()).toBe(true);
    channels[0]!.deliver({ kind: "editEnd" });
    expect(isCaretActive()).toBe(false);
  });

  test("a selectionChanged snapshot alone proves the caret is live", async () => {
    // A snapshot only ever posts from a live session, so it recovers the flag if the editStart that
    // Opened the session never landed.
    await mountReady();
    channels[0]!.deliver({
      activeTags: [],
      collapsed: false,
      kind: "selectionChanged",
      link: { active: false, href: null },
      localScope: null,
      path: ["children", 0],
      rect: null,
      seq: 1,
    });
    expect(isCaretActive()).toBe(true);
    channels[0]!.deliver({ kind: "editEnd" });
    expect(isCaretActive()).toBe(false);
  });

  test("a frame torn down mid-session cannot latch the flag on", async () => {
    // No editEnd ever arrives when the iframe goes away with the caret in it (a mode switch, a
    // Closed tab) — a stored boolean would go on stealing ⌘C forever.
    const canvasEl = await mountReady();
    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    expect(isCaretActive()).toBe(true);
    canvasEl.remove();
    expect(isCaretActive()).toBe(false);
  });
});

// ─── Preview is truthful ────────────────────────────────────────────────────────
// Preview must behave like the shipped page: nothing selectable, nothing outlined, nothing
// Droppable, and a frame that scrolls its own document instead of being grown to its content.

describe("preview renders", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
    resolved.mapperCtx = { ...(resolved.mapperCtx as object), canvasMode: "preview" };
  });

  /** Mount a ready host whose render mode is preview. */
  async function mountPreview(): Promise<HTMLElement> {
    return mountReady();
  }

  test("the overlay layer is suppressed, and restored by the next editable render", async () => {
    const canvasEl = await mountPreview();
    const overlay = canvasEl.querySelector(".jx-canvas-iframe-overlay") as HTMLElement;
    expect(overlay.style.display).toBe("none");

    resolved.mapperCtx = { ...(resolved.mapperCtx as object), canvasMode: "design" };
    await mountIframeCanvas(2, {} as never, canvasEl, null, activeTab.value?.id ?? null);
    expect(overlay.style.display).toBe("");
  });

  test("a hit selects nothing", async () => {
    const canvasEl = await mountPreview();
    channels[0]!.deliver({
      hit: { path: ["children", 0], rect: { height: 20, width: 100, x: 10, y: 5 } },
      kind: "hit",
    });
    expect(activeTab.value?.session.selection).toEqual([]);
    const sel = canvasEl.querySelector(".overlay-selection") as HTMLElement;
    expect(sel.style.display).toBe("none");
  });

  test("hover draws no box", async () => {
    const canvasEl = await mountPreview();
    channels[0]!.deliver({
      hit: { path: ["children", 1], rect: { height: 8, width: 40, x: 2, y: 3 } },
      kind: "hover",
    });
    expect((canvasEl.querySelector(".overlay-hover") as HTMLElement).style.display).toBe("none");
  });

  test("no insertion +", async () => {
    const canvasEl = await mountPreview();
    channels[0]!.deliver({
      kind: "insertZones",
      zones: [
        {
          edge: "top",
          index: 0,
          parentPath: [],
          rect: { height: 0, width: 100, x: 0, y: 0 },
        },
      ],
    });
    expect((canvasEl.querySelector(".insertion-helper") as HTMLElement).style.display).toBe("none");
  });

  test("the Jx context menu never opens", async () => {
    let shown = 0;
    setCanvasContextMenuHandler({
      dismiss: () => {},
      show: () => {
        shown += 1;
      },
    });
    await mountPreview();
    channels[0]!.deliver({ kind: "contextMenu", path: ["children", 0], x: 5, y: 6 });
    expect(shown).toBe(0);
  });

  test("an inline-edit session cannot start, so no caret is reported", async () => {
    await mountPreview();
    channels[0]!.deliver({ kind: "editStart", path: ["children", 0] });
    expect(isCaretActive()).toBe(false);
  });

  test("a file drop is refused", async () => {
    let calls = 0;
    setFileDropHandler(async () => {
      calls += 1;
    });
    await mountPreview();
    channels[0]!.deliver({ files: [], hit: null, kind: "fileDrop", preview: null });
    expect(calls).toBe(0);
  });

  test("the frame stays a real viewport instead of growing to its content", async () => {
    const canvasEl = await mountPreview();
    const iframe = canvasEl.querySelector("iframe")!;
    channels[0]!.deliver({ fragment: false, height: 4000, kind: "contentHeight" });
    expect(iframe.style.height).toBe("100%");
    expect(iframe.style.minHeight).toBe("0px");
  });
});

// ─── The preview flag and the frame box are ONE state transition ────────────────
// Frame sizing has two inputs on two different clocks: the render mode (synchronous, decided by the
// Renderer) and the content measurement (asynchronous, posted by the iframe — and DEDUPED by it, so
// An unchanged measurement produces no message at all). Before this was derived rather than
// Incremental, an entering-preview render whose measurement had already landed stayed content-sized
// Forever: there was no second message to correct it. The camera caught it; a user switching into
// Preview loses the same race.

describe("preview frame sizing is derived, not incremental", () => {
  beforeEach(() => {
    resetWorkspaceWithTab();
  });

  test("entering preview re-sizes the frame from the retained measurement, with no new message", async () => {
    // Design render: the iframe measures its content and the frame grows to it.
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    channels[0]!.deliver({ fragment: false, height: 1234, kind: "contentHeight" });
    expect(iframe.style.height).toBe("1234px");

    // Switch the SAME host to preview. The iframe posts nothing: its measurement is unchanged, and
    // It only posts on a change. The frame must still become a real viewport.
    resolved.mapperCtx = { ...(resolved.mapperCtx as object), canvasMode: "preview" };
    await mountIframeCanvas(2, {} as never, canvasEl, null, activeTab.value?.id ?? null);
    expect(iframe.style.height).toBe("100%");
    expect(iframe.style.minHeight).toBe("0px");
  });

  test("leaving preview restores the content-sized frame from the retained measurement", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    channels[0]!.deliver({ fragment: false, height: 1234, kind: "contentHeight" });

    resolved.mapperCtx = { ...(resolved.mapperCtx as object), canvasMode: "preview" };
    await mountIframeCanvas(2, {} as never, canvasEl, null, activeTab.value?.id ?? null);
    expect(iframe.style.height).toBe("100%");

    resolved.mapperCtx = { ...(resolved.mapperCtx as object), canvasMode: "design" };
    await mountIframeCanvas(3, {} as never, canvasEl, null, activeTab.value?.id ?? null);
    expect(iframe.style.height).toBe("1234px");
    expect(iframe.style.minHeight).toBe("480px");
  });

  test("a measurement that lands mid-resolve is re-answered under the mode that actually renders", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;

    // Hold the next mount's document resolution open — this is the window in which the host does
    // Not yet know the incoming mode.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const previewResolved = {
      ...resolved,
      mapperCtx: { ...(resolved.mapperCtx as object), canvasMode: "preview" },
    };
    void mock.module("../src/canvas/canvas-live-render", () => ({
      resolveCanvasDocument: async () => {
        await gate;
        return previewResolved;
      },
    }));

    const mounting = mountIframeCanvas(4, {} as never, canvasEl, null, activeTab.value?.id ?? null);
    // Mid-resolve the iframe measures and posts. The host has not adopted the preview flag yet.
    channels[0]!.deliver({ fragment: false, height: 4000, kind: "contentHeight" });
    release!();
    await mounting;

    expect(iframe.style.height).toBe("100%");
    expect(iframe.style.minHeight).toBe("0px");

    // Restore the shared stub for the rest of the file.
    void mock.module("../src/canvas/canvas-live-render", () => ({
      resolveCanvasDocument: () => {
        resolveCalls += 1;
        return Promise.resolve(resolved);
      },
    }));
  });

  test("adoptCanvasPreviewMode sizes the frame synchronously, before any mount awaits", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    channels[0]!.deliver({ fragment: false, height: 1234, kind: "contentHeight" });
    expect(iframe.style.height).toBe("1234px");

    // No await between the declaration and the assertion: this is the whole point of the seam.
    adoptCanvasPreviewMode(canvasEl, true);
    expect(iframe.style.height).toBe("100%");
    expect(iframe.style.minHeight).toBe("0px");

    adoptCanvasPreviewMode(canvasEl, false);
    expect(iframe.style.height).toBe("1234px");
  });

  test("a fragment measurement keeps its dropped floor across a preview round trip", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    channels[0]!.deliver({ fragment: true, height: 300, kind: "contentHeight" });
    expect(iframe.style.minHeight).toBe("0px");

    adoptCanvasPreviewMode(canvasEl, true);
    adoptCanvasPreviewMode(canvasEl, false);
    expect(iframe.style.height).toBe("300px");
    expect(iframe.style.minHeight).toBe("0px");
  });

  test("before any measurement, leaving preview leaves the cssText defaults alone", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    adoptCanvasPreviewMode(canvasEl, true);
    expect(iframe.style.minHeight).toBe("0px");
    adoptCanvasPreviewMode(canvasEl, false);
    // Nothing measured, so there is nothing to restore — the frame keeps whatever preview left it
    // At rather than inventing a height.
    expect(iframe.style.height).toBe("100%");
  });
});

// ─── releaseCanvasHosts ───────────────────────────────────────────────────────

/*
 * The one NON-lazy path out of `liveHosts`, and the reason a pane can go away without leaking.
 *
 * Eleven sites prune a disconnected host when they happen to walk the set. That is enough to stop a
 * dead frame being POSTED to and is not enough to release it: `iframe-channel.ts` adds a `window`
 * "message" listener that only `dispose()` removes, and until this landed the sole parent-side
 * `dispose()` was the URL-change rebuild in `ensureHost`. So every mode transition — which detaches
 * every artboard — and every closed pane left one live listener and one overlay subtree per frame,
 * for the life of the window.
 *
 * "Stopped iterating" and "disposed" are different states, and only the second is what a teardown
 * owes. These assertions distinguish them: the channel says it was disposed, the iframe and the
 * overlay are out of the DOM, and a second release finds nothing left to do.
 */
describe("releaseCanvasHosts", () => {
  test("disposes the channel, removes the frame and the overlay, and says how many", async () => {
    const stage = document.createElement("div");
    document.body.append(stage);
    const canvasEl = document.createElement("div");
    stage.append(canvasEl);

    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    channels[0]!.deliver({ kind: "ready" });
    const iframe = canvasEl.querySelector("iframe")!;
    expect(iframe.isConnected).toBe(true);
    expect(channels[0]!.disposed).toBeFalsy();

    expect(releaseCanvasHosts(stage)).toBe(1);

    // Not "the variable was nulled": the channel was disposed and the DOM is gone.
    expect(channels[0]!.disposed).toBe(true);
    expect(iframe.isConnected).toBe(false);
    expect(canvasEl.querySelector("iframe")).toBeNull();
    expect(canvasEl.querySelector(".jx-canvas-iframe-overlay")).toBeNull();
    // And the host is out of `liveHosts`, so nothing posts to it again.
    expect(releaseCanvasHosts(stage)).toBe(0);
  });

  test("releases only the hosts under the root it was given", async () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.append(a, b);
    const canvasA = document.createElement("div");
    const canvasB = document.createElement("div");
    a.append(canvasA);
    b.append(canvasB);

    await mountIframeCanvas(1, { tagName: "div" } as never, canvasA);
    await mountIframeCanvas(2, { tagName: "div" } as never, canvasB);
    expect(channels).toHaveLength(2);

    // Unsplitting releases ONE pane's frames. A release that took both would tear down the pane
    // That is still on screen — which is exactly what a `liveHosts.clear()` would have done.
    expect(releaseCanvasHosts(a)).toBe(1);
    expect(channels[0]!.disposed).toBe(true);
    expect(channels[1]!.disposed).toBeFalsy();
    expect(canvasB.querySelector("iframe")).toBeTruthy();

    expect(releaseCanvasHosts(b)).toBe(1);
    expect(channels[1]!.disposed).toBe(true);
  });

  test("a mounted-then-released host leaves no idle blocker behind", async () => {
    const stage = document.createElement("div");
    document.body.append(stage);
    const canvasEl = document.createElement("div");
    stage.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    // Un-acked: `pendingTabIds` holds gen 1, which `canvasIdleBlockers()` reports.
    expect(canvasIdleBlockers().length).toBeGreaterThan(0);
    releaseCanvasHosts(stage);
    // The assertion the `screenshots` lane depends on, and its single hard-red failure mode.
    expect(canvasIdleBlockers()).toEqual([]);
  });
});

// ─── Selection and presence are per-pane fan-outs ───────────────────────────────

describe("selection measures are routed by the host's own tab", () => {
  beforeEach(() => {
    resetWorkspaceWithTab({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" });
  });

  /** The `measure` posts a channel received, as bare path arrays. */
  const measures = (channel: FakeChannel) =>
    channel.posts.filter((p) => p.kind === "measure").map((p) => p.paths);

  /**
   * Two panes, each with a live host on its own tab, and the keyboard in the primary.
   *
   * This is the arrangement the whole defect needs: with ONE pane, "the focused tab" and "this
   * host's tab" are the same answer and the missing filter is invisible.
   */
  async function twoPanesTwoHosts() {
    const { focusPane, openTab, splitRight } = await import("../src/workspace/workspace");
    const tabA = activeTab.value!;
    const tabB = openTab({
      document: { children: [{ tagName: "p", textContent: "B" }], tagName: "div" },
      id: "tab-sel-side",
    });
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    focusPane(PRIMARY_PANE);

    const elA = document.createElement("div");
    const elB = document.createElement("div");
    document.body.append(elA, elB);
    await mountIframeCanvas(1, {} as never, elA, null, tabA.id);
    const chA = channels.at(-1)!;
    chA.deliver({ kind: "ready" });
    chA.deliver({ gen: 1, kind: "renderComplete" });
    await mountIframeCanvas(2, {} as never, elB, null, tabB.id);
    const chB = channels.at(-1)!;
    chB.deliver({ kind: "ready" });
    chB.deliver({ gen: 2, kind: "renderComplete" });
    chA.posts.length = 0;
    chB.posts.length = 0;
    return { chA, chB, elA, elB, tabA, tabB };
  }

  /** What a host believes it has selected — the bookkeeping the foreign paths used to overwrite. */
  const selectionOf = (el: HTMLElement) =>
    (hostForCanvas(el) as unknown as { selectionPaths: unknown[] } | null)?.selectionPaths;

  test("the focused pane's selection is measured in its own frame and in no other", async () => {
    /* `ensureSelectionWatch` read `activeTab` and posted to every entry in `liveHosts` with no
       `host.tabId === tab.id` gate — unlike `postPatchToHosts`, `requestCanvasEval` and
       `flushCanvasEdits`, which all filter. The side pane's frame was asked to measure paths from a
       document it is not showing, and its own `selectionPath`/`selectionPaths` were overwritten
       with them. */
    const { chA, chB, elA, elB, tabA } = await twoPanesTwoHosts();

    tabA.session.selection = [["children", 0]];
    await flush();

    console.log(
      `[iframe-host] measures posted to the primary frame: ${JSON.stringify(measures(chA))}  ` +
        `to the SIDE frame: ${JSON.stringify(measures(chB))}`,
    );
    expect(measures(chA)).toEqual([[["children", 0]]]);
    expect(measures(chB)).toEqual([]);
    expect(selectionOf(elA)).toEqual([["children", 0]]);
    expect(selectionOf(elB)).toEqual([]);
  });

  test("the UNFOCUSED pane can show a selection of its own", async () => {
    /* The other half, and the worse one: `requestSelection`'s `if (!primary)` branch clears the
       overlay, so the focused pane merely having nothing selected erased the side pane's box on
       every pass. The unfocused pane could never draw a selection at all. */
    const { chA, chB, elA, elB, tabA, tabB } = await twoPanesTwoHosts();

    tabA.session.selection = [];
    tabB.session.selection = [["children", 1]];
    await flush();

    expect(measures(chB)).toEqual([[["children", 1]]]);
    expect(measures(chA)).toEqual([]);
    // And each host's own bookkeeping is its own document's, not the focused pane's.
    expect(selectionOf(elB)).toEqual([["children", 1]]);
    expect(selectionOf(elA)).toEqual([]);
  });
});

describe("a released host takes its edit session with it", () => {
  beforeEach(() => {
    resetWorkspaceWithTab({ children: [{ tagName: "p", textContent: "A" }], tagName: "div" });
  });

  test("releasing the host ends the session instead of leaving a toolbar over nothing", async () => {
    /* `releaseHost` cleared the channel, the overlay, the frame, every pending reply and both
       registries — and left `activeEditHost` pointing at the host it had just destroyed. Unsplit a
       pane with a live inline-edit caret and `getEditSnapshot()` still answered `editing: true`, so
       the format toolbar stayed up anchored to a detached frame, and `commitActiveEditSession()`
       posted through `iframe.contentWindow?.postMessage` on a removed frame — optional-chained, so
       the author's edit was lost without a word. */
    const stage = document.createElement("div");
    document.body.append(stage);
    const canvasEl = document.createElement("div");
    stage.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    const channel = channels.at(-1)!;
    channel.deliver({ kind: "ready" });
    channel.deliver({ kind: "editStart", path: ["children", 0] });

    expect(getEditSnapshot().editing).toBe(true);
    expect(isCaretActive()).toBe(true);

    expect(releaseCanvasHosts(stage)).toBe(1);

    expect(getEditSnapshot()).toEqual({ editing: false, editingProp: null, snapshot: null });
    expect(isCaretActive()).toBe(false);
    // And the commit does not pretend: no `endEdit` is posted into a frame that cannot receive it.
    channel.posts.length = 0;
    commitActiveEditSession();
    expect(channel.posts).toEqual([]);
  });

  test("a pending '+' grace timer is cancelled with the host", async () => {
    const stage = document.createElement("div");
    document.body.append(stage);
    const canvasEl = document.createElement("div");
    stage.append(canvasEl);
    await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
    const channel = channels.at(-1)!;
    channel.deliver({ kind: "ready" });
    channel.deliver({
      kind: "insertZones",
      zones: [
        {
          edge: "top",
          index: 1,
          insertParentPath: ["children", 0],
          rect: { height: 0, width: 300, x: 10, y: 200 },
        },
      ],
    });
    // A null post arms the grace timer rather than hiding at once.
    channel.deliver({ kind: "insertZones", zones: null });
    const host = hostForCanvas(canvasEl) as unknown as {
      insertHideTimer: ReturnType<typeof setTimeout> | null;
    };
    expect(host.insertHideTimer).not.toBeNull();

    releaseCanvasHosts(stage);

    // A timer holding a released host is a callback that will run against a dead overlay.
    expect(host.insertHideTimer).toBeNull();
  });
});
