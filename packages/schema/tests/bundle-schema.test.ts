/**
 * BundleSchema round-trip suite (specs/extensions.md §5.4): the bundled compound document must
 * validate exactly the same instances as the unbundled entry document resolved through a file
 * loader. Structure is also pinned: relative-path refs are rewritten to canonical `$id`s, targets
 * embed once under `$defs` (keyed by `$id`, resource boundaries preserved), nested relative refs
 * inline recursively, and `$id`-less files get generated `urn:jx:bundled:*` identities.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROJECT_CORE_SCHEMA_ID,
  PROJECT_FIELDS_SCHEMA_ID,
  bundleSchema,
  emitProjectSchema,
} from "../src/project-schemas";
import { generateProjectCoreSchema } from "../src/schema";

const TMP = resolve(import.meta.dir, "__test-bundle-schema__");
const FRAG_ID = "https://test.invalid/parser/project.fragment.schema.json";

/** File loader for the bundler — plain reads, no restrictions (tests exercise paths directly). */
const loadJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

function writeJson(relPath: string, content: object) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify(content, null, 2), "utf8");
}

/** A parser-like project fragment contributing `content`, with fields on the well-known union. */
const contentFragment = {
  $id: FRAG_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  properties: {
    content: {
      additionalProperties: {
        properties: {
          format: { type: "string" },
          schema: {
            properties: {
              properties: {
                additionalProperties: { $ref: PROJECT_FIELDS_SCHEMA_ID },
                type: "object",
              },
            },
            type: "object",
          },
          source: { type: "string" },
        },
        required: ["source"],
        type: "object",
      },
      type: "object",
    },
  },
  type: "object",
};

const entrySchema = emitProjectSchema({
  corePath: "./core.schema.json",
  fragments: ["./frags/project.fragment.schema.json"],
});

function validProject(): Record<string, unknown> {
  return {
    $schema: "./project.schema.json",
    content: {
      posts: {
        format: "Markdown",
        schema: {
          properties: {
            author: { $ref: "#/content/authors" },
            title: { type: "string" },
          },
        },
        source: "./content/posts/",
      },
    },
    extensions: ["@jxsuite/parser"],
    name: "Bundle Fixture",
  };
}

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  writeJson("core.schema.json", generateProjectCoreSchema());
  writeJson("frags/project.fragment.schema.json", contentFragment);
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

/** Compile the UNBUNDLED entry with a file loader (the validate-project resolution model). */
async function compileUnbundled() {
  const entryPath = resolve(TMP, "project.schema.json");
  writeFileSync(entryPath, JSON.stringify(entrySchema, null, 2), "utf8");
  const withId = { ...structuredClone(entrySchema), $id: pathToFileURL(entryPath).href };
  const ajv = new Ajv2020({
    allErrors: true,
    loadSchema: async (uri) => loadJson(new URL(uri).pathname),
    strict: false,
  });
  return ajv.compileAsync(withId);
}

describe("bundleSchema round-trip", () => {
  test("the bundled document validates the same instances as the file-resolved entry", async () => {
    const validateFiles = await compileUnbundled();
    const bundled = await bundleSchema(entrySchema, loadJson, TMP);
    // Self-contained: compiles with NO external resolution at all.
    const validateBundled = new Ajv2020({ allErrors: true, strict: false }).compile(bundled);

    const cases: Record<string, unknown>[] = [
      validProject(),
      { ...validProject(), unknownTopLevelKey: {} },
      (() => {
        const doc = validProject();
        const content = doc.content as Record<string, Record<string, unknown>>;
        (content.posts!.schema as { properties: Record<string, unknown> }).properties.broken = {
          neither: "type nor $ref",
        };
        return doc;
      })(),
      (() => {
        const doc = validProject();
        const content = doc.content as Record<string, Record<string, unknown>>;
        (content.posts!.schema as { properties: Record<string, unknown> }).properties.tags = {
          items: { $ref: "#/content/tags" },
          type: "array",
        };
        return doc;
      })(),
      { content: "not an object", name: 5 },
    ];
    for (const doc of cases) {
      expect(validateBundled(doc)).toBe(validateFiles(doc));
    }
    // And the verdicts themselves are the expected ones (valid, then three failures, then valid).
    expect(validateBundled(cases[0]!)).toBe(true);
    expect(validateBundled(cases[1]!)).toBe(false);
    expect(validateBundled(cases[2]!)).toBe(false);
  });

  test("relative refs are rewritten to canonical $ids and targets embed once under $defs", async () => {
    const bundled = await bundleSchema(entrySchema, loadJson, TMP);
    const allOf = bundled.allOf as { $ref: string }[];
    expect(allOf.map((e) => e.$ref)).toEqual([PROJECT_CORE_SCHEMA_ID, FRAG_ID]);
    const defs = bundled.$defs as Record<string, Record<string, unknown>>;
    expect(defs[PROJECT_CORE_SCHEMA_ID]!.$id).toBe(PROJECT_CORE_SCHEMA_ID);
    expect(defs[FRAG_ID]!.$id).toBe(FRAG_ID);
    // The entry's own Fields embed survives with its canonical $id.
    expect(defs.Fields!.$id).toBe(PROJECT_FIELDS_SCHEMA_ID);
    // Canonical refs inside embedded resources stay untouched.
    const frag = defs[FRAG_ID] as typeof contentFragment;
    expect(
      frag.properties.content.additionalProperties.properties.schema.properties.properties
        .additionalProperties.$ref,
    ).toBe(PROJECT_FIELDS_SCHEMA_ID);
  });

  test("does not mutate the input entry document", async () => {
    const input = structuredClone(entrySchema);
    await bundleSchema(input, loadJson, TMP);
    expect(input).toEqual(entrySchema);
  });
});

describe("bundleSchema mechanics", () => {
  test("nested relative refs inline recursively against the referrer's directory", async () => {
    writeJson("nested/leaf.schema.json", {
      $id: "https://test.invalid/leaf",
      type: "string",
    });
    writeJson("nested/mid.schema.json", {
      $id: "https://test.invalid/mid",
      properties: { leafy: { $ref: "./leaf.schema.json" } },
      type: "object",
    });
    const entry = { $ref: "./nested/mid.schema.json" };
    const bundled = await bundleSchema(entry, loadJson, TMP);
    expect(bundled.$ref).toBe("https://test.invalid/mid");
    const defs = bundled.$defs as Record<string, Record<string, unknown>>;
    const mid = defs["https://test.invalid/mid"] as {
      properties: { leafy: { $ref: string } };
    };
    expect(mid.properties.leafy.$ref).toBe("https://test.invalid/leaf");
    expect(defs["https://test.invalid/leaf"]!.type).toBe("string");
    const validate = new Ajv2020({ strict: false }).compile(bundled);
    expect(validate({ leafy: "ok" })).toBe(true);
    expect(validate({ leafy: 42 })).toBe(false);
  });

  test("pointer fragments survive the rewrite and $id-less files get generated urns", async () => {
    writeJson("anon.schema.json", {
      $defs: { Named: { const: "named" } },
    });
    const entry = {
      properties: { pick: { $ref: "./anon.schema.json#/$defs/Named" } },
      type: "object",
    };
    const bundled = await bundleSchema(entry, loadJson, TMP);
    const props = bundled.properties as Record<string, { $ref: string }>;
    expect(props.pick!.$ref).toBe("urn:jx:bundled:1#/$defs/Named");
    const defs = bundled.$defs as Record<string, Record<string, unknown>>;
    expect(defs["urn:jx:bundled:1"]!.$id).toBe("urn:jx:bundled:1");
    const validate = new Ajv2020({ strict: false }).compile(bundled);
    expect(validate({ pick: "named" })).toBe(true);
    expect(validate({ pick: "other" })).toBe(false);
  });

  test("a target whose $id is already in the compound document is not embedded twice", async () => {
    writeJson("fields-default.schema.json", {
      $id: PROJECT_FIELDS_SCHEMA_ID,
      type: "object",
    });
    // The entry already embeds the fields resource ($defs.Fields) — the file ref must land there.
    const entry = {
      ...emitProjectSchema({ corePath: "./core.schema.json", fragments: [] }),
      properties: { probe: { $ref: "./fields-default.schema.json" } },
    };
    const bundled = await bundleSchema(entry, loadJson, TMP);
    const props = bundled.properties as Record<string, { $ref: string }>;
    expect(props.probe!.$ref).toBe(PROJECT_FIELDS_SCHEMA_ID);
    const defs = bundled.$defs as Record<string, unknown>;
    expect(defs[PROJECT_FIELDS_SCHEMA_ID]).toBeUndefined();
    expect(defs.Fields).toBeDefined();
  });

  test("'..' segments normalize so aliased paths share one embed", async () => {
    const entry = {
      allOf: [
        { $ref: "./frags/../frags/project.fragment.schema.json" },
        { $ref: "./frags/project.fragment.schema.json" },
      ],
    };
    const bundled = await bundleSchema(entry, loadJson, TMP);
    const allOf = bundled.allOf as { $ref: string }[];
    expect(allOf.map((e) => e.$ref)).toEqual([FRAG_ID, FRAG_ID]);
    expect(Object.keys(bundled.$defs as object)).toEqual([FRAG_ID]);
  });

  test("unloadable ref targets throw with the loader failure as cause", async () => {
    const entry = { $ref: "./does-not-exist.schema.json" };
    const failing = async () => {
      throw new Error("ENOENT boom");
    };
    expect(bundleSchema(entry, failing, TMP)).rejects.toThrow(
      /cannot load \$ref target ".*does-not-exist\.schema\.json": ENOENT boom/,
    );
    try {
      await bundleSchema(entry, failing, TMP);
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });

  test("windows-style separators and local '#/...' refs are left semantically intact", async () => {
    const entry = {
      $defs: { Local: { type: "number" } },
      properties: { n: { $ref: "#/$defs/Local" } },
      type: "object",
    };
    const bundled = await bundleSchema(entry, loadJson, `${TMP}\\`);
    const props = bundled.properties as Record<string, { $ref: string }>;
    expect(props.n!.$ref).toBe("#/$defs/Local");
    expect(bundled).toEqual(entry);
  });
});
