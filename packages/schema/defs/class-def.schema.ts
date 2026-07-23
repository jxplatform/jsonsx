/**
 * Method capability roles: "method"/"accessor" plus every static capability role hosts dispatch on
 * (format-registry EXTENSION_CAPABILITIES — specs/extensions.md §8). Kept as a literal tuple so
 * FromSchema inference stays precise; the drift-guard test in tests/class-schema-drift.test.ts
 * asserts parity with EXTENSION_CAPABILITIES.
 */
export const CLASS_METHOD_ROLES = [
  "method",
  "accessor",
  "parse",
  "serialize",
  "discover",
  "load",
  "projectData",
  "resolvePaths",
  "lower",
  "emit",
  "assets",
  "mount",
  "dialect",
  "deploySchema",
  "bindings",
  "testConnection",
] as const;

export const classParameterDefSchema = {
  description: "A typed parameter definition for a class.",
  properties: {
    default: {},
    description: { type: "string" },
    examples: { type: "array" },
    format: {
      description: 'When "json-schema", this parameter\'s value is itself a JSON Schema.',
      type: "string",
    },
    identifier: { type: "string" },
    type: {},
  },
  required: ["identifier"],
  type: "object",
} as const;

export const classFieldDefSchema = {
  description: "A class field definition with access control and scope.",
  properties: {
    $prototype: {
      description: 'Data source prototype for this field (e.g., "Request").',
      type: "string",
    },
    access: { enum: ["public", "private", "protected"], type: "string" },
    default: {},
    description: { type: "string" },
    examples: { type: "array" },
    identifier: { type: "string" },
    initializer: {},
    role: { const: "field", type: "string" },
    scope: { enum: ["instance", "static"], type: "string" },
    type: {},
  },
  type: "object",
} as const;

export const classConstructorDefSchema = {
  description: "Class constructor definition.",
  properties: {
    $prototype: { const: "Function", type: "string" },
    body: {
      oneOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }],
    },
    description: { type: "string" },
    parameters: {
      items: {
        oneOf: [
          {
            additionalProperties: false,
            properties: { $ref: { type: "string" } },
            required: ["$ref"],
            type: "object",
          },
          { $ref: "#/$defs/ClassParameterDef" },
        ],
      },
      type: "array",
    },
    role: { const: "constructor", type: "string" },
    superCall: {
      properties: {
        arguments: { items: { type: "string" }, type: "array" },
      },
      type: "object",
    },
  },
  type: "object",
} as const;

export const classMethodDefSchema = {
  description:
    "A class method or accessor definition. Capability roles (parse, serialize, discover, load) " +
    "mark static methods that hosts (compiler, server, studio) invoke for format dispatch.",
  properties: {
    $prototype: { const: "Function", type: "string" },
    access: { enum: ["public", "private", "protected"], type: "string" },
    body: {
      oneOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }],
    },
    description: { type: "string" },
    getter: {
      properties: { body: { type: "string" } },
      type: "object",
    },
    identifier: { type: "string" },
    parameters: {
      items: {
        oneOf: [
          {
            additionalProperties: false,
            properties: { $ref: { type: "string" } },
            required: ["$ref"],
            type: "object",
          },
          { $ref: "#/$defs/ClassParameterDef" },
        ],
      },
      type: "array",
    },
    returnType: {},
    role: {
      enum: CLASS_METHOD_ROLES,
      type: "string",
    },
    scope: { enum: ["instance", "static"], type: "string" },
    setter: {
      properties: {
        body: { type: "string" },
        parameters: { type: "array" },
      },
      type: "object",
    },
    timing: {
      description:
        "Execution environments allowed to call this capability directly. " +
        "Hosts outside the list round-trip through the dev server.",
      items: { enum: ["compiler", "server", "client"], type: "string" },
      type: "array",
    },
  },
  type: "object",
} as const;

export const formatDefSchema = {
  description:
    "Format participation marker. A class carrying this block is auto-discovered from the " +
    "project imports map and used for file-extension dispatch by the compiler, server, and studio.",
  properties: {
    documentKinds: {
      description:
        '"page"/"component" allow the extension in pages/components discovery; ' +
        '"content" allows it as a content-type source.',
      items: { enum: ["page", "component", "content"], type: "string" },
      type: "array",
    },
    exportTarget: {
      description: "When true, site builds emit a serialized sidecar per page in this format.",
      type: "boolean",
    },
    extensions: {
      description: 'File extensions this format claims, with leading dot (e.g. [".md"]).',
      items: { pattern: "^\\.", type: "string" },
      minItems: 1,
      type: "array",
    },
    mediaType: {
      description: "MIME type for the format (icons, labels, HTTP).",
      type: "string",
    },
    remote: {
      description: "When true, the load capability accepts http(s) URLs as sources.",
      type: "boolean",
    },
  },
  required: ["extensions"],
  type: "object",
} as const;

export const projectBlockDefSchema = {
  additionalProperties: false,
  description:
    "Project-section admission block (specs/extensions.md §9). A class carrying this block owns " +
    "the project.json section named by `key`; hosts dispatch that section's data through the " +
    "class's projectData/resolvePaths capabilities.",
  properties: {
    description: { type: "string" },
    key: {
      description: "The project.json top-level section this class owns (exclusive per project).",
      type: "string",
    },
    referenceable: {
      description: "Whether section entries can be referenced from documents (e.g. content types).",
      type: "boolean",
    },
    title: { type: "string" },
  },
  required: ["key"],
  type: "object",
} as const;

export const serverBlockDefSchema = {
  additionalProperties: false,
  description:
    "Server-mount admission block (specs/extensions.md §11). A class carrying this block mounts " +
    "routes under its /_jx/ basePath in the site worker and dev server.",
  properties: {
    basePath: {
      description: "Route subtree this class mounts — must be under /_jx/ (exclusive per project).",
      examples: ["/_jx/data", "/_jx/auth"],
      type: "string",
    },
    module: {
      description: "Module specifier exporting the mount handler.",
      type: "string",
    },
    order: {
      description: "Mount order (ascending; default 100).",
      type: "number",
    },
  },
  required: ["basePath"],
  type: "object",
} as const;

export const connectorBlockDefSchema = {
  // Open by design: the block mirrors format-registry's ConnectorBlock ([key: string]: unknown) —
  // Providers carry extra keys (e.g. D1's `module`), so additionalProperties stays true.
  description:
    "Connection-provider admission block (specs/extensions.md §12). A class carrying this block " +
    "provides database connections of the given provider/kind.",
  properties: {
    kind: {
      description: "SQL dialect family the provider speaks.",
      enum: ["sqlite", "postgres"],
      type: "string",
    },
    local: {
      description: "Local-development substitute provider (e.g. sqlite for D1).",
      type: "string",
    },
    module: {
      description: "Module specifier exporting the provider implementation.",
      type: "string",
    },
    provider: {
      description: "Provider identifier (e.g. d1, supabase, sqlite).",
      type: "string",
    },
    serve: {
      description: "Module specifier exporting the serve-time worker binding.",
      type: "string",
    },
  },
  required: ["provider", "kind"],
  type: "object",
} as const;

export const studioHintsSchema = {
  description:
    "Studio control-surface hints for a format class: editor modes, document-mode rules, " +
    "templates, and the element/nesting constraints that gate structural editing.",
  properties: {
    documentMode: {
      properties: {
        componentWhen: {
          description:
            "Treat the document as a component when this top-level/frontmatter key matches the regex.",
          properties: {
            frontmatterKey: { type: "string" },
            matches: { type: "string" },
          },
          type: "object",
        },
        default: { enum: ["content", "component"], type: "string" },
      },
      type: "object",
    },
    elements: {
      description: "Element allowlist and nesting constraints for structural editing.",
      properties: {
        block: { items: { type: "string" }, type: "array" },
        inline: { items: { type: "string" }, type: "array" },
        nesting: {
          additionalProperties: {
            properties: {
              block: { type: "boolean" },
              directive: { type: "boolean" },
              inline: { type: "boolean" },
              only: { items: { type: "string" }, type: "array" },
            },
            type: "object",
          },
          description:
            'Per-parent child rules keyed by tag (or "_root"): ' +
            "{ block, inline, directive } booleans or { only: [tags] }.",
          type: "object",
        },
        textOnly: { items: { type: "string" }, type: "array" },
        void: { items: { type: "string" }, type: "array" },
      },
      type: "object",
    },
    icon: { type: "string" },
    modes: {
      description: "Editor modes the studio offers for documents of this format.",
      items: { type: "string" },
      type: "array",
    },
    newFileTemplate: {
      description: "Initial source text for newly created files of this format.",
      type: "string",
    },
  },
  type: "object",
} as const;

export const classDefSchema = {
  additionalProperties: false,
  description:
    'A .class.json schema-defined class. $prototype must be "Class". ' +
    "Defines fields, constructor, methods, and type parameters via $defs. " +
    "Optionally points to a JS module via $implementation for hybrid execution.",
  properties: {
    $defs: {
      description: "Class members: parameters, returnTypes, fields, constructor, methods.",
      properties: {
        constructor: { $ref: "#/$defs/ClassConstructorDef" },
        fields: {
          additionalProperties: { $ref: "#/$defs/ClassFieldDef" },
          description: "Class fields with role, access, scope, and type information.",
          type: "object",
        },
        methods: {
          additionalProperties: { $ref: "#/$defs/ClassMethodDef" },
          description: "Class methods and accessors.",
          type: "object",
        },
        parameters: {
          additionalProperties: { $ref: "#/$defs/ClassParameterDef" },
          description: "Reusable typed parameter schemas, keyed by name.",
          type: "object",
        },
        returnTypes: {
          additionalProperties: { type: "object" },
          description: "Output type schemas, keyed by name.",
          type: "object",
        },
      },
      type: "object",
    },
    $id: { type: "string" },
    $implementation: {
      description: "Relative path to a JS module containing the actual class implementation.",
      type: "string",
    },
    $prototype: { const: "Class", type: "string" },
    $schema: { type: "string" },
    $studio: { $ref: "#/$defs/StudioHints" },
    connector: { $ref: "#/$defs/ConnectorBlockDef" },
    description: { type: "string" },
    extends: {
      description: "Base class — string name or $ref to another .class.json.",
      oneOf: [
        { type: "string" },
        { properties: { $ref: { type: "string" } }, required: ["$ref"], type: "object" },
      ],
    },
    format: { $ref: "#/$defs/FormatDef" },
    project: { $ref: "#/$defs/ProjectBlockDef" },
    server: { $ref: "#/$defs/ServerBlockDef" },
    title: {
      description: "PascalCase class name, used as the export name.",
      type: "string",
    },
  },
  required: ["$prototype", "title"],
  type: "object",
} as const;
