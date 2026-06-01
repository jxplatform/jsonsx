export const pureTypeDefSchema = {
  description:
    "A reusable JSON Schema type definition for tooling only. " +
    "No function, no runtime artifact. " +
    "Referenced from state entries via $ref. " +
    "Naming convention: PascalCase.",
  type: "object",
  required: ["type"],
  properties: {
    type: { $ref: "#/$defs/JsonSchemaType" },
    description: { type: "string" },
    enum: { type: "array" },
    minimum: { type: "number" },
    maximum: { type: "number" },
    minLength: { type: "integer", minimum: 0 },
    maxLength: { type: "integer", minimum: 0 },
    pattern: { type: "string" },
    items: {},
    properties: { type: "object" },
    required: { type: "array", items: { type: "string" } },
    examples: { type: "array" },
  },
  not: {
    anyOf: [{ required: ["default"] }, { required: ["$prototype"] }],
  },
} as const;
