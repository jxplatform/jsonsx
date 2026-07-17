/**
 * Unit tests for client.ts — the headless browser client: memoized preload with retry on failure,
 * synchronous grouped queries over a real MiniSearch index, and the $src state-convention helpers.
 * Fetch is mocked; MiniSearch is real.
 *
 * The client memoizes module-level state, so the load-failure cases run FIRST (they clear the memo)
 * and the success path builds the index the query tests share.
 */

import { describe, expect, test } from "bun:test";
import { configure, isReady, preload, query, runSearch, searchInit } from "../src/client";
import type { SearchResultGroup } from "../src/client";
import type { SearchIndexEnvelope } from "../src/search-index";

const ENVELOPE: SearchIndexEnvelope = {
  boost: { heading: 2, title: 4 },
  documents: [
    {
      collection: "docs",
      description: "How sites are built",
      heading: "",
      id: "docs:framework/site",
      slug: "framework/site",
      text: "Sites are folders of pages. The build pipeline emits assets and a search index.",
      title: "Site architecture",
      url: "/docs/framework/site/",
    },
    {
      collection: "docs",
      description: "How sites are built",
      heading: "Search index",
      id: "docs:framework/site#search-index",
      slug: "framework/site",
      text: "The emit capability writes the search index into dist.",
      title: "Site architecture",
      url: "/docs/framework/site/#search-index",
    },
    {
      collection: "docs",
      description: "",
      heading: "",
      id: "docs:start/install",
      slug: "start/install",
      text: "Install the toolchain with bun install.",
      title: "Install",
      url: "/docs/start/install/",
    },
  ],
  engine: "minisearch",
  fields: ["title", "heading", "text"],
  version: 1,
};

function mockFetch(handler: () => Promise<Response> | Response) {
  (globalThis as { fetch: unknown }).fetch = handler;
}

/** Let queued microtasks/timers settle (async completions inside the client). */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("preload failure handling (runs before the success path)", () => {
  test("query before ready returns [] and kicks off a (failing) preload", async () => {
    mockFetch(() => Promise.reject(new Error("offline")));
    expect(isReady()).toBe(false);
    expect(query("anything")).toEqual([]);
    // Allow the kicked-off preload to settle and clear its memo.
    await settle();
    expect(isReady()).toBe(false);
  });

  test("a non-OK response rejects and clears the memo for retry", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    configure({ indexUrl: "/search-index.json" });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(preload()).rejects.toThrow(/search index fetch failed: 500/);
    expect(isReady()).toBe(false);
  });

  test("searchInit swallows a failed load with a warning instead of rejecting", async () => {
    mockFetch(() => Promise.reject(new Error("still offline")));
    const state: Record<string, unknown> = {};
    expect(searchInit(state)).toBe(true);
    await settle();
    expect(state.searchReady).toBeUndefined();
    expect(isReady()).toBe(false);
  });
});

describe("preload success + queries", () => {
  test("preload fetches the envelope once and builds the index", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return Response.json(ENVELOPE);
    });
    await preload("/search-index.json");
    await preload(); // Memoized — no second fetch.
    expect(calls).toBe(1);
    expect(isReady()).toBe(true);
  });

  test("grouped query nests section hits under their page, best score first", () => {
    const groups = query("search index") as SearchResultGroup[];
    expect(groups.length).toBeGreaterThan(0);
    const top = groups[0]!;
    expect(top.slug).toBe("framework/site");
    expect(top.url).toBe("/docs/framework/site/");
    expect(top.title).toBe("Site architecture");
    expect(top.hits.map((h) => h.heading)).toEqual(["Search index"]);
    expect(top.hits[0]!.url).toBe("/docs/framework/site/#search-index");
  });

  test("title boost ranks title matches above body mentions", () => {
    const groups = query("install") as SearchResultGroup[];
    expect(groups[0]!.slug).toBe("start/install");
  });

  test("limit caps result groups; group:false returns flat documents", () => {
    const limited = query("site install search", { limit: 1 });
    expect(limited).toHaveLength(1);
    const flat = query("search index", { group: false }) as { id: string }[];
    expect(flat.length).toBeGreaterThan(1);
    expect(flat[0]!.id).toBeDefined();
  });

  test("blank queries return no results", () => {
    expect(query("")).toEqual([]);
    expect(query("   ")).toEqual([]);
  });
});

describe("$src state conventions", () => {
  test("searchInit flips searchReady and re-runs a pending query", async () => {
    const state: Record<string, unknown> = { searchQuery: "install" };
    expect(searchInit(state)).toBe(true);
    await settle();
    expect(state.searchReady).toBe(true);
    expect((state.searchResults as SearchResultGroup[])[0]!.slug).toBe("start/install");
  });

  test("runSearch reads the input event, stores grouped results, and resets the active row", () => {
    const state: Record<string, unknown> = { searchActive: 3 };
    const results = runSearch(state, { target: { value: "search index" } });
    expect(state.searchQuery).toBe("search index");
    expect(state.searchResults).toBe(results);
    expect(state.searchActive).toBe(0);
    expect((results as SearchResultGroup[])[0]!.slug).toBe("framework/site");
  });

  test("runSearch without an event falls back to state.searchQuery", () => {
    const state: Record<string, unknown> = { searchQuery: "install" };
    const results = runSearch(state) as SearchResultGroup[];
    expect(results[0]!.slug).toBe("start/install");
  });
});
