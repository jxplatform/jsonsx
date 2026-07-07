/**
 * Site-loader.js — Load and validate project.json configuration
 *
 * Parses the project root's project.json file and provides normalized configuration with sensible
 * defaults for all project-level properties.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ImageConfig, ProjectConfig } from "@jxsuite/schema/types";
import { errorMessage, parseProjectConfig } from "@jxsuite/schema/parse";
import { resolve } from "node:path";

/**
 * Default project configuration. All properties are optional in project.json; these defaults fill
 * in anything the author omits.
 */
/** A project config after merging with DEFAULTS — the option groups are always present. */
export interface ResolvedProjectConfig extends ProjectConfig {
  name: string;
  url: string;
  defaults: NonNullable<ProjectConfig["defaults"]>;
  images: ImageConfig & { service: "build" | "cloudflare" };
  build: {
    adapter?: string;
    outDir: string;
    format: string;
    trailingSlash: string;
    provider?: string | null;
    [key: string]: unknown;
  };
}

const DEFAULTS = {
  $head: [],
  $media: {},
  build: {
    format: "directory",
    outDir: "./dist",
    provider: null,
    trailingSlash: "always",
  },
  contentTypes: {},
  defaults: {
    charset: "utf8",
    lang: "en",
    layout: null,
  },
  images: {
    formats: ["webp", "avif"],
    lazyLoad: true,
    optimize: true,
    quality: { avif: 65, jpeg: 80, png: 80, webp: 80 },
    service: "build",
    sizes: "(max-width: 768px) 100vw, 50vw",
    widths: [320, 640, 960, 1280, 1920],
  },
  imports: {},
  name: "Jx Site",
  redirects: {},
  state: {},
  style: {},
  url: "",
} satisfies Partial<ResolvedProjectConfig>;

/**
 * Load and validate project.json from a project root.
 *
 * @param {string} projectRoot - Absolute path to the project directory
 * @returns {{ config: ProjectConfig; configPath: string; projectRoot: string }}
 * @throws {Error} If project.json is missing or invalid JSON
 */
export function loadProjectConfig(projectRoot: string) {
  const configPath = resolve(projectRoot, "project.json");

  if (!existsSync(configPath)) {
    throw new Error(`project.json not found in ${projectRoot}`);
  }

  let raw: ProjectConfig;
  try {
    raw = parseProjectConfig(readFileSync(configPath, "utf8"), configPath);
  } catch (error) {
    throw new Error(`Invalid project.json: ${errorMessage(error)}`, { cause: error });
  }

  // Deep merge with defaults
  const config: ResolvedProjectConfig = {
    ...DEFAULTS,
    ...raw,
    build: { ...DEFAULTS.build, ...raw.build },
    defaults: { ...DEFAULTS.defaults, ...raw.defaults },
    images: { ...DEFAULTS.images, ...raw.images },
  };

  // Preserve arrays and objects that shouldn't be shallow-merged
  if (raw.$head) {
    config.$head = raw.$head;
  }
  if (raw.$media) {
    config.$media = raw.$media;
  }
  if (raw.style) {
    config.style = raw.style;
  }
  if (raw.state) {
    config.state = raw.state;
  }
  if (raw.redirects) {
    config.redirects = raw.redirects;
  }
  if (raw.imports) {
    config.imports = raw.imports;
  }
  if (raw.contentTypes) {
    config.contentTypes = raw.contentTypes;
  }

  // Validate adapter
  const VALID_ADAPTERS = ["cloudflare-workers", "cloudflare-pages", "node", "bun"];
  // "static" is the Settings UI's explicit no-adapter choice; normalize it away.
  if (config.build.adapter === "static") {
    delete config.build.adapter;
  }
  if (config.build.adapter && !VALID_ADAPTERS.includes(config.build.adapter)) {
    throw new Error(
      `Unknown build adapter "${config.build.adapter}" in project.json. ` +
        `Valid adapters: ${VALID_ADAPTERS.join(", ")}`,
    );
  }

  // Validate image service. The "cloudflare" service emits /cdn-cgi/image transform URLs,
  // Which work on any zone served through Cloudflare regardless of the build adapter.
  const VALID_IMAGE_SERVICES = ["build", "cloudflare"];
  if (!VALID_IMAGE_SERVICES.includes(config.images.service)) {
    throw new Error(
      `Unknown images.service "${config.images.service}" in project.json. ` +
        `Valid services: ${VALID_IMAGE_SERVICES.join(", ")}`,
    );
  }

  return {
    config,
    configPath,
    projectRoot: resolve(projectRoot),
  };
}
