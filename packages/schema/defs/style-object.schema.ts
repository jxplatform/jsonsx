export const styleObjectSchema = {
  description:
    "CSS style definition. camelCase property names follow CSSOM convention. " +
    "Keys starting with :, ., &, or [ are treated as nested CSS selectors. " +
    "Keys matching $media breakpoint names are treated as responsive rules.",
  type: "object",
  properties: {},
  additionalProperties: {
    oneOf: [
      { type: "string" },
      { type: "number" },
      {
        description: "Nested CSS selector or media breakpoint rules.",
        type: "object",
        additionalProperties: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    ],
  },
} as const;
