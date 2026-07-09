/**
 * Field-schema vocabulary (specs/extensions.md §5.3, specs/relationships.md).
 *
 * JxFieldSchema is the JSON-Schema-subset shape for a single field inside a section entry schema
 * (content frontmatter fields, table columns). Recursive positions (`items`, nested `properties`)
 * reference the well-known **fields resource URI** — a schema resource the generated per-project
 * entry document re-embeds under the same `$id` with the effective union (core shape +
 * RelationshipRef + extension extras), shadowing the shipped default by standard compound-document
 * `$id` resolution. Extension fragments reference the same URI at their field positions.
 *
 * (An earlier design used `$dynamicRef`/`$dynamicAnchor` here; ajv restricts `$dynamicAnchor` to
 * schema-resource roots, which cannot express a non-root recursion unit, so the model uses plain
 * `$id` indirection instead — verified against ajv 8.20 / 2020-12.)
 */

/** The well-known $id of the project field-schema union resource. */
export const PROJECT_FIELDS_SCHEMA_ID = "https://jxsuite.com/schema/project/fields/v2";

/** The well-known $id of the document $paths-value union resource. */
export const DOCUMENT_PATHS_SCHEMA_ID = "https://jxsuite.com/schema/document/paths/v2";

export const jxFieldSchemaDef = {
  description:
    "A single field definition inside a section entry schema — a small, recursive subset of " +
    "JSON Schema. Recursive positions reference the effective field union via the well-known " +
    "fields resource $id.",
  properties: {
    default: {},
    description: { type: "string" },
    enum: { type: "array" },
    format: { type: "string" },
    items: { $ref: PROJECT_FIELDS_SCHEMA_ID },
    properties: {
      additionalProperties: { $ref: PROJECT_FIELDS_SCHEMA_ID },
      type: "object",
    },
    required: { items: { type: "string" }, type: "array" },
    type: {
      enum: ["string", "number", "integer", "boolean", "array", "object"],
      type: "string",
    },
  },
  required: ["type"],
  type: "object",
} as const;

export const relationshipRefSchema = {
  description:
    "Relationship reference field: points at a named entry of a referenceable section via " +
    '"#/<sectionKey>/<name>" (specs/relationships.md). A bare reference is to-one; wrap in an ' +
    "array field's items for to-many.",
  properties: {
    $ref: { pattern: "^#/[A-Za-z][A-Za-z0-9_-]*/[A-Za-z0-9._-]+$", type: "string" },
    description: { type: "string" },
  },
  required: ["$ref"],
  type: "object",
} as const;
