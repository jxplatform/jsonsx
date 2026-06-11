export const pureTypeDefSchema = {
  description:
    "A reusable JSON Schema type definition for tooling only. " +
    "No function, no runtime artifact. " +
    "Referenced from state entries via $ref. " +
    "Naming convention: PascalCase.",
  not: {
    anyOf: [{ required: ["default"] }, { required: ["$prototype"] }],
  },
  properties: {
    description: { type: "string" },
    enum: { type: "array" },
    examples: { type: "array" },
    items: {},
    maxLength: { minimum: 0, type: "integer" },
    maximum: { type: "number" },
    minLength: { minimum: 0, type: "integer" },
    minimum: { type: "number" },
    pattern: { type: "string" },
    properties: { type: "object" },
    required: { items: { type: "string" }, type: "array" },
    type: { $ref: "#/$defs/JsonSchemaType" },
  },
  required: ["type"],
  type: "object",
} as const;
