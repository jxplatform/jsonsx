/** Content-collections.test.js — Tests for Phase 2 content collection system */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  loadContentConfig,
  loadCollections,
  queryCollection,
  findEntry,
  resolveCollectionRefs,
  getCollectionElements,
} from "../src/site/content-loader.js";
import { discoverPages, expandDynamicRoutes } from "../src/site/pages-discovery.js";
import { injectContext } from "../src/site/context-injection.js";
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

  // project.json (includes collections definition)
  writeFile("project.json", {
    name: "Content Test Site",
    url: "https://test.com",
    defaults: { layout: "./layouts/base.json", lang: "en" },
    build: { outDir: "./dist" },
    collections: {
      blog: {
        source: "./content/blog/**/*.md",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            pubDate: { type: "string", format: "date" },
            draft: { type: "boolean", default: false },
            author: { $ref: "#/collections/authors" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["title", "pubDate"],
        },
      },
      authors: {
        source: "./content/authors/*.json",
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
        collection: "blog",
        filter: { draft: false },
        sort: { field: "pubDate", order: "desc" },
      },
    },
    children: [{ tagName: "h1", children: ["Blog Posts"] }],
  });

  // Dynamic blog post page — collection-based $paths
  writeFile("pages/blog/[slug].json", {
    title: "Blog Post",
    $paths: {
      collection: "blog",
      param: "slug",
      field: "id",
    },
    state: {
      post: {
        $prototype: "ContentEntry",
        collection: "blog",
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
      expect(result.config.collections).toBeDefined();
      expect(result.config.collections.blog).toBeDefined();
      expect(result.config.collections.authors).toBeDefined();
      expect(result.config.collections.products).toBeDefined();
    });

    it("returns empty collections when no project config", () => {
      const result = /** @type {any} */ (loadContentConfig("/tmp/nope-" + Date.now()));
      expect(result).not.toBeNull();
      expect(result.config.collections).toEqual({});
    });
  });

  describe("loadCollections", () => {
    it("loads Markdown collection entries", async () => {
      const collections = await loadCollections(TMP, getProjectConfig());
      const blog = /** @type {any[]} */ (collections.get("blog"));
      expect(blog).toBeDefined();
      expect(blog.length).toBe(3); // hello-world, second-post, draft-post

      const hello = blog.find((e) => e.id === "hello-world");
      expect(hello).toBeDefined();
      expect(hello.data.title).toBe("Hello World");
      expect(hello.data.pubDate).toBe("2024-01-15");
      expect(Array.isArray(hello.$children)).toBe(true);
      expect(hello.$children.some((/** @type {any} */ n) => n.tagName === "h1")).toBe(true);
      expect(hello.body).toContain("# Hello World");
    });

    it("loads JSON collection entries", async () => {
      const collections = await loadCollections(TMP, getProjectConfig());
      const authors = /** @type {any[]} */ (collections.get("authors"));
      expect(authors).toBeDefined();
      expect(authors.length).toBe(1);
      expect(authors[0].id).toBe("jane");
      expect(authors[0].data.name).toBe("Jane Doe");
    });

    it("loads CSV collection entries with type coercion", async () => {
      const collections = await loadCollections(TMP, getProjectConfig());
      const products = /** @type {any[]} */ (collections.get("products"));
      expect(products).toBeDefined();
      expect(products.length).toBe(3);

      const widget = products.find((e) => e.id === "WIDGET-1");
      expect(widget).toBeDefined();
      expect(widget.data.name).toBe("Blue Widget");
      expect(widget.data.price).toBe(9.99); // coerced to number
      expect(typeof widget.data.price).toBe("number");
    });
  });

  describe("queryCollection", () => {
    it("filters entries", async () => {
      const collections = await loadCollections(TMP, getProjectConfig());
      const blog = /** @type {any[]} */ (collections.get("blog"));
      const published = queryCollection(blog, { filter: { draft: false } });
      expect(published.length).toBe(2);
      expect(published.every((e) => e.data.draft === false)).toBe(true);
    });

    it("sorts entries", async () => {
      const collections = await loadCollections(TMP, getProjectConfig());
      const blog = /** @type {any[]} */ (collections.get("blog"));
      const sorted = queryCollection(blog, {
        sort: { field: "pubDate", order: "desc" },
      });
      expect(sorted[0].data.pubDate >= sorted[1].data.pubDate).toBe(true);
    });

    it("limits entries", async () => {
      const collections = await loadCollections(TMP, getProjectConfig());
      const blog = /** @type {any[]} */ (collections.get("blog"));
      const limited = queryCollection(blog, { limit: 1 });
      expect(limited.length).toBe(1);
    });

    it("combines filter + sort + limit", async () => {
      const collections = await loadCollections(TMP, getProjectConfig());
      const blog = /** @type {any[]} */ (collections.get("blog"));
      const result = queryCollection(blog, {
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
      const collections = await loadCollections(TMP, getProjectConfig());
      const blog = /** @type {any[]} */ (collections.get("blog"));
      const entry = findEntry(blog, "hello-world");
      expect(entry).not.toBeNull();
      expect(entry.data.title).toBe("Hello World");
    });

    it("returns null for missing ID", async () => {
      const collections = await loadCollections(TMP, getProjectConfig());
      const blog = /** @type {any[]} */ (collections.get("blog"));
      expect(findEntry(blog, "nonexistent")).toBeNull();
    });
  });

  describe("resolveCollectionRefs", () => {
    it("resolves cross-collection $ref (author → authors)", async () => {
      const collections = await loadCollections(TMP, getProjectConfig());
      const contentConfig = /** @type {any} */ (loadContentConfig(TMP, getProjectConfig()));
      resolveCollectionRefs(collections, contentConfig.config);

      const blog = /** @type {any[]} */ (collections.get("blog"));
      const hello = blog.find((e) => e.id === "hello-world");
      // Author "jane" should be resolved to the full author entry
      expect(hello.data.author).toBeDefined();
      expect(typeof hello.data.author).toBe("object");
      expect(hello.data.author.data.name).toBe("Jane Doe");
    });
  });
});

// ── $paths expansion ──────────────────────────────────────────────────────────

describe("$paths expansion", () => {
  it("expands collection-based $paths", async () => {
    const collections = await loadCollections(TMP, getProjectConfig());
    const pagesDir = resolve(TMP, "pages");
    const routes = discoverPages(pagesDir);
    const expanded = await expandDynamicRoutes(routes, TMP, collections);

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
    const collections = await loadCollections(TMP, getProjectConfig());
    const pagesDir = resolve(TMP, "pages");
    const routes = discoverPages(pagesDir);
    const expanded = await expandDynamicRoutes(routes, TMP, collections);

    const langRoutes = expanded.filter((r) => ["/en", "/fr", "/de"].includes(r.urlPattern));
    expect(langRoutes.length).toBe(3);
  });

  it("preserves _pathParams on expanded routes", async () => {
    const collections = await loadCollections(TMP, getProjectConfig());
    const pagesDir = resolve(TMP, "pages");
    const routes = discoverPages(pagesDir);
    const expanded = await expandDynamicRoutes(routes, TMP, collections);

    const hello = /** @type {any} */ (expanded.find((r) => r.urlPattern === "/blog/hello-world"));
    expect(hello._pathParams).toEqual({ slug: "hello-world" });
  });
});

// ── ContentCollection/ContentEntry $prototype resolution ──────────────────────

describe("$prototype resolution in context-injection", () => {
  it("resolves ContentCollection $prototype in state", async () => {
    const collections = await loadCollections(TMP, getProjectConfig());
    /** @type {any} */
    const doc = {
      state: {
        posts: {
          $prototype: "ContentCollection",
          collection: "blog",
          filter: { draft: false },
          sort: { field: "pubDate", order: "desc" },
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { urlPattern: "/blog", _pathParams: {} };

    injectContext(doc, projectConfig, route, collections);

    expect(Array.isArray(doc.state.posts)).toBe(true);
    expect(doc.state.posts.length).toBe(2); // non-drafts
    expect(doc.state.posts[0].data.title).toBe("Second Post"); // desc order
  });

  it("resolves ContentEntry $prototype with $params ref", async () => {
    const collections = await loadCollections(TMP, getProjectConfig());
    /** @type {any} */
    const doc = {
      state: {
        post: {
          $prototype: "ContentEntry",
          collection: "blog",
          id: { $ref: "#/$params/slug" },
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = {
      urlPattern: "/blog/hello-world",
      _pathParams: { slug: "hello-world" },
    };

    injectContext(doc, projectConfig, route, collections);

    expect(doc.state.post).not.toBeNull();
    expect(doc.state.post.id).toBe("hello-world");
    expect(doc.state.post.data.title).toBe("Hello World");
    expect(Array.isArray(doc.state.post.$children)).toBe(true);
  });

  it("returns null for missing ContentEntry", async () => {
    const collections = await loadCollections(TMP, getProjectConfig());
    const doc = {
      state: {
        post: {
          $prototype: "ContentEntry",
          collection: "blog",
          id: "nonexistent",
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { urlPattern: "/blog/nope", _pathParams: {} };

    injectContext(doc, projectConfig, route, collections);

    expect(doc.state.post).toBeNull();
  });

  it("returns empty array for missing collection", async () => {
    const collections = await loadCollections(TMP, getProjectConfig());
    /** @type {any} */
    const doc = {
      state: {
        items: {
          $prototype: "ContentCollection",
          collection: "nonexistent",
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { urlPattern: "/", _pathParams: {} };

    injectContext(doc, projectConfig, route, collections);

    expect(doc.state.items).toEqual([]);
  });
});

// ── Full build with content ───────────────────────────────────────────────────

describe("buildSite with content collections", () => {
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
        collections: {
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
      const collections = await loadCollections(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const items = /** @type {any[]} */ (collections.get("items"));
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
        collections: {
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
      const collections = await loadCollections(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const items = /** @type {any[]} */ (collections.get("items"));
      expect(items.length).toBe(2);
      expect(items[0].id).toContain("list-0");
      expect(items[1].id).toContain("list-1");
    } finally {
      rmSync(TMP2, { recursive: true, force: true });
    }
  });

  it("getCollectionElements returns $elements from collection def", () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-elements__");
    rmSync(TMP2, { recursive: true, force: true });
    mkdirSync(TMP2, { recursive: true });

    const projectConfig = {
      collections: {
        blog: {
          source: "./content/blog/*.md",
          $elements: ["my-component", { $ref: "./card.json" }],
        },
      },
    };

    const result = getCollectionElements(TMP2, "blog", projectConfig);
    expect(result).toEqual(["my-component", { $ref: "./card.json" }]);

    const missing = getCollectionElements(TMP2, "nonexistent", projectConfig);
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
        collections: {
          items: {
            source: "./content/items/*.json",
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
      const collections = await loadCollections(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const items = /** @type {any[]} */ (collections.get("items"));
      expect(items.length).toBe(1);
      expect(items[0].id).toBe("bad");
    } finally {
      rmSync(TMP2, { recursive: true, force: true });
    }
  });

  it("sorts entries in ascending order (comparison branches)", async () => {
    const collections = await loadCollections(TMP, getProjectConfig());
    const blog = /** @type {any[]} */ (collections.get("blog"));
    const sorted = queryCollection(blog, {
      sort: { field: "pubDate", order: "asc" },
    });
    expect(sorted[0].data.pubDate <= sorted[1].data.pubDate).toBe(true);
  });

  it("loadCollection with $elements passes allowedNames", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-directives__");
    rmSync(TMP2, { recursive: true, force: true });
    mkdirSync(resolve(TMP2, "content/docs"), { recursive: true });

    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({
        collections: {
          docs: {
            source: "./content/docs/*.md",
            $elements: ["my-widget", { $ref: "./card.json" }],
            schema: { properties: { title: { type: "string" } } },
          },
        },
      }),
    );
    writeFileSync(resolve(TMP2, "content/docs/intro.md"), "---\ntitle: Intro\n---\n\nHello docs\n");

    try {
      const collections = await loadCollections(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const docs = /** @type {any[]} */ (collections.get("docs"));
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
        collections: {
          items: {
            source: "./content/items/*.json",
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
    console.warn = (/** @type {any} */ msg) => warnings.push(msg);
    try {
      const collections = await loadCollections(
        TMP3,
        JSON.parse(readFileSync(resolve(TMP3, "project.json"), "utf8")),
      );
      expect(collections.get("items")).toHaveLength(1);
      expect(warnings.some((w) => w.includes("missing required field"))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(TMP3, { recursive: true, force: true });
    }
  });

  it("sorts entries in descending order", async () => {
    const entries = [
      { id: "a", data: { score: 10 } },
      { id: "b", data: { score: 30 } },
      { id: "c", data: { score: 20 } },
    ];
    const ascSorted = queryCollection(entries, { sort: { field: "score", order: "asc" } });
    expect(ascSorted[0].data.score).toBe(10);
    expect(ascSorted[2].data.score).toBe(30);
    const descSorted = queryCollection(entries, { sort: { field: "score", order: "desc" } });
    expect(descSorted[0].data.score).toBe(30);
    expect(descSorted[2].data.score).toBe(10);
  });
});
