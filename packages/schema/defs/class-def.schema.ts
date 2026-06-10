export const classParameterDefSchema = {
  description: "A typed parameter definition for a class.",
  type: "object",
  required: ["identifier"],
  properties: {
    identifier: { type: "string" },
    type: {},
    format: {
      description: 'When "json-schema", this parameter\'s value is itself a JSON Schema.',
      type: "string",
    },
    description: { type: "string" },
    default: {},
    examples: { type: "array" },
  },
} as const;

export const classFieldDefSchema = {
  description: "A class field definition with access control and scope.",
  type: "object",
  properties: {
    role: { type: "string", const: "field" },
    access: { type: "string", enum: ["public", "private", "protected"] },
    scope: { type: "string", enum: ["instance", "static"] },
    identifier: { type: "string" },
    type: {},
    $prototype: {
      description: 'Data source prototype for this field (e.g., "Request").',
      type: "string",
    },
    initializer: {},
    default: {},
    description: { type: "string" },
    examples: { type: "array" },
  },
} as const;

export const classConstructorDefSchema = {
  description: "Class constructor definition.",
  type: "object",
  properties: {
    role: { type: "string", const: "constructor" },
    $prototype: { type: "string", const: "Function" },
    parameters: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            required: ["$ref"],
            properties: { $ref: { type: "string" } },
            additionalProperties: false,
          },
          { $ref: "#/$defs/ClassParameterDef" },
        ],
      },
    },
    superCall: {
      type: "object",
      properties: {
        arguments: { type: "array", items: { type: "string" } },
      },
    },
    body: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
    description: { type: "string" },
  },
} as const;

export const classMethodDefSchema = {
  description:
    "A class method or accessor definition. Capability roles (parse, serialize, discover, load) " +
    "mark static methods that hosts (compiler, server, studio) invoke for format dispatch.",
  type: "object",
  properties: {
    role: {
      type: "string",
      enum: ["method", "accessor", "parse", "serialize", "discover", "load"],
    },
    $prototype: { type: "string", const: "Function" },
    access: { type: "string", enum: ["public", "private", "protected"] },
    scope: { type: "string", enum: ["instance", "static"] },
    identifier: { type: "string" },
    timing: {
      description:
        "Execution environments allowed to call this capability directly. " +
        "Hosts outside the list round-trip through the dev server.",
      type: "array",
      items: { type: "string", enum: ["compiler", "server", "client"] },
    },
    parameters: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            required: ["$ref"],
            properties: { $ref: { type: "string" } },
            additionalProperties: false,
          },
          { $ref: "#/$defs/ClassParameterDef" },
        ],
      },
    },
    returnType: {},
    body: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
    getter: {
      type: "object",
      properties: { body: { type: "string" } },
    },
    setter: {
      type: "object",
      properties: {
        parameters: { type: "array" },
        body: { type: "string" },
      },
    },
    description: { type: "string" },
  },
} as const;

export const formatDefSchema = {
  description:
    "Format participation marker. A class carrying this block is auto-discovered from the " +
    "project imports map and used for file-extension dispatch by the compiler, server, and studio.",
  type: "object",
  required: ["extensions"],
  properties: {
    extensions: {
      description: 'File extensions this format claims, with leading dot (e.g. [".md"]).',
      type: "array",
      items: { type: "string", pattern: "^\\." },
      minItems: 1,
    },
    mediaType: {
      description: "MIME type for the format (icons, labels, HTTP).",
      type: "string",
    },
    documentKinds: {
      description:
        '"page"/"component" allow the extension in pages/components discovery; ' +
        '"content" allows it as a content-type source.',
      type: "array",
      items: { type: "string", enum: ["page", "component", "content"] },
    },
    exportTarget: {
      description: "When true, site builds emit a serialized sidecar per page in this format.",
      type: "boolean",
    },
    remote: {
      description: "When true, the load capability accepts http(s) URLs as sources.",
      type: "boolean",
    },
  },
} as const;

export const studioHintsSchema = {
  description:
    "Studio control-surface hints for a format class: editor modes, document-mode rules, " +
    "templates, and the element/nesting constraints that gate structural editing.",
  type: "object",
  properties: {
    icon: { type: "string" },
    modes: {
      description: "Editor modes the studio offers for documents of this format.",
      type: "array",
      items: { type: "string" },
    },
    documentMode: {
      type: "object",
      properties: {
        default: { type: "string", enum: ["content", "component"] },
        componentWhen: {
          description:
            "Treat the document as a component when this top-level/frontmatter key matches the regex.",
          type: "object",
          properties: {
            frontmatterKey: { type: "string" },
            matches: { type: "string" },
          },
        },
      },
    },
    newFileTemplate: {
      description: "Initial source text for newly created files of this format.",
      type: "string",
    },
    elements: {
      description: "Element allowlist and nesting constraints for structural editing.",
      type: "object",
      properties: {
        block: { type: "array", items: { type: "string" } },
        inline: { type: "array", items: { type: "string" } },
        void: { type: "array", items: { type: "string" } },
        textOnly: { type: "array", items: { type: "string" } },
        nesting: {
          description:
            'Per-parent child rules keyed by tag (or "_root"): ' +
            "{ block, inline, directive } booleans or { only: [tags] }.",
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              block: { type: "boolean" },
              inline: { type: "boolean" },
              directive: { type: "boolean" },
              only: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

export const classDefSchema = {
  description:
    'A .class.json schema-defined class. $prototype must be "Class". ' +
    "Defines fields, constructor, methods, and type parameters via $defs. " +
    "Optionally points to a JS module via $implementation for hybrid execution.",
  type: "object",
  required: ["$prototype", "title"],
  properties: {
    $schema: { type: "string" },
    $id: { type: "string" },
    $prototype: { type: "string", const: "Class" },
    title: {
      description: "PascalCase class name, used as the export name.",
      type: "string",
    },
    description: { type: "string" },
    format: { $ref: "#/$defs/FormatDef" },
    $studio: { $ref: "#/$defs/StudioHints" },
    extends: {
      description: "Base class — string name or $ref to another .class.json.",
      oneOf: [
        { type: "string" },
        { type: "object", required: ["$ref"], properties: { $ref: { type: "string" } } },
      ],
    },
    $implementation: {
      description: "Relative path to a JS module containing the actual class implementation.",
      type: "string",
    },
    $defs: {
      description: "Class members: parameters, returnTypes, fields, constructor, methods.",
      type: "object",
      properties: {
        parameters: {
          description: "Reusable typed parameter schemas, keyed by name.",
          type: "object",
          additionalProperties: { $ref: "#/$defs/ClassParameterDef" },
        },
        returnTypes: {
          description: "Output type schemas, keyed by name.",
          type: "object",
          additionalProperties: { type: "object" },
        },
        fields: {
          description: "Class fields with role, access, scope, and type information.",
          type: "object",
          additionalProperties: { $ref: "#/$defs/ClassFieldDef" },
        },
        constructor: { $ref: "#/$defs/ClassConstructorDef" },
        methods: {
          description: "Class methods and accessors.",
          type: "object",
          additionalProperties: { $ref: "#/$defs/ClassMethodDef" },
        },
      },
    },
  },
  additionalProperties: false,
} as const;
