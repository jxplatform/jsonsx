/**
 * Pages-discovery.js — File-based route discovery
 *
 * Scans the pages/ directory and builds a route table mapping URL paths to their source files,
 * layouts, and metadata. `.json` pages are native; any other extension must be claimed by a format
 * class (with the `parse` capability and a "page" document kind) provided by an enabled extension.
 *
 * Conventions (per site-architecture spec §4): pages/index.json → / pages/about.json → /about
 * pages/about/index.json → /about pages/blog/[slug].json → /blog/:slug (dynamic)
 * pages/docs/[...path].json → /docs/* (catch-all) pages/_component.json → NOT routed (underscore
 * prefix)
 */

import { readFileSync, readdirSync } from "node:fs";
import { parseJxDocument } from "@jxsuite/schema/parse";
import { extname, join, relative, resolve } from "node:path";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";
import type { JxDocument, JxPathsDef, ProjectConfig } from "@jxsuite/schema/types";
import { localeOfRoute } from "./i18n.ts";
import type { ResolvedI18n } from "./i18n.ts";

interface Route {
  urlPattern: string; // URL pattern (e.g. "/blog/:slug")
  sourcePath: string; // Absolute path to the source file
  relativePath: string; // Path relative to pages/ dir
  isDynamic: boolean; // Whether route has parameters
  isCatchAll: boolean; // Whether route uses [...param] spread
  params: string[]; // Parameter names (e.g. ["slug"])
  $layout: string | null; // Layout override from page frontmatter, if any
  _pathParams?: Record<string, string>; // Resolved path parameters
  /**
   * The timestamp of the thing this concrete route was generated FROM, when that is not the
   * template file. A collection route's source is an entry; `sourcePath` still points at the
   * `[slug].json` that rendered it, so without this every post in an archive reports the template's
   * mtime and the whole collection looks edited whenever the template is.
   */
  sourceMtime?: string;
}

/**
 * Read a page document, dispatching by extension: .json natively, anything else via the format
 * registry's parse capability.
 *
 * @param {string} filePath - Absolute path to the page source
 * @param {FormatRegistry} [registry]
 * @returns {Promise<JxDocument>}
 */
export async function readPageDocument(
  filePath: string,
  registry?: FormatRegistry,
): Promise<JxDocument> {
  const source = readFileSync(filePath, "utf8");
  if (filePath.endsWith(".json")) {
    return parseJxDocument(source, filePath);
  }
  const ext = extname(filePath).toLowerCase();
  const entry = registry?.byExtension(ext, "parse");
  if (!entry) {
    throw new Error(
      `No format class registered for "${ext}" (${filePath}). ` +
        `Enable an extension providing this format in project.json "extensions", ` +
        `e.g. "@jxsuite/parser".`,
    );
  }
  return (await entry.call("parse", source)) as JxDocument;
}

/**
 * The `$translationKey` each route's document declares, for the routes that declare one.
 *
 * A **pre-pass**, because a page's alternates depend on the whole route table (§13.5): the set has
 * to be complete before the first page is compiled, so a document cannot tell the build what its
 * key is while it is being compiled.
 *
 * The file is read and the **parse is skipped** unless the text mentions the key. Most pages of a
 * multilingual site never declare one — their paths are parallel and the derivation is right — so
 * paying a second full parse for every page to find a key that is usually absent would be a cost
 * with nothing behind it. Documents sharing a source (a `$paths` template's expansions) are read
 * once.
 *
 * A document that fails to parse is skipped rather than thrown from here. It will fail again a
 * moment later while being compiled, where the error names the page and the rest of the site still
 * builds; failing in a pre-pass would turn one bad page into no site at all.
 *
 * @param {readonly { sourcePath: string; urlPattern: string }[]} routes - Concrete routes
 * @param {FormatRegistry} [registry]
 * @returns {Promise<Map<string, string>>} Keyed by `urlPattern`
 */
export async function readTranslationKeys(
  routes: readonly { sourcePath: string; urlPattern: string }[],
  registry?: FormatRegistry,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byFile = new Map<string, string | null>();
  for (const route of routes) {
    if (!byFile.has(route.sourcePath)) {
      byFile.set(route.sourcePath, await declaredTranslationKey(route.sourcePath, registry));
    }
    const key = byFile.get(route.sourcePath);
    if (key !== null && key !== undefined) {
      out.set(route.urlPattern, key);
    }
  }
  return out;
}

/**
 * One document's `$translationKey`, or null when it declares none or cannot be read.
 *
 * @param {string} sourcePath
 * @param {FormatRegistry} [registry]
 * @returns {Promise<string | null>}
 */
async function declaredTranslationKey(
  sourcePath: string,
  registry?: FormatRegistry,
): Promise<string | null> {
  if (!readFileSync(sourcePath, "utf8").includes("$translationKey")) {
    return null;
  }
  let doc: JxDocument;
  try {
    doc = await readPageDocument(sourcePath, registry);
  } catch {
    return null;
  }
  return typeof doc.$translationKey === "string" && doc.$translationKey !== ""
    ? doc.$translationKey
    : null;
}

/**
 * Discover all routable pages in a pages/ directory.
 *
 * @param {string} pagesDir - Absolute path to the pages/ directory
 * @param {FormatRegistry} [registry] - Format registry; its "page"-kind extensions are routable
 * @returns {Promise<Route[]>} Sorted route table (static routes first, then dynamic)
 */
export async function discoverPages(pagesDir: string, registry?: FormatRegistry) {
  const routes: Route[] = [];
  const pageExtensions = new Set([".json", ...(registry?.documentExtensions("page") ?? [])]);
  await walkDir(pagesDir, pagesDir, routes, pageExtensions, registry);

  // Sort: static routes first, then by specificity (more segments = more specific)
  routes.sort((a, b) => {
    if (a.isDynamic !== b.isDynamic) {
      return a.isDynamic ? 1 : -1;
    }
    if (a.isCatchAll !== b.isCatchAll) {
      return a.isCatchAll ? 1 : -1;
    }
    return a.urlPattern.localeCompare(b.urlPattern);
  });

  return routes;
}

/**
 * Recursively walk the pages directory tree.
 *
 * @param {string} dir
 * @param {string} pagesRoot
 * @param {Route[]} routes
 * @param {Set<string>} pageExtensions
 * @param {FormatRegistry} [registry]
 */
async function walkDir(
  dir: string,
  pagesRoot: string,
  routes: Route[],
  pageExtensions: Set<string>,
  registry?: FormatRegistry,
) {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip underscore-prefixed directories
      if (entry.name.startsWith("_")) {
        continue;
      }
      await walkDir(fullPath, pagesRoot, routes, pageExtensions, registry);
      continue;
    }

    // Only process .json and registered page-format files
    const ext = extname(entry.name).toLowerCase();
    if (!pageExtensions.has(ext)) {
      continue;
    }

    // Skip underscore-prefixed files (local components, not routes)
    if (entry.name.startsWith("_")) {
      continue;
    }

    const relativePath = relative(pagesRoot, fullPath);
    const route = await fileToRoute(relativePath, fullPath, registry);
    if (route) {
      routes.push(route);
    }
  }
}

/**
 * Convert a file path relative to pages/ into a Route object.
 *
 * @param {string} relativePath - E.g. "blog/[slug].json"
 * @param {string} absolutePath - Full filesystem path
 * @param {FormatRegistry} [registry]
 * @returns {Promise<Route>}
 */
async function fileToRoute(relativePath: string, absolutePath: string, registry?: FormatRegistry) {
  // Remove the source extension
  const ext = extname(relativePath);
  let urlPath = ext ? relativePath.slice(0, -ext.length) : relativePath;

  // Normalize path separators
  urlPath = urlPath.split("\\").join("/");

  // Index files map to their parent directory
  if (urlPath.endsWith("/index")) {
    urlPath = urlPath.slice(0, -6) || "/";
  } else if (urlPath === "index") {
    urlPath = "/";
  }

  // Ensure leading slash
  if (!urlPath.startsWith("/")) {
    urlPath = `/${urlPath}`;
  }

  // Extract parameters from bracket syntax
  const params: string[] = [];
  let isDynamic = false;
  let isCatchAll = false;

  // Convert [param] → :param and [...param] → *
  const urlPattern = urlPath.replaceAll(
    /\[\.\.\.(\w+)\]|\[(\w+)\]/g,
    (_match: string, spread: string, named: string) => {
      if (spread) {
        isCatchAll = true;
        isDynamic = true;
        params.push(spread);
        return "*";
      }
      isDynamic = true;
      params.push(named);
      return `:${named}`;
    },
  );

  // Peek at the page to extract $layout if present
  let $layout: string | null = null;
  try {
    const doc = await readPageDocument(absolutePath, registry);
    const layout = doc.$layout;
    if (typeof layout === "string") {
      $layout = layout;
    }
  } catch {
    // Skip unreadable files — will error during compilation
  }

  return {
    $layout,
    isCatchAll,
    isDynamic,
    params,
    relativePath,
    sourcePath: absolutePath,
    urlPattern,
  };
}

/**
 * The reserved key a `resolvePaths` result may carry alongside its route parameters.
 *
 * A route parameter comes from a `[bracket]` segment in a filename, so this name cannot collide
 * with one by accident, and it matches what the content loader already calls the same data on an
 * entry (`parser.md` §9.3) — so a fact about an entry keeps one name from the file it was read out
 * of all the way to the sitemap.
 */
const PATH_ENTRY_META = "_meta";

/**
 * The entry timestamp carried on a `$paths` result, or null when there is none.
 *
 * Null is ordinary: the core `$paths` shapes (`values`, `$ref`, a literal array) describe route
 * parameters and nothing else, and a route with no entry of its own correctly falls back to its
 * template's own modification time.
 *
 * @param {Record<string, unknown>} pathEntry
 * @returns {string | null}
 */
function entryMtime(pathEntry: Record<string, unknown>): string | null {
  const meta = pathEntry[PATH_ENTRY_META];
  if (meta === null || typeof meta !== "object") {
    return null;
  }
  const { mtime } = meta as { mtime?: unknown };
  return typeof mtime === "string" && mtime !== "" ? mtime : null;
}

/**
 * Expand dynamic routes by resolving $paths from each dynamic page.
 *
 * Supports these $paths shapes (per spec §4.3): 1. Explicit values: { values: ["en", "fr"], param:
 * "lang" } 2. Data file ref: { "$ref": "./data/products.json", param: "id", field: "sku" } 3.
 * Legacy array: [{ slug: "hello" }, { slug: "world" }] 4. Extension-discriminated: any object
 * carrying a key an enabled extension registered as its `resolvePaths` discriminator (e.g. the
 * parser's { contentType: "blog", param: "slug" }).
 *
 * @param {Route[]} routes - Discovered route table
 * @param {string} projectRoot - Project root for resolving $ref paths
 * @param {Record<string, unknown>} [sections] - Loaded project sections (projectData results)
 * @param {ExtensionRegistry} [registry] - Extension registry (formats view reads non-JSON pages)
 * @param {ProjectConfig} [projectConfig] - Already-loaded project config
 * @returns {Promise<Route[]>} Expanded routes with concrete paths
 */
export async function expandDynamicRoutes(
  routes: Route[],
  projectRoot: string,
  sections: Record<string, unknown> = {},
  registry?: ExtensionRegistry,
  projectConfig?: ProjectConfig,
  i18n?: ResolvedI18n | null,
) {
  const expanded: Route[] = [];

  for (const route of routes) {
    if (!route.isDynamic) {
      expanded.push(route);
      continue;
    }

    // Read the page to look for $paths
    /** @type {Record<string, unknown>} */
    let raw;
    try {
      raw = await readPageDocument(route.sourcePath, registry?.formats);
    } catch {
      expanded.push(route);
      continue;
    }

    if (!raw.$paths) {
      console.warn(`Warning: dynamic route ${route.urlPattern} has no $paths — skipping`);
      continue;
    }

    const pathEntries = await resolvePathEntries(
      raw.$paths,
      projectRoot,
      sections,
      registry,
      projectConfig,
      // The template's OWN prefix, read before expansion: `/fr/blog/:slug` is a French route
      // Whatever its entries turn out to be called, and that is what scopes a localized collection.
      localeOfRoute(route.urlPattern, i18n ?? null),
    );

    for (const pathEntry of pathEntries) {
      let concreteUrl = route.urlPattern;
      const params: Record<string, string> = {};
      for (const [param, value] of Object.entries(pathEntry)) {
        // `_meta` is the reserved carrier for facts about the source ENTRY (extensions.md §8).
        // It is not a route parameter and must never reach substitution.
        if (param === PATH_ENTRY_META) {
          continue;
        }
        params[param] = String(value);
        concreteUrl = concreteUrl.replace(`:${param}`, params[param]);
        concreteUrl = concreteUrl.replace("*", params[param]);
      }

      const mtime = entryMtime(pathEntry);
      expanded.push({
        ...route,
        _pathParams: params,
        isCatchAll: false,
        isDynamic: false,
        params: [],
        ...(mtime === null ? {} : { sourceMtime: mtime }),
        urlPattern: concreteUrl,
      });
    }
  }

  return expanded;
}

/**
 * Resolve $paths into an array of param objects.
 *
 * Core shapes (array / `values` / `$ref`) are handled inline; any other object dispatches through
 * the extension registry — the first key with a registered `resolvePaths` discriminator routes the
 * whole $paths value to the owning class, with its section's loaded data as context.
 *
 * @param {import("@jxsuite/schema/types").JxPathsDef} $paths - The $paths declaration
 * @param {string} projectRoot
 * @param {Record<string, unknown>} sections - Loaded project sections keyed by section key
 * @param {ExtensionRegistry} [registry]
 * @param {ProjectConfig} [projectConfig]
 * @returns {Promise<Record<string, unknown>[]>} Array of { paramName: value } objects
 */
async function resolvePathEntries(
  $paths: JxPathsDef,
  projectRoot: string,
  sections: Record<string, unknown>,
  registry?: ExtensionRegistry,
  projectConfig?: ProjectConfig,
  locale?: string | null,
): Promise<Record<string, unknown>[]> {
  // Legacy: array of param objects
  if (Array.isArray($paths)) {
    return $paths;
  }

  // Explicit values: { values: ["en", "fr"], param: "lang" }
  if ("values" in $paths && Array.isArray($paths.values)) {
    const param = typeof $paths.param === "string" ? $paths.param : "value";
    return ($paths.values as unknown[]).map((v) => ({ [param]: v }));
  }

  // Data file ref: { "$ref": "./data/products.json", param: "id", field: "sku" }
  if ("$ref" in $paths && typeof $paths.$ref === "string" && $paths.$ref) {
    const refPath = $paths.$ref;
    const filePath = resolve(projectRoot, refPath);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    } catch (error) {
      const err = error as Error;
      console.warn(`Warning: $paths.$ref could not load "${refPath}": ${err.message}`);
      return [];
    }
    if (!Array.isArray(data)) {
      console.warn(`Warning: $paths.$ref "${refPath}" must be a JSON array`);
      return [];
    }
    const param = typeof $paths.param === "string" ? $paths.param : "id";
    const field = typeof $paths.field === "string" ? $paths.field : "id";
    return (data as Record<string, unknown>[]).map((item: Record<string, unknown>) => ({
      [param]: item[field] ?? item.id ?? String(item),
    }));
  }

  // Extension-discriminated: the first key with a registered resolvePaths discriminator routes
  // The whole value to the owning class (specs/extensions.md §8).
  for (const key of Object.keys($paths)) {
    const entry = registry?.byPathsDiscriminator(key);
    if (!entry?.project) {
      continue;
    }
    return (await entry.call("resolvePaths", $paths, {
      data: sections[entry.project.key],
      locale,
      projectConfig,
      root: projectRoot,
    })) as Record<string, unknown>[];
  }

  console.warn(`Warning: unrecognized $paths shape — skipping`);
  return [];
}
