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
  description: "A class method or accessor definition.",
  type: "object",
  properties: {
    role: { type: "string", enum: ["method", "accessor"] },
    $prototype: { type: "string", const: "Function" },
    access: { type: "string", enum: ["public", "private", "protected"] },
    scope: { type: "string", enum: ["instance", "static"] },
    identifier: { type: "string" },
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
