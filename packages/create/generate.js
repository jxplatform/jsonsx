/** Shared project generation logic. Used by both the CLI scaffolder and the Studio server endpoint. */

import { mkdir, writeFile, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "template");

/**
 * @typedef {{
 *   name: string;
 *   description?: string;
 *   url?: string;
 *   adapter?: "static" | "cloudflare-pages" | "node" | "bun";
 * }} ProjectOptions
 */

/**
 * Generate a new Jx project at the given path.
 *
 * @param {string} destPath — absolute path to the project directory
 * @param {ProjectOptions} opts
 */
export async function generateProject(destPath, opts) {
  const { name, description = "", url = "", adapter = "static" } = opts;

  if (existsSync(destPath)) {
    const { readdirSync } = await import("node:fs");
    if (readdirSync(destPath).length > 0) {
      throw new Error(`Directory "${destPath}" is not empty`);
    }
  }

  await mkdir(destPath, { recursive: true });
  await mkdir(join(destPath, "components"), { recursive: true });
  await mkdir(join(destPath, "public"), { recursive: true });
  await mkdir(join(destPath, "content"), { recursive: true });

  const projectJson = buildProjectJson({ name, description, url, adapter });
  const packageJson = buildPackageJson({ name, description, adapter });

  await Promise.all([
    writeFile(join(destPath, "project.json"), JSON.stringify(projectJson, null, "\t") + "\n"),
    writeFile(join(destPath, "package.json"), JSON.stringify(packageJson, null, "  ") + "\n"),
    cp(join(TEMPLATE_DIR, "gitignore"), join(destPath, ".gitignore")),
    cp(join(TEMPLATE_DIR, "layouts"), join(destPath, "layouts"), { recursive: true }),
    cp(join(TEMPLATE_DIR, "pages"), join(destPath, "pages"), { recursive: true }),
  ]);
}

/** @param {ProjectOptions} opts */
function buildProjectJson({ name, description, url, adapter }) {
  const $head = [
    {
      tagName: "meta",
      attributes: { name: "viewport", content: "width=device-width, initial-scale=1" },
    },
  ];

  if (description) {
    $head.push({
      tagName: "meta",
      attributes: { name: "description", content: description },
    });
  }

  /** @type {{ outDir: string; format: string; trailingSlash: string; adapter?: string }} */
  const build = {
    outDir: "./dist",
    format: "directory",
    trailingSlash: "always",
  };

  if (adapter && adapter !== "static") {
    build.adapter = adapter;
  }

  return {
    name,
    url: url || "https://example.com",
    defaults: {
      layout: "./layouts/base.json",
      lang: "en",
    },
    $head,
    $media: {
      "--": "1280px",
      "--lg": "(max-width: 1024px)",
      "--md": "(max-width: 768px)",
      "--sm": "(max-width: 640px)",
    },
    style: {
      margin: "0",
      padding: "0",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      lineHeight: "1.6",
      color: "#1a1a1a",
    },
    build,
  };
}

/** @param {{ name: string; description?: string; adapter?: string }} opts */
function buildPackageJson({ name, description, adapter }) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  /** @type {Record<string, string>} */
  const devDependencies = {
    "@jxsuite/compiler": "^0.19.0",
    "@jxsuite/runtime": "^0.19.0",
  };

  if (adapter === "cloudflare-pages") {
    devDependencies["wrangler"] = "^4";
  }

  return {
    name: slug,
    private: true,
    description: description || "",
    license: "MIT",
    scripts: {
      build: "jx build",
      dev: "jx dev",
    },
    devDependencies,
  };
}
