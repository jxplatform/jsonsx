export const typedStateDefSchema = {
  description:
    "A typed reactive state variable with explicit type and default value. " +
    "The type property is a JSON Schema or $ref to a $defs type definition. " +
    "The default property is the initial runtime value.",
  type: "object",
  required: ["default"],
  properties: {
    default: { description: "Initial state value." },
    type: {
      description: "JSON Schema type definition, $ref to a $defs type, or JSON Schema type string.",
      oneOf: [{ type: "string" }, { type: "object" }],
    },
    description: { type: "string" },
    attribute: {
      description: "Linked HTML attribute name for CEM extraction.",
      type: "string",
    },
    reflects: {
      description: "Whether property changes reflect back to the HTML attribute.",
      type: "boolean",
    },
    deprecated: {
      description: "Deprecation notice for CEM extraction.",
      oneOf: [{ type: "boolean" }, { type: "string" }],
    },
    examples: { type: "array" },
    $ref: { description: "Reference to a shared type definition.", type: "string" },
  },
  not: { required: ["$prototype"] },
} as const;
