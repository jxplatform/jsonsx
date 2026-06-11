export const contentTypeDefSchema = {
  description:
    "Content type definition. Defines the source directory, frontmatter schema, and element dependencies.",
  properties: {
    $elements: {
      description: "Custom elements available in markdown directives for this content type.",
      items: {
        oneOf: [
          {
            properties: { $ref: { type: "string" } },
            required: ["$ref"],
            type: "object",
          },
          { type: "string" },
        ],
      },
      type: "array",
    },
    format: {
      description:
        "Import name of a format class declared in the project imports map " +
        '(e.g. "Markdown", "Csv"). When omitted, the format is derived from the ' +
        'source file extension via the format registry. "json" is the only built-in.',
      type: "string",
    },
    schema: {
      description: "JSON Schema for validating frontmatter of content type entries.",
      type: "object",
    },
    source: {
      description: "Path to the content directory relative to the project root.",
      examples: ["./content/blog/", "./content/docs/"],
      type: "string",
    },
  },
  type: "object",
} as const;
