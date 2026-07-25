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
import { describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { StudioSchema } from "../src/handlers";

void mock.module("electrobun/bun", () => ({
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
  Utils: { openFileDialog: async () => [] },
}));

const { setProjectRoot, fetchPluginSchema, fetchProjectSchemas, jxResolve, listExtensions } =
  await import("../src/handlers");

const PROJECT = join(import.meta.dir, "_fixtures_content");

describe("ContentCollection desktop integration", () => {
  test("fetchPluginSchema resolves a bare-specifier .class.json (drives the config form)", async () => {
    setProjectRoot(PROJECT);
    const schema = (await fetchPluginSchema({
      prototype: "ContentCollection",
      src: "@jxsuite/parser/ContentCollection.class.json",
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
        $prototype: "ContentCollection",
        $src: "@jxsuite/parser/ContentCollection.class.json",
        contentType: "docs",
        sort: { field: "order", order: "asc" },
      }),
    });

    expect(status).toBe(200);
    const entries = JSON.parse(body) as {
      id: string;
      data: Record<string, unknown>;
    }[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.map((e) => e.data.title)).toEqual(["Getting Started", "Advanced"]);
    setProjectRoot(null);
  });

  test("jxResolve honours filter rules", async () => {
    setProjectRoot(PROJECT);
    const { status, body } = await jxResolve({
      body: JSON.stringify({
        $prototype: "ContentCollection",
        $src: "@jxsuite/parser/ContentCollection.class.json",
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

  test("listExtensions serves the parser contribution with its fragment entry schema", async () => {
    setProjectRoot(PROJECT);
    const extensions = (await listExtensions()) as {
      specifier: string;
      contributions: {
        className: string;
        project: { key: string };
        studio: { settings?: { layout?: string } } | null;
        entrySchema: { additionalProperties?: { properties?: Record<string, unknown> } } | null;
      }[];
    }[];
    expect(extensions).toHaveLength(1);
    expect(extensions[0]!.specifier).toBe("@jxsuite/parser");
    const content = extensions[0]!.contributions.find((c) => c.project.key === "content")!;
    expect(content.className).toBe("Content");
    expect(content.studio?.settings?.layout).toBe("map");
    expect(Object.keys(content.entrySchema?.additionalProperties?.properties ?? {})).toContain(
      "source",
    );
    setProjectRoot(null);
  });

  test("fetchProjectSchemas returns self-contained bundles (drives Monaco registration)", async () => {
    setProjectRoot(PROJECT);
    try {
      const { project, document } = await fetchProjectSchemas();
      // Root pointers only: Monaco gets these as inline objects and never fetches a URI.
      const { allOf } = project as { allOf: { $ref: string }[] };
      expect(allOf.map((entry) => entry.$ref)).toEqual([
        "#/$defs/project-core-v2",
        "#/$defs/ext-parser-project-v1",
      ]);
      const projectDefs = (project as { $defs: Record<string, unknown> }).$defs;
      expect(projectDefs["ext-parser-project-v1"]).toBeDefined();
      const doc = document as { $ref?: string; allOf: { $ref: string }[] };
      expect(doc.$ref).toBeUndefined();
      expect(doc.allOf.map((entry) => entry.$ref)).toEqual(["#/$defs/v1"]);
    } finally {
      // The bundler regenerates the entry documents on demand — keep the fixture pristine.
      rmSync(join(PROJECT, "project.schema.json"), { force: true });
      rmSync(join(PROJECT, "document.schema.json"), { force: true });
      setProjectRoot(null);
    }
  });
});
