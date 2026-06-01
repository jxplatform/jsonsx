export const stringOrRefSchema = {
  oneOf: [{ type: "string" }, { $ref: "#/$defs/RefObject" }],
} as const;

export const boolOrRefSchema = {
  oneOf: [{ type: "boolean" }, { $ref: "#/$defs/RefObject" }],
} as const;

export const numberOrRefSchema = {
  oneOf: [{ type: "number" }, { $ref: "#/$defs/RefObject" }],
} as const;
