export const headEntrySchema = {
  additionalProperties: true,
  description: "A page-level <head> entry. Defines meta tags, link tags, script tags, etc.",
  properties: {
    attributes: {
      additionalProperties: {
        oneOf: [{ type: "string" }, { type: "boolean" }],
      },
      type: "object",
    },
    children: { items: { $ref: "#/$defs/HeadEntry" }, type: "array" },
    tagName: { type: "string" },
    textContent: { type: "string" },
  },
  required: ["tagName"],
  type: "object",
} as const;
