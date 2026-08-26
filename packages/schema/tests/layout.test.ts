/**
 * Layout resolution — slot distribution and property merging, over an in-memory loader.
 *
 * The compiler's own suite drives the same rules through a real directory; this one drives them
 * through the injected loader, which is the seam the studio and the cloud preview use. A rule that
 * only held when the layout came off a disk would pass there and fail here.
 */
import { describe, expect, test } from "bun:test";
import { resolveLayout } from "../src/layout.ts";
import type { JxDocument } from "../types.ts";

/** A loader over a plain map, recording the refs it was asked for. */
function loaderFor(layouts: Record<string, unknown>) {
  const asked: string[] = [];
  const load = (ref: string) => {
    asked.push(ref);
    const doc = layouts[ref];
    if (!doc) {
      throw new Error(`Layout not found: ${ref}`);
    }
    return structuredClone(doc) as JxDocument;
  };
  return { asked, load };
}

describe("resolveLayout", () => {
  test("a page with no layout is returned as it was", async () => {
    const page = { children: [{ tagName: "p" }], tagName: "div" } as unknown as JxDocument;
    const { asked, load } = loaderFor({});
    expect(await resolveLayout(page, {}, load)).toBe(page);
    expect(asked).toEqual([]);
  });

  test("the project default supplies the layout when the page names none", async () => {
    const { asked, load } = loaderFor({
      "./layouts/base.json": { children: [{ tagName: "slot" }], tagName: "body" },
    });
    const page = { children: ["hi"] } as unknown as JxDocument;
    const result = await resolveLayout(page, { defaults: { layout: "./layouts/base.json" } }, load);
    expect(asked).toEqual(["./layouts/base.json"]);
    expect(result.children).toEqual(["hi"]);
  });

  test("the page's own $layout wins over the project default", async () => {
    const { asked, load } = loaderFor({
      "./layouts/base.json": { children: [{ tagName: "slot" }], tagName: "body" },
      "./layouts/post.json": { children: [{ tagName: "slot" }], tagName: "article" },
    });
    const page = { $layout: "./layouts/post.json", children: ["hi"] } as unknown as JxDocument;
    const result = await resolveLayout(page, { defaults: { layout: "./layouts/base.json" } }, load);
    expect(asked).toEqual(["./layouts/post.json"]);
    expect(result.tagName).toBe("article");
  });

  test("a loader failure is the caller's error, not swallowed", async () => {
    const { load } = loaderFor({});
    const page = { $layout: "./layouts/missing.json" } as unknown as JxDocument;
    let failure: unknown;
    try {
      await resolveLayout(page, {}, load);
    } catch (error) {
      failure = error;
    }
    expect((failure as Error | undefined)?.message).toContain("Layout not found");
  });

  test("named children go to their slot and the rest to the default one", async () => {
    const { load } = loaderFor({
      "./l.json": {
        children: [
          { attributes: { name: "header" }, tagName: "slot" },
          { children: [{ tagName: "slot" }], tagName: "main" },
        ],
        tagName: "body",
      },
    });
    const page = {
      $layout: "./l.json",
      children: [{ attributes: { slot: "header" }, tagName: "h1" }, { tagName: "p" }],
    } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(result.children[0].tagName).toBe("h1");
    expect(result.children[1].children[0].tagName).toBe("p");
  });

  test("an unmatched slot keeps its own fallback children", async () => {
    const { load } = loaderFor({
      "./l.json": {
        children: [
          { attributes: { name: "aside" }, children: [{ tagName: "nav" }], tagName: "slot" },
          { tagName: "slot" },
        ],
        tagName: "body",
      },
    });
    const page = { $layout: "./l.json", children: [{ tagName: "p" }] } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(result.children[0].tagName).toBe("nav");
    expect(result.children[1].tagName).toBe("p");
  });

  test("a string children value is distributed as one text child", async () => {
    const { load } = loaderFor({
      "./l.json": { children: [{ tagName: "slot" }], tagName: "body" },
    });
    const page = { $layout: "./l.json", children: "hello" } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(result.children).toEqual(["hello"]);
  });

  test("a nested layout is resolved before the page lands in it", async () => {
    const { asked, load } = loaderFor({
      "./inner.json": {
        $layout: "./outer.json",
        children: [
          { attributes: { slot: "body" }, children: [{ tagName: "slot" }], tagName: "main" },
        ],
        tagName: "div",
      },
      "./outer.json": {
        children: [{ attributes: { name: "body" }, tagName: "slot" }],
        tagName: "body",
      },
    });
    const page = { $layout: "./inner.json", children: [{ tagName: "p" }] } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(asked).toEqual(["./inner.json", "./outer.json"]);
    expect(result.tagName).toBe("body");
    expect(result.children[0].tagName).toBe("main");
    expect(result.children[0].children[0].tagName).toBe("p");
  });

  test("page state, style, $media and attributes extend the layout's", async () => {
    const { load } = loaderFor({
      "./l.json": {
        attributes: { class: "layout" },
        $media: { wide: "(min-width: 60rem)" },
        children: [{ tagName: "slot" }],
        state: { a: 1, b: 1 },
        style: { color: "red", margin: "0" },
        tagName: "body",
      },
    });
    const page = {
      attributes: { id: "page" },
      $layout: "./l.json",
      $media: { tall: "(min-height: 60rem)" },
      children: [],
      state: { b: 2 },
      style: { color: "blue" },
    } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(result.state).toEqual({ a: 1, b: 2 });
    expect(result.style).toEqual({ color: "blue", margin: "0" });
    expect(result.$media).toEqual({ tall: "(min-height: 60rem)", wide: "(min-width: 60rem)" });
    expect(result.attributes).toEqual({ class: "layout", id: "page" });
  });

  test("the page's own head and title survive the merge, and $layout does not", async () => {
    const { load } = loaderFor({
      "./l.json": { children: [{ tagName: "slot" }], tagName: "body" },
    });
    const page = {
      $head: [{ attributes: { content: "x", name: "d" }, tagName: "meta" }],
      $layout: "./l.json",
      children: [],
      title: "Hello",
    } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(result._pageTitle).toBe("Hello");
    expect(result._pageHead).toHaveLength(1);
    expect(result.$layout).toBeUndefined();
  });

  test("the layout document the loader returned is not mutated for the next page", async () => {
    const layouts = { "./l.json": { children: [{ tagName: "slot" }], tagName: "body" } };
    const { load } = loaderFor(layouts);
    const first = { $layout: "./l.json", children: ["one"] } as unknown as JxDocument;
    const second = { $layout: "./l.json", children: ["two"] } as unknown as JxDocument;
    const firstResult = await resolveLayout(first, {}, load);
    const secondResult = await resolveLayout(second, {}, load);
    expect(firstResult.children).toEqual(["one"]);
    expect(secondResult.children).toEqual(["two"]);
  });

  test("a layout that is not an element tree distributes nothing", async () => {
    const { load } = loaderFor({ "./l.json": { tagName: "body" } });
    const page = { $layout: "./l.json", children: [{ tagName: "p" }] } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(result.children).toBeUndefined();
  });

  test("page children that are not an array or string distribute as nothing", async () => {
    const { load } = loaderFor({
      "./l.json": { children: [{ children: ["fallback"], tagName: "slot" }], tagName: "body" },
    });
    const page = { $layout: "./l.json", children: 42 } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(result.children).toEqual(["fallback"]);
  });

  test("text and null children in the layout are walked past, not into", async () => {
    const { load } = loaderFor({
      "./l.json": {
        children: ["lead text", null, { children: [{ tagName: "slot" }], tagName: "main" }],
        tagName: "body",
      },
    });
    const page = { $layout: "./l.json", children: [{ tagName: "p" }] } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(result.children[0]).toBe("lead text");
    expect(result.children[1]).toBeNull();
    expect(result.children[2].children[0].tagName).toBe("p");
  });

  test("a childless element in the layout is left alone", async () => {
    const { load } = loaderFor({
      "./l.json": { children: [{ tagName: "hr" }, { tagName: "slot" }], tagName: "body" },
    });
    const page = { $layout: "./l.json", children: [{ tagName: "p" }] } as unknown as JxDocument;
    const result = (await resolveLayout(page, {}, load)) as any;
    expect(result.children[0]).toEqual({ tagName: "hr" });
    expect(result.children[1].tagName).toBe("p");
  });

  test("a layout document that is not an object distributes nothing and does not throw", async () => {
    const { load } = loaderFor({ "./l.json": "not a document" });
    const page = { $layout: "./l.json", children: [{ tagName: "p" }] } as unknown as JxDocument;
    const result = await resolveLayout(page, {}, load);
    expect(result).toBe("not a document" as never);
  });
});
