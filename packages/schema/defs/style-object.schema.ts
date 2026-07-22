export const styleObjectSchema = {
  additionalProperties: {
    oneOf: [{ type: "string" }, { type: "number" }, { $ref: "#/$defs/StyleObject" }],
  },
  description:
    "CSS style definition. camelCase property names follow CSSOM convention. " +
    "Keys starting with :, ., &, or [ are treated as nested CSS selectors. " +
    "Keys matching $media breakpoint names (or other @-prefixed at-rules) group nested rules. " +
    "Nesting is recursive: selector and at-rule groups may nest to arbitrary depth " +
    "(e.g. breakpoint → selector → pseudo-class), mirroring the compiler's recursive emission.",
  properties: {},
  type: "object",
} as const;
