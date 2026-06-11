export const arrayNamespaceSchema = {
  additionalProperties: false,
  description: "Dynamic mapped list. Re-renders when the items state entry changes.",
  properties: {
    $prototype: { const: "Array", type: "string" },
    filter: { $ref: "#/$defs/RefObject" },
    items: {
      oneOf: [{ $ref: "#/$defs/RefObject" }, { type: "array" }],
    },
    map: { $ref: "#/$defs/ElementDef" },
    sort: { $ref: "#/$defs/RefObject" },
  },
  required: ["$prototype", "items", "map"],
  type: "object",
} as const;

export const childrenValueSchema = {
  description: "Static array of child definitions, or an Array namespace for dynamic lists.",
  oneOf: [
    {
      items: {
        oneOf: [{ $ref: "#/$defs/ElementDef" }, { type: "string" }, { type: "number" }],
      },
      type: "array",
    },
    { $ref: "#/$defs/ArrayNamespace" },
  ],
} as const;
