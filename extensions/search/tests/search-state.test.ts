/**
 * Unit tests for search-state.ts — the Search state class: lower() shapes (queries, index
 * resolution, $bundle registration) and resolve() in browser and node environments.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { sidecarAssetPath } from "@jxsuite/schema/asset-paths";
import { CLIENT_SPECIFIER, Search } from "../src/search-state";

const CLIENT_URL = sidecarAssetPath(CLIENT_SPECIFIER);

describe("Search.lower", () => {
  test("compiles a $ref query into a reactive state expression", () => {
    const lowered = Search.lower({ query: { $ref: "#/state/q" } });
    expect(lowered.$prototype).toBe("Function");
    expect(lowered.timing).toBe("client");
    expect(lowered.$bundle).toEqual([CLIENT_SPECIFIER]);
    const body = lowered.body as string;
    expect(body).toContain("return");
    expect(body).toContain("m.query(state.q, ");
    expect(body).toContain(`import(${JSON.stringify(CLIENT_URL)})`);
    expect(body).toContain('m.preload("/search-index.json")');
  });

  test("nested $ref paths and literal queries compile correctly", () => {
    expect(Search.lower({ query: { $ref: "#/state/ui/q" } }).body as string).toContain(
      "m.query(state.ui.q, ",
    );
    expect(Search.lower({ query: "fixed terms" }).body as string).toContain(
      'm.query("fixed terms", ',
    );
    // Refs outside state degrade to an empty literal query.
    expect(Search.lower({ query: { $ref: "#/$params/slug" } }).body as string).toContain(
      'm.query("", ',
    );
  });

  test("index resolution: def override, then projectConfig.search.output, then default", () => {
    const fromProject = Search.lower(
      { query: "x" },
      { projectConfig: { search: { output: "/idx.json" } } },
    );
    expect(fromProject.body as string).toContain('m.preload("/idx.json")');

    const fromDef = Search.lower(
      { index: "/other.json", query: "x" },
      { projectConfig: { search: { output: "/idx.json" } } },
    );
    expect(fromDef.body as string).toContain('m.preload("/other.json")');
  });

  test("limit/group options and default value pass through", () => {
    const lowered = Search.lower({ default: null, group: false, limit: 3, query: "x" });
    expect(lowered.body as string).toContain('{"group":false,"limit":3}');
    expect(lowered.default).toBeNull();
    expect(Search.lower({ query: "x" }).default).toBeUndefined();
  });
});

describe("Search resolve", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).document;
  });

  test("degrades to [] with a warning outside the browser", async () => {
    const search = new Search({ query: "anything" });
    expect(await search.resolve()).toEqual([]);
  });

  test("in browsers, loads the bundled client, preloads, and queries", async () => {
    (globalThis as Record<string, unknown>).document = {};
    const preload = mock(async () => {});
    const query = mock(() => [{ slug: "hit" }]);
    await mock.module(CLIENT_URL, () => ({ preload, query }));

    const search = new Search({ index: "/custom.json", limit: 5, query: "docs" });
    const results = await search.resolve();
    expect(results).toEqual([{ slug: "hit" }]);
    expect(preload).toHaveBeenCalledWith("/custom.json");
    expect(query).toHaveBeenCalledWith("docs", { group: true, limit: 5 });
  });

  test("indexUrl precedence: def, then _project.search.output, then default", () => {
    expect(new Search({ index: "/a.json" }).indexUrl()).toBe("/a.json");
    const withProject = new Search({});
    withProject.config._project = { search: { output: "/b.json" } };
    expect(withProject.indexUrl()).toBe("/b.json");
    expect(new Search({}).indexUrl()).toBe("/search-index.json");
  });
});
