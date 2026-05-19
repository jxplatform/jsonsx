/**
 * Context-injection.js — $page and $site context injection
 *
 * Injects project-level and page-level context variables into a page's state before compilation.
 * These are available as $site.* and $page.* in template expressions.
 *
 * Also resolves ContentCollection and ContentEntry $prototype entries against loaded content types
 * (Phase 2, spec §6.4).
 *
 * Per site-architecture spec §10: $site.name — from project.json name $site.url — from project.json
 * url $site.state.* — site-wide reactive state $page.url — current page URL path $page.title — page
 * title $page.params — dynamic route parameters (if any)
 */

import { queryContentType, findEntry } from "./content-loader.js";
import { resolve, dirname, relative } from "node:path";

/**
 * Inject $site and $page context into a page document's state.
 *
 * @param {any} doc - The page document (mutated)
 * @param {any} projectConfig - Loaded project configuration
 * @param {any} route - The resolved route for this page
 * @param {Map<string, any[]>} [contentTypes] - Loaded content types
 * @param {string | null} [projectRoot] - Absolute path to the project root (for import rebasing)
 * @returns {any} The mutated document
 */
export function injectContext(
  doc,
  projectConfig,
  route,
  contentTypes = new Map(),
  projectRoot = null,
) {
  if (!doc.state) doc.state = {};

  // $site context — read-only project-level data
  doc.state.$site = {
    name: projectConfig.name ?? "Jx Site",
    url: projectConfig.url ?? "",
    ...projectConfig.state,
  };

  // $page context — read-only page-level data
  doc.state.$page = {
    url: route.urlPattern,
    title: doc.title ?? doc._pageTitle ?? projectConfig.name ?? "",
    params: route._pathParams ?? {},
  };

  // Resolve ContentCollection and ContentEntry $prototype entries
  if (contentTypes.size > 0) {
    resolveContentPrototypes(doc.state, contentTypes, route._pathParams ?? {});
  }

  // Merge project-level state into page state (page wins on conflicts)
  if (projectConfig.state) {
    for (const [key, value] of Object.entries(projectConfig.state)) {
      if (key !== "$site" && key !== "$page" && !(key in doc.state)) {
        doc.state[key] = value;
      }
    }
  }

  // Merge project-level $media into page $media
  if (projectConfig.$media) {
    doc.$media = { ...projectConfig.$media, ...doc.$media };
  }

  // Merge project-level imports into page imports (page wins on collision)
  if (projectConfig.imports && Object.keys(projectConfig.imports).length > 0) {
    if (!doc.imports) doc.imports = {};
    for (const [name, srcPath] of Object.entries(projectConfig.imports)) {
      if (!(name in doc.imports)) {
        const src = /** @type {string} */ (srcPath);
        // Only rebase relative paths — bare/npm specifiers pass through unmodified
        if (projectRoot && route.sourcePath && (src.startsWith("./") || src.startsWith("../"))) {
          const abs = resolve(projectRoot, src);
          doc.imports[name] = "./" + relative(dirname(route.sourcePath), abs);
        } else {
          doc.imports[name] = src;
        }
      }
    }
  }

  // Merge project-level $elements into page $elements (union, dedup)
  if (projectConfig.$elements?.length) {
    if (!doc.$elements?.length) {
      doc.$elements = [...projectConfig.$elements];
    } else {
      /** @type {Set<string>} */
      const seen = new Set();
      /** @type {any[]} */
      const merged = [];
      for (const entry of [...projectConfig.$elements, ...doc.$elements]) {
        const key = typeof entry === "string" ? entry : entry?.$ref;
        if (key && !seen.has(key)) {
          seen.add(key);
          merged.push(entry);
        }
      }
      doc.$elements = merged;
    }
  }

  return doc;
}

/**
 * Resolve ContentCollection and ContentEntry $prototype state entries.
 *
 * Replaces state entries like: { "$prototype": "ContentCollection", "contentType": "blog", ... }
 * with the actual resolved content type data.
 *
 * @param {Record<string, any>} state - Page state (mutated)
 * @param {Map<string, any[]>} contentTypes - Loaded content types
 * @param {Record<string, any>} params - Route parameters for $ref resolution
 */
function resolveContentPrototypes(state, contentTypes, params) {
  for (const [key, value] of Object.entries(state)) {
    if (!value || typeof value !== "object" || !value.$prototype) continue;

    if (value.$prototype === "ContentCollection") {
      const entries = contentTypes.get(value.contentType);
      if (!entries) {
        console.warn(`ContentCollection: content type "${value.contentType}" not found`);
        state[key] = [];
        continue;
      }
      state[key] = queryContentType(entries, {
        filter: value.filter,
        sort: value.sort,
        limit: value.limit,
      });
    } else if (value.$prototype === "ContentEntry") {
      const entries = contentTypes.get(value.contentType);
      if (!entries) {
        console.warn(`ContentEntry: content type "${value.contentType}" not found`);
        state[key] = null;
        continue;
      }
      // Resolve the ID — may reference $params
      let id = value.id;
      if (id && typeof id === "object" && id.$ref?.startsWith("#/$params/")) {
        const paramName = id.$ref.replace("#/$params/", "");
        id = params[paramName];
      }
      state[key] = findEntry(entries, id);
    }
  }
}
