export const imageConfigSchema = {
  description: "Image optimization configuration for the project.",
  type: "object",
  properties: {
    optimize: { type: "boolean" },
    widths: { type: "array", items: { type: "number" } },
    formats: { type: "array", items: { type: "string" } },
    quality: {
      type: "object",
      properties: {
        webp: { type: "number" },
        avif: { type: "number" },
        jpeg: { type: "number" },
        png: { type: "number" },
      },
    },
    sizes: { type: "string" },
    lazyLoad: { type: "boolean" },
  },
} as const;
