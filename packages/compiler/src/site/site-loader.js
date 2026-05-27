/**
 * Site-loader.js — Load and validate project.json configuration
 *
 * Parses the project root's project.json file and provides normalized configuration with sensible
 * defaults for all project-level properties.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Default project configuration. All properties are optional in project.json; these defaults fill
 * in anything the author omits.
 */
const DEFAULTS = {
  name: "Jx Site",
  url: "",
  defaults: {
    layout: null,
    lang: "en",
    charset: "utf-8",
  },
  $head: [],
  imports: {},
  $media: {},
  style: {},
  state: {},
  contentTypes: {},
  redirects: {},
  images: {
    optimize: true,
    widths: [320, 640, 960, 1280, 1920],
    formats: ["webp", "avif"],
    quality: { webp: 80, avif: 65, jpeg: 80, png: 80 },
    sizes: "(max-width: 768px) 100vw, 50vw",
    lazyLoad: true,
  },
  build: {
    outDir: "./dist",
    format: "directory",
    trailingSlash: "always",
    provider: null,
  },
};

/**
 * Load and validate project.json from a project root.
 *
 * @param {string} projectRoot - Absolute path to the project directory
 * @returns {{ config: Record<string, any>; configPath: string; projectRoot: string }}
 * @throws {Error} If project.json is missing or invalid JSON
 */
export function loadProjectConfig(projectRoot) {
  const configPath = resolve(projectRoot, "project.json");

  if (!existsSync(configPath)) {
    throw new Error(`project.json not found in ${projectRoot}`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    const err = /** @type {Error} */ (e);
    throw new Error(`Invalid JSON in ${configPath}: ${err.message}`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`project.json must be a JSON object, got ${typeof raw}`);
  }

  // Deep merge with defaults
  const config = {
    ...DEFAULTS,
    ...raw,
    defaults: { ...DEFAULTS.defaults, ...raw.defaults },
    images: { ...DEFAULTS.images, ...raw.images },
    build: { ...DEFAULTS.build, ...raw.build },
  };

  // Preserve arrays and objects that shouldn't be shallow-merged
  if (raw.$head) config.$head = raw.$head;
  if (raw.$media) config.$media = raw.$media;
  if (raw.style) config.style = raw.style;
  if (raw.state) config.state = raw.state;
  if (raw.redirects) config.redirects = raw.redirects;
  if (raw.imports) config.imports = raw.imports;
  if (raw.contentTypes) config.contentTypes = raw.contentTypes;

  // Validate adapter
  const VALID_ADAPTERS = ["cloudflare-workers", "cloudflare-pages", "node", "bun"];
  if (config.build.adapter && !VALID_ADAPTERS.includes(config.build.adapter)) {
    throw new Error(
      `Unknown build adapter "${config.build.adapter}" in project.json. ` +
        `Valid adapters: ${VALID_ADAPTERS.join(", ")}`,
    );
  }

  return {
    config,
    configPath,
    projectRoot: resolve(projectRoot),
  };
}
