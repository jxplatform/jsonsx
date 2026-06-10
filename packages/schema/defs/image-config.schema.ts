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
    service: {
      description:
        'How images are optimized: "build" runs Sharp at build time; "cloudflare" emits ' +
        "/cdn-cgi/image transform URLs served by Cloudflare Image Transformations (requires " +
        "the feature to be enabled on the serving zone).",
      type: "string",
      enum: ["build", "cloudflare"],
    },
    remoteDomains: {
      description:
        "Hostnames whose remote (https) images are optimized through /cdn-cgi/image transform " +
        'URLs (cloudflare service only), e.g. ["drive.usercontent.google.com"]. Remote sources ' +
        "from other hosts are left untouched.",
      type: "array",
      items: { type: "string" },
    },
  },
} as const;
