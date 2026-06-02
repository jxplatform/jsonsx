/**
 * Regression coverage for the desktop's integration with the parser's ContentCollection class.
 *
 * Two paths previously broke in the electrobun build:
 *
 * 1. The class-driven config form — fetchPluginSchema() could not resolve a bare specifier like
 *    "@jxsuite/parser/ContentCollection.class.json", so the studio showed an empty form.
 * 2. The data sidebar — the runtime resolves the class by POSTing to /**jx_resolve**, which the
 *    desktop now serves via the jxResolve handler (loading content types + injecting _project).
 */
import { describe, test, expect, mock } from "bun:test";
import { join } from "node:path";
import type { StudioSchema } from "../src/handlers";

mock.module("electrobun/bun", () => ({
  Utils: { openFileDialog: async () => [] },
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
}));

const { setProjectRoot, fetchPluginSchema, jxResolve } = await import("../src/handlers");

const PROJECT = join(import.meta.dir, "_fixtures_content");

describe("ContentCollection desktop integration", () => {
  test("fetchPluginSchema resolves a bare-specifier .class.json (drives the config form)", async () => {
    setProjectRoot(PROJECT);
    const schema = (await fetchPluginSchema({
      src: "@jxsuite/parser/ContentCollection.class.json",
      prototype: "ContentCollection",
    })) as StudioSchema | null;

    expect(schema).not.toBeNull();
    // The form is built from these constructor parameters.
    expect(Object.keys(schema!.properties)).toEqual(
      expect.arrayContaining(["contentType", "filter", "sort", "limit"]),
    );
    setProjectRoot(null);
  });

  test("jxResolve runs ContentCollection.resolve() with project content types (feeds the data sidebar)", async () => {
    setProjectRoot(PROJECT);
    const { status, body } = await jxResolve({
      body: JSON.stringify({
        $src: "@jxsuite/parser/ContentCollection.class.json",
        $prototype: "ContentCollection",
        contentType: "docs",
        sort: { field: "order", order: "asc" },
      }),
    });

    expect(status).toBe(200);
    const entries = JSON.parse(body) as { id: string; data: Record<string, unknown> }[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.map((e) => e.data.title)).toEqual(["Getting Started", "Advanced"]);
    setProjectRoot(null);
  });

  test("jxResolve honours filter rules", async () => {
    setProjectRoot(PROJECT);
    const { status, body } = await jxResolve({
      body: JSON.stringify({
        $src: "@jxsuite/parser/ContentCollection.class.json",
        $prototype: "ContentCollection",
        contentType: "docs",
        filter: [{ field: "title", op: "==", value: "Advanced" }],
      }),
    });

    expect(status).toBe(200);
    const entries = JSON.parse(body) as { data: Record<string, unknown> }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].data.title).toBe("Advanced");
    setProjectRoot(null);
  });
});
