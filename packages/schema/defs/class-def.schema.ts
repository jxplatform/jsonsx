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
      enum: ["method", "accessor", "parse", "serialize", "discover", "load"],
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
    description: { type: "string" },
    extends: {
      description: "Base class — string name or $ref to another .class.json.",
      oneOf: [
        { type: "string" },
        { properties: { $ref: { type: "string" } }, required: ["$ref"], type: "object" },
      ],
    },
    format: { $ref: "#/$defs/FormatDef" },
    title: {
      description: "PascalCase class name, used as the export name.",
      type: "string",
    },
  },
  required: ["$prototype", "title"],
  type: "object",
} as const;
