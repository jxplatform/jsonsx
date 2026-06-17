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
  description:
    "Array of child definitions — elements, text, or Array namespaces (dynamic lists) mixed " +
    "freely. A bare Array namespace (the whole children slot is one dynamic list) is also " +
    "accepted for backward compatibility.",
  oneOf: [
    {
      items: {
        oneOf: [
          { $ref: "#/$defs/ElementDef" },
          { $ref: "#/$defs/ArrayNamespace" },
          { type: "string" },
          { type: "number" },
        ],
      },
      type: "array",
    },
    { $ref: "#/$defs/ArrayNamespace" },
  ],
} as const;
