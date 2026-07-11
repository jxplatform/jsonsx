/**
 * Page-params tests: dynamic route-param parsing, $paths value enumeration (all four shapes from
 * the compiler's resolvePathEntries), and preview substitution ($ref → literal + state.$page).
 */
import { installMockPlatform } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { refreshFormats, setExtensions } from "../src/format/format-host";
import {
  documentUrlPattern,
  dynamicRouteParams,
  invalidateParamValues,
  loadParamValues,
  pagePathsDef,
  paramBoundStateKeys,
  resolveParamBoundState,
  substitutePreviewParams,
} from "../src/page-params";
import type { JxMutableNode } from "@jxsuite/schema/types";

beforeEach(() => {
  invalidateParamValues();
  installMockPlatform();
});

// ─── Route parsing ────────────────────────────────────────────────────────────

describe("dynamicRouteParams", () => {
  test("extracts named and catch-all bracket params", () => {
    expect(dynamicRouteParams("pages/products/[sku].json")).toEqual(["sku"]);
    expect(dynamicRouteParams("pages/docs/[...slug].json")).toEqual(["slug"]);
    expect(dynamicRouteParams("pages/[lang]/posts/[id].json")).toEqual(["lang", "id"]);
  });

  test("returns empty for static paths and missing paths", () => {
    expect(dynamicRouteParams("pages/about.json")).toEqual([]);
    expect(dynamicRouteParams(null)).toEqual([]);
  });
});

describe("documentUrlPattern", () => {
  test("mirrors the compiler's fileToRoute conversion", () => {
    expect(documentUrlPattern("pages/products/[sku].json")).toBe("/products/:sku");
    expect(documentUrlPattern("./pages/docs/[...slug].json")).toBe("/docs/*");
    expect(documentUrlPattern("pages/index.json")).toBe("/");
    expect(documentUrlPattern("pages/blog/index.json")).toBe("/blog");
    expect(documentUrlPattern("pages/about.md")).toBe("/about");
    expect(documentUrlPattern(null)).toBe("/");
  });
});

describe("pagePathsDef", () => {
  test("prefers the document root and falls back to frontmatter", () => {
    const fromDoc = pagePathsDef({
      document: { $paths: { contentType: "product" } } as unknown as JxMutableNode,
      frontmatter: { $paths: { contentType: "other" } },
    });
    expect(fromDoc).toEqual({ contentType: "product" });

    const fromFrontmatter = pagePathsDef({
      document: { tagName: "div" } as JxMutableNode,
      frontmatter: { $paths: { values: ["a"] } },
    });
    expect(fromFrontmatter).toEqual({ values: ["a"] });

    expect(pagePathsDef({ document: { tagName: "div" } as JxMutableNode })).toBeNull();
  });
});

// ─── Enumeration ──────────────────────────────────────────────────────────────

describe("loadParamValues", () => {
  test("null $paths resolves to no params", async () => {
    expect(await loadParamValues("pages/x.json", null)).toEqual({});
  });

  test("values shape with default and explicit param names", async () => {
    expect(await loadParamValues("p1", { param: "lang", values: ["en", "fr"] })).toEqual({
      lang: ["en", "fr"],
    });
    expect(await loadParamValues("p2", { values: ["a", "b"] })).toEqual({ value: ["a", "b"] });
  });

  test("legacy array shape groups values per param and dedupes", async () => {
    const values = await loadParamValues("p3", [
      { slug: "hello" },
      { slug: "world" },
      { slug: "hello" },
      { slug: "" },
    ]);
    expect(values).toEqual({ slug: ["hello", "world"] });
  });

  test("contentType shape resolves entries via the platform and maps the field", async () => {
    const calls: Record<string, unknown>[] = [];
    installMockPlatform({
      resolveClass: async (body: Record<string, unknown>) => {
        calls.push(body);
        return [
          { data: { sku: "mini-trencher" }, id: "Mini Trencher" },
          { data: {}, id: "No Sku" },
          { data: { sku: "kubota-u35" }, id: "Kubota" },
        ];
      },
    });

    const values = await loadParamValues("p4", {
      contentType: "product",
      field: "sku",
      param: "sku",
    });
    expect(values).toEqual({ sku: ["mini-trencher", "No Sku", "kubota-u35"] });
    expect(calls).toEqual([
      {
        $prototype: "ContentCollection",
        $src: "@jxsuite/parser/ContentCollection.class.json",
        contentType: "product",
      },
    ]);
  });

  test("contentType shape derives $src from the extensions payload when present", async () => {
    setExtensions([
      {
        specifier: "@jxsuite/parser",
        name: "@jxsuite/parser",
        contributions: [],
        classes: [
          { name: "Markdown", path: "/ext/parser/src/Markdown.class.json" },
          { name: "ContentCollection", path: "/ext/parser/src/ContentCollection.class.json" },
        ],
      },
    ]);
    try {
      const calls: Record<string, unknown>[] = [];
      installMockPlatform({
        resolveClass: async (body: Record<string, unknown>) => {
          calls.push(body);
          return [];
        },
      });
      await loadParamValues("p4-ext", { contentType: "product" });
      expect(calls[0]?.$src).toBe("/ext/parser/src/ContentCollection.class.json");
    } finally {
      refreshFormats();
    }
  });

  test("contentType shape defaults to param=slug / field=id", async () => {
    installMockPlatform({
      resolveClass: async () => [
        { data: {}, id: "first" },
        { data: {}, id: "second" },
      ],
    });
    expect(await loadParamValues("p5", { contentType: "docs" })).toEqual({
      slug: ["first", "second"],
    });
  });

  test("non-array resolution result yields an empty candidate list", async () => {
    installMockPlatform({ resolveClass: async () => ({ error: "nope" }) });
    expect(await loadParamValues("p6", { contentType: "product" })).toEqual({ slug: [] });
  });

  test("$ref shape reads a JSON array via the platform readFile", async () => {
    installMockPlatform(
      {},
      {
        "data/products.json": JSON.stringify([
          { sku: "a-1" },
          { id: "fallback-id" },
          { sku: "b-2" },
        ]),
      },
    );
    const values = await loadParamValues("p7", {
      $ref: "./data/products.json",
      field: "sku",
      param: "sku",
    });
    expect(values).toEqual({ sku: ["a-1", "fallback-id", "b-2"] });
  });

  test("$ref shape tolerates a non-array payload and read failures", async () => {
    installMockPlatform({}, { "data/one.json": JSON.stringify({ not: "array" }) });
    expect(await loadParamValues("p8", { $ref: "./data/one.json", param: "id" })).toEqual({
      id: [],
    });
    // Missing file → the promise rejects internally, is caught, and resolves to {}.
    expect(await loadParamValues("p9", { $ref: "./data/missing.json" })).toEqual({});
  });

  test("results are cached per (documentPath, $paths) and invalidated explicitly", async () => {
    let callCount = 0;
    installMockPlatform({
      resolveClass: async () => {
        callCount += 1;
        return [{ data: {}, id: "only" }];
      },
    });
    const def = { contentType: "product" };
    await loadParamValues("p10", def);
    await loadParamValues("p10", def);
    expect(callCount).toBe(1);

    invalidateParamValues();
    await loadParamValues("p10", def);
    expect(callCount).toBe(2);
  });

  test("unrecognized shapes resolve to no params", async () => {
    expect(await loadParamValues("p11", {} as never)).toEqual({});
  });
});

// ─── Substitution ─────────────────────────────────────────────────────────────

describe("substitutePreviewParams", () => {
  const paramRef = (name: string) => ({ $ref: `#/$params/${name}` });

  test("replaces $params refs anywhere in the tree without mutating the input doc", () => {
    const doc = {
      children: [
        { attributes: { "data-sku": paramRef("sku") }, tagName: "span" },
        { children: [{ tagName: "b", textContent: "x" }], tagName: "div" },
      ],
      state: {
        product: { $prototype: "ContentEntry", contentType: "product", id: paramRef("sku") },
      },
      tagName: "main",
    } as unknown as JxMutableNode;

    const out = substitutePreviewParams(doc, { sku: "mini-trencher" }, "pages/products/[sku].json");

    const state = out.state as Record<string, Record<string, unknown>>;
    expect(state.product!.id).toBe("mini-trencher");
    const child = (out.children as JxMutableNode[])[0]!;
    expect((child.attributes as Record<string, unknown>)["data-sku"]).toBe("mini-trencher");
    // Pure: the input doc (which shares nodes with the tab's source document) keeps its $refs.
    const srcState = doc.state as Record<string, Record<string, unknown>>;
    expect(srcState.product!.id).toEqual(paramRef("sku"));
  });

  test("injects state.$page mirroring the compiler's context injection", () => {
    const doc = { tagName: "main", title: "Product" } as unknown as JxMutableNode;
    const out = substitutePreviewParams(doc, { sku: "b-2" }, "pages/products/[sku].json");
    expect((out.state as Record<string, unknown>).$page).toEqual({
      params: { sku: "b-2" },
      title: "Product",
      url: "/products/:sku",
    });
  });

  test("leaves refs for params without a chosen value and other $refs untouched", () => {
    const doc = {
      state: {
        other: { id: { $ref: "#/$defs/thing" } },
        pricing: { id: paramRef("missing") },
      },
      tagName: "main",
    } as unknown as JxMutableNode;
    const out = substitutePreviewParams(doc, { sku: "a" }, "pages/[sku].json");
    const state = out.state as Record<string, Record<string, unknown>>;
    expect(state.pricing!.id).toEqual(paramRef("missing"));
    expect(state.other!.id).toEqual({ $ref: "#/$defs/thing" });
  });

  test("returns the doc unchanged for an empty params map", () => {
    const doc = { state: { x: { id: paramRef("sku") } }, tagName: "main" } as never;
    const out = substitutePreviewParams(doc, {}, "pages/[sku].json");
    expect(out).toBe(doc);
    expect((out as { state: Record<string, unknown> }).state.$page).toBeUndefined();
  });
});

// ─── Param-bound state baking ─────────────────────────────────────────────────

describe("paramBoundStateKeys / resolveParamBoundState", () => {
  const paramRef = (name: string) => ({ $ref: `#/$params/${name}` });

  const sourceState = () => ({
    plain: { just: "data" },
    pricing: {
      $prototype: "ContentEntry",
      $src: "@jxsuite/parser/ContentEntry.class.json",
      contentType: "pricing",
      field: "sku",
      id: paramRef("sku"),
    },
    product: {
      $prototype: "ContentEntry",
      $src: "@jxsuite/parser/ContentEntry.class.json",
      contentType: "product",
      field: "sku",
      id: paramRef("sku"),
    },
    unbound: {
      $prototype: "ContentCollection",
      $src: "@jxsuite/parser/ContentCollection.class.json",
      contentType: "product",
    },
  });

  test("detects class-prototype entries that reference a route param", () => {
    expect(paramBoundStateKeys(sourceState())).toEqual(["pricing", "product"]);
    expect(paramBoundStateKeys(null)).toEqual([]);
    expect(paramBoundStateKeys({})).toEqual([]);
  });

  test("bakes resolved values into renderDoc.state via platform.resolveClass", async () => {
    const calls: Record<string, unknown>[] = [];
    installMockPlatform({
      resolveClass: async (body: Record<string, unknown>) => {
        calls.push(body);
        return { data: { sku: String(body.id) }, id: "resolved" };
      },
    });
    const doc = { state: sourceState(), tagName: "main" } as unknown as JxMutableNode;
    const keys = paramBoundStateKeys(doc.state as Record<string, unknown>);
    const out = substitutePreviewParams(doc, { sku: "a-1" }, "pages/[sku].json");
    await resolveParamBoundState(out, keys, "http://x/pages/[sku].json");

    const state = out.state as Record<string, Record<string, unknown>>;
    expect(state.product).toEqual({ data: { sku: "a-1" }, id: "resolved" });
    expect(state.pricing).toEqual({ data: { sku: "a-1" }, id: "resolved" });
    // Entries without a param binding stay untouched (runtime resolves them as usual).
    expect(state.unbound!.$prototype).toBe("ContentCollection");
    expect(state.plain).toEqual({ just: "data" });
    // The substituted literal id and $base reached the resolver.
    expect(calls.every((c) => c.id === "a-1" && c.$base === "http://x/pages/[sku].json")).toBe(
      true,
    );
  });

  test("a resolution failure leaves the entry for the runtime fallback", async () => {
    installMockPlatform({
      resolveClass: async () => {
        throw new Error("backend down");
      },
    });
    const doc = { state: sourceState(), tagName: "main" } as unknown as JxMutableNode;
    const keys = paramBoundStateKeys(doc.state as Record<string, unknown>);
    const out = substitutePreviewParams(doc, { sku: "a-1" }, "pages/[sku].json");
    await resolveParamBoundState(out, keys);
    const state = out.state as Record<string, Record<string, unknown>>;
    expect(state.product!.$prototype).toBe("ContentEntry");
    expect(state.product!.id).toBe("a-1");
  });

  test("no-ops without keys or a resolveClass-capable platform", async () => {
    installMockPlatform(); // No resolveClass
    const doc = { state: sourceState(), tagName: "main" } as unknown as JxMutableNode;
    const out = substitutePreviewParams(doc, { sku: "a-1" }, "pages/[sku].json");
    await resolveParamBoundState(out, ["product"]);
    expect((out.state as Record<string, Record<string, unknown>>).product!.id).toBe("a-1");
  });
});
