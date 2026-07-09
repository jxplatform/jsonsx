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

interface Route {
  urlPattern: string; // URL pattern (e.g. "/blog/:slug")
  sourcePath: string; // Absolute path to the source file
  relativePath: string; // Path relative to pages/ dir
  isDynamic: boolean; // Whether route has parameters
  isCatchAll: boolean; // Whether route uses [...param] spread
  params: string[]; // Parameter names (e.g. ["slug"])
  $layout: string | null; // Layout override from page frontmatter, if any
  _pathParams?: Record<string, string>; // Resolved path parameters
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
    );

    for (const pathEntry of pathEntries) {
      let concreteUrl = route.urlPattern;
      const params: Record<string, string> = {};
      for (const [param, value] of Object.entries(pathEntry)) {
        params[param] = String(value);
        concreteUrl = concreteUrl.replace(`:${param}`, params[param]);
        concreteUrl = concreteUrl.replace("*", params[param]);
      }

      expanded.push({
        ...route,
        _pathParams: params,
        isCatchAll: false,
        isDynamic: false,
        params: [],
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
      projectConfig,
      root: projectRoot,
    })) as Record<string, unknown>[];
  }

  console.warn(`Warning: unrecognized $paths shape — skipping`);
  return [];
}
