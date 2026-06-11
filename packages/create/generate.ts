/** Shared project generation logic. Used by both the CLI scaffolder and the Studio server endpoint. */

import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { existsSync } from "node:fs";

const __dirname = import.meta.dirname;
const TEMPLATE_DIR = join(__dirname, "template");

export interface ProjectOptions {
  name: string;
  description?: string;
  url?: string;
  adapter?: "static" | "cloudflare-pages" | "cloudflare-workers" | "node" | "bun";
}

const CF_ADAPTERS = new Set(["cloudflare-pages", "cloudflare-workers"]);

/**
 * Generate a new Jx project at the given path.
 *
 * @param {string} destPath — absolute path to the project directory
 * @param {ProjectOptions} opts
 */
export async function generateProject(destPath: string, opts: ProjectOptions) {
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

  const projectJson = buildProjectJson({ adapter, description, name, url });
  const packageJson = buildPackageJson({ adapter, description, name });

  const writes = [
    writeFile(join(destPath, "project.json"), `${JSON.stringify(projectJson, null, "\t")}\n`),
    writeFile(join(destPath, "package.json"), `${JSON.stringify(packageJson, null, "  ")}\n`),
    cp(join(TEMPLATE_DIR, "gitignore"), join(destPath, ".gitignore")),
    cp(join(TEMPLATE_DIR, "layouts"), join(destPath, "layouts"), { recursive: true }),
    cp(join(TEMPLATE_DIR, "pages"), join(destPath, "pages"), { recursive: true }),
  ];

  if (adapter && CF_ADAPTERS.has(adapter)) {
    const wranglerJsonc = buildWranglerJsonc({ adapter, slug: packageJson.name });
    writes.push(writeFile(join(destPath, "wrangler.jsonc"), wranglerJsonc));
  }

  await Promise.all(writes);
}

/**
 * Build a wrangler.jsonc for Cloudflare adapters.
 *
 * @param {{ slug: string; adapter: string }} opts
 */
function buildWranglerJsonc({ slug, adapter }: { slug: string; adapter: string }) {
  const compatibilityDate = new Date().toISOString().slice(0, 10);

  // Nodejs_compat: server functions routinely pull in Node-flavored npm packages
  const config =
    adapter === "cloudflare-workers"
      ? {
          assets: { binding: "ASSETS", directory: "./dist" },
          compatibility_date: compatibilityDate,
          compatibility_flags: ["nodejs_compat"],
          main: "./dist/worker.js",
          name: slug,
        }
      : {
          compatibility_date: compatibilityDate,
          compatibility_flags: ["nodejs_compat"],
          name: slug,
          pages_build_output_dir: "./dist",
        };

  return `${JSON.stringify(config, null, "\t")}\n`;
}

/** @param {ProjectOptions} opts */
function buildProjectJson({ name, description, url, adapter }: ProjectOptions) {
  const $head = [
    {
      attributes: { content: "width=device-width, initial-scale=1", name: "viewport" },
      tagName: "meta",
    },
  ];

  if (description) {
    $head.push({
      attributes: { content: description, name: "description" },
      tagName: "meta",
    });
  }

  const build: { outDir: string; format: string; trailingSlash: string; adapter?: string } = {
    format: "directory",
    outDir: "./dist",
    trailingSlash: "always",
  };

  if (adapter && adapter !== "static") {
    build.adapter = adapter;
  }

  return {
    $head,
    $media: {
      "--": "1280px",
      "--lg": "(max-width: 1024px)",
      "--md": "(max-width: 768px)",
      "--sm": "(max-width: 640px)",
    },
    build,
    defaults: {
      lang: "en",
      layout: "./layouts/base.json",
    },
    name,
    style: {
      color: "#1a1a1a",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      lineHeight: "1.6",
      margin: "0",
      padding: "0",
    },
    url: url || "https://example.com",
  };
}

/** @param {{ name: string; description?: string; adapter?: string }} opts */
function buildPackageJson({
  name,
  description,
  adapter,
}: {
  name: string;
  description?: string;
  adapter?: string;
}) {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {
    "@jxsuite/compiler": "^0.19.0",
    "@jxsuite/runtime": "^0.19.0",
  };

  const scripts: Record<string, string> = {
    build: "jx build",
    dev: "jx dev",
  };

  if (adapter && adapter !== "static") {
    // The generated server worker imports hono; wrangler/node/bun resolve it from node_modules
    dependencies["hono"] = "^4";
  }

  if (adapter && CF_ADAPTERS.has(adapter)) {
    devDependencies["wrangler"] = "^4";
    scripts.deploy =
      adapter === "cloudflare-workers" ? "wrangler deploy" : "wrangler pages deploy dist";
  }

  return {
    description: description || "",
    devDependencies,
    license: "MIT",
    name: slug,
    private: true,
    scripts,
    ...(Object.keys(dependencies).length > 0 && { dependencies }),
  };
}
