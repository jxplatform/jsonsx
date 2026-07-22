export const projectConfigSchema = {
  description:
    "Schema for Jx project.json files. " +
    "A project.json file is the root anchor file for a Jx project, " +
    "declaring site metadata, default settings, global styles, extensions, " +
    "and build configuration. Open by design: extension-contributed sections " +
    "(e.g. `content`) are opaque top-level keys; the generated per-project " +
    "entry document (project.schema.json) closes the composition.",
  properties: {
    $defs: {
      description: "Global type definitions available to all pages.",
      type: "object",
    },
    $elements: {
      description:
        "Global custom element dependencies available to all pages. " +
        "Items are $ref objects or npm package specifier strings.",
      items: {
        oneOf: [
          {
            additionalProperties: false,
            properties: { $ref: { type: "string" } },
            required: ["$ref"],
            type: "object",
          },
          { type: "string" },
        ],
      },
      type: "array",
    },
    $head: {
      description:
        "Global <head> entries applied to all pages. " +
        "Array of element definitions for meta tags, link tags, script tags, etc.",
      examples: [
        [
          { attributes: { href: "/favicon.svg", rel: "icon" }, tagName: "link" },
          { attributes: { content: "Jx", name: "generator" }, tagName: "meta" },
        ],
      ],
      items: {
        properties: {
          attributes: {
            additionalProperties: { type: "string" },
            type: "object",
          },
          tagName: { type: "string" },
        },
        type: "object",
      },
      type: "array",
    },
    $media: {
      additionalProperties: { type: "string" },
      description:
        "Named media breakpoints following CSS @custom-media convention. " +
        "Available in all component style objects. Declaring a pure color-scheme " +
        'query (e.g. "--dark": "(prefers-color-scheme: dark)") additionally opts the ' +
        "site into the forced-scheme contract: @--dark style blocks are dual-emitted " +
        "so a data-color-scheme attribute on <html> overrides the OS preference, " +
        "color-scheme is declared on :root, and a pre-paint script restores the " +
        "visitor's persisted choice (spec §9.5).",
      examples: [
        {
          "--dark": "(prefers-color-scheme: dark)",
          "--lg": "(min-width: 1024px)",
          "--md": "(min-width: 768px)",
          "--sm": "(min-width: 640px)",
        },
      ],
      type: "object",
    },
    $schema: {
      description:
        "Relative path to the generated per-project schema (conventionally " +
        "./project.schema.json, written by `jx schema`).",
      type: "string",
    },
    build: {
      description: "Build configuration.",
      properties: {
        adapter: {
          description: "Platform adapter for deployment-specific output.",
          enum: ["static", "cloudflare-pages", "cloudflare-workers", "node", "bun"],
          type: "string",
        },
        deploy: {
          additionalProperties: false,
          description:
            "Deployment tracking: the hosting project this repo publishes to. Identifiers " +
            "only (no secrets) — safe to commit; Studio uses it to tell whether the publish " +
            "workflow already exists. `adapter` says how the build is packaged; `deploy` says " +
            "where it ships.",
          properties: {
            accountId: {
              description: "Hosting account id (e.g. the Cloudflare account id).",
              type: "string",
            },
            productionUrl: {
              description: "Production URL of the connected hosting project.",
              type: "string",
            },
            projectName: {
              description: "Hosting project name (e.g. the Cloudflare Pages project).",
              pattern: "^[a-z0-9][a-z0-9-]*$",
              type: "string",
            },
            provider: {
              description: "Hosting provider the project is connected to.",
              enum: ["cloudflare-pages"],
              type: "string",
            },
          },
          required: ["provider", "accountId", "projectName"],
          type: "object",
        },
        format: {
          default: "directory",
          description:
            "Reserved; currently unused. Accepted for forward compatibility with single-file output (desktop single-file mode) — the build emits per-route directories regardless.",
          enum: ["directory", "single"],
          type: "string",
        },
        outDir: {
          default: "./dist",
          description: "Output directory for compiled site.",
          type: "string",
        },
        sitemap: {
          default: true,
          description:
            "Generate sitemap.xml from the route table (requires `url`). Set false to disable.",
          type: "boolean",
        },
        trailingSlash: {
          default: "always",
          description: "Trailing slash behavior for generated URLs.",
          enum: ["always", "never", "ignore"],
          type: "string",
        },
      },
      type: "object",
    },
    copy: {
      additionalProperties: { type: "string" },
      description:
        "Declarative file copy map. Keys are source paths (relative to project root), values are destination paths (relative to outDir).",
      type: "object",
    },
    defaults: {
      description: "Default settings applied to all pages unless overridden.",
      properties: {
        charset: {
          default: "utf8",
          description: "Default charset for the page.",
          type: "string",
        },
        lang: {
          default: "en",
          description: "Default lang attribute for the <html> element.",
          type: "string",
        },
        layout: {
          default: null,
          description:
            "Default layout file path applied to all pages. " +
            "Set to null to render pages without a layout.",
          examples: ["./layouts/base.json"],
          oneOf: [{ type: "string" }, { type: "null" }],
        },
      },
      type: "object",
    },
    extensions: {
      description:
        "Extension packages: bare package names (resolved project-first through the package " +
        "exports map) or relative paths. Each must export jx-extension.json.",
      examples: [["@jxsuite/parser"]],
      items: { type: "string" },
      type: "array",
    },
    i18n: {
      description: "Internationalization configuration.",
      properties: {
        defaultLocale: {
          description: "Default locale code.",
          examples: ["en"],
          type: "string",
        },
        locales: {
          description: "Available locale codes.",
          examples: [["en", "fr", "de"]],
          items: { type: "string" },
          type: "array",
        },
        routing: {
          description: "Locale routing strategy.",
          enum: ["prefix-except-default", "prefix-always"],
          type: "string",
        },
      },
      type: "object",
    },
    images: { $ref: "#/$defs/ImageConfig" },
    imports: {
      additionalProperties: { type: "string" },
      description:
        "Global import map: $prototype names to .class.json file paths. " +
        "Makes external classes available by name in all pages.",
      examples: [
        {
          Markdown: "@jxsuite/parser/Markdown.class.json",
          MarkdownCollection: "@jxsuite/parser/MarkdownCollection.class.json",
        },
      ],
      type: "object",
    },
    name: {
      default: "Jx Site",
      description: "Human-readable project name.",
      examples: ["My Portfolio", "Jx Example Site"],
      type: "string",
    },
    redirects: {
      additionalProperties: { type: "string" },
      description: "Static redirect rules. Maps source paths to destination paths.",
      examples: [{ "/old-about": "/about" }],
      type: "object",
    },
    state: {
      description: "Site-wide reactive state available to all pages.",
      type: "object",
    },
    style: {
      additionalProperties: {
        oneOf: [{ type: "string" }, { type: "number" }, { $ref: "#/$defs/StyleObject" }],
      },
      description:
        "Global CSS styles applied to the <body> element. " +
        "Uses the same camelCase CSSOM convention and recursive selector/at-rule " +
        "nesting as component styles.",
      type: "object",
    },
    url: {
      description: "Production URL of the deployed site.",
      examples: ["https://example.com", "https://jxsuite.com"],
      type: "string",
    },
  },
  type: "object",
} as const;
