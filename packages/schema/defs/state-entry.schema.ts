export const stateEntrySchema = {
  description:
    "A single state entry. Shape is determined by value type: " +
    "scalar/array → naked reactive property, string with ${} → computed, " +
    'object with $prototype: "Function" → function, ' +
    "object with $prototype: <other> → data source, " +
    "object with type and default → typed reactive property, " +
    "plain object → naked object reactive property.",
  oneOf: [
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "string" },
    { type: "array" },
    { $ref: "#/$defs/TypedStateDef" },
    { $ref: "#/$defs/FunctionDef" },
    { $ref: "#/$defs/ExternalClassDef" },
    { $ref: "#/$defs/ExpressionEntry" },
    {
      type: "object",
      not: {
        anyOf: [
          { required: ["$prototype"] },
          { required: ["default"] },
          { required: ["type"] },
          { required: ["$expression"] },
        ],
      },
    },
  ],
} as const;

export const stateMapSchema = {
  description:
    "Map of runtime variables. Keys are camelCase (public) or #-prefixed (private). " +
    "All entries are reactive by default.",
  type: "object",
  additionalProperties: { $ref: "#/$defs/StateEntry" },
} as const;

export const defsMapSchema = {
  description:
    "Map of reusable JSON Schema type definitions. " +
    "Keys are PascalCase type names. No runtime artifacts are produced.",
  type: "object",
  additionalProperties: { $ref: "#/$defs/TypeDefEntry" },
} as const;

export const typeDefEntrySchema = {
  description:
    "A $defs type definition entry. Must be a pure JSON Schema type " +
    "definition or a class definition (.class.json format).",
  oneOf: [{ $ref: "#/$defs/PureTypeDef" }, { $ref: "#/$defs/ClassDef" }],
} as const;
