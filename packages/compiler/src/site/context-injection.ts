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

import { dirname, relative, resolve } from "node:path";
import type {
  JxDocument,
  JxElement,
  JxStateDefinition,
  ProjectConfig,
} from "@jxsuite/schema/types";
import type { ContentLoaderEntry } from "@jxsuite/parser/types";
import type { SiteRoute } from "../types.ts";

/**
 * Inject $site and $page context into a page document's state.
 *
 * @param {JxDocument} doc - The page document (mutated)
 * @param {ProjectConfig} projectConfig - Loaded project configuration
 * @param {SiteRoute} route - The resolved route for this page
 * @param {Map<string, ContentLoaderEntry[]>} [contentTypes] - Loaded content types
 * @param {string | null} [projectRoot] - Absolute path to the project root (for import rebasing)
 * @returns {JxDocument} The mutated document
 */
export function injectContext(
  doc: JxDocument,
  projectConfig: ProjectConfig,
  route: SiteRoute,
  contentTypes = new Map<string, ContentLoaderEntry[]>(),
  projectRoot: string | null = null,
) {
  if (!doc.state) {
    doc.state = {};
  }

  // $site context — read-only project-level data
  doc.state.$site = {
    name: projectConfig.name ?? "Jx Site",
    url: projectConfig.url ?? "",
    ...projectConfig.state,
  };

  // $page context — read-only page-level data
  doc.state.$page = {
    params: route._pathParams ?? {},
    title: doc.title ?? doc._pageTitle ?? projectConfig.name ?? "",
    url: route.urlPattern,
  };

  // Merge project-level state into page state (page wins on conflicts)
  if (projectConfig.state) {
    for (const [key, value] of Object.entries(projectConfig.state)) {
      if (key !== "$site" && key !== "$page" && !(key in doc.state)) {
        doc.state[key] = value as JxStateDefinition;
      }
    }
  }

  // Merge project-level $media into page $media
  if (projectConfig.$media) {
    doc.$media = { ...projectConfig.$media, ...doc.$media };
  }

  // Merge project-level imports into page imports (page wins on collision)
  if (projectConfig.imports && Object.keys(projectConfig.imports).length > 0) {
    if (!doc.imports) {
      doc.imports = {};
    }
    for (const [name, srcPath] of Object.entries(projectConfig.imports)) {
      if (!(name in doc.imports)) {
        const src = srcPath as string;
        // Only rebase relative paths — bare/npm specifiers pass through unmodified
        if (projectRoot && route.sourcePath && (src.startsWith("./") || src.startsWith("../"))) {
          const abs = resolve(projectRoot, src);
          doc.imports[name] = `./${relative(dirname(route.sourcePath), abs)}`;
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
      const seen = new Set<string>();
      const merged: (string | JxElement)[] = [];
      for (const entry of [
        ...projectConfig.$elements,
        ...(doc.$elements as (string | JxElement)[]),
      ]) {
        const key =
          typeof entry === "string" ? entry : /** @type {{ $ref?: string }} */ entry?.$ref;
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
