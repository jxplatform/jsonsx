export const imageConfigSchema = {
  description: "Image optimization configuration for the project.",
  properties: {
    formats: { items: { type: "string" }, type: "array" },
    lazyLoad: { type: "boolean" },
    optimize: { type: "boolean" },
    quality: {
      properties: {
        avif: { type: "number" },
        jpeg: { type: "number" },
        png: { type: "number" },
        webp: { type: "number" },
      },
      type: "object",
    },
    remoteDomains: {
      description:
        "Hostnames whose remote (https) images are optimized through /cdn-cgi/image transform " +
        'URLs (cloudflare service only), e.g. ["drive.usercontent.google.com"]. Remote sources ' +
        "from other hosts are left untouched.",
      items: { type: "string" },
      type: "array",
    },
    service: {
      description:
        'How images are optimized: "build" runs Sharp at build time; "cloudflare" emits ' +
        "/cdn-cgi/image transform URLs served by Cloudflare Image Transformations (requires " +
        "the feature to be enabled on the serving zone).",
      enum: ["build", "cloudflare"],
      type: "string",
    },
    sizes: { type: "string" },
    widths: { items: { type: "number" }, type: "array" },
  },
  type: "object",
} as const;
