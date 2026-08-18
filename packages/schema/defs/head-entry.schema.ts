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
    textContent: {
      description:
        "Element content. An object is serialized to JSON inside the tag — that is how a " +
        'JSON-LD block (`<script type="application/ld+json">`) is authored.',
      oneOf: [{ type: "string" }, { type: "object" }],
    },
  },
  required: ["tagName"],
  type: "object",
} as const;
