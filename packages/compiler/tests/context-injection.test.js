import { describe, test, expect } from "bun:test";
import { injectContext } from "../src/site/context-injection.js";
import { resolvePrototypes } from "../src/site/prototype-resolver.js";

// ─── injectContext ──────────────────────────────────────────────────────────

describe("injectContext", () => {
  const baseProject = {
    name: "Test Site",
    url: "https://example.com",
  };

  const baseRoute = {
    urlPattern: "/about",
  };

  test("injects $site context into state", () => {
    /** @type {Record<string, any>} */
    const doc = {};
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state.$site.name).toBe("Test Site");
    expect(doc.state.$site.url).toBe("https://example.com");
  });

  test("injects $page context into state", () => {
    /** @type {Record<string, any>} */
    const doc = { title: "About Us" };
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state.$page.url).toBe("/about");
    expect(doc.state.$page.title).toBe("About Us");
    expect(doc.state.$page.params).toEqual({});
  });

  test("uses project name as fallback page title", () => {
    /** @type {Record<string, any>} */
    const doc = {};
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state.$page.title).toBe("Test Site");
  });

  test("uses _pageTitle as intermediate fallback", () => {
    /** @type {Record<string, any>} */
    const doc = { _pageTitle: "Layout Title" };
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state.$page.title).toBe("Layout Title");
  });

  test("includes route path params", () => {
    /** @type {Record<string, any>} */
    const doc = {};
    const route = { urlPattern: "/blog/:slug", _pathParams: { slug: "hello-world" } };
    injectContext(doc, baseProject, route);
    expect(doc.state.$page.params).toEqual({ slug: "hello-world" });
  });

  test("merges project state into page state (page wins)", () => {
    /** @type {Record<string, any>} */
    const doc = { state: { count: 42 } };
    const project = { ...baseProject, state: { count: 0, theme: "dark" } };
    injectContext(doc, project, baseRoute);
    expect(doc.state.count).toBe(42);
    expect(doc.state.theme).toBe("dark");
  });

  test("does not overwrite $site/$page with project state", () => {
    /** @type {Record<string, any>} */
    const doc = {};
    const project = { ...baseProject, state: { $site: "bad", $page: "bad" } };
    injectContext(doc, project, baseRoute);
    expect(doc.state.$site).not.toBe("bad");
    expect(doc.state.$page).not.toBe("bad");
  });

  test("merges project $media into page $media", () => {
    /** @type {Record<string, any>} */
    const doc = { $media: { "--sm": "(min-width: 640px)" } };
    const project = { ...baseProject, $media: { "--lg": "(min-width: 1024px)" } };
    injectContext(doc, project, baseRoute);
    expect(doc.$media["--sm"]).toBe("(min-width: 640px)");
    expect(doc.$media["--lg"]).toBe("(min-width: 1024px)");
  });

  test("page $media overrides project $media on conflict", () => {
    /** @type {Record<string, any>} */
    const doc = { $media: { "--md": "(min-width: 800px)" } };
    const project = { ...baseProject, $media: { "--md": "(min-width: 768px)" } };
    injectContext(doc, project, baseRoute);
    expect(doc.$media["--md"]).toBe("(min-width: 800px)");
  });

  test("merges project imports into page imports", () => {
    /** @type {Record<string, any>} */
    const doc = { imports: { MyClass: "./local.class.json" } };
    const project = {
      ...baseProject,
      imports: { Parser: "@jxsuite/parser/Parser.class.json" },
    };
    injectContext(doc, project, baseRoute);
    expect(doc.imports.MyClass).toBe("./local.class.json");
    expect(doc.imports.Parser).toBe("@jxsuite/parser/Parser.class.json");
  });

  test("page imports win on collision", () => {
    /** @type {any} */
    const doc = { imports: { Parser: "./my-parser.class.json" } };
    const project = {
      ...baseProject,
      imports: { Parser: "@jxsuite/parser/Parser.class.json" },
    };
    injectContext(doc, project, baseRoute);
    expect(doc.imports.Parser).toBe("./my-parser.class.json");
  });

  test("merges project $elements into page $elements (union, dedup)", () => {
    const doc = {
      $elements: [{ $ref: "./comp-a.json" }],
    };
    const project = {
      ...baseProject,
      $elements: [{ $ref: "./comp-b.json" }],
    };
    injectContext(doc, project, baseRoute);
    expect(doc.$elements).toHaveLength(2);
  });

  test("deduplicates $elements by $ref", () => {
    const doc = {
      $elements: [{ $ref: "./comp-a.json" }],
    };
    const project = {
      ...baseProject,
      $elements: [{ $ref: "./comp-a.json" }],
    };
    injectContext(doc, project, baseRoute);
    expect(doc.$elements).toHaveLength(1);
  });

  test("creates state if not present on doc", () => {
    /** @type {Record<string, any>} */
    const doc = {};
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state).toBeDefined();
    expect(doc.state.$site).toBeDefined();
    expect(doc.state.$page).toBeDefined();
  });

  test("spreads project state into $site", () => {
    const project = { ...baseProject, state: { analytics: "GA-123" } };
    /** @type {Record<string, any>} */
    const doc = {};
    injectContext(doc, project, baseRoute);
    expect(doc.state.$site.analytics).toBe("GA-123");
  });

  test("defaults $site.name to 'Jx Site' when project name missing", () => {
    /** @type {Record<string, any>} */
    const doc = {};
    injectContext(doc, {}, baseRoute);
    expect(doc.state.$site.name).toBe("Jx Site");
  });

  test("rebases relative project imports to page source path", () => {
    /** @type {Record<string, any>} */
    const doc = {};
    const project = {
      ...baseProject,
      imports: { Utils: "./lib/utils.class.json" },
    };
    const route = { urlPattern: "/blog/post", sourcePath: "/project/pages/blog/post.json" };
    injectContext(doc, project, route, new Map(), "/project");
    expect(doc.imports.Utils).toContain("utils.class.json");
    expect(doc.imports.Utils).toMatch(/^\.\//);
  });

  test("injects project $elements when page has none", () => {
    /** @type {Record<string, any>} */
    const doc = {};
    const project = {
      ...baseProject,
      $elements: [{ $ref: "./components/card.json" }],
    };
    injectContext(doc, project, baseRoute);
    expect(doc.$elements).toHaveLength(1);
    expect(doc.$elements[0].$ref).toBe("./components/card.json");
  });

  test("resolves ContentEntry with missing content type gracefully", async () => {
    /** @type {Record<string, any>} */
    const doc = {
      imports: {
        ContentEntry: "@jxsuite/parser/ContentEntry.class.json",
      },
      state: {
        post: { $prototype: "ContentEntry", contentType: "nonexistent", id: "abc" },
      },
    };
    const contentTypes = /** @type {any} */ (new Map([["posts", [{ id: "x", data: {} }]]]));
    injectContext(doc, baseProject, /** @type {any} */ (baseRoute), contentTypes);
    await resolvePrototypes(doc, /** @type {any} */ (baseRoute), import.meta.dir, {
      config: baseProject,
      contentTypes,
    });
    expect(doc.state.post).toBeNull();
  });
});
