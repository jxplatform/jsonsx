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
  documentPathsCoreMembers,
  documentPathsUnknownSourceMember,
} from "../defs/field-schema.schema";
import {
  GENERATED_SCHEMA_COMMENT,
  PROJECT_CORE_SCHEMA_ID,
  PROJECT_FIELDS_SCHEMA_ID,
  emitDocumentSchema,
  composeProjectSchemas,
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
    /* The union is ADDITIVE: it shadows the shipped default by $id, so it has to carry the core
       source shapes itself or they would stop validating the moment an extension contributes one. */
    const members = defs.PathsValue!.anyOf as Record<string, unknown>[];
    expect(members.at(-1)).toEqual({ $ref: `${FRAG_ID}#/$defs/ContentPathsSource` });
    expect(members).toEqual([...documentPathsCoreMembers, members.at(-1)!]);
  });

  test("references the core via allOf, never a root $ref beside $defs", () => {
    /* A root-level $ref makes VS Code shallow-merge the core resource's $defs over the entry's
       own, breaking every `#/$defs/<embed>/...` pointer downstream. */
    const doc = emitDocumentSchema({ corePath: "./core.json", pathsValueRefs: [] });
    expect(doc.$ref).toBeUndefined();
    expect(doc.allOf).toEqual([{ $ref: "./core.json" }]);
  });

  test("carries the core source shapes with no contributed paths shapes", () => {
    const doc = emitDocumentSchema({ corePath: "./core.json", pathsValueRefs: [] });
    const defs = doc.$defs as Record<string, Record<string, unknown>>;
    expect(defs.PathsValue).toEqual({
      $id: "https://jxsuite.com/schema/document/paths/v2",
      anyOf: [...documentPathsCoreMembers],
    });
  });

  test("entry unions never carry the default's unknown-source escape hatch", () => {
    /* That member exists so the shipped default under-suggests instead of reporting false errors
       on extension shapes it cannot see. An entry document knows the enabled extensions, so
       inheriting it would silently re-open `$paths` to anything. */
    const doc = emitDocumentSchema({
      corePath: "./core.json",
      pathsValueRefs: [`${FRAG_ID}#/$defs/ContentPathsSource`],
    });
    const defs = doc.$defs as Record<string, Record<string, unknown>>;
    expect(defs.PathsValue!.anyOf).not.toContainEqual(documentPathsUnknownSourceMember);
    expect(generateDocumentPathsSchema().anyOf).toContainEqual(documentPathsUnknownSourceMember);
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

/* ComposeProjectSchemas is the host-agnostic half of `jx schema`: the filesystem host (the compiler)
   and the cloud session (a Worker with no filesystem and no node_modules) must produce the SAME two
   entry documents for the same project, because a project's schemas cannot depend on which host
   generated them. These tests drive it over an in-memory loader — the shape the cloud uses. */
describe("composeProjectSchemas (host-agnostic composition)", () => {
  const CORE_PROJECT = {
    $id: PROJECT_CORE_SCHEMA_ID,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: { name: { type: "string" } },
    type: "object",
    $defs: {
      JxFieldSchema: { type: "object" },
      RelationshipRef: { type: "object" },
    },
  };
  const CORE_DOCUMENT = {
    $id: "https://jxsuite.com/schema/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: { tagName: { type: "string" } },
    type: "object",
  };
  const EXT_PROJECT = {
    $id: "https://jxsuite.com/schema/ext/parser/project/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: { content: { type: "object" } },
  };
  const EXT_DOCUMENT = {
    $id: "https://jxsuite.com/schema/ext/parser/document/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { ContentPathsSource: { type: "object", required: ["contentType"] } },
  };
  const EXT_FIELDS = {
    $id: "https://jxsuite.com/schema/ext/connector/fields/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { ColumnExtras: { type: "object" } },
  };

  /** Bare-specifier loader: exactly what a Worker has — a table, no filesystem. */
  const FILES: Record<string, object> = {
    "@jxsuite/connector/schemas/fields.fragment.schema.json": EXT_FIELDS,
    "@jxsuite/parser/schemas/document.fragment.schema.json": EXT_DOCUMENT,
    "@jxsuite/parser/schemas/project.fragment.schema.json": EXT_PROJECT,
    "@jxsuite/schema/schema.json": CORE_DOCUMENT,
    "@jxsuite/schema/schemas/project.core.schema.json": CORE_PROJECT,
  };
  const loadJson = (path: string): Promise<Record<string, unknown>> => {
    // Refs resolve against baseDir "", so the bundler hands over a leading slash.
    const file = FILES[path.replace(/^\//, "")];
    return file
      ? Promise.resolve(structuredClone(file) as Record<string, unknown>)
      : Promise.reject(new Error(`No such file: ${path}`));
  };
  const compose = (extensions: Parameters<typeof composeProjectSchemas>[0]["extensions"]) =>
    composeProjectSchemas({
      baseDir: "",
      coreDocumentRef: "@jxsuite/schema/schema.json",
      coreProjectRef: "@jxsuite/schema/schemas/project.core.schema.json",
      extensions,
      loadJson,
    });

  test("composes self-contained entry documents with no external refs left", async () => {
    const { document, project } = await compose([
      {
        document: "@jxsuite/parser/schemas/document.fragment.schema.json",
        project: "@jxsuite/parser/schemas/project.fragment.schema.json",
      },
    ]);

    // Self-containment is the contract (§5.4): every ref a root-relative JSON pointer.
    for (const entry of [project, document]) {
      const refs: string[] = [];
      JSON.stringify(entry, (key, value) => {
        if (key === "$ref" && typeof value === "string") {
          refs.push(value);
        }
        return value as unknown;
      });
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.every((ref) => ref.startsWith("#/"))).toBe(true);
    }
  });

  test("both entry documents compile and enforce the composition under ajv", async () => {
    const { document, project } = await compose([
      {
        document: "@jxsuite/parser/schemas/document.fragment.schema.json",
        project: "@jxsuite/parser/schemas/project.fragment.schema.json",
      },
    ]);
    const ajv = new Ajv2020({ allErrors: true, strict: false });

    const validateProject = ajv.compile(project);
    expect(validateProject({ content: {}, name: "Demo" })).toBe(true);
    // Closed by `unevaluatedProperties: false` over the composition over core + the extension's fragment.
    expect(validateProject({ name: "Demo", typodSection: {} })).toBe(false);

    expect(ajv.compile(document)({ tagName: "div" })).toBe(true);
  });

  test("an extension's document $defs join the paths union; its fragment is embedded", async () => {
    const { document } = await compose([
      { document: "@jxsuite/parser/schemas/document.fragment.schema.json" },
    ]);
    const serialized = JSON.stringify(document);
    expect(serialized).toContain("ContentPathsSource");
    // Referenced by canonical $id only, so it must be embedded explicitly or the ref dangles.
    expect(new Ajv2020({ allErrors: true, strict: false }).compile(document)).toBeTruthy();
  });

  test("a fields fragment contributes its $defs to the field union", async () => {
    const { project } = await compose([
      { fields: "@jxsuite/connector/schemas/fields.fragment.schema.json" },
    ]);
    expect(JSON.stringify(project)).toContain("ColumnExtras");
  });

  test("no extensions still yields the core-only pair", async () => {
    const { document, project } = await compose([]);
    expect(project.$comment).toBe(GENERATED_SCHEMA_COMMENT);
    expect(document.$comment).toBe(GENERATED_SCHEMA_COMMENT);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    expect(ajv.compile(project)({ name: "Demo" })).toBe(true);
    expect(ajv.compile(document)({ tagName: "div" })).toBe(true);
  });

  /* A fragment the host cannot supply fails LOUDLY rather than being dropped: a silently
     incomplete entry document would under-validate the project with nothing to show for it. Hosts
     that cannot supply an extension's fragments leave the extension out of the list instead — what
     the cloud session does for packages it does not bundle. */
  test("an unreadable fragment fails the composition rather than being dropped", async () => {
    let message = "";
    try {
      await compose([{ fields: "@jxsuite/missing/fields.json" }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/cannot load \$ref target/);
  });

  test("a fragment without $id or $defs contributes no union members", async () => {
    FILES["@jxsuite/bare/fields.json"] = { type: "object" };
    const { project } = await compose([{ fields: "@jxsuite/bare/fields.json" }]);
    const fields = (project.$defs as Record<string, { anyOf?: unknown[] }>).Fields;
    // Core JxFieldSchema + RelationshipRef only.
    expect(fields?.anyOf).toHaveLength(2);
  });
});
