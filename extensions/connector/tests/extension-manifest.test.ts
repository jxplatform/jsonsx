/**
 * Extension-package surface tests (specs/extensions.md §4–§5, mirroring
 * extensions/parser/tests/extension-manifest.test.ts): the manifest validates against the generated
 * extension-manifest schema, every class descriptor exists and carries the expected admission
 * blocks, and the project fragment is a standalone-valid 2020-12 document.
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

/** An ajv instance with the shipped core + field-union defaults registered. */
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
    expect(pkg.exports["./worker"]).toBe("./src/worker.ts");
    expect(pkg.exports["./types"]).toBe("./src/types.ts");
    expect(pkg.exports["./schemas/project.fragment.schema.json"]).toBeDefined();
    expect(pkg.files).toContain("jx-extension.json");
    expect(pkg.files).toContain("schemas/");
    // Every class descriptor is addressable through the exports map.
    for (const ref of Object.values(manifest.classes)) {
      const exportKey = ref.replace("./src/", "./");
      expect(pkg.exports[exportKey]).toBe(ref);
    }
  });

  test("every classes entry points at an existing descriptor", () => {
    expect(Object.keys(manifest.classes).toSorted()).toEqual([
      "Connections",
      "D1",
      "Data",
      "Sqlite",
      "Supabase",
      "TableDelete",
      "TableEntry",
      "TableInsert",
      "TableQuery",
      "TableUpdate",
    ]);
    for (const ref of Object.values(manifest.classes)) {
      const classPath = resolve(dirname(MANIFEST_PATH), ref);
      expect(existsSync(classPath)).toBe(true);
    }
  });

  test("admission blocks: connector providers, section owners, and the data mount", () => {
    const classDef = (name: string) =>
      loadJson(resolve(dirname(MANIFEST_PATH), manifest.classes[name]!));

    for (const provider of ["D1", "Supabase", "Sqlite"]) {
      const def = classDef(provider) as { connector: Record<string, unknown> };
      expect(def.connector.serve).toBe("@jxsuite/connector/worker");
      expect(typeof def.connector.provider).toBe("string");
      expect(["sqlite", "postgres"]).toContain(String(def.connector.kind));
    }
    expect((classDef("D1") as { connector: { local?: string } }).connector.local).toBe("sqlite");

    const data = classDef("Data") as {
      project: { key: string; referenceable: boolean };
      server: { basePath: string; order: number; module: string };
    };
    expect(data.project.key).toBe("data");
    expect(data.project.referenceable).toBe(true);
    expect(data.server).toEqual({
      basePath: "/_jx/data",
      module: "@jxsuite/connector/worker",
      order: 20,
    });

    const connections = classDef("Connections") as { project: { key: string } };
    expect(connections.project.key).toBe("connections");

    for (const stateClass of [
      "TableQuery",
      "TableEntry",
      "TableInsert",
      "TableUpdate",
      "TableDelete",
    ]) {
      const def = classDef(stateClass) as {
        $studio: { stateDefaults: Record<string, unknown> };
        $defs: { methods: Record<string, { role?: string; timing?: string[] }> };
      };
      expect(def.$studio.stateDefaults).toEqual({ timing: "client" });
      expect(def.$defs.methods.lower!.role).toBe("lower");
      expect(def.$defs.methods.lower!.timing).toEqual(["compiler"]);
    }
  });
});

describe("project fragment", () => {
  const fragment = loadJson(resolve(import.meta.dir, "../schemas/project.fragment.schema.json"));

  test("is a standalone-valid 2020-12 document contributing connections + data", () => {
    expect(fragment.$id).toBe("https://jxsuite.com/schema/ext/connector/project/v1");
    expect(fragment.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const properties = fragment.properties as Record<string, unknown>;
    expect(Object.keys(properties).toSorted()).toEqual(["connections", "data"]);
    expect(() => makeAjv().compile(fragment)).not.toThrow();
  });

  test("accepts connections + tables with field schemas, refs, and permissions", () => {
    const validate = makeAjv().compile(fragment);
    const section = {
      connections: {
        main: { binding: "DB", databaseId: "uuid-1", provider: "d1" },
        pg: { hyperdriveId: "hd", provider: "supabase", urlEnv: "SUPABASE_DB_URL" },
      },
      data: {
        comments: {
          connection: "main",
          id: "uuid",
          indexes: ["created_at", ["author", "created_at"]],
          ownerField: "user_id",
          permissions: { delete: "owner", insert: "authenticated", read: "public" },
          schema: {
            properties: {
              author: { $ref: "#/data/users" },
              message: { type: "string" },
              tags: { items: { $ref: "#/content/tags" }, type: "array" },
            },
            required: ["message"],
            type: "object",
          },
          timestamps: true,
        },
      },
    };
    expect(validate(section)).toBe(true);
  });

  test("rejects malformed connections, tables, and permission rules", () => {
    const validate = makeAjv().compile(fragment);
    expect(validate({ connections: { main: {} } })).toBe(false); // Provider is required.
    expect(validate({ data: { t: { connection: "main" } } })).toBe(false); // Schema is required.
    expect(
      validate({
        data: {
          t: { connection: "main", permissions: { read: "everyone" }, schema: { type: "object" } },
        },
      }),
    ).toBe(false);
    expect(
      validate({
        data: {
          t: { connection: "main", id: "guid", schema: { type: "object" } },
        },
      }),
    ).toBe(false);
    expect(
      validate({
        data: {
          t: {
            connection: "main",
            schema: { properties: { bad: { junk: true } }, type: "object" },
          },
        },
      }),
    ).toBe(false);
  });
});
