/** Content-types.test.js — Tests for Phase 2 content type system */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  loadContentConfig,
  loadContentTypes,
  queryContentType,
  findEntry,
  resolveContentTypeRefs,
  getContentTypeElements,
} from "../src/site/content-loader.js";
import { discoverPages, expandDynamicRoutes } from "../src/site/pages-discovery.js";
import { injectContext } from "../src/site/context-injection.js";
import { resolvePrototypes } from "../src/site/prototype-resolver.js";
import { loadProjectConfig } from "../src/site/site-loader.js";
import { buildSite } from "../src/site/site-build.js";

const TMP = resolve(import.meta.dir, "__test-content__");

/** Load project config from the test fixture */
function getProjectConfig() {
  return loadProjectConfig(TMP).config;
}

/** @param {string} relPath @param {string|object} content */
function writeFile(relPath, content) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });

  // project.json (includes contentTypes definition)
  writeFile("project.json", {
    name: "Content Test Site",
    url: "https://test.com",
    defaults: { layout: "./layouts/base.json", lang: "en" },
    build: { outDir: "./dist" },
    imports: {
      ContentCollection: "@jxsuite/parser/ContentCollection.class.json",
      ContentEntry: "@jxsuite/parser/ContentEntry.class.json",
    },
    contentTypes: {
      blog: {
        source: "./content/blog/",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            pubDate: { type: "string", format: "date" },
            draft: { type: "boolean", default: false },
            author: { $ref: "#/contentTypes/authors" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["title", "pubDate"],
        },
      },
      authors: {
        source: "./content/authors/",
        format: "json",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            bio: { type: "string" },
          },
          required: ["name"],
        },
      },
      products: {
        source: "./content/products/catalog.csv",
        schema: {
          type: "object",
          properties: {
            sku: { type: "string" },
            name: { type: "string" },
            price: { type: "number" },
            category: { type: "string" },
          },
          required: ["sku", "name", "price"],
        },
      },
    },
  });

  // Layout
  writeFile("layouts/base.json", {
    tagName: "div",
    children: [{ tagName: "main", children: [{ tagName: "slot" }] }],
  });

  // Blog posts (Markdown)
  writeFile(
    "content/blog/hello-world.md",
    `---
title: Hello World
pubDate: "2024-01-15"
author: jane
tags:
  - intro
  - welcome
draft: false
---

# Hello World

This is my first blog post. Welcome!
`,
  );

  writeFile(
    "content/blog/second-post.md",
    `---
title: Second Post
pubDate: "2024-02-20"
author: jane
tags:
  - update
draft: false
---

# Second Post

Another great article here.
`,
  );

  writeFile(
    "content/blog/draft-post.md",
    `---
title: Draft Post
pubDate: "2024-03-01"
draft: true
---

# Draft

This shouldn't show up in published lists.
`,
  );

  // Authors (JSON)
  writeFile("content/authors/jane.json", {
    id: "jane",
    name: "Jane Doe",
    bio: "A prolific writer",
  });

  // Products (CSV)
  writeFile(
    "content/products/catalog.csv",
    `sku,name,price,category
WIDGET-1,Blue Widget,9.99,widgets
GADGET-2,Red Gadget,19.99,gadgets
WIDGET-3,Green Widget,14.99,widgets`,
  );

  // ── Pages ─────────────────────────────────────────────────────────────

  // Static index page
  writeFile("pages/index.json", {
    title: "Home",
    children: [{ tagName: "h1", children: ["Home"] }],
  });

  // Blog listing page
  writeFile("pages/blog/index.json", {
    title: "Blog",
    state: {
      posts: {
        $prototype: "ContentCollection",
        contentType: "blog",
        filter: { draft: false },
        sort: { field: "pubDate", order: "desc" },
      },
    },
    children: [{ tagName: "h1", children: ["Blog Posts"] }],
  });

  // Dynamic blog post page — content type-based $paths
  writeFile("pages/blog/[slug].json", {
    title: "Blog Post",
    $paths: {
      contentType: "blog",
      param: "slug",
      field: "id",
    },
    state: {
      post: {
        $prototype: "ContentEntry",
        contentType: "blog",
        id: { $ref: "#/$params/slug" },
      },
    },
    children: [{ tagName: "article", children: ["Post content here"] }],
  });

  // Page with explicit $paths values
  writeFile("pages/[lang]/index.json", {
    title: "Localized",
    $paths: {
      values: ["en", "fr", "de"],
      param: "lang",
    },
    children: [{ tagName: "h1", children: ["Localized Page"] }],
  });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ── content-loader ────────────────────────────────────────────────────────────

describe("content-loader", () => {
  describe("loadContentConfig", () => {
    it("loads content.config.json", () => {
      const result = /** @type {any} */ (loadContentConfig(TMP, getProjectConfig()));
      expect(result).not.toBeNull();
      expect(result.config.contentTypes).toBeDefined();
      expect(result.config.contentTypes.blog).toBeDefined();
      expect(result.config.contentTypes.authors).toBeDefined();
      expect(result.config.contentTypes.products).toBeDefined();
    });

    it("returns empty contentTypes when no project config", () => {
      const result = /** @type {any} */ (loadContentConfig("/tmp/nope-" + Date.now()));
      expect(result).not.toBeNull();
      expect(result.config.contentTypes).toEqual({});
    });
  });

  describe("loadContentTypes", () => {
    it("loads Markdown content type entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("blog"));
      expect(blog).toBeDefined();
      expect(blog.length).toBe(3); // hello-world, second-post, draft-post

      const hello = /** @type {any} */ (blog.find((e) => e.id === "hello-world"));
      expect(hello).toBeDefined();
      expect(hello.data.title).toBe("Hello World");
      expect(hello.data.pubDate).toBe("2024-01-15");
      expect(Array.isArray(hello.$children)).toBe(true);
      expect(hello.$children.some((/** @type {JxElement} */ n) => n.tagName === "h1")).toBe(true);
      expect(hello.body).toContain("# Hello World");
    });

    it("loads JSON content type entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const authors = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("authors"));
      expect(authors).toBeDefined();
      expect(authors.length).toBe(1);
      expect(authors[0].id).toBe("jane");
      expect(authors[0].data.name).toBe("Jane Doe");
    });

    it("loads CSV content type entries with type coercion", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const products = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("products"));
      expect(products).toBeDefined();
      expect(products.length).toBe(3);

      const widget = /** @type {any} */ (products.find((e) => e.id === "WIDGET-1"));
      expect(widget).toBeDefined();
      expect(widget.data.name).toBe("Blue Widget");
      expect(widget.data.price).toBe(9.99); // coerced to number
      expect(typeof widget.data.price).toBe("number");
    });
  });

  describe("queryContentType", () => {
    it("filters entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("blog"));
      const published = queryContentType(blog, { filter: { draft: false } });
      expect(published.length).toBe(2);
      expect(published.every((e) => e.data.draft === false)).toBe(true);
    });

    it("sorts entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("blog"));
      const sorted = /** @type {ContentLoaderEntry[]} */ (
        queryContentType(blog, {
          sort: { field: "pubDate", order: "desc" },
        })
      );
      expect(
        /** @type {any} */ (sorted[0].data.pubDate) >= /** @type {any} */ (sorted[1].data.pubDate),
      ).toBe(true);
    });

    it("limits entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("blog"));
      const limited = queryContentType(blog, { limit: 1 });
      expect(limited.length).toBe(1);
    });

    it("combines filter + sort + limit", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("blog"));
      const result = queryContentType(blog, {
        filter: { draft: false },
        sort: { field: "pubDate", order: "desc" },
        limit: 1,
      });
      expect(result.length).toBe(1);
      expect(result[0].data.title).toBe("Second Post"); // most recent non-draft
    });
  });

  describe("findEntry", () => {
    it("finds entry by ID", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("blog"));
      const entry = /** @type {any} */ (findEntry(blog, "hello-world"));
      expect(entry).not.toBeNull();
      expect(/** @type {any} */ (entry).data.title).toBe("Hello World");
    });

    it("returns null for missing ID", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("blog"));
      expect(findEntry(blog, "nonexistent")).toBeNull();
    });
  });

  describe("resolveContentTypeRefs", () => {
    it("resolves cross-content-type $ref (author → authors)", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const contentConfig = /** @type {any} */ (loadContentConfig(TMP, getProjectConfig()));
      resolveContentTypeRefs(contentTypes, contentConfig.config);

      const blog = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("blog"));
      const hello = /** @type {any} */ (blog.find((e) => e.id === "hello-world"));
      // Author "jane" should be resolved to the full author entry
      expect(hello.data.author).toBeDefined();
      expect(typeof hello.data.author).toBe("object");
      expect(hello.data.author.data.name).toBe("Jane Doe");
    });
  });
});

// ── $paths expansion ──────────────────────────────────────────────────────────

describe("$paths expansion", () => {
  it("expands content type-based $paths", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const pagesDir = resolve(TMP, "pages");
    const routes = discoverPages(pagesDir);
    const expanded = await expandDynamicRoutes(routes, TMP, contentTypes);

    const blogRoutes = expanded.filter(
      (r) => r.urlPattern.startsWith("/blog/") && r.urlPattern !== "/blog",
    );
    // Should have one route per blog entry (3 posts)
    expect(blogRoutes.length).toBe(3);
    expect(blogRoutes.map((r) => r.urlPattern).sort()).toEqual([
      "/blog/draft-post",
      "/blog/hello-world",
      "/blog/second-post",
    ]);
  });

  it("expands explicit values $paths", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const pagesDir = resolve(TMP, "pages");
    const routes = discoverPages(pagesDir);
    const expanded = await expandDynamicRoutes(routes, TMP, contentTypes);

    const langRoutes = expanded.filter((r) => ["/en", "/fr", "/de"].includes(r.urlPattern));
    expect(langRoutes.length).toBe(3);
  });

  it("preserves _pathParams on expanded routes", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const pagesDir = resolve(TMP, "pages");
    const routes = discoverPages(pagesDir);
    const expanded = await expandDynamicRoutes(routes, TMP, contentTypes);

    const hello = /** @type {any} */ (expanded.find((r) => r.urlPattern === "/blog/hello-world"));
    expect(hello._pathParams).toEqual({ slug: "hello-world" });
  });
});

// ── ContentCollection/ContentEntry $prototype resolution ──────────────────────

describe("$prototype resolution in context-injection", () => {
  it("resolves ContentCollection $prototype in state", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    /** @type {any} */
    const doc = {
      imports: {
        ContentCollection: "@jxsuite/parser/ContentCollection.class.json",
      },
      state: {
        posts: {
          $prototype: "ContentCollection",
          contentType: "blog",
          filter: { draft: false },
          sort: { field: "pubDate", order: "desc" },
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { urlPattern: "/blog", _pathParams: {} };

    injectContext(doc, projectConfig, route, contentTypes);
    await resolvePrototypes(doc, route, TMP, { config: projectConfig, contentTypes });

    expect(Array.isArray(doc.state.posts)).toBe(true);
    expect(doc.state.posts.length).toBe(2); // non-drafts
    expect(doc.state.posts[0].data.title).toBe("Second Post"); // desc order
  });

  it("resolves ContentEntry $prototype with $params ref", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    /** @type {any} */
    const doc = {
      imports: {
        ContentEntry: "@jxsuite/parser/ContentEntry.class.json",
      },
      state: {
        post: {
          $prototype: "ContentEntry",
          contentType: "blog",
          id: { $ref: "#/$params/slug" },
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = {
      urlPattern: "/blog/hello-world",
      _pathParams: { slug: "hello-world" },
    };

    injectContext(doc, projectConfig, route, contentTypes);
    await resolvePrototypes(doc, route, TMP, { config: projectConfig, contentTypes });

    expect(doc.state.post).not.toBeNull();
    expect(doc.state.post.id).toBe("hello-world");
    expect(doc.state.post.data.title).toBe("Hello World");
    expect(Array.isArray(doc.state.post.$children)).toBe(true);
  });

  it("returns null for missing ContentEntry", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const doc = {
      imports: {
        ContentEntry: "@jxsuite/parser/ContentEntry.class.json",
      },
      state: {
        post: {
          $prototype: "ContentEntry",
          contentType: "blog",
          id: "nonexistent",
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { urlPattern: "/blog/nope", _pathParams: {} };

    injectContext(doc, projectConfig, route, contentTypes);
    await resolvePrototypes(doc, route, TMP, { config: projectConfig, contentTypes });

    expect(doc.state.post).toBeNull();
  });

  it("returns empty array for missing content type", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    /** @type {any} */
    const doc = {
      imports: {
        ContentCollection: "@jxsuite/parser/ContentCollection.class.json",
      },
      state: {
        items: {
          $prototype: "ContentCollection",
          contentType: "nonexistent",
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { urlPattern: "/", _pathParams: {} };

    injectContext(doc, projectConfig, route, contentTypes);
    await resolvePrototypes(doc, route, TMP, { config: projectConfig, contentTypes });

    expect(doc.state.items).toEqual([]);
  });
});

// ── Full build with content ───────────────────────────────────────────────────

describe("buildSite with content types", () => {
  it("builds site with content-driven dynamic routes", async () => {
    const result = await buildSite(TMP, { verbose: false });

    expect(result.errors).toHaveLength(0);

    // Static: /, /blog
    // Dynamic blog: /blog/hello-world, /blog/second-post, /blog/draft-post
    // Dynamic lang: /en, /fr, /de
    expect(result.routes).toBe(8);

    // Verify output files
    const dist = resolve(TMP, "dist");
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(existsSync(join(dist, "blog/index.html"))).toBe(true);
    expect(existsSync(join(dist, "blog/hello-world/index.html"))).toBe(true);
    expect(existsSync(join(dist, "blog/second-post/index.html"))).toBe(true);
    expect(existsSync(join(dist, "blog/draft-post/index.html"))).toBe(true);
    expect(existsSync(join(dist, "en/index.html"))).toBe(true);
    expect(existsSync(join(dist, "fr/index.html"))).toBe(true);
    expect(existsSync(join(dist, "de/index.html"))).toBe(true);
  });
});

// ── content-loader edge cases ────────────────────────────────────────────────

describe("content-loader edge cases", () => {
  it("parses CSV with quoted newlines and escaped quotes", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-csv__");
    rmSync(TMP2, { recursive: true, force: true });
    mkdirSync(resolve(TMP2, "content/items"), { recursive: true });

    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({
        contentTypes: {
          items: {
            source: "./content/items/data.csv",
            schema: {
              properties: { name: { type: "string" }, desc: { type: "string" } },
              required: ["name"],
            },
          },
        },
      }),
    );
    // CSV with: multiline field (newline inside quotes) AND doubled-quote escape
    writeFileSync(
      resolve(TMP2, "content/items/data.csv"),
      'name,desc\n"Line1\nLine2",Simple\n"Has ""quotes""",Plain',
    );

    try {
      const contentTypes = await loadContentTypes(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const items = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("items"));
      expect(items.length).toBe(2);
      // First item: multiline field preserved correctly
      expect(items[0].data.name).toBe("Line1\nLine2");
      // Second item: escaped quotes resolved to literal quotes
      expect(items[1].data.name).toBe('Has "quotes"');
    } finally {
      rmSync(TMP2, { recursive: true, force: true });
    }
  });

  it("loads JSON array entries without id fields", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-json-arr__");
    rmSync(TMP2, { recursive: true, force: true });
    mkdirSync(resolve(TMP2, "content/items"), { recursive: true });

    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({
        contentTypes: {
          items: {
            source: "./content/items/list.json",
            schema: { properties: { name: { type: "string" } } },
          },
        },
      }),
    );
    writeFileSync(
      resolve(TMP2, "content/items/list.json"),
      JSON.stringify([{ name: "Alpha" }, { name: "Beta" }]),
    );

    try {
      const contentTypes = await loadContentTypes(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const items = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("items"));
      expect(items.length).toBe(2);
      expect(items[0].id).toContain("list-0");
      expect(items[1].id).toContain("list-1");
    } finally {
      rmSync(TMP2, { recursive: true, force: true });
    }
  });

  it("getContentTypeElements returns $elements from content type def", () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-elements__");
    rmSync(TMP2, { recursive: true, force: true });
    mkdirSync(TMP2, { recursive: true });

    const projectConfig = {
      contentTypes: {
        blog: {
          source: "./content/blog/",
          $elements: ["my-component", { $ref: "./card.json" }],
        },
      },
    };

    const result = getContentTypeElements(TMP2, "blog", projectConfig);
    expect(result).toEqual(["my-component", { $ref: "./card.json" }]);

    const missing = getContentTypeElements(TMP2, "nonexistent", projectConfig);
    expect(missing).toBeUndefined();

    rmSync(TMP2, { recursive: true, force: true });
  });

  it("validates entries: warns on missing required field", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-validate__");
    rmSync(TMP2, { recursive: true, force: true });
    mkdirSync(resolve(TMP2, "content/items"), { recursive: true });

    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({
        contentTypes: {
          items: {
            source: "./content/items/",
            format: "json",
            schema: {
              properties: {
                name: { type: "string" },
                count: { type: "number" },
                active: { type: "boolean" },
                tags: { type: "array" },
              },
              required: ["name"],
            },
          },
        },
      }),
    );
    // Entry missing required "name" field, and has wrong types for all checked branches
    writeFileSync(
      resolve(TMP2, "content/items/bad.json"),
      JSON.stringify({
        id: "bad",
        name: 123,
        count: "not-a-number",
        active: "yes",
        tags: "not-array",
      }),
    );

    try {
      const contentTypes = await loadContentTypes(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const items = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("items"));
      expect(items.length).toBe(1);
      expect(items[0].id).toBe("bad");
    } finally {
      rmSync(TMP2, { recursive: true, force: true });
    }
  });

  it("sorts entries in ascending order (comparison branches)", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const blog = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("blog"));
    const sorted = /** @type {ContentLoaderEntry[]} */ (
      queryContentType(blog, {
        sort: { field: "pubDate", order: "asc" },
      })
    );
    expect(
      /** @type {any} */ (sorted[0].data.pubDate) <= /** @type {any} */ (sorted[1].data.pubDate),
    ).toBe(true);
  });

  it("loadCollection with $elements passes allowedNames", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-directives__");
    rmSync(TMP2, { recursive: true, force: true });
    mkdirSync(resolve(TMP2, "content/docs"), { recursive: true });

    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({
        contentTypes: {
          docs: {
            source: "./content/docs/",
            $elements: ["my-widget", { $ref: "./card.json" }],
            schema: { properties: { title: { type: "string" } } },
          },
        },
      }),
    );
    writeFileSync(resolve(TMP2, "content/docs/intro.md"), "---\ntitle: Intro\n---\n\nHello docs\n");

    try {
      const contentTypes = await loadContentTypes(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const docs = /** @type {ContentLoaderEntry[]} */ (contentTypes.get("docs"));
      expect(docs.length).toBe(1);
      expect(docs[0].data.title).toBe("Intro");
    } finally {
      rmSync(TMP2, { recursive: true, force: true });
    }
  });

  it("validates missing required fields with console.warn", async () => {
    const TMP3 = resolve(import.meta.dir, "__test-content-validation__");
    rmSync(TMP3, { recursive: true, force: true });
    mkdirSync(resolve(TMP3, "content/items"), { recursive: true });

    writeFileSync(
      resolve(TMP3, "project.json"),
      JSON.stringify({
        contentTypes: {
          items: {
            source: "./content/items/",
            format: "json",
            schema: {
              required: ["name", "price"],
              properties: { name: { type: "string" }, price: { type: "number" } },
            },
          },
        },
      }),
    );
    writeFileSync(
      resolve(TMP3, "content/items/incomplete.json"),
      JSON.stringify({ id: "incomplete", price: 10 }),
    );

    /** @type {string[]} */
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (/** @type {string} */ msg) => warnings.push(msg);
    try {
      const contentTypes = await loadContentTypes(
        TMP3,
        JSON.parse(readFileSync(resolve(TMP3, "project.json"), "utf8")),
      );
      expect(contentTypes.get("items")).toHaveLength(1);
      expect(warnings.some((w) => w.includes("missing required field"))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(TMP3, { recursive: true, force: true });
    }
  });

  it("sorts entries in descending order", async () => {
    /** @type {any []} */
    const entries = [
      { id: "a", data: { score: 10 }, body: null },
      { id: "b", data: { score: 30 }, body: null },
      { id: "c", data: { score: 20 }, body: null },
    ];
    const ascSorted = queryContentType(entries, { sort: { field: "score", order: "asc" } });
    expect(ascSorted[0].data.score).toBe(10);
    expect(ascSorted[2].data.score).toBe(30);
    const descSorted = queryContentType(entries, { sort: { field: "score", order: "desc" } });
    expect(descSorted[0].data.score).toBe(30);
    expect(descSorted[2].data.score).toBe(10);
  });
});

// ── Array-based filter and multi-field sort ─────────────────────────────────

describe("queryContentType — array filter with operators", () => {
  /** @type {any[]} */
  const entries = [
    { id: "a", data: { title: "Alpha Guide", score: 10, draft: false, tags: ["web"] }, body: null },
    { id: "b", data: { title: "Beta Post", score: 25, draft: true, tags: [] }, body: null },
    {
      id: "c",
      data: { title: "Gamma Tutorial", score: 15, draft: false, tags: ["api", "web"] },
      body: null,
    },
    { id: "d", data: { title: "", score: 5, draft: false, tags: null }, body: null },
  ];

  it("== operator matches exact values", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "draft", op: "==", value: true }],
    });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("b");
  });

  it("!= operator excludes values", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "draft", op: "!=", value: true }],
    });
    expect(result.length).toBe(3);
    expect(result.every((e) => e.data.draft === false)).toBe(true);
  });

  it("contains operator matches substring", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "title", op: "contains", value: "Guide" }],
    });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("a");
  });

  it("not contains operator excludes substring", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "title", op: "not contains", value: "Post" }],
    });
    expect(result.length).toBe(3);
    expect(result.every((e) => !(/** @type {string} */ (e.data.title).includes("Post")))).toBe(
      true,
    );
  });

  it("> operator for numeric comparison", () => {
    const result = queryContentType(entries, { filter: [{ field: "score", op: ">", value: 10 }] });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).sort()).toEqual(["b", "c"]);
  });

  it("< operator for numeric comparison", () => {
    const result = queryContentType(entries, { filter: [{ field: "score", op: "<", value: 15 }] });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).sort()).toEqual(["a", "d"]);
  });

  it(">= operator", () => {
    const result = queryContentType(entries, { filter: [{ field: "score", op: ">=", value: 15 }] });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).sort()).toEqual(["b", "c"]);
  });

  it("<= operator", () => {
    const result = queryContentType(entries, { filter: [{ field: "score", op: "<=", value: 10 }] });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).sort()).toEqual(["a", "d"]);
  });

  it("empty operator detects null/empty string/empty array", () => {
    const result = queryContentType(entries, { filter: [{ field: "tags", op: "empty" }] });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).sort()).toEqual(["b", "d"]);
  });

  it("not empty operator detects non-null/non-empty", () => {
    const result = queryContentType(entries, { filter: [{ field: "tags", op: "not empty" }] });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).sort()).toEqual(["a", "c"]);
  });

  it("empty operator on string field", () => {
    const result = queryContentType(entries, { filter: [{ field: "title", op: "empty" }] });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("d");
  });

  it("multiple rules are ANDed together", () => {
    const result = queryContentType(entries, {
      filter: [
        { field: "draft", op: "==", value: false },
        { field: "score", op: ">", value: 5 },
      ],
    });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).sort()).toEqual(["a", "c"]);
  });

  it("field 'id' matches entry.id", () => {
    const result = queryContentType(entries, { filter: [{ field: "id", op: "==", value: "c" }] });
    expect(result.length).toBe(1);
    expect(result[0].data.title).toBe("Gamma Tutorial");
  });

  it("legacy plain-object filter still works", () => {
    const result = queryContentType(entries, { filter: { draft: false, score: 10 } });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("a");
  });
});

describe("queryContentType — multi-field sort", () => {
  /** @type {any[]} */
  const entries = [
    { id: "1", data: { category: "B", title: "Zebra" }, body: null },
    { id: "2", data: { category: "A", title: "Mango" }, body: null },
    { id: "3", data: { category: "B", title: "Apple" }, body: null },
    { id: "4", data: { category: "A", title: "Cherry" }, body: null },
  ];

  it("sorts by multiple fields (array format)", () => {
    const result = queryContentType(entries, {
      sort: [
        { field: "category", order: "asc" },
        { field: "title", order: "asc" },
      ],
    });
    expect(result.map((e) => e.id)).toEqual(["4", "2", "3", "1"]);
  });

  it("multi-field sort with mixed orders", () => {
    const result = queryContentType(entries, {
      sort: [
        { field: "category", order: "asc" },
        { field: "title", order: "desc" },
      ],
    });
    expect(result.map((e) => e.id)).toEqual(["2", "4", "1", "3"]);
  });

  it("legacy single-object sort still works", () => {
    const result = queryContentType(entries, { sort: { field: "title", order: "asc" } });
    expect(result[0].data.title).toBe("Apple");
    expect(result[3].data.title).toBe("Zebra");
  });

  it("sorts by id field", () => {
    const result = queryContentType(entries, { sort: [{ field: "id", order: "desc" }] });
    expect(result.map((e) => e.id)).toEqual(["4", "3", "2", "1"]);
  });

  it("combined array filter + array sort + limit", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "category", op: "==", value: "B" }],
      sort: [{ field: "title", order: "asc" }],
      limit: 1,
    });
    expect(result.length).toBe(1);
    expect(result[0].data.title).toBe("Apple");
  });
});
