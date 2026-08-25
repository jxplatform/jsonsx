/**
 * Canvas live render gaps — layout trees with non-element children (markLayoutNodes' primitive
 * guard, nested slot containers), the legacy whole-children repeater and $switch-cases walks of
 * findArrayPaths, and collectTags' primitive guard during content-mode component discovery.
 */
import { installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveCanvasDocument } from "../src/canvas/canvas-live-render";
import { invalidateLayoutCache } from "../src/site-context";
import { loadComponentRegistry } from "../src/files/components";
import { closeAllTabs } from "../src/workspace/workspace";

import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  resetStudioState();
  installMockPlatform();
  invalidateLayoutCache();
});

afterEach(async () => {
  closeAllTabs();
  installMockPlatform();
  await loadComponentRegistry();
});

describe("layout wrapping with irregular trees", () => {
  test("a nested slot container behind non-content siblings still maps the page prefix", async () => {
    // The slot hides inside a wrapper; a sibling subtree (header > nav) holds only layout nodes, so
    // The prefix search must descend, fail, continue, and find the content in the next branch.
    const layout = {
      children: [
        {
          children: [
            { children: [{ tagName: "span", textContent: "nav" }], tagName: "header" },
            { children: [{ tagName: "noscript" }, { tagName: "slot" }], tagName: "main" },
          ],
          tagName: "div",
        },
      ],
      tagName: "body",
    };
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    installMockPlatform({}, { "layouts/nested.json": JSON.stringify(layout) });
    const tab = resetWorkspaceWithTab(
      {
        $layout: "./layouts/nested.json",
        children: [{ tagName: "p", textContent: "Page content" }],
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/home.json" },
    ) as Tab;
    const result = await resolveCanvasDocument(tab.doc.document as JxMutableNode, tab);

    expect(result.mapperCtx.layoutWrapped).toBe(true);
    // The prefix descends into the wrapper's main container…
    expect(result.mapperCtx.pageContentPrefix).toEqual(["children", 0, "children", 1, "children"]);
    // …and the offset accounts for the layout's leading <noscript> sibling.
    expect(result.mapperCtx.pageContentOffset).toBe(1);
  });

  test("primitive children in the layout tree survive layout marking", async () => {
    const layout = {
      children: [42, { children: [{ tagName: "slot" }], tagName: "main" }],
      tagName: "div",
    };
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    installMockPlatform({}, { "layouts/odd.json": JSON.stringify(layout) });
    const tab = resetWorkspaceWithTab(
      {
        $layout: "./layouts/odd.json",
        children: [{ tagName: "p", textContent: "Page content" }],
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "pages/odd.json" },
    ) as Tab;
    const result = await resolveCanvasDocument(tab.doc.document as JxMutableNode, tab);
    expect(result.mapperCtx.layoutWrapped).toBe(true);
  });
});

describe("findArrayPaths edge shapes", () => {
  test("walks the legacy whole-children repeater form", async () => {
    const tab = resetWorkspaceWithTab() as Tab;
    const legacy = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: ["a"],
            map: { tagName: "li" },
          },
          tagName: "ul",
        },
      ],
      tagName: "div",
    } as unknown as JxMutableNode;
    const result = await resolveCanvasDocument(legacy, tab);
    expect(result.mapperCtx.arrayPaths).toContain("children/0/children");
  });

  test("walks $switch cases (including nested repeaters and primitive case values)", async () => {
    const tab = resetWorkspaceWithTab() as Tab;
    const doc = {
      $switch: { $ref: "#/state/view" },
      cases: {
        list: {
          children: [{ $prototype: "Array", items: [], map: { tagName: "li" } }],
          tagName: "ul",
        },
        off: null,
      },
      children: [],
      tagName: "div",
    } as unknown as JxMutableNode;
    const result = await resolveCanvasDocument(doc, tab);
    expect(result.mapperCtx.arrayPaths).toContain("cases/list/children/0");
  });

  test("nested map templates and primitive children are walked safely", async () => {
    const tab = resetWorkspaceWithTab() as Tab;
    const doc = {
      children: [
        7 as unknown as JxMutableNode,
        {
          $prototype: "Array",
          items: [],
          map: { $prototype: "Array", items: [], map: { tagName: "li" } },
        },
      ],
      tagName: "div",
    } as unknown as JxMutableNode;
    const result = await resolveCanvasDocument(doc, tab);
    expect(result.mapperCtx.arrayPaths).toContain("children/1");
    expect(result.mapperCtx.arrayPaths).toContain("children/1/map");
  });
});

describe("content-mode component discovery with irregular children", () => {
  test("collectTags skips primitive children while still registering component refs", async () => {
    installMockPlatform({
      discoverComponents: async () => [
        { path: "components/x-card-live.json", source: "jx", tagName: "x-card-live" },
      ],
    });
    await loadComponentRegistry();
    const tab = resetWorkspaceWithTab(
      {
        // Pre-existing refs (object and string forms) exercise the existing-ref key extraction.
        $elements: [{ $ref: "./components/manual.json" }, "components/by-name.json"],
        children: [
          9 as unknown as JxMutableNode,
          { children: [null as unknown as JxMutableNode], tagName: "x-card-live" },
        ],
        tagName: "div",
      } as unknown as JxMutableNode,
      { documentPath: "content/odd.md" },
    ) as Tab;
    tab.doc.mode = "content";
    const result = await resolveCanvasDocument(tab.doc.document as JxMutableNode, tab);
    const refs = ((result.renderDoc as { $elements?: { $ref?: string }[] }).$elements ?? []).map(
      (e) => e.$ref,
    );
    expect(refs.some((r) => r?.includes("components/x-card-live.json"))).toBe(true);
  });
});

// ─── Content-relative asset resolution ───────────────────────────────────────

/**
 * What the parent hands the canvas about media.
 *
 * It used to hand over a REWRITTEN document: a walk mapped every literal `./images/hero.png` onto
 * the content type's mount before the doc crossed into the iframe. That walk is gone, because a
 * walk can only ever see literal values — `applyAttributes` resolves a `{"$ref": …}` or `"${…}"`
 * src inside a reactive effect, so at walk time a bound image src is not a string at all, and a
 * collection listing of bound card images broke all at once in preview.
 *
 * So the parent's job is now to hand over the CONTEXT, and the resolution happens at render time
 * (`resolveAssetRef` in `canvas/asset-refs`, installed on the runtime by `iframe-render`). These
 * tests assert the context; the mapping itself is asserted in `asset-refs.test.ts`.
 */
describe("content-entry asset context", () => {
  const POSTS = { posts: { format: "Markdown", source: "./content/posts/" } };

  const entryDoc = () =>
    ({
      children: [
        { attributes: { src: "./images/hero.png" }, tagName: "img" },
        { attributes: { src: "/logo.png" }, tagName: "img" },
      ],
      tagName: "div",
    }) as unknown as JxMutableNode;

  async function resolveFor(documentPath: string, mode?: "preview") {
    resetStudioState({ isSiteProject: true, projectConfig: { content: POSTS } });
    const tab = resetWorkspaceWithTab(entryDoc(), { documentPath }) as Tab;
    if (mode) {
      tab.session.ui.canvasMode = mode;
    }
    return {
      result: await resolveCanvasDocument(tab.doc.document as JxMutableNode, tab),
      tab,
    };
  }

  test("an entry carries its content type's mount and its own directory", async () => {
    const { result } = await resolveFor("content/posts/hello.md");
    expect(result.assets).toMatchObject({
      documentDir: "content/posts",
      mounts: [{ dir: "content/posts", urlPrefix: "/content/posts" }],
      space: "site",
    });
  });

  test("the tab's SOURCE document keeps the authored ref — it is what gets serialized", async () => {
    const { result, tab } = await resolveFor("content/posts/hello.md");
    const source = tab.doc.document as unknown as { children: Record<string, unknown>[] };
    expect((source.children[0]!.attributes as Record<string, string>).src).toBe(
      "./images/hero.png",
    );
    // And so does the RENDER document: nothing rewrites a value any more.
    const kids = result.renderDoc.children as Record<string, Record<string, string>>[];
    expect(kids[0]!.attributes!.src).toBe("./images/hero.png");
    expect(kids[1]!.attributes!.src).toBe("/logo.png");
  });

  /* In site space the mount is the only thing that needs doing, so a page — which has none — needs
     no context at all, and the canvas installs no resolver. */
  test("a page document carries NO context on a host that serves site URLs", async () => {
    const { result } = await resolveFor("pages/index.json");
    expect(result.assets).toBeNull();
  });

  test("preview mode carries the same context — a preview is what the built page will look like", async () => {
    const { result } = await resolveFor("content/posts/hello.md", "preview");
    expect(result.assets).toMatchObject({ documentDir: "content/posts", space: "site" });
  });
});
