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

/**
 * The CORE `$paths` source shapes — the members the shipped default paths union carries, and the
 * ones every per-project entry document unions extension shapes on top of.
 *
 * These mirror `resolvePathEntries` in the compiler's pages-discovery exactly (specs/
 * site-architecture.md §4.3): an explicit value list, a JSON data-file reference, and the legacy
 * bare array of parameter objects. Anything else is dispatched by discriminator key to an
 * extension's `resolvePaths` capability, so extension shapes reach the union through the entry
 * document rather than from here.
 *
 * Each shape is CLOSED (`additionalProperties: false`). `$paths` is a build-time instruction with a
 * fully specified grammar and no forward-compatible extension points of its own — a stray or
 * misspelled key means the route silently expands to nothing, which is exactly the failure worth
 * catching in the editor.
 */
export const documentPathsCoreMembers = [
  {
    additionalProperties: false,
    description:
      'Explicit value list: generates one page per value, bound to `param` (default "value").',
    properties: {
      param: { description: 'Route parameter to fill (default "value").', type: "string" },
      values: { description: "The values to expand.", type: "array" },
    },
    required: ["values"],
    type: "object",
  },
  {
    additionalProperties: false,
    description:
      "JSON data-file source: loads a project-relative file that must contain an array, and " +
      "generates one page per item.",
    properties: {
      $ref: {
        description: "Project-relative path to a .json file containing an array.",
        type: "string",
      },
      field: {
        description: 'Item field providing the parameter value (default "id").',
        type: "string",
      },
      param: { description: 'Route parameter to fill (default "id").', type: "string" },
    },
    required: ["$ref"],
    type: "object",
  },
  {
    description:
      "Legacy explicit form: an array of ready-made parameter objects, used as-is with no " +
      "expansion. Prefer one of the source shapes above.",
    items: { additionalProperties: { type: "string" }, type: "object" },
    type: "array",
  },
] as const;

/**
 * The extra member the SHIPPED DEFAULT union carries and a per-project entry document does not.
 *
 * A default cannot know which extensions a project enables, so without this any extension source
 * shape — `{ contentType: "blog" }` with the parser on — would be a FALSE ERROR wherever the
 * default is what is in play: the studio's offline fallback before per-project schemas arrive, and
 * clients that fetch the canonical URL. Spec §5.4 promises that path degrades to
 * _under-suggestion_, never false errors, so the default accepts any non-empty object and the entry
 * document — which does know the enabled extensions, and is what `jx validate` and every editor
 * actually resolve — is the strict one.
 */
export const documentPathsUnknownSourceMember = {
  description:
    "A source shape contributed by an extension this schema cannot see. The project's generated " +
    "document.schema.json validates these exactly; enable the owning extension and regenerate " +
    "with `jx schema` to get precise checking here.",
  minProperties: 1,
  type: "object",
} as const;
