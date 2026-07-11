/**
 * Extension-package surface tests (specs/extensions.md §4–§5): the jx-extension.json manifest
 * validates against the generated extension-manifest schema, every referenced class descriptor
 * exists, and both shipped schema fragments are standalone-valid 2020-12 documents that compile
 * with the shipped field-union default registered.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";

const require = createRequire(import.meta.url);

const MANIFEST_PATH = resolve(import.meta.dir, "../jx-extension.json");

function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const manifest = loadJson(MANIFEST_PATH) as {
  name: string;
  title: string;
  classes: Record<string, string>;
  schemas: { project: string; document: string };
};

/** An ajv instance with the shipped core + field-union defaults registered (standalone validation). */
function makeAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(loadJson(require.resolve("@jxsuite/schema/schemas/project.core.schema.json")));
  ajv.addSchema(loadJson(require.resolve("@jxsuite/schema/schemas/project.fields.schema.json")));
  return ajv;
}

describe("jx-extension.json manifest", () => {
  test("validates against the extension-manifest schema", () => {
    const schema = loadJson(require.resolve("@jxsuite/schema/extension-manifest.schema.json"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    expect(validate(manifest)).toBe(true);
  });

  test("carries the package name and is wired through package.json", () => {
    const pkg = loadJson(resolve(import.meta.dir, "../package.json")) as {
      name: string;
      jx: string;
      exports: Record<string, string>;
      files: string[];
    };
    expect(manifest.name).toBe(pkg.name);
    expect(pkg.jx).toBe("./jx-extension.json");
    expect(pkg.exports["./jx-extension.json"]).toBe("./jx-extension.json");
    expect(pkg.exports["./Content.class.json"]).toBe("./src/Content.class.json");
    expect(pkg.exports["./content-loader"]).toBe("./src/content-loader.ts");
    expect(pkg.exports["./schemas/project.fragment.schema.json"]).toBeDefined();
    expect(pkg.exports["./schemas/document.fragment.schema.json"]).toBeDefined();
    expect(pkg.files).toContain("jx-extension.json");
    expect(pkg.files).toContain("schemas/");
  });

  test("every classes entry points at an existing descriptor", () => {
    expect(Object.keys(manifest.classes).toSorted()).toEqual([
      "Content",
      "ContentCollection",
      "ContentEntry",
      "Csv",
      "Markdown",
      "MarkdownCollection",
    ]);
    for (const ref of Object.values(manifest.classes)) {
      const classPath = resolve(dirname(MANIFEST_PATH), ref);
      expect(existsSync(classPath)).toBe(true);
    }
  });

  test("schema fragments exist at the declared paths", () => {
    const projectPath = resolve(dirname(MANIFEST_PATH), manifest.schemas.project);
    const documentPath = resolve(dirname(MANIFEST_PATH), manifest.schemas.document);
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(documentPath)).toBe(true);
  });
});

describe("project fragment", () => {
  const fragment = loadJson(resolve(import.meta.dir, "../schemas/project.fragment.schema.json"));

  test("is a standalone-valid 2020-12 document contributing `content`", () => {
    expect(fragment.$id).toBe("https://jxsuite.com/schema/ext/parser/project/v1");
    expect(fragment.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const properties = fragment.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(["content"]);
    expect(() => makeAjv().compile(fragment)).not.toThrow();
  });

  test("accepts a content section with field schemas and relationship refs", () => {
    const validate = makeAjv().compile(fragment);
    const section = {
      content: {
        posts: {
          $elements: ["post-card", { $ref: "./card.class.json" }],
          format: "Markdown",
          schema: {
            properties: {
              author: { $ref: "#/content/authors" },
              tags: { items: { $ref: "#/content/tags" }, type: "array" },
              title: { type: "string" },
            },
            required: ["title"],
            type: "object",
          },
          source: "./content/posts/",
        },
        settings: {},
      },
    };
    expect(validate(section)).toBe(true);
  });

  test("rejects malformed entries and field schemas", () => {
    const validate = makeAjv().compile(fragment);
    expect(validate({ content: { posts: 42 } })).toBe(false);
    expect(validate({ content: { posts: { source: 7 } } })).toBe(false);
    expect(
      validate({
        content: { posts: { schema: { properties: { bad: { junk: 1 } } }, source: "./c/" } },
      }),
    ).toBe(false);
    expect(validate({ content: { posts: { $elements: [{ notRef: true }] } } })).toBe(false);
  });
});

describe("document fragment", () => {
  const fragment = loadJson(resolve(import.meta.dir, "../schemas/document.fragment.schema.json"));

  test("is a standalone-valid 2020-12 document with $defs.ContentPathsSource", () => {
    expect(fragment.$id).toBe("https://jxsuite.com/schema/ext/parser/document/v1");
    const defs = fragment.$defs as Record<string, unknown>;
    expect(defs.ContentPathsSource).toBeDefined();
    expect(() => makeAjv().compile(fragment)).not.toThrow();
  });

  test("ContentPathsSource requires contentType and admits param/field", () => {
    const ajv = makeAjv();
    ajv.addSchema(fragment);
    const validate = ajv.compile({
      $ref: "https://jxsuite.com/schema/ext/parser/document/v1#/$defs/ContentPathsSource",
    });
    expect(validate({ contentType: "blog" })).toBe(true);
    expect(validate({ contentType: "blog", field: "id", param: "slug" })).toBe(true);
    expect(validate({ param: "slug" })).toBe(false);
    expect(validate({ contentType: 42 })).toBe(false);
  });
});
