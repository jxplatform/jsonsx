/**
 * FlattenSchema suite (specs/extensions.md §5.4): collapsing a bundled compound document into a
 * single resource must preserve validation behavior exactly while leaving only root-relative JSON
 * Pointers behind — the one ref form ajv, VS Code's JSON language service, and Monaco all resolve
 * identically. Structure is pinned too: embedded `$id`s become readable `$defs` slugs and are
 * dropped, `$id` shadowing resolves to the entry's own embed, and instance-data keywords
 * (`examples`, `default`, `const`, `enum`) keep their `$ref`-shaped contents untouched.
 */
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import {
  PROJECT_CORE_SCHEMA_ID,
  PROJECT_FIELDS_SCHEMA_ID,
  emitProjectSchema,
  flattenSchema,
} from "../src/project-schemas";

const FRAG_ID = "https://test.invalid/parser/project.fragment.schema.json";

/** Every `$ref` in a document, paired with the pointer it sits at. */
function allRefs(node: unknown, path = "", out: [string, string][] = []): [string, string][] {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      allRefs(item, `${path}/${index}`, out);
    }
    return out;
  }
  if (typeof node !== "object" || node === null) {
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      out.push([value, path]);
    } else {
      allRefs(value, `${path}/${key}`, out);
    }
  }
  return out;
}

/** A compound document shaped like a real bundle: an entry plus two embedded resources. */
function compound(): Record<string, unknown> {
  return {
    $defs: {
      Fields: {
        $id: PROJECT_FIELDS_SCHEMA_ID,
        anyOf: [{ $ref: `${PROJECT_CORE_SCHEMA_ID}#/$defs/JxFieldSchema` }],
      },
      [PROJECT_CORE_SCHEMA_ID]: {
        $defs: {
          JxFieldSchema: {
            properties: {
              items: { $ref: PROJECT_FIELDS_SCHEMA_ID },
              type: { type: "string" },
            },
            required: ["type"],
            type: "object",
          },
          StyleObject: {
            // Recursive through a LOCAL pointer — the ref form VS Code cannot re-base.
            additionalProperties: { oneOf: [{ type: "string" }, { $ref: "#/$defs/StyleObject" }] },
            type: "object",
          },
        },
        $id: PROJECT_CORE_SCHEMA_ID,
        properties: {
          name: { type: "string" },
          style: { $ref: "#/$defs/StyleObject" },
        },
        type: "object",
      },
      [FRAG_ID]: {
        $id: FRAG_ID,
        properties: {
          content: { additionalProperties: { $ref: PROJECT_FIELDS_SCHEMA_ID }, type: "object" },
        },
        type: "object",
      },
    },
    $schema: "https://json-schema.org/draft/2020-12/schema",
    allOf: [{ $ref: PROJECT_CORE_SCHEMA_ID }, { $ref: FRAG_ID }],
    type: "object",
    unevaluatedProperties: false,
  };
}

describe("flattenSchema structure", () => {
  test("leaves only root-relative pointers and no embedded $ids", () => {
    const flat = flattenSchema(compound());
    for (const [ref, at] of allRefs(flat)) {
      expect(ref.startsWith("#/"), `${ref} at ${at}`).toBe(true);
    }
    const defs = flat.$defs as Record<string, Record<string, unknown>>;
    for (const [key, value] of Object.entries(defs)) {
      expect(value.$id, `${key} kept an $id`).toBeUndefined();
    }
  });

  test("rekeys URI-keyed $defs to readable slugs and repoints the composition", () => {
    const flat = flattenSchema(compound());
    expect(Object.keys(flat.$defs as object)).toEqual([
      "Fields",
      "project-core-v2",
      "parser-project-fragment-schema-json",
    ]);
    expect(flat.allOf).toEqual([
      { $ref: "#/$defs/project-core-v2" },
      { $ref: "#/$defs/parser-project-fragment-schema-json" },
    ]);
  });

  test("re-bases a local pointer onto the resource it appears in", () => {
    const flat = flattenSchema(compound());
    const core = (flat.$defs as Record<string, Record<string, unknown>>)["project-core-v2"]!;
    const props = core.properties as Record<string, { $ref: string }>;
    expect(props.style!.$ref).toBe("#/$defs/project-core-v2/$defs/StyleObject");
    const style = (core.$defs as Record<string, Record<string, unknown>>).StyleObject!;
    const { oneOf } = style.additionalProperties as { oneOf: { $ref?: string }[] };
    expect(oneOf[1]!.$ref).toBe("#/$defs/project-core-v2/$defs/StyleObject");
  });

  test("$id shadowing resolves to the entry document's own embed", () => {
    const flat = flattenSchema(compound());
    const defs = flat.$defs as Record<string, Record<string, unknown>>;
    /* Both the fragment and the core field shape reference the fields union by canonical $id; each
       must land on `#/$defs/Fields` (the effective union), not on any shipped default. */
    const frag = defs["parser-project-fragment-schema-json"]!;
    const content = (frag.properties as Record<string, Record<string, unknown>>).content!;
    expect((content.additionalProperties as { $ref: string }).$ref).toBe("#/$defs/Fields");
    const field = (defs["project-core-v2"]!.$defs as Record<string, Record<string, unknown>>)
      .JxFieldSchema!;
    const fieldProps = field.properties as Record<string, { $ref?: string }>;
    expect(fieldProps.items!.$ref).toBe("#/$defs/Fields");
    expect(defs.Fields!.anyOf).toEqual([{ $ref: "#/$defs/project-core-v2/$defs/JxFieldSchema" }]);
  });

  test("does not mutate the input document", () => {
    const input = compound();
    const snapshot = structuredClone(input);
    flattenSchema(input);
    expect(input).toEqual(snapshot);
  });
});

describe("flattenSchema equivalence", () => {
  test("validates exactly the instances the compound document validates", () => {
    const source = compound();
    const validateCompound = new Ajv2020({ allErrors: true, strict: false }).compile(source);
    const validateFlat = new Ajv2020({ allErrors: true, strict: false }).compile(
      flattenSchema(compound()),
    );
    const cases: unknown[] = [
      { content: { posts: { type: "string" } }, name: "ok", style: { color: "red" } },
      // Recursion through the local StyleObject pointer, two levels deep.
      { name: "ok", style: { "&:hover": { color: "red" } } },
      { name: "ok", style: { "&:hover": { "@media": { color: 1 } } } },
      { name: 42 },
      { name: "ok", unknownTopLevelKey: true },
      { content: { posts: { noType: true } }, name: "ok" },
    ];
    for (const doc of cases) {
      expect(validateFlat(doc)).toBe(validateCompound(doc));
    }
    expect(validateFlat(cases[0])).toBe(true);
    expect(validateFlat(cases[3])).toBe(false);
    expect(validateFlat(cases[4])).toBe(false);
    expect(validateFlat(cases[5])).toBe(false);
  });

  test("a bundled emitProjectSchema entry flattens to a compilable single resource", () => {
    const entry = {
      ...emitProjectSchema({ corePath: PROJECT_CORE_SCHEMA_ID, fragments: [] }),
      $defs: compound().$defs as Record<string, unknown>,
    };
    const flat = flattenSchema(entry);
    expect(() => new Ajv2020({ strict: false }).compile(flat)).not.toThrow();
  });
});

describe("flattenSchema edge cases", () => {
  test("keeps $ref-shaped strings inside instance-data keywords untouched", () => {
    const flat = flattenSchema({
      $defs: {
        "https://test.invalid/res": {
          $id: "https://test.invalid/res",
          properties: {
            body: {
              const: { $ref: "#/state/frozen" },
              default: { $ref: "#/state/fallback" },
              enum: [{ $ref: "#/state/one" }],
              examples: [{ $ref: "#/state/cart" }],
              type: "object",
            },
          },
        },
      },
      allOf: [{ $ref: "https://test.invalid/res" }],
    });
    const res = (flat.$defs as Record<string, Record<string, unknown>>)["res"]!;
    const body = (res.properties as Record<string, Record<string, unknown>>).body!;
    expect(body.examples).toEqual([{ $ref: "#/state/cart" }]);
    expect(body.default).toEqual({ $ref: "#/state/fallback" });
    expect(body.const).toEqual({ $ref: "#/state/frozen" });
    expect(body.enum).toEqual([{ $ref: "#/state/one" }]);
  });

  test("walks tuple items, prefixItems, and dependentSchemas positions", () => {
    const flat = flattenSchema({
      $defs: {
        "https://test.invalid/r": {
          $defs: { Leaf: { type: "string" } },
          $id: "https://test.invalid/r",
          dependentSchemas: { flag: { $ref: "#/$defs/Leaf" } },
          items: [{ $ref: "#/$defs/Leaf" }],
          prefixItems: [{ $ref: "#/$defs/Leaf" }],
        },
      },
    });
    const r = (flat.$defs as Record<string, Record<string, unknown>>)["r"]!;
    const expected = "#/$defs/r/$defs/Leaf";
    expect((r.items as { $ref: string }[])[0]!.$ref).toBe(expected);
    expect((r.prefixItems as { $ref: string }[])[0]!.$ref).toBe(expected);
    expect((r.dependentSchemas as Record<string, { $ref: string }>).flag!.$ref).toBe(expected);
  });

  test("slugs collide-safely and cover urn, bare-authority, and reserved-key forms", () => {
    const flat = flattenSchema({
      $defs: {
        "core-v2": { type: "object" },
        "https://a.invalid/schema/core/v2": { $id: "https://a.invalid/schema/core/v2" },
        "https://b.invalid/schema/core/v2": { $id: "https://b.invalid/schema/core/v2" },
        "https://c.invalid": { $id: "https://c.invalid" },
        "urn:jx:bundled:1": { $id: "urn:jx:bundled:1" },
      },
    });
    expect(Object.keys(flat.$defs as object)).toEqual([
      "core-v2",
      "core-v2-2",
      "core-v2-3",
      "resource",
      "jx-bundled-1",
    ]);
  });

  test("a $defs entry without its own $id is keyed from the URI it was filed under", () => {
    const flat = flattenSchema({
      $defs: { "https://test.invalid/schema/no-id": { type: "string" } },
    });
    expect(Object.keys(flat.$defs as object)).toEqual(["no-id"]);
  });

  test("keeps the root's own $id and its already-root-relative pointers", () => {
    const flat = flattenSchema({
      $defs: { Local: { type: "number" } },
      $id: "https://test.invalid/entry",
      properties: { n: { $ref: "#/$defs/Local" } },
      type: "object",
    });
    expect(flat.$id).toBe("https://test.invalid/entry");
    expect((flat.properties as Record<string, { $ref: string }>).n!.$ref).toBe("#/$defs/Local");
  });

  test("leaves refs to URIs that are not embedded here alone", () => {
    const flat = flattenSchema({
      properties: { meta: { $ref: "https://json-schema.org/draft/2020-12/schema" } },
      type: "object",
    });
    expect((flat.properties as Record<string, { $ref: string }>).meta!.$ref).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  test("handles a document with no $defs and an anchor-style ref", () => {
    const flat = flattenSchema({ $ref: "#anchored", type: "object" });
    expect(flat.$ref).toBe("#anchored");
    expect(flat.$defs).toBeUndefined();
  });

  test("a resource nested below the top level re-bases onto its own pointer", () => {
    const flat = flattenSchema({
      $defs: {
        Outer: {
          properties: {
            inner: {
              $defs: { Leaf: { type: "boolean" } },
              $id: "https://test.invalid/inner",
              additionalProperties: { $ref: "#/$defs/Leaf" },
            },
          },
        },
      },
    });
    const outer = (flat.$defs as Record<string, Record<string, unknown>>).Outer!;
    const inner = (outer.properties as Record<string, Record<string, unknown>>).inner!;
    expect(inner.$id).toBeUndefined();
    expect((inner.additionalProperties as { $ref: string }).$ref).toBe(
      "#/$defs/Outer/properties/inner/$defs/Leaf",
    );
  });
});
