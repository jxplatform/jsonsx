/** Shared project generation logic. Used by both the CLI scaffolder and the Studio server endpoint. */

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { existsSync } from "node:fs";

const __dirname = import.meta.dirname;
const TEMPLATE_DIR = join(__dirname, "template");

export interface ProjectOptions {
  name: string;
  description?: string;
  url?: string;
  adapter?: "static" | "cloudflare-pages" | "cloudflare-workers" | "node" | "bun";
  /**
   * Id of a starter template to clone (from @jxsuite/starters), or "blank"/undefined for the
   * built-in minimal template.
   */
  starter?: string;
}

const CF_ADAPTERS = new Set(["cloudflare-pages", "cloudflare-workers"]);

// Paths never copied out of a starter tree into a fresh project: build artifacts and the
// Authoring-only Pexels fetch manifest.
const STARTER_EXCLUDE = new Set([
  "node_modules",
  "dist",
  ".cache",
  ".jx-cache",
  ".git",
  "images.json",
]);

/**
 * Generate a new Jx project at the given path.
 *
 * @param {string} destPath — absolute path to the project directory
 * @param {ProjectOptions} opts
 */
export async function generateProject(destPath: string, opts: ProjectOptions) {
  const { name, description = "", url = "", adapter = "static", starter } = opts;

  if (existsSync(destPath)) {
    const { readdirSync } = await import("node:fs");
    if (readdirSync(destPath).length > 0) {
      throw new Error(`Directory "${destPath}" is not empty`);
    }
  }

  await mkdir(destPath, { recursive: true });

  if (starter && starter !== "blank") {
    await scaffoldFromStarter(destPath, starter, { adapter, description, name, url });
    return;
  }

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
 * Clone a starter template from @jxsuite/starters, then re-stamp the files that carry the new
 * project's identity: project.json (name/url/description/adapter) and a freshly-built package.json
 * (current dependency ranges, user's name). Content, components, layouts, and public assets are
 * copied verbatim.
 *
 * @param {string} destPath
 * @param {string} starter
 * @param {Required<Pick<ProjectOptions, "name">> &
 *   Pick<ProjectOptions, "description" | "url" | "adapter">} opts
 */
async function scaffoldFromStarter(
  destPath: string,
  starter: string,
  opts: { name: string; description?: string; url?: string; adapter?: ProjectOptions["adapter"] },
) {
  const { name, description = "", url = "", adapter = "static" } = opts;

  // Resolved lazily so blank projects never load the (large) starters package.
  const { getStarterDir } = await import("@jxsuite/starters");
  const srcDir = getStarterDir(starter);

  await cp(srcDir, destPath, {
    recursive: true,
    filter: (src) => {
      const rel = relative(srcDir, src);
      return rel === "" || !rel.split(sep).some((seg) => STARTER_EXCLUDE.has(seg));
    },
  });

  // Re-stamp project.json with the new project's identity, keeping the starter's design tokens,
  // Content types, image pipeline, and head.
  const projectPath = join(destPath, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
  project.name = name;
  if (url) {
    project.url = url;
  }
  applyDescription(project, description);
  if (adapter && adapter !== "static") {
    const build = (project.build as Record<string, unknown> | undefined) ?? {};
    build.adapter = adapter;
    project.build = build;
  }
  await writeFile(projectPath, `${JSON.stringify(project, null, "\t")}\n`);

  // Rebuild package.json so scaffolded projects get current dep ranges and scripts regardless of
  // What the in-repo starter pinned.
  const packageJson = buildPackageJson({ adapter, description, name });
  await writeFile(join(destPath, "package.json"), `${JSON.stringify(packageJson, null, "  ")}\n`);

  if (adapter && CF_ADAPTERS.has(adapter)) {
    const wranglerJsonc = buildWranglerJsonc({ adapter, slug: packageJson.name });
    await writeFile(join(destPath, "wrangler.jsonc"), wranglerJsonc);
  }
}

/**
 * Set the `<meta name="description">` content in a project's `$head` (or leave it untouched when
 * the starter has no such tag or no description was supplied).
 *
 * @param {Record<string, unknown>} project
 * @param {string} description
 */
function applyDescription(project: Record<string, unknown>, description: string) {
  if (!description || !Array.isArray(project.$head)) {
    return;
  }
  for (const tag of project.$head as { tagName?: string; attributes?: Record<string, unknown> }[]) {
    if (tag.tagName === "meta" && tag.attributes?.name === "description") {
      tag.attributes.content = description;
    }
  }
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
