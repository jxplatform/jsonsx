import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { flush, resetWorkspaceWithTab, stubRect } from "./harness";
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
void mock.module("../src/canvas/canvas-live-render", () => ({
  resolveCanvasDocument: () => Promise.resolve(resolved),
}));

const {
  adoptDragSession,
  beginDragSession,
  clearDropIndicator,
  currentDragSession,
  endDragSession,
  getActiveEditHost,
  getEditBarAnchorRect,
  getEditSnapshot,
  hostDragGeometry,
  hostForCanvas,
  liveDragHostAt,
  mountIframeCanvas,
  postApplyFormat,
  postDragMessage,
  postPatchToHosts,
  setIframeOriginateHandler,
  setIframePatchEscalation,
  setInsertZoneClickHandler,
  setToolbarRefresh,
} = await import("../src/canvas/iframe-host");

beforeEach(() => {
  channels.length = 0;
  document.body.innerHTML = "";
  resolved = structuredClone(DEFAULT_RESOLVED);
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
  await mountIframeCanvas(1, {} as never, canvasEl);
  channels[0]!.deliver({ kind: "ready" });
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

    const count = postPatchToHosts(OPS, 7);
    expect(count).toBe(1);
    expect(channels[0]!.posts).toContainEqual({ forwardOps: OPS, gen: 7, kind: "patch" });
  });

  test("postPatchToHosts returns 0 when no host is ready, so the caller escalates", async () => {
    const canvasEl = document.createElement("div");
    document.body.append(canvasEl);
    await mountIframeCanvas(1, {} as never, canvasEl);
    // No `ready` delivered → the host can't apply a patch yet.
    expect(postPatchToHosts(OPS, 1)).toBe(0);
    expect(channels[0]!.posts.some((p) => p.kind === "patch")).toBe(false);
  });

  test("postPatchToHosts drops a host whose iframe has been disconnected", async () => {
    const canvasEl = await mountReady();
    canvasEl.remove(); // Detach the canvas → the iframe is no longer connected.
    expect(postPatchToHosts(OPS, 1)).toBe(0);
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

  test("editSplit applies and asks the iframe to re-enter on the new paragraph", async () => {
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
    expect(channels[0]!.posts).toContainEqual({ kind: "enterEdit", path: ["children", 1] });
  });

  test("editInsert applies and re-enters on the resulting path", async () => {
    await mountReady();
    channels[0]!.posts.length = 0;
    channels[0]!.deliver({
      cmd: { tag: "h2" },
      commitData: { textContent: "Hi" },
      kind: "editInsert",
      path: ["children", 0],
    });
    expect(docChildren()[1]!.tagName).toBe("h2");
    expect(channels[0]!.posts).toContainEqual({ kind: "enterEdit", path: ["children", 1] });
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

  test("dragOriginate routes to the installed coordinator handler with the host + path + seq", async () => {
    const { host } = await readyHostAt(4);
    const seen: { host: unknown; path: unknown; seq: unknown }[] = [];
    setIframeOriginateHandler((h, p, s) => seen.push({ host: h, path: p, seq: s }));
    channels[0]!.deliver({ dragSeq: 11, kind: "dragOriginate", path: ["children", 0] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.host).toBe(host as never);
    expect(seen[0]!.path).toEqual(["children", 0]);
    // The iframe's seq is threaded through so the parent can adopt it (replies pass the seq gate).
    expect(seen[0]!.seq).toBe(11);
    setIframeOriginateHandler(() => {});
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

  test("contentHeight sizes the host iframe element to the document height", async () => {
    const canvasEl = await mountReady();
    const iframe = canvasEl.querySelector("iframe")!;
    channels[0]!.deliver({ height: 1234, kind: "contentHeight" });
    expect(iframe.style.height).toBe("1234px");
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

  test("mounting neutralizes a sibling .canvas-panel-click catcher (pointer-events:none)", async () => {
    // The legacy hit-test catcher is a positioned sibling of the canvas (under the canvas's parent).
    // On mount the host must set its pointer-events to none so it no longer eats clicks/wheel before
    // The iframe — which now owns hit-testing and native scrolling — can see them.
    const parent = document.createElement("div");
    const catcher = document.createElement("div");
    catcher.className = "canvas-panel-click";
    const canvasEl = document.createElement("div");
    parent.append(catcher, canvasEl);
    document.body.append(parent);

    await mountIframeCanvas(1, {} as never, canvasEl);
    expect(catcher.style.pointerEvents).toBe("none");
  });
});

/** Opaque host handle for the drag-session API tests (its internals aren't asserted directly). */
type AnyHost = Parameters<typeof beginDragSession>[0];
