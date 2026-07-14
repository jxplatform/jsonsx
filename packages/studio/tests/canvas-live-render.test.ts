/**
 * Canvas live render — parent-side document resolution (`resolveCanvasDocument`) for the iframe
 * canvas host: page/layout wrapping with slot distribution, mapped-array path collection in edit
 * mode, content-mode component auto-discovery, and site-style passthrough. The realm-specific
 * render (buildScope/renderNode, $head/site-style DOM injection) now happens inside the iframe and
 * is unit-tested via tests/iframe-entry.test.ts — the legacy in-realm `renderCanvasLive` (and its
 * `makePathMapper`/`layoutElements`/`activeLayoutPath` bookkeeping) was removed with the legacy
 * canvas.
 */
import { installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initCanvasLiveRender, resolveCanvasDocument } from "../src/canvas/canvas-live-render";
import { invalidateLayoutCache } from "../src/site-context";
import { loadComponentRegistry } from "../src/files/components";
import { closeAllTabs } from "../src/workspace/workspace";

import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";

// Happy-dom defaults to about:blank (origin "null"), which breaks docBase-relative URL math.
const { happyDOM } = globalThis as unknown as {
  happyDOM: { setURL: (u: string) => void; settings: Record<string, unknown> };
};
happyDOM.setURL("http://localhost:3000/");

let canvasMode = "design";

interface ResolveOpts {
  documentPath?: string;
  mode?: string;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  resetStudioState();
  installMockPlatform();
  invalidateLayoutCache();
  canvasMode = "design";
  initCanvasLiveRender({ getCanvasMode: () => canvasMode });
});

afterEach(async () => {
  closeAllTabs();
  // Reset the shared component registry (loadComponentRegistry reassigns it from the platform).
  installMockPlatform();
  await loadComponentRegistry();
});

const LAYOUT = {
  $elements: [{ tagName: "x-layout-marker" }],
  children: [
    { tagName: "header", textContent: "HDR" },
    { children: [{ tagName: "slot" }], tagName: "main" },
  ],
  tagName: "div",
};

// ─── resolveCanvasDocument (parent-side resolution for the iframe host) ─────────

describe("resolveCanvasDocument", () => {
  async function resolve(docDef: JxMutableNode, opts: ResolveOpts = {}) {
    const tab = resetWorkspaceWithTab(docDef, {
      documentPath: opts.documentPath ?? "doc.json",
    }) as Tab;
    if (opts.mode) {
      tab.doc.mode = opts.mode;
    }
    return resolveCanvasDocument(tab.doc.document as JxMutableNode);
  }

  test("resolves a simple page-less doc into renderDoc + docBase + mapperCtx", async () => {
    const result = await resolve({
      children: [{ children: ["hi"], tagName: "p" }],
      tagName: "div",
    } as JxMutableNode);
    expect(result.renderDoc.tagName).toBe("div");
    expect(result.docBase).toContain("doc.json");
    expect(result.mapperCtx).toMatchObject({
      arrayPaths: [],
      canvasMode: "design",
      layoutWrapped: false,
      pageContentPrefix: null,
    });
    expect(result.siteStyle).toBeNull();
  });

  test("returns the project's site style", async () => {
    resetStudioState({ projectConfig: { style: { "--brand": "#0f0", color: "red" } } });
    const result = await resolve({ children: [], tagName: "div" } as JxMutableNode);
    expect(result.siteStyle).toEqual({ "--brand": "#0f0", color: "red" });
  });

  test("collects mapped-array document paths in edit mode", async () => {
    canvasMode = "edit";
    const result = await resolve({
      children: [{ $prototype: "Array", map: { tagName: "li" } }],
      tagName: "div",
    } as unknown as JxMutableNode);
    expect(result.mapperCtx.canvasMode).toBe("edit");
    expect(result.mapperCtx.arrayPaths).toContain("children/0");
  });

  test("wraps page documents in their layout", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    installMockPlatform({}, { "layouts/base.json": JSON.stringify(LAYOUT) });
    const result = await resolve(
      {
        $layout: "./layouts/base.json",
        children: [{ tagName: "p", textContent: "Page content" }],
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/home.json" },
    );
    expect(result.mapperCtx.layoutWrapped).toBe(true);
    expect(result.mapperCtx.pageContentPrefix).not.toBeNull();
  });

  test("skips layout wrapping when the tab's showLayout toggle is off", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    installMockPlatform({}, { "layouts/base.json": JSON.stringify(LAYOUT) });
    const tab = resetWorkspaceWithTab(
      {
        $layout: "./layouts/base.json",
        children: [{ tagName: "p", textContent: "Page content" }],
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/home.json" },
    ) as Tab;
    tab.session.ui.showLayout = false;
    const result = await resolveCanvasDocument(tab.doc.document as JxMutableNode);
    expect(result.mapperCtx.layoutWrapped).toBe(false);
    expect(result.mapperCtx.pageContentPrefix).toBeNull();
    const children = result.renderDoc.children as JxMutableNode[];
    expect(children.some((c) => c.tagName === "header")).toBe(false);
  });

  test("effective preview mode keeps the raw doc (no edit-display tokens)", async () => {
    canvasMode = "preview";
    const result = await resolve({
      children: [{ tagName: "p", textContent: "${state.x}" }],
      tagName: "div",
    } as unknown as JxMutableNode);
    expect(result.mapperCtx.canvasMode).toBe("preview");
    const p = (result.renderDoc.children as JxMutableNode[])[0]!;
    // Preview passes the raw template through; design/edit would rewrite it to a display token.
    expect(p.textContent).toBe("${state.x}");
    expect(result.mapperCtx.arrayPaths).toEqual([]);
  });

  test("substitutes chosen preview params into renderDoc, leaving the source doc intact", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    const tab = resetWorkspaceWithTab(
      {
        children: [],
        state: {
          product: { $prototype: "ContentEntry", id: { $ref: "#/$params/sku" } },
        },
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/products/[sku].json" },
    ) as Tab;
    tab.session.ui.previewParams = { sku: "mini-trencher" };
    const result = await resolveCanvasDocument(tab.doc.document as JxMutableNode);

    const state = result.renderDoc.state as Record<string, Record<string, unknown>>;
    expect(state.product!.id).toBe("mini-trencher");
    expect(state.$page).toEqual({
      params: { sku: "mini-trencher" },
      title: "",
      url: "/products/:sku",
    });
    // The tab's source document keeps its $ref (it is what gets edited and saved).
    const srcState = (tab.doc.document as { state: Record<string, Record<string, unknown>> }).state;
    expect(srcState.product!.id).toEqual({ $ref: "#/$params/sku" });
  });

  test("substitution composes with layout wrapping", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    installMockPlatform({}, { "layouts/base.json": JSON.stringify(LAYOUT) });
    const tab = resetWorkspaceWithTab(
      {
        $layout: "./layouts/base.json",
        children: [{ tagName: "p", textContent: "Body" }],
        state: { entry: { id: { $ref: "#/$params/slug" } } },
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/docs/[slug].json" },
    ) as Tab;
    tab.session.ui.previewParams = { slug: "intro" };
    const result = await resolveCanvasDocument(tab.doc.document as JxMutableNode);

    expect(result.mapperCtx.layoutWrapped).toBe(true);
    const state = result.renderDoc.state as Record<string, Record<string, unknown>>;
    expect(state.entry!.id).toBe("intro");
  });

  test("auto-discovers project components in content mode and adds them to $elements", async () => {
    installMockPlatform({
      discoverComponents: async () => [
        { path: "components/x-card-live.json", source: "jx", tagName: "x-card-live" },
      ],
    });
    await loadComponentRegistry();
    const result = await resolve(
      { children: [{ tagName: "x-card-live" }], tagName: "div" } as JxMutableNode,
      { documentPath: "content/home.md", mode: "content" },
    );
    const refs = ((result.renderDoc as { $elements?: { $ref?: string }[] }).$elements ?? []).map(
      (e) => e.$ref,
    );
    expect(refs.some((r) => r?.includes("components/x-card-live.json"))).toBe(true);
  });

  test("auto-discovers project components in a layout opened directly (no content mode)", async () => {
    installMockPlatform({
      discoverComponents: async () => [
        { path: "components/x-card-live.json", source: "jx", tagName: "x-card-live" },
      ],
    });
    await loadComponentRegistry();
    // A layout opened on its own is not a page (no layoutWrapped) and a plain .json file never
    // Sets content mode, yet its custom-element tags must still be registered for the canvas.
    const result = await resolve(
      { children: [{ tagName: "x-card-live" }], tagName: "div" } as JxMutableNode,
      { documentPath: "layouts/base.json" },
    );
    const refs = ((result.renderDoc as { $elements?: { $ref?: string }[] }).$elements ?? []).map(
      (e) => e.$ref,
    );
    expect(refs.some((r) => r?.includes("components/x-card-live.json"))).toBe(true);
  });
});
