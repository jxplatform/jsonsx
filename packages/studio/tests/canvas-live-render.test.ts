/**
 * Canvas live render — drives renderCanvasLive end-to-end with the real @jxsuite/runtime in
 * happy-dom: design/preview/edit rendering, path mapping ($map remaps, layout prefix stripping),
 * layout wrapping with slot distribution, $elements registration (packages, $refs, failure cache),
 * content-mode component auto-discovery, site style/head injection, render-generation staleness
 * bail-outs, error fallback, and panel context persistence.
 */
import { flush, installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  activeLayoutPath,
  initCanvasLiveRender,
  layoutElements,
  makePathMapper,
  renderCanvasLive,
} from "../src/canvas/canvas-live-render";
import { elToPath, elToScope } from "../src/store";
import { view } from "../src/view";
import { invalidateLayoutCache } from "../src/site-context";
import { loadComponentRegistry } from "../src/files/components";
import { closeAllTabs } from "../src/workspace/workspace";

import type { JxMutableNode } from "@jxsuite/schema/types";
import type { CanvasPanel } from "../src/types";
import type { Tab } from "../src/tabs/tab";

// Happy-dom defaults to about:blank (origin "null"), which breaks docBase-relative URL math.
const { happyDOM } = globalThis as unknown as {
  happyDOM: { setURL: (u: string) => void; settings: Record<string, unknown> };
};
happyDOM.setURL("http://localhost:3000/");
// Appended <script src>/<link href> must not hit the network or throw on connect.
happyDOM.settings.disableJavaScriptFileLoading = true;
happyDOM.settings.disableCSSFileLoading = true;
happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;

let canvasMode = "design";
const realFetch = globalThis.fetch;

/** Viewport > (optional .content-edit-canvas) > canvas, attached to the body. */
function makeCanvas(editWrap = false) {
  const viewport = document.createElement("div");
  viewport.className = "canvas-panel-viewport";
  let host: HTMLElement = viewport;
  if (editWrap) {
    const wrap = document.createElement("div");
    wrap.className = "content-edit-canvas";
    viewport.append(wrap);
    host = wrap;
  }
  const canvas = document.createElement("div");
  host.append(canvas);
  document.body.append(viewport);
  return { canvas, editSurface: editWrap ? host : null, viewport };
}

interface RenderOpts {
  documentPath?: string;
  mode?: string;
  editWrap?: boolean;
  panel?: CanvasPanel | null;
}

async function renderDoc(docDef: JxMutableNode, opts: RenderOpts = {}) {
  const tab = resetWorkspaceWithTab(docDef, {
    documentPath: opts.documentPath ?? "doc.json",
  }) as Tab;
  if (opts.mode) {
    tab.doc.mode = opts.mode;
  }
  const { canvas, editSurface, viewport } = makeCanvas(opts.editWrap ?? false);
  view.renderGeneration += 1;
  const defs = await renderCanvasLive(
    view.renderGeneration,
    tab.doc.document,
    canvas,
    opts.panel ?? null,
  );
  await flush();
  return { canvas, defs, editSurface, tab, viewport };
}

/** Minimal fetch stub returning Jx documents per URL; unknown URLs reject. */
function stubFetch(routes: Record<string, unknown>, onCall?: (url: string) => void) {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL) => {
    const url = String(input);
    calls.push(url);
    onCall?.(url);
    if (url in routes) {
      return Promise.resolve({ json: () => Promise.resolve(routes[url]), ok: true });
    }
    return Promise.reject(new Error(`stub fetch: no route for ${url}`));
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  resetStudioState();
  installMockPlatform();
  invalidateLayoutCache();
  canvasMode = "design";
  view.componentInlineEdit = null;
  initCanvasLiveRender({ getCanvasMode: () => canvasMode });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  view.componentInlineEdit = null;
  closeAllTabs();
  // Reset the shared component registry (loadComponentRegistry reassigns it from the platform).
  installMockPlatform();
  await loadComponentRegistry();
});

// ─── Path mapper ──────────────────────────────────────────────────────────────

describe("makePathMapper", () => {
  const baseCtx = {
    arrayPaths: new Set<string>(),
    canvasMode: "design",
    layoutWrapped: false,
    pageContentPrefix: null,
  };

  test("ignores non-element nodes and records scope state for elements", () => {
    const mapper = makePathMapper({ ...baseCtx });
    expect(() => {
      mapper(document.createTextNode("x"), ["children", 0], {});
    }).not.toThrow();

    const el = document.createElement("p");
    const state = { count: 1 };
    mapper(el, ["children", 0], {}, state);
    expect(elToPath.get(el)).toEqual(["children", 0]);
    expect(elToScope.get(el)).toBe(state);
  });

  test("marks layout-originated elements without registering paths", () => {
    const mapper = makePathMapper({ ...baseCtx, layoutWrapped: true });
    const el = document.createElement("header");
    mapper(el, ["children", 0], { $__layout: true });
    expect(layoutElements.has(el)).toBe(true);
    expect(el.dataset.jxLayout).toBe("");
    expect(elToPath.get(el)).toBeUndefined();
  });

  test("strips the layout prefix from page-content paths", () => {
    const mapper = makePathMapper({
      ...baseCtx,
      layoutWrapped: true,
      pageContentPrefix: ["children", 1, "children"],
    });
    const inside = document.createElement("p");
    mapper(inside, ["children", 1, "children", 2], {});
    expect(elToPath.get(inside)).toEqual(["children", 2]);

    const outside = document.createElement("p");
    mapper(outside, ["children", 0], {});
    expect(elToPath.get(outside)).toEqual(["children", 0]);
  });

  test("subtracts the slot-container offset for layout siblings before the slot", () => {
    // Layout <main> = [<noscript>, <slot>] → page content starts at container index 1.
    const mapper = makePathMapper({
      ...baseCtx,
      layoutWrapped: true,
      pageContentOffset: 1,
      pageContentPrefix: ["children", 1, "children"],
    });
    // First page child renders at container index 1 but is page-document children/0.
    const first = document.createElement("section");
    mapper(first, ["children", 1, "children", 1], {});
    expect(elToPath.get(first)).toEqual(["children", 0]);

    // Second page child → children/1, with a nested descendant preserved.
    const nested = document.createElement("p");
    mapper(nested, ["children", 1, "children", 2, "children", 0], {});
    expect(elToPath.get(nested)).toEqual(["children", 1, "children", 0]);
  });

  test("remaps repeater perimeter template paths to document paths", () => {
    const mapper = makePathMapper({ ...baseCtx, arrayPaths: new Set(["children/1"]) });
    // The perimeter's render path already equals the array's document path — no remap.
    const perimeter = document.createElement("div");
    mapper(perimeter, ["children", 1], {});
    expect(elToPath.get(perimeter)).toEqual(["children", 1]);

    // The template (perimeter's child[0]) collapses [...arrayPath, "children", 0] → [...arrayPath, "map"].
    const template = document.createElement("li");
    mapper(template, ["children", 1, "children", 0], {});
    expect(elToPath.get(template)).toEqual(["children", 1, "map"]);

    const deep = document.createElement("em");
    mapper(deep, ["children", 1, "children", 0, "children", 2], {});
    expect(elToPath.get(deep)).toEqual(["children", 1, "map", "children", 2]);
  });

  test("remaps nested repeater perimeters", () => {
    // Outer array at children/1, inner array at its template's children/0.
    const mapper = makePathMapper({
      ...baseCtx,
      arrayPaths: new Set(["children/1", "children/1/map/children/0"]),
    });
    // Inner perimeter render path = outer template > inner perimeter.
    const innerPerimeter = document.createElement("div");
    mapper(innerPerimeter, ["children", 1, "children", 0, "children", 0], {});
    expect(elToPath.get(innerPerimeter)).toEqual(["children", 1, "map", "children", 0]);

    // Inner template = inner perimeter > child[0].
    const innerTemplate = document.createElement("span");
    mapper(innerTemplate, ["children", 1, "children", 0, "children", 0, "children", 0], {});
    expect(elToPath.get(innerTemplate)).toEqual(["children", 1, "map", "children", 0, "map"]);
  });

  test("leaves non-array shapes and preview-mode paths unmapped", () => {
    const mapper = makePathMapper({ ...baseCtx, arrayPaths: new Set(["children/1"]) });
    // Children/0 is not an array path → no remap.
    const sibling = document.createElement("li");
    mapper(sibling, ["children", 0, "children", 3], {});
    expect(elToPath.get(sibling)).toEqual(["children", 0, "children", 3]);

    const previewMapper = makePathMapper({
      ...baseCtx,
      arrayPaths: new Set(["children/1"]),
      canvasMode: "preview",
    });
    const el = document.createElement("div");
    previewMapper(el, ["children", 1, "children", 0], {});
    expect(elToPath.get(el)).toEqual(["children", 1, "children", 0]);
  });
});

// ─── Full renders ─────────────────────────────────────────────────────────────

describe("renderCanvasLive", () => {
  test("renders a document with edit-mode transforms and path bookkeeping", async () => {
    const { canvas, defs } = await renderDoc({
      children: [
        { style: { color: "red" }, tagName: "p", textContent: "Hello ${name}" },
        { attributes: { href: "https://example.com" }, tagName: "a", textContent: "go" },
      ],
      state: { name: "World" },
      tagName: "div",
    } as unknown as JxMutableNode);

    expect(defs).not.toBeNull();
    const root = canvas.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("DIV");
    const p = root.children[0] as HTMLElement;
    expect(p.textContent).toBe("Hello ❪ name ❫");
    expect(p.style.color).toBe("red");
    expect(elToPath.get(root)).toEqual([]);
    expect(elToPath.get(p)).toEqual(["children", 0]);
    expect(p.style.pointerEvents).toBe("none");
    expect(canvas.dataset.contentMode).toBeUndefined();
  });

  test("prevents link navigation through the delegated nav guard", async () => {
    const { canvas } = await renderDoc({
      children: [
        { attributes: { href: "https://example.com" }, tagName: "a", textContent: "go" },
        { tagName: "p", textContent: "plain" },
      ],
      tagName: "div",
    } as unknown as JxMutableNode);

    const link = canvas.querySelector("a") as HTMLElement;
    const linkClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(linkClick);
    expect(linkClick.defaultPrevented).toBe(true);

    const p = canvas.querySelector("p") as HTMLElement;
    const plainClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    p.dispatchEvent(plainClick);
    expect(plainClick.defaultPrevented).toBe(false);
  });

  test("preview mode renders live template bindings without edit transforms", async () => {
    canvasMode = "preview";
    const { canvas } = await renderDoc({
      children: [{ tagName: "p", textContent: "Hello ${state.name}" }],
      state: { name: "World" },
      tagName: "div",
    } as unknown as JxMutableNode);

    const p = canvas.querySelector("p") as HTMLElement;
    expect(p.textContent).toBe("Hello World");
    expect(p.style.pointerEvents).not.toBe("none");
  });

  test("content mode toggles the canvas contentMode dataset flag", async () => {
    const first = await renderDoc(
      { children: [{ tagName: "p", textContent: "md" }], tagName: "div" } as JxMutableNode,
      { mode: "content" },
    );
    expect(first.canvas.dataset.contentMode).toBe("");

    // Re-render the same canvas from a component-mode tab: the flag is removed.
    const tab = resetWorkspaceWithTab(
      { children: [{ tagName: "p" }], tagName: "div" } as JxMutableNode,
      { documentPath: "doc.json" },
    ) as Tab;
    view.renderGeneration += 1;
    await renderCanvasLive(view.renderGeneration, tab.doc.document, first.canvas, null);
    expect(first.canvas.dataset.contentMode).toBeUndefined();
  });

  test("re-disables pointer events after rAF, sparing the inline-edited element", async () => {
    // Capture the scheduled sweep so state can be staged before it runs.
    const realRaf = globalThis.requestAnimationFrame;
    let sweep: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      sweep = cb;
      return 1;
    }) as typeof requestAnimationFrame;
    try {
      const { canvas } = await renderDoc({
        children: [{ tagName: "p" }, { tagName: "span" }],
        tagName: "div",
      } as JxMutableNode);
      const p = canvas.querySelector("p") as HTMLElement;
      const span = canvas.querySelector("span") as HTMLElement;
      p.style.pointerEvents = "auto";
      span.style.pointerEvents = "auto";
      view.componentInlineEdit = {
        el: p,
        mediaName: null,
        originalText: "",
        path: ["children", 0],
      };

      expect(sweep).not.toBeNull();
      (sweep as unknown as FrameRequestCallback)(0);
      expect(p.style.pointerEvents).toBe("auto");
      expect(span.style.pointerEvents).toBe("none");
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });

  test("persists render context and replaces the panel's render scope", async () => {
    let stopped = 0;
    const panel = {
      activeBreakpoints: null,
      liveCtx: null,
      mediaName: "",
      ready: false,
      renderScope: {
        run: <T>(fn: () => T) => fn(),
        stop: () => {
          stopped += 1;
        },
      },
    } as unknown as CanvasPanel;

    const { defs } = await renderDoc(
      { children: [{ tagName: "p" }], tagName: "div" } as JxMutableNode,
      { panel },
    );

    expect(stopped).toBe(1);
    expect(panel.renderScope).not.toBeNull();
    expect(panel.liveCtx?.canvasMode).toBe("design");
    expect(panel.liveCtx?.layoutWrapped).toBe(false);
    expect(panel.liveCtx?.scope).toBe(defs as Record<string, unknown>);
    expect(typeof panel.liveCtx?.pathMapper).toBe("function");
  });

  test("collects array paths and remaps repeater perimeter paths in the rendered DOM", async () => {
    const panel = {
      activeBreakpoints: null,
      liveCtx: null,
      mediaName: "",
      ready: false,
      renderScope: null,
    } as unknown as CanvasPanel;
    const { canvas } = await renderDoc(
      {
        children: [
          {
            // Array as a member of the <ul>'s children (canonical form).
            children: [
              {
                $prototype: "Array",
                items: ["a", "b"],
                map: { tagName: "li", textContent: "item" },
              },
            ],
            tagName: "ul",
          },
          { $switch: "${mode}", cases: { a: { tagName: "i", textContent: "A" } }, tagName: "span" },
        ],
        tagName: "div",
      } as unknown as JxMutableNode,
      { panel },
    );

    const ul = canvas.querySelector("ul") as HTMLElement;
    const perimeter = ul.firstElementChild as HTMLElement;
    expect(perimeter.className).toContain("repeater-perimeter");
    const li = perimeter.firstElementChild as HTMLElement;
    expect(li.tagName).toBe("LI");
    // Array node lives at ul.children[0] → doc path ["children",0,"children",0]; template adds "map".
    expect(elToPath.get(perimeter)).toEqual(["children", 0, "children", 0]);
    expect(elToPath.get(li)).toEqual(["children", 0, "children", 0, "map"]);
    expect(panel.liveCtx?.arrayPaths.has("children/0/children/0")).toBe(true);
  });

  test("returns null and warns when rendering throws, leaving the canvas intact", async () => {
    const { canvas: target } = makeCanvas();
    const marker = document.createElement("aside");
    target.append(marker);
    // Force a failure inside the render pipeline (after the effect scope exists): the canvas
    // Clear-and-append step throws, exercising the catch + scope disposal path.
    Object.defineProperty(target, "innerHTML", {
      get() {
        return "";
      },
      set() {
        throw new Error("boom: canvas unavailable");
      },
    });
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "x" }],
      tagName: "div",
    } as JxMutableNode) as Tab;
    view.renderGeneration += 1;
    const defs = await renderCanvasLive(view.renderGeneration, tab.doc.document, target, null);
    expect(defs).toBeNull();
    expect(marker.isConnected).toBe(true);
  });
});

// ─── Staleness bail-outs ──────────────────────────────────────────────────────

describe("render generation staleness", () => {
  test("a stale generation bails out before touching the canvas", async () => {
    const tab = resetWorkspaceWithTab() as Tab;
    const { canvas } = makeCanvas();
    view.renderGeneration += 2;
    const defs = await renderCanvasLive(view.renderGeneration - 1, tab.doc.document, canvas, null);
    expect(defs).toBeNull();
    expect(canvas.childElementCount).toBe(0);
  });

  test("bails out when a newer render starts during buildScope", async () => {
    const tab = resetWorkspaceWithTab() as Tab;
    const { canvas } = makeCanvas();
    view.renderGeneration += 1;
    const pending = renderCanvasLive(view.renderGeneration, tab.doc.document, canvas, null);
    view.renderGeneration += 1; // A newer render begins while buildScope awaits
    expect(await pending).toBeNull();
    expect(canvas.childElementCount).toBe(0);
  });

  test("bails out when a newer render starts during layout resolution", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    installMockPlatform({
      readFile: async () => {
        view.renderGeneration += 1;
        return JSON.stringify({ children: [{ tagName: "slot" }], tagName: "div" });
      },
    });
    const tab = resetWorkspaceWithTab(
      {
        $layout: "./layouts/stale.json",
        children: [{ tagName: "p" }],
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/home.json" },
    ) as Tab;
    const { canvas } = makeCanvas();
    view.renderGeneration += 1;
    const defs = await renderCanvasLive(view.renderGeneration, tab.doc.document, canvas, null);
    expect(defs).toBeNull();
    expect(canvas.childElementCount).toBe(0);
  });

  test("bails out when a newer render starts during element registration", async () => {
    stubFetch({}, () => {
      view.renderGeneration += 1;
    });
    const tab = resetWorkspaceWithTab({
      $elements: [{ $ref: "http://comp.test/gen-bump.json" }],
      children: [{ tagName: "p" }],
      tagName: "div",
    } as unknown as JxMutableNode) as Tab;
    const { canvas } = makeCanvas();
    view.renderGeneration += 1;
    const defs = await renderCanvasLive(view.renderGeneration, tab.doc.document, canvas, null);
    expect(defs).toBeNull();
    expect(canvas.childElementCount).toBe(0);
  });
});

// ─── Layout wrapping ──────────────────────────────────────────────────────────

const LAYOUT = {
  $elements: [{ tagName: "x-layout-marker" }],
  children: [
    { tagName: "header", textContent: "HDR" },
    { children: [{ tagName: "slot" }], tagName: "main" },
  ],
  tagName: "div",
};

describe("layout wrapping", () => {
  test("wraps page content in the layout and remaps page paths", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    installMockPlatform({}, { "layouts/base.json": JSON.stringify(LAYOUT) });

    const { canvas, defs } = await renderDoc(
      {
        $layout: "./layouts/base.json",
        children: [{ tagName: "p", textContent: "Page content" }],
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/home.json" },
    );

    expect(defs).not.toBeNull();
    expect(activeLayoutPath).toBe("layouts/base.json");
    const header = canvas.querySelector("header") as HTMLElement;
    expect(header.dataset.jxLayout).toBe("");
    expect(layoutElements.has(header)).toBe(true);
    expect(elToPath.get(header)).toBeUndefined();
    const p = canvas.querySelector("main p") as HTMLElement;
    expect(p.textContent).toBe("Page content");
    expect(elToPath.get(p)).toEqual(["children", 0]);
  });

  test("uses the project default layout when the page sets none", async () => {
    resetStudioState({
      isSiteProject: true,
      projectConfig: { defaults: { layout: "layouts/default.json" } },
    });
    installMockPlatform({}, { "layouts/default.json": JSON.stringify(LAYOUT) });

    const { canvas } = await renderDoc(
      { children: [{ tagName: "p", textContent: "body" }], tagName: "div" } as JxMutableNode,
      { documentPath: "pages/about.json" },
    );
    expect(activeLayoutPath).toBe("layouts/default.json");
    expect(canvas.querySelector("header")).not.toBeNull();
  });

  test("$layout: false opts out of the default layout", async () => {
    resetStudioState({
      isSiteProject: true,
      projectConfig: { defaults: { layout: "layouts/default.json" } },
    });
    installMockPlatform({}, { "layouts/default.json": JSON.stringify(LAYOUT) });

    const { canvas } = await renderDoc(
      {
        $layout: false,
        children: [{ tagName: "p", textContent: "raw" }],
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/raw.json" },
    );
    expect(activeLayoutPath).toBeNull();
    expect(canvas.querySelector("header")).toBeNull();
  });

  test("renders unwrapped when the layout file cannot be resolved", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    installMockPlatform(); // No layout file seeded → readFile throws

    const { canvas, defs } = await renderDoc(
      {
        $layout: "./layouts/missing.json",
        children: [{ tagName: "p", textContent: "still here" }],
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/home.json" },
    );
    expect(defs).not.toBeNull();
    expect(activeLayoutPath).toBeNull();
    expect(canvas.querySelector("p")?.textContent).toBe("still here");
  });
});

// ─── $elements registration ───────────────────────────────────────────────────

describe("$elements registration", () => {
  test("registers $ref custom elements through defineElement", async () => {
    stubFetch({
      "http://comp.test/ok-comp.json": {
        children: [{ tagName: "p", textContent: "inner" }],
        tagName: "x-live-ok",
      },
    });
    const { canvas, defs } = await renderDoc({
      $elements: [{ $ref: "http://comp.test/ok-comp.json" }],
      children: [{ tagName: "x-live-ok" }],
      tagName: "div",
    } as unknown as JxMutableNode);

    expect(defs).not.toBeNull();
    expect(customElements.get("x-live-ok")).toBeDefined();
    expect(canvas.querySelector("x-live-ok")).not.toBeNull();
  });

  test("survives unimportable package entries and invalid element URLs", async () => {
    const { canvas, defs } = await renderDoc({
      $elements: ["totally-missing-pkg-xyz", { $ref: "http://" }],
      children: [{ tagName: "p", textContent: "ok" }],
      tagName: "div",
    } as unknown as JxMutableNode);
    expect(defs).not.toBeNull();
    expect(canvas.querySelector("p")?.textContent).toBe("ok");
  });

  test("caches failed element loads per document and skips retries", async () => {
    const calls = stubFetch({});
    const docDef = {
      $elements: [{ $ref: "http://comp.test/fail-comp.json" }],
      children: [{ tagName: "p", textContent: "ok" }],
      tagName: "div",
    } as unknown as JxMutableNode;

    const first = await renderDoc(docDef, { documentPath: "fail.json" });
    expect(first.defs).not.toBeNull();
    expect(calls.length).toBe(1);

    // Same document path: the failed href is skipped without another fetch.
    const { canvas } = makeCanvas();
    view.renderGeneration += 1;
    const defs = await renderCanvasLive(
      view.renderGeneration,
      first.tab.doc.document,
      canvas,
      null,
    );
    expect(defs).not.toBeNull();
    expect(calls.length).toBe(1);
  });
});

// ─── Content-mode component auto-discovery ────────────────────────────────────

describe("component auto-discovery", () => {
  test("discovers project components by tag name in content mode", async () => {
    installMockPlatform({
      discoverComponents: async () => [
        { path: "components/x-card-live.json", source: "jx", tagName: "x-card-live" },
        { path: "x-npm-thing", source: "npm", tagName: "x-npm-thing" },
      ],
    });
    await loadComponentRegistry();
    const calls = stubFetch({
      "http://localhost:3000/components/x-card-live.json": {
        children: [{ tagName: "p", textContent: "card body" }],
        tagName: "x-card-live",
      },
    });

    const { canvas, defs } = await renderDoc(
      {
        children: [{ tagName: "x-card-live" }, { tagName: "x-npm-thing" }, { tagName: "p" }],
        tagName: "div",
      } as JxMutableNode,
      { documentPath: "content/home.md", mode: "content" },
    );

    expect(defs).not.toBeNull();
    expect(calls).toContain("http://localhost:3000/components/x-card-live.json");
    expect(calls.length).toBe(1); // Npm-sourced and plain tags trigger no fetch
    expect(customElements.get("x-card-live")).toBeDefined();
    expect(canvas.querySelector("x-card-live")).not.toBeNull();
    expect(canvas.dataset.contentMode).toBe("");
  });
});

// ─── Site style and $head injection ───────────────────────────────────────────

describe("site style and $head", () => {
  test("applies project styles to viewport/canvas and emits nested-site CSS", async () => {
    resetStudioState({
      projectConfig: {
        style: { "& li": { margin: "4px" }, "--brand": "#ff0000", fontFamily: "serif" },
      },
    });

    const { canvas, viewport } = await renderDoc({
      children: [{ tagName: "p" }],
      tagName: "div",
    } as JxMutableNode);

    expect(viewport.style.getPropertyValue("--brand")).toBe("#ff0000");
    expect(viewport.style.fontFamily).toBe("serif");
    expect(canvas.style.fontFamily).toBe("serif");
    expect(canvas.dataset.jxSite).toBe("");
    const siteStyle = document.querySelector("#jx-site-style");
    expect(siteStyle).not.toBeNull();
    expect(siteStyle?.textContent).toContain("li");
    expect(siteStyle?.textContent).toContain("[data-jx-site]");

    // A second render replaces the style tag instead of accumulating.
    await renderDoc({ children: [{ tagName: "p" }], tagName: "div" } as JxMutableNode);
    expect(document.querySelectorAll("#jx-site-style").length).toBe(1);
  });

  test("edit mode propagates project styles to the content-edit surface", async () => {
    canvasMode = "edit";
    resetStudioState({
      projectConfig: { style: { "& p": { margin: "0" }, "--ink": "#222", color: "navy" } },
    });
    const { canvas, editSurface } = await renderDoc(
      { children: [{ tagName: "p" }], tagName: "div" } as JxMutableNode,
      { editWrap: true },
    );
    expect(editSurface?.style.getPropertyValue("--ink")).toBe("#222");
    expect(editSurface?.style.color).toBe("navy");
    // Nested selector objects are skipped for inline application on every surface.
    expect(editSurface?.style.margin).toBe("");
    expect(canvas.style.margin).toBe("");
    expect(canvas.style.color).toBe("navy");
  });

  test("injects $head entries with node_modules prefixing, dedup, and script filtering", async () => {
    resetStudioState({
      projectConfig: {
        $head: [
          { attributes: { href: "theme.css", rel: "stylesheet" }, tagName: "link" },
          { tagName: "script", textContent: "alert(1)" }, // Inline script: skipped
          { attributes: { src: "http://cdn.test/x.js" }, tagName: "script" },
          { attributes: { href: "ignored.css" } }, // No tagName: skipped
          { attributes: { media: "print" }, tagName: "style", textContent: "body{margin:0}" },
        ],
      },
    });

    await renderDoc({ children: [{ tagName: "p" }], tagName: "div" } as JxMutableNode);
    const link = document.head.querySelector("link");
    expect(link?.getAttribute("href")).toBe("/node_modules/theme.css");
    expect(document.head.querySelectorAll("script").length).toBe(1);
    expect(document.head.querySelector("script")?.getAttribute("src")).toBe("http://cdn.test/x.js");

    // Re-render: href/src-keyed entries are deduped.
    await renderDoc({ children: [{ tagName: "p" }], tagName: "div" } as JxMutableNode);
    expect(document.head.querySelectorAll("link").length).toBe(1);
    expect(document.head.querySelectorAll("script").length).toBe(1);
  });
});
