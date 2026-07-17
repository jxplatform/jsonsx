/**
 * Extension-package surface tests (specs/extensions.md §4–§5, mirroring
 * extensions/auth/tests/extension-manifest.test.ts): the manifest validates against the generated
 * extension-manifest schema, every class descriptor exists and carries the expected admission
 * blocks (search section owner with projectData + emit; Search state class with lower), and the
 * project fragment is a standalone-valid 2020-12 document contributing the `search` section.
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
  schemas: { project: string };
};

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
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe(pkg.name);
    expect(pkg.jx).toBe("./jx-extension.json");
    expect(pkg.exports["./jx-extension.json"]).toBe("./jx-extension.json");
    expect(pkg.exports["./client"]).toBe("./src/client.ts");
    expect(pkg.exports["./schemas/project.fragment.schema.json"]).toBeDefined();
    expect(pkg.files).toContain("jx-extension.json");
    expect(pkg.files).toContain("schemas/");
    expect(pkg.dependencies["@jxsuite/schema"]).toBe("workspace:^");
    expect(pkg.dependencies.minisearch).toMatch(/^\^7\./);
    // Every class descriptor is addressable through the exports map.
    for (const ref of Object.values(manifest.classes)) {
      const exportKey = ref.replace("./src/", "./");
      expect(pkg.exports[exportKey]).toBe(ref);
    }
  });

  test("every classes entry points at an existing descriptor", () => {
    expect(Object.keys(manifest.classes).toSorted()).toEqual(["Search", "SearchIndex"]);
    for (const ref of Object.values(manifest.classes)) {
      const classPath = resolve(dirname(MANIFEST_PATH), ref);
      expect(existsSync(classPath)).toBe(true);
    }
  });

  test("admission blocks: section owner declares projectData + emit; Search declares lower", () => {
    const classDef = (name: string) =>
      loadJson(resolve(dirname(MANIFEST_PATH), manifest.classes[name]!)) as {
        project?: { key: string };
        $studio?: Record<string, unknown>;
        $defs: { methods: Record<string, { role?: string; timing?: string[] }> };
      };

    const owner = classDef("SearchIndex");
    expect(owner.project?.key).toBe("search");
    expect(owner.$defs.methods.projectData?.role).toBe("projectData");
    expect(owner.$defs.methods.projectData?.timing).toEqual(["compiler", "server"]);
    expect(owner.$defs.methods.emit?.role).toBe("emit");
    expect(owner.$defs.methods.emit?.timing).toEqual(["compiler"]);

    const search = classDef("Search");
    expect(search.project).toBeUndefined();
    expect(search.$studio).toEqual({ stateDefaults: { timing: "client" } });
    expect(search.$defs.methods.lower?.role).toBe("lower");
    expect(search.$defs.methods.lower?.timing).toEqual(["compiler"]);
  });
});

describe("project fragment", () => {
  const fragment = loadJson(resolve(import.meta.dir, "../schemas/project.fragment.schema.json"));

  test("is a standalone-valid 2020-12 schema contributing the search section", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(fragment);
    expect(typeof validate).toBe("function");
    expect((fragment.properties as Record<string, unknown>).search).toBeDefined();
  });

  test("accepts a typical section and rejects malformed ones", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
    const validate = ajv.compile(fragment);

    expect(
      validate({
        search: {
          output: "/search-index.json",
          collections: { docs: { basePath: "/docs/", boost: { title: 4, heading: 2 } } },
        },
      }),
    ).toBe(true);

    // Missing collections
    expect(validate({ search: {} })).toBe(false);
    // Empty collections map
    expect(validate({ search: { collections: {} } })).toBe(false);
    // Collection without basePath
    expect(validate({ search: { collections: { docs: {} } } })).toBe(false);
    // Unknown engine
    expect(
      validate({ search: { engine: "fuse", collections: { docs: { basePath: "/d/" } } } }),
    ).toBe(false);
  });
});
