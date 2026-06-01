export const headEntrySchema = {
  description: "A page-level <head> entry. Defines meta tags, link tags, script tags, etc.",
  type: "object",
  required: ["tagName"],
  properties: {
    tagName: { type: "string" },
    attributes: {
      type: "object",
      additionalProperties: {
        oneOf: [{ type: "string" }, { type: "boolean" }],
      },
    },
    textContent: { type: "string" },
    children: { type: "array", items: { $ref: "#/$defs/HeadEntry" } },
  },
  additionalProperties: true,
} as const;
