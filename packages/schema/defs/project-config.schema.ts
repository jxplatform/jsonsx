export const projectConfigSchema = {
  description:
    "Schema for Jx project.json files. " +
    "A project.json file is the root anchor file for a Jx project, " +
    "declaring site metadata, default settings, global styles, content types, " +
    "and build configuration.",
  type: "object",
  properties: {
    name: {
      description: "Human-readable project name.",
      type: "string",
      default: "Jx Site",
      examples: ["My Portfolio", "Jx Example Site"],
    },
    url: {
      description: "Production URL of the deployed site.",
      type: "string",
      examples: ["https://example.com", "https://jxsuite.com"],
    },
    defaults: {
      description: "Default settings applied to all pages unless overridden.",
      type: "object",
      properties: {
        layout: {
          description:
            "Default layout file path applied to all pages. " +
            "Set to null to render pages without a layout.",
          oneOf: [{ type: "string" }, { type: "null" }],
          default: null,
          examples: ["./layouts/base.json"],
        },
        lang: {
          description: "Default lang attribute for the <html> element.",
          type: "string",
          default: "en",
        },
        charset: {
          description: "Default charset for the page.",
          type: "string",
          default: "utf-8",
        },
      },
    },
    $head: {
      description:
        "Global <head> entries applied to all pages. " +
        "Array of element definitions for meta tags, link tags, script tags, etc.",
      type: "array",
      items: {
        type: "object",
        properties: {
          tagName: { type: "string" },
          attributes: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
      examples: [
        [
          { tagName: "link", attributes: { rel: "icon", href: "/favicon.svg" } },
          { tagName: "meta", attributes: { name: "generator", content: "Jx" } },
        ],
      ],
    },
    $elements: {
      description:
        "Global custom element dependencies available to all pages. " +
        "Items are $ref objects or npm package specifier strings.",
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            required: ["$ref"],
            properties: { $ref: { type: "string" } },
            additionalProperties: false,
          },
          { type: "string" },
        ],
      },
    },
    imports: {
      description:
        "Global import map: $prototype names to .class.json file paths. " +
        "Makes external classes available by name in all pages.",
      type: "object",
      additionalProperties: { type: "string" },
      examples: [
        {
          MarkdownFile: "@jxsuite/parser/MarkdownFile.class.json",
          MarkdownCollection: "@jxsuite/parser/MarkdownCollection.class.json",
        },
      ],
    },
    $media: {
      description:
        "Named media breakpoints following CSS @custom-media convention. " +
        "Available in all component style objects.",
      type: "object",
      additionalProperties: { type: "string" },
      examples: [
        {
          "--sm": "(min-width: 640px)",
          "--md": "(min-width: 768px)",
          "--lg": "(min-width: 1024px)",
        },
      ],
    },
    style: {
      description:
        "Global CSS styles applied to the <body> element. " +
        "Uses the same camelCase CSSOM convention as component styles.",
      type: "object",
      additionalProperties: {
        oneOf: [{ type: "string" }, { type: "number" }, { type: "object" }],
      },
    },
    state: {
      description: "Site-wide reactive state available to all pages.",
      type: "object",
    },
    $defs: {
      description: "Global type definitions available to all pages.",
      type: "object",
    },
    contentTypes: {
      description:
        "Content type definitions. Each key is a content type name; " +
        "the value defines the source directory, frontmatter schema, and element dependencies.",
      type: "object",
      additionalProperties: { $ref: "#/$defs/ContentTypeDef" },
    },
    redirects: {
      description: "Static redirect rules. Maps source paths to destination paths.",
      type: "object",
      additionalProperties: { type: "string" },
      examples: [{ "/old-about": "/about" }],
    },
    copy: {
      description:
        "Declarative file copy map. Keys are source paths (relative to project root), values are destination paths (relative to outDir).",
      type: "object",
      additionalProperties: { type: "string" },
    },
    build: {
      description: "Build configuration.",
      type: "object",
      properties: {
        outDir: {
          description: "Output directory for compiled site.",
          type: "string",
          default: "./dist",
        },
        format: {
          description: "Output format.",
          type: "string",
          enum: ["directory", "single"],
          default: "directory",
        },
        trailingSlash: {
          description: "Trailing slash behavior for generated URLs.",
          type: "string",
          enum: ["always", "never", "ignore"],
          default: "always",
        },
        adapter: {
          description: "Platform adapter for deployment-specific output.",
          type: "string",
          enum: ["netlify", "vercel", "cloudflare"],
        },
      },
    },
    images: { $ref: "#/$defs/ImageConfig" },
    i18n: {
      description: "Internationalization configuration.",
      type: "object",
      properties: {
        defaultLocale: {
          description: "Default locale code.",
          type: "string",
          examples: ["en"],
        },
        locales: {
          description: "Available locale codes.",
          type: "array",
          items: { type: "string" },
          examples: [["en", "fr", "de"]],
        },
        routing: {
          description: "Locale routing strategy.",
          type: "string",
          enum: ["prefix-except-default", "prefix-always"],
        },
      },
    },
  },
  additionalProperties: false,
} as const;
