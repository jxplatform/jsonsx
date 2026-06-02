/**
 * Pages-discovery.js — File-based route discovery
 *
 * Scans the pages/ directory and builds a route table mapping URL paths to their source JSON files,
 * layouts, and metadata.
 *
 * Conventions (per site-architecture spec §4): pages/index.json → / pages/about.json → /about
 * pages/about/index.json → /about pages/blog/[slug].json → /blog/:slug (dynamic)
 * pages/docs/[...path].json → /docs/* (catch-all) pages/_component.json → NOT routed (underscore
 * prefix)
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, extname, join } from "node:path";
import type { ContentLoaderEntry } from "@jxsuite/parser/types";

interface Route {
  urlPattern: string; // URL pattern (e.g. "/blog/:slug")
  sourcePath: string; // Absolute path to the .json source file
  relativePath: string; // Path relative to pages/ dir
  isDynamic: boolean; // Whether route has parameters
  isCatchAll: boolean; // Whether route uses [...param] spread
  params: string[]; // Parameter names (e.g. ["slug"])
  $layout: string | null; // Layout override from page frontmatter, if any
  _pathParams?: Record<string, string>; // Resolved path parameters
}

/**
 * Discover all routable pages in a pages/ directory.
 *
 * @param {string} pagesDir - Absolute path to the pages/ directory
 * @returns {Route[]} Sorted route table (static routes first, then dynamic)
 */
export function discoverPages(pagesDir: string) {
  const routes: Route[] = [];
  walkDir(pagesDir, pagesDir, routes);

  // Sort: static routes first, then by specificity (more segments = more specific)
  routes.sort((a, b) => {
    if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1;
    if (a.isCatchAll !== b.isCatchAll) return a.isCatchAll ? 1 : -1;
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
 */
function walkDir(dir: string, pagesRoot: string, routes: Route[]) {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip underscore-prefixed directories
      if (entry.name.startsWith("_")) continue;
      walkDir(fullPath, pagesRoot, routes);
      continue;
    }

    // Only process .json and .md files
    const ext = extname(entry.name);
    if (ext !== ".json" && ext !== ".md") continue;

    // Skip underscore-prefixed files (local components, not routes)
    if (entry.name.startsWith("_")) continue;

    const relativePath = relative(pagesRoot, fullPath);
    const route = fileToRoute(relativePath, fullPath);
    if (route) routes.push(route);
  }
}

/**
 * Convert a file path relative to pages/ into a Route object.
 *
 * @param {string} relativePath - E.g. "blog/[slug].json"
 * @param {string} absolutePath - Full filesystem path
 * @returns {Route}
 */
function fileToRoute(relativePath: string, absolutePath: string) {
  // Remove .json or .md extension
  let urlPath = relativePath.replace(/\.(json|md)$/, "");

  // Normalize path separators
  urlPath = urlPath.split("\\").join("/");

  // index files map to their parent directory
  if (urlPath.endsWith("/index")) {
    urlPath = urlPath.slice(0, -6) || "/";
  } else if (urlPath === "index") {
    urlPath = "/";
  }

  // Ensure leading slash
  if (!urlPath.startsWith("/")) urlPath = "/" + urlPath;

  // Extract parameters from bracket syntax
  const params: string[] = [];
  let isDynamic = false;
  let isCatchAll = false;

  // Convert [param] → :param and [...param] → *
  const urlPattern = urlPath.replace(
    /\[\.\.\.(\w+)\]|\[(\w+)\]/g,
    (match: string, spread: string, named: string) => {
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
  /** @type {string | null} */
  let $layout = null;
  try {
    const source = readFileSync(absolutePath, "utf8");
    if (absolutePath.endsWith(".md")) {
      // Parse YAML frontmatter for $layout
      const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        // Quick regex extraction — avoids full YAML dependency
        const layoutMatch = fmMatch[1].match(/^\$layout:\s*(.+)/m);
        if (layoutMatch) $layout = layoutMatch[1].trim().replace(/^['"]|['"]$/g, "");
      }
    } else {
      const raw = JSON.parse(source);
      if (typeof raw.$layout === "string") {
        $layout = raw.$layout;
      }
    }
  } catch {
    // Skip unreadable files — will error during compilation
  }

  return {
    urlPattern,
    sourcePath: absolutePath,
    relativePath,
    isDynamic,
    isCatchAll,
    params,
    $layout,
  };
}

/**
 * Expand dynamic routes by resolving $paths from each dynamic page.
 *
 * Supports three $paths shapes (per spec §4.3): 1. Content type-based: { contentType: "blog",
 * param: "slug", field: "id" } 2. Explicit values: { values: ["en", "fr"], param: "lang" } 3. Data
 * file ref: { "$ref": "./data/products.json", param: "id", field: "sku" } 4. Legacy array: [{ slug:
 * "hello" }, { slug: "world" }]
 *
 * @param {Route[]} routes - Discovered route table
 * @param {string} projectRoot - Project root for resolving $ref paths
 * @param {Map<string, any[]>} [contentTypes] - Loaded content types (from content-loader)
 * @returns {Promise<Route[]>} Expanded routes with concrete paths
 */
export async function expandDynamicRoutes(
  routes: Route[],
  projectRoot: string,
  contentTypes: Map<string, any[]> = new Map(),
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
      raw = JSON.parse(readFileSync(route.sourcePath, "utf8"));
    } catch {
      expanded.push(route);
      continue;
    }

    if (!raw.$paths) {
      console.warn(`Warning: dynamic route ${route.urlPattern} has no $paths — skipping`);
      continue;
    }

    const pathEntries = resolvePathEntries(raw.$paths, projectRoot, contentTypes);

    for (const pathEntry of pathEntries) {
      let concreteUrl = route.urlPattern;
      for (const [param, value] of Object.entries(pathEntry)) {
        concreteUrl = concreteUrl.replace(`:${param}`, value as string);
        concreteUrl = concreteUrl.replace("*", value as string);
      }

      expanded.push({
        ...route,
        urlPattern: concreteUrl,
        isDynamic: false,
        isCatchAll: false,
        params: [],
        _pathParams: pathEntry,
      });
    }
  }

  return expanded;
}

/**
 * Resolve $paths into an array of param objects.
 *
 * @param {any} $paths - The $paths declaration
 * @param {string} projectRoot
 * @param {Map<string, any[]>} contentTypes
 * @returns {Record<string, any>[]} Array of { paramName: value } objects
 */
function resolvePathEntries($paths: any, projectRoot: string, contentTypes: Map<string, any[]>) {
  // Legacy: array of param objects
  if (Array.isArray($paths)) {
    return $paths;
  }

  // Content type-based: { contentType: "blog", param: "slug", field: "id" }
  if ($paths.contentType) {
    const entries = contentTypes.get($paths.contentType);
    if (!entries || entries.length === 0) {
      console.warn(
        `Warning: $paths references content type "${$paths.contentType}" but it has no entries`,
      );
      return [];
    }
    const param = $paths.param ?? "slug";
    const field = $paths.field ?? "id";
    return entries.map((entry: ContentLoaderEntry) => ({
      [param]: field === "id" ? entry.id : (entry.data[field] ?? entry.id),
    }));
  }

  // Explicit values: { values: ["en", "fr"], param: "lang" }
  if (Array.isArray($paths.values)) {
    const param = $paths.param ?? "value";
    return $paths.values.map((v: string) => ({ [param]: v }));
  }

  // Data file ref: { "$ref": "./data/products.json", param: "id", field: "sku" }
  if ($paths.$ref) {
    const filePath = resolve(projectRoot, $paths.$ref);
    /** @type {Record<string, unknown>[]} */
    let data;
    try {
      data = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (e) {
      const err = e as Error;
      console.warn(`Warning: $paths.$ref could not load "${$paths.$ref}": ${err.message}`);
      return [];
    }
    if (!Array.isArray(data)) {
      console.warn(`Warning: $paths.$ref "${$paths.$ref}" must be a JSON array`);
      return [];
    }
    const param = $paths.param ?? "id";
    const field = $paths.field ?? "id";
    return data.map((item: Record<string, unknown>) => ({
      [param]: item[field] ?? item.id ?? String(item),
    }));
  }

  console.warn(`Warning: unrecognized $paths shape — skipping`);
  return [];
}
