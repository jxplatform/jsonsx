/**
 * The composition-correctness suite for the per-project schema model (specs/extensions.md §5): real
 * ajv-2020 compiles the emitted entry document against the generated core fragment and a
 * parser-like extension fragment, proving the two load-bearing mechanics —
 *
 * 1. `allOf` + `unevaluatedProperties: false` closes the composition (extension keys valid, unknown
 *    keys rejected), and
 * 2. The entry document's re-embedded field-union resource shadows the shipped default by
 *    compound-document `$id` resolution, so extension field extras validate in composed validation
 *    but NOT against the shipped default (the override proof).
 */
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import {
  GENERATED_SCHEMA_COMMENT,
  PROJECT_CORE_SCHEMA_ID,
  PROJECT_FIELDS_SCHEMA_ID,
  emitDocumentSchema,
  emitProjectSchema,
} from "../src/project-schemas";
import {
  generateDocumentPathsSchema,
  generateExtensionManifestSchema,
  generateProjectCoreSchema,
  generateProjectFieldsSchema,
} from "../src/schema";

const FRAG_ID = "https://test.invalid/parser/project.fragment.schema.json";
const EXTRAS_ID = "https://test.invalid/connector/extras.json";

/** A parser-like project fragment: contributes `content`; fields ref the well-known union. */
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
              required: { items: { type: "string" }, type: "array" },
            },
            type: "object",
          },
          source: { type: "string" },
        },
        required: ["source"],
        type: "object",
      },
      description: "File-based content collections.",
      type: "object",
    },
  },
  type: "object",
};

function makeAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(generateProjectCoreSchema());
  ajv.addSchema(contentFragment);
  return ajv;
}

const entrySchema = {
  ...emitProjectSchema({ corePath: PROJECT_CORE_SCHEMA_ID, fragments: [FRAG_ID] }),
  $id: "https://test.invalid/proj/project.schema.json",
};

function validProject(): Record<string, unknown> {
  return {
    $schema: "./project.schema.json",
    content: {
      posts: {
        format: "Markdown",
        schema: {
          properties: {
            date: { format: "date", type: "string" },
            title: { type: "string" },
          },
          required: ["title"],
        },
        source: "./content/posts/",
      },
    },
    extensions: ["@jxsuite/parser"],
    name: "Test Site",
  };
}

function postsSchema(doc: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const content = doc.content as Record<string, Record<string, unknown>>;
  return content.posts!.schema as Record<string, Record<string, unknown>>;
}

describe("emitProjectSchema + ajv-2020 composition", () => {
  const validate = makeAjv().compile(entrySchema);

  test("a project using core + extension sections validates", () => {
    expect(validate(validProject())).toBe(true);
  });

  test("unknown top-level keys are rejected by unevaluatedProperties", () => {
    const doc = { ...validProject(), contentTypez: {} };
    expect(validate(doc)).toBe(false);
    expect(JSON.stringify(validate.errors)).toContain("unevaluatedProperties");
  });

  test("relationship refs are valid field schemas through the union", () => {
    const doc = validProject();
    postsSchema(doc).properties!.author = { $ref: "#/content/authors" };
    expect(validate(doc)).toBe(true);
  });

  test("to-many relationship refs (array items) are valid through recursion", () => {
    const doc = validProject();
    postsSchema(doc).properties!.tags = { items: { $ref: "#/content/tags" }, type: "array" };
    expect(validate(doc)).toBe(true);
  });

  test("nested object fields recurse through the union at depth", () => {
    const doc = validProject();
    postsSchema(doc).properties!.meta = {
      properties: { editor: { $ref: "#/content/authors" } },
      type: "object",
    };
    expect(validate(doc)).toBe(true);
  });

  test("garbage field schemas fail every union branch", () => {
    const doc = validProject();
    postsSchema(doc).properties!.broken = { neither: "type nor $ref" };
    expect(validate(doc)).toBe(false);
  });

  test("entry embed shadows the shipped default: extras valid composed, invalid standalone", () => {
    const columnExtra = {
      $defs: { Column: { properties: { column: { type: "string" } }, required: ["column"] } },
      $id: EXTRAS_ID,
      $schema: "https://json-schema.org/draft/2020-12/schema",
    };
    const withExtras = {
      ...emitProjectSchema({
        corePath: PROJECT_CORE_SCHEMA_ID,
        fieldSchemaRefs: [`${EXTRAS_ID}#/$defs/Column`],
        fragments: [FRAG_ID],
      }),
      $id: "https://test.invalid/proj2/project.schema.json",
    };
    const composed = makeAjv();
    composed.addSchema(columnExtra);
    const validateExtras = composed.compile(withExtras);

    const doc = validProject();
    postsSchema(doc).properties!.sku = { column: "sku" };
    expect(validateExtras(doc)).toBe(true);

    // Standalone (fragment + shipped default union): the extras shape is NOT in the union.
    const standalone = makeAjv();
    standalone.addSchema(generateProjectFieldsSchema());
    const validateStandalone = standalone.compile({ $ref: FRAG_ID });
    expect(validateStandalone({ content: doc.content })).toBe(false);
  });

  test("standalone fragment validation accepts core shapes and relationship refs", () => {
    const standalone = makeAjv();
    standalone.addSchema(generateProjectFieldsSchema());
    const validateStandalone = standalone.compile({ $ref: FRAG_ID });
    expect(
      validateStandalone({
        content: {
          posts: {
            schema: { properties: { author: { $ref: "#/content/authors" } } },
            source: "./c/",
          },
        },
      }),
    ).toBe(true);
    expect(
      validateStandalone({
        content: { posts: { schema: { properties: { bad: { junk: 1 } } }, source: "./c/" } },
      }),
    ).toBe(false);
  });

  test("emitted document carries the generated-comment marker", () => {
    const emitted = emitProjectSchema({ corePath: "./core.json", fragments: [] });
    expect(emitted.$comment).toBe(GENERATED_SCHEMA_COMMENT);
  });
});

describe("emitDocumentSchema", () => {
  test("re-embeds the paths resource with contributed shapes", () => {
    const doc = emitDocumentSchema({
      corePath: "./node_modules/@jxsuite/schema/schema.json",
      pathsValueRefs: [`${FRAG_ID}#/$defs/ContentPathsSource`],
    });
    expect(doc.allOf).toEqual([{ $ref: "./node_modules/@jxsuite/schema/schema.json" }]);
    const defs = doc.$defs as Record<string, Record<string, unknown>>;
    expect(defs.PathsValue!.$id).toBe("https://jxsuite.com/schema/document/paths/v2");
    expect(defs.PathsValue!.anyOf).toEqual([{ $ref: `${FRAG_ID}#/$defs/ContentPathsSource` }]);
  });

  test("references the core via allOf, never a root $ref beside $defs", () => {
    /* A root-level $ref makes VS Code shallow-merge the core resource's $defs over the entry's
       own, breaking every `#/$defs/<embed>/...` pointer downstream. */
    const doc = emitDocumentSchema({ corePath: "./core.json", pathsValueRefs: [] });
    expect(doc.$ref).toBeUndefined();
    expect(doc.allOf).toEqual([{ $ref: "./core.json" }]);
  });

  test("stays permissive with no contributed paths shapes", () => {
    const doc = emitDocumentSchema({ corePath: "./core.json", pathsValueRefs: [] });
    const defs = doc.$defs as Record<string, Record<string, unknown>>;
    expect(defs.PathsValue).toEqual({ $id: "https://jxsuite.com/schema/document/paths/v2" });
  });
});

describe("generated core fragment, union defaults, and manifest schema", () => {
  test("core fragment is open, drops contentTypes, and adds extensions/$schema", () => {
    const core = generateProjectCoreSchema();
    expect(core.$id).toBe(PROJECT_CORE_SCHEMA_ID);
    expect("additionalProperties" in core).toBe(false);
    expect("contentTypes" in core.properties).toBe(false);
    expect(core.properties.extensions.items).toEqual({ type: "string" });
    expect(core.properties.$schema.type).toBe("string");
    expect(core.$defs.RelationshipRef.required).toEqual(["$ref"]);
    // Recursion goes through the well-known union resource, not a local ref.
    expect(core.$defs.JxFieldSchema.properties.items).toEqual({
      $ref: PROJECT_FIELDS_SCHEMA_ID,
    });
  });

  test("default union resources carry the canonical $ids", () => {
    expect(generateProjectFieldsSchema().$id).toBe(PROJECT_FIELDS_SCHEMA_ID);
    expect(generateDocumentPathsSchema().$id).toBe("https://jxsuite.com/schema/document/paths/v2");
  });

  test("manifest schema validates a real manifest and rejects unknown keys", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(generateExtensionManifestSchema());
    expect(
      validate({
        classes: { Markdown: "./src/Markdown.class.json" },
        name: "@jxsuite/parser",
        schemas: { project: "./schemas/project.fragment.schema.json" },
      }),
    ).toBe(true);
    expect(validate({ classes: {} })).toBe(false); // Missing name
    expect(validate({ extra: true, name: "@x/y" })).toBe(false);
  });
});
