export const arrayNamespaceSchema = {
  description: "Dynamic mapped list. Re-renders when the items state entry changes.",
  type: "object",
  required: ["$prototype", "items", "map"],
  properties: {
    $prototype: { type: "string", const: "Array" },
    items: {
      oneOf: [{ $ref: "#/$defs/RefObject" }, { type: "array" }],
    },
    map: { $ref: "#/$defs/ElementDef" },
    filter: { $ref: "#/$defs/RefObject" },
    sort: { $ref: "#/$defs/RefObject" },
  },
  additionalProperties: false,
} as const;

export const childrenValueSchema = {
  description: "Static array of child definitions, or an Array namespace for dynamic lists.",
  oneOf: [
    {
      type: "array",
      items: {
        oneOf: [{ $ref: "#/$defs/ElementDef" }, { type: "string" }, { type: "number" }],
      },
    },
    { $ref: "#/$defs/ArrayNamespace" },
  ],
} as const;
