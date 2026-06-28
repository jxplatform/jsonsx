import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { flush, resetWorkspaceWithTab, stubRect } from "./harness";
import { activeTab } from "../src/workspace/workspace";
import { canvasPanels } from "../src/store";
import type { WireDocOp } from "../src/canvas/iframe-protocol";
import type { CanvasPanel } from "../src/panels/canvas-dnd";

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
  getActiveEditHost,
  getEditBarAnchorRect,
  getEditSnapshot,
  mountIframeCanvas,
  postApplyFormat,
  postPatchToHosts,
  setIframePatchEscalation,
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
    expect(iframe!.getAttribute("src")).toMatch(
      /\/packages\/studio\/canvas\.html\?parentOrigin=.+&token=.+/,
    );
    expect(channels).toHaveLength(1);
    // Not ready yet → the render is queued, not posted.
    expect(channels[0]!.posts).toHaveLength(0);

    channels[0]!.deliver({ kind: "ready" });
    expect(channels[0]!.posts).toHaveLength(1);
    expect(channels[0]!.posts[0]).toMatchObject({ gen: 1, kind: "render", mode: "design" });
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
