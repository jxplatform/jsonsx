/** Shared project generation logic. Used by both the CLI scaffolder and the Studio server endpoint. */

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { adapterNeedsWrangler, buildWranglerJsonc } from "./scaffold";
import { basename, join, relative, sep } from "node:path";

import { Buffer } from "node:buffer";

import { existsSync } from "node:fs";
import { mediaForTemplate } from "./templates";
import type { TemplateId } from "./templates";

import TEMPLATE_VERSIONS from "./template-versions.json";

const __dirname = import.meta.dirname;
const TEMPLATE_DIR = join(__dirname, "template");
const TEMPLATE_OVERLAYS_DIR = join(__dirname, "templates");

export interface DesignOptions {
  /** Accent / primary brand color (hex). */
  accent?: string;
  /** Page background color (hex). */
  background?: string;
  /** Body text color (hex). */
  text?: string;
  /** Body font stack. */
  bodyFont?: string;
  /** Heading font stack. */
  headingFont?: string;
  /** Replaces project.json $media entirely when provided (name → query/width map). */
  media?: Record<string, string>;
  /** Logo image written to public/<name>. base64 is the raw file content, no data: prefix. */
  logo?: { name: string; base64: string };
}

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
  /**
   * Id of a built-in template variant (from ./templates). Ignored when a non-blank starter is
   * given; undefined means "blank".
   */
  template?: TemplateId;
  /** Design quickstart (colors, fonts, logo, breakpoints) applied on top of the scaffold. */
  design?: DesignOptions;
}

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
  const {
    name,
    description = "",
    url = "",
    adapter = "static",
    starter,
    template = "blank",
    design,
  } = opts;

  if (existsSync(destPath)) {
    const { readdirSync } = await import("node:fs");
    if (readdirSync(destPath).length > 0) {
      throw new Error(`Directory "${destPath}" is not empty`);
    }
  }

  await mkdir(destPath, { recursive: true });

  if (starter && starter !== "blank") {
    await scaffoldFromStarter(destPath, starter, {
      adapter,
      description,
      name,
      url,
      ...(design !== undefined ? { design } : {}),
    });
    return;
  }

  await mkdir(join(destPath, "components"), { recursive: true });
  await mkdir(join(destPath, "public"), { recursive: true });
  await mkdir(join(destPath, "content"), { recursive: true });

  const projectJson = buildProjectJson({ adapter, description, name, template, url });
  if (design) {
    applyDesign(projectJson as unknown as Record<string, unknown>, design, { starter: false });
  }
  const packageJson = buildPackageJson({ adapter, description, name });

  const writes = [
    writeFile(join(destPath, "project.json"), `${JSON.stringify(projectJson, null, "\t")}\n`),
    writeFile(join(destPath, "package.json"), `${JSON.stringify(packageJson, null, "  ")}\n`),
    cp(join(TEMPLATE_DIR, "gitignore"), join(destPath, ".gitignore")),
    cp(join(TEMPLATE_DIR, "layouts"), join(destPath, "layouts"), { recursive: true }),
    cp(join(TEMPLATE_DIR, "pages"), join(destPath, "pages"), { recursive: true }),
  ];

  if (adapterNeedsWrangler(adapter)) {
    const wranglerJsonc = buildWranglerJsonc({ adapter, slug: packageJson.name });
    writes.push(writeFile(join(destPath, "wrangler.jsonc"), wranglerJsonc));
  }

  await Promise.all(writes);

  // The mobile-app variant overlays the shared skeleton with its app-shell layout and home page.
  // Sequenced after the base copies so the overlay files win.
  if (template === "mobile-app") {
    await cp(join(TEMPLATE_OVERLAYS_DIR, "mobile-app"), destPath, {
      force: true,
      recursive: true,
    });
  }

  if (design?.logo) {
    await writeLogo(destPath, design.logo);
  }
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
  opts: {
    name: string;
    description?: string;
    url?: string;
    adapter?: ProjectOptions["adapter"];
    design?: DesignOptions;
  },
) {
  const { name, description = "", url = "", adapter = "static", design } = opts;

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
  if (design) {
    applyDesign(project, design, { starter: true });
  }
  await writeFile(projectPath, `${JSON.stringify(project, null, "\t")}\n`);

  // Rebuild package.json so scaffolded projects get current dep ranges and scripts regardless of
  // What the in-repo starter pinned.
  const packageJson = buildPackageJson({ adapter, description, name });
  await writeFile(join(destPath, "package.json"), `${JSON.stringify(packageJson, null, "  ")}\n`);

  if (adapterNeedsWrangler(adapter)) {
    const wranglerJsonc = buildWranglerJsonc({ adapter, slug: packageJson.name });
    await writeFile(join(destPath, "wrangler.jsonc"), wranglerJsonc);
  }

  if (design?.logo) {
    await writeLogo(destPath, design.logo);
  }
}

/**
 * Apply the design quickstart (colors, fonts, breakpoints) to a project.json object, in place.
 *
 * Blank projects own their style block, so values are written directly. Starters are re-themed
 * best-effort against the conventions the in-repo starters share (`--color-primary`,
 * `--color-text-primary`, `--font-body`, `--font-heading`, top-level `fontFamily` /
 * `backgroundColor`): an override only lands on a token key the starter's style already declares
 * (falling back to the plain CSS property where noted), and is otherwise skipped silently rather
 * than fighting the starter's layered styles. `--color-primary-hover` is intentionally left alone.
 *
 * @param {Record<string, unknown>} project — parsed project.json, mutated in place
 * @param {DesignOptions} design
 * @param {{ starter: boolean }} mode — starter clone vs. blank/template scaffold
 */
function applyDesign(
  project: Record<string, unknown>,
  design: DesignOptions,
  { starter }: { starter: boolean },
) {
  const { accent, background, text, bodyFont, headingFont, media } = design;
  const style = project.style as Record<string, unknown> | undefined;

  if (style) {
    if (accent && (!starter || "--color-primary" in style)) {
      style["--color-primary"] = accent;
    }
    if (text) {
      if (!starter) {
        style.color = text;
      } else if ("--color-text-primary" in style) {
        style["--color-text-primary"] = text;
      } else if ("color" in style) {
        style.color = text;
      }
    }
    if (background && (!starter || "backgroundColor" in style)) {
      style.backgroundColor = background;
    }
    if (bodyFont) {
      if (!starter) {
        style.fontFamily = bodyFont;
      } else if ("--font-body" in style) {
        style["--font-body"] = bodyFont;
      } else if ("fontFamily" in style) {
        style.fontFamily = bodyFont;
      }
    }
    if (headingFont && (!starter || "--font-heading" in style)) {
      style["--font-heading"] = headingFont;
    }
  }

  if (media && Object.keys(media).length > 0) {
    project.$media = media;
  }
}

/** File types accepted for the quickstart logo. */
const LOGO_EXTENSION = /\.(svg|png|jpe?g|webp|gif|ico)$/i;

/**
 * Write the design-quickstart logo into the project's public/ directory. The provided name is
 * flattened to its basename (no path segments can escape public/) and must carry an image extension
 * — this is the only guard between UI input and the filesystem.
 *
 * @param {string} destPath — absolute path to the project directory
 * @param {{ name: string; base64: string }} logo
 */
async function writeLogo(destPath: string, logo: { name: string; base64: string }) {
  const fileName = basename(logo.name);
  if (!LOGO_EXTENSION.test(fileName)) {
    throw new Error(
      `Logo file type not allowed: "${logo.name}" (expected .svg, .png, .jpg, .jpeg, .webp, .gif, or .ico)`,
    );
  }
  const publicDir = join(destPath, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, fileName), Buffer.from(logo.base64, "base64"));
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

/** @param {ProjectOptions} opts */
function buildProjectJson({ name, description, url, adapter, template = "blank" }: ProjectOptions) {
  // Mobile-app shells draw under device notches/home bars; viewport-fit=cover makes the safe-area
  // Insets used by the app-shell layout take effect.
  const viewport =
    template === "mobile-app"
      ? "width=device-width, initial-scale=1, viewport-fit=cover"
      : "width=device-width, initial-scale=1";

  const $head = [
    {
      attributes: { content: viewport, name: "viewport" },
      tagName: "meta",
    },
  ];

  if (template === "mobile-app") {
    $head.push({
      attributes: { content: "#ffffff", name: "theme-color" },
      tagName: "meta",
    });
  }

  if (description) {
    $head.push({
      attributes: { content: description, name: "description" },
      tagName: "meta",
    });
  }

  const build: { outDir: string; trailingSlash: string; adapter?: string } = {
    outDir: "./dist",
    trailingSlash: "always",
  };

  if (adapter && adapter !== "static") {
    build.adapter = adapter;
  }

  return {
    // The generated per-project schema binding; written by `jx schema` (specs/extensions.md §5.2).
    $schema: "./project.schema.json",
    $head,
    $media: mediaForTemplate(template),
    build,
    // The scaffolded pages/index.md needs the parser extension's Markdown format; `content` is the
    // Parser-owned section ready for the first collection.
    content: {},
    defaults: {
      lang: "en",
      layout: "./layouts/base.json",
    },
    extensions: ["@jxsuite/parser"],
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

  // Projects own their extension dependencies (specs/extensions.md §3) — the parser extension is
  // A runtime dependency, resolved project-first by every host.
  //
  // The ranges come from ./template-versions.json, which is GENERATED and CI-verified
  // (`bun run templates:check`) and rewritten by release-please inside the release commit itself
  // (release-please-config.json extra-files). Hardcoding them here is what left every scaffolded
  // Project asking for a compiler version that was never published. Never hand-edit the
  // Map; `bun run templates:sync` is the fixer.
  const dependencies: Record<string, string> = {
    "@jxsuite/parser": TEMPLATE_VERSIONS.parser,
  };
  const devDependencies: Record<string, string> = {
    "@jxsuite/compiler": TEMPLATE_VERSIONS.compiler,
    "@jxsuite/runtime": TEMPLATE_VERSIONS.runtime,
    // The `dev` script spawns @jxsuite/server's dev entry (see jx dev in the compiler CLI)
    "@jxsuite/server": TEMPLATE_VERSIONS.server,
  };

  const scripts: Record<string, string> = {
    build: "jx build",
    dev: "jx dev",
    preview: "jx preview",
  };

  if (adapter && adapter !== "static") {
    // The generated server worker imports hono; wrangler/node/bun resolve it from node_modules
    dependencies["hono"] = "^4";
  }

  if (adapterNeedsWrangler(adapter)) {
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
