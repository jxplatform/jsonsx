/**
 * The build's filesystem half of context injection.
 *
 * `injectContext` itself is `@jxsuite/site/context` — a live renderer binds `${$site.name}` and
 * `${$page.url}` exactly as a built page does, so the two must not be separate implementations.
 * What is left here is the one thing that needs real directories: rebasing a project-level relative
 * `imports` entry onto the page's own directory.
 *
 * @docs framework/site/i18n
 */

import { dirname, relative, resolve } from "node:path";
import { injectContext as injectContextWith } from "@jxsuite/site/context";
import type { ImportRebaser, SiteRoute, TranslationMember } from "@jxsuite/site/context";
import type { ResolvedI18n } from "@jxsuite/schema/locale";
import type { JxDocument, ProjectConfig } from "@jxsuite/schema/types";

/** An {@link ImportRebaser} over a project on disk. */
export function nodeImportRebaser(projectRoot: string): ImportRebaser {
  return (src, route) => {
    if (!route.sourcePath) {
      return src;
    }
    return `./${relative(dirname(route.sourcePath), resolve(projectRoot, src))}`;
  };
}

/**
 * Inject $site and $page context for a page compiled from a project on disk.
 *
 * @param {JxDocument} doc - The page document (mutated)
 * @param {ProjectConfig} projectConfig - Loaded project configuration
 * @param {SiteRoute} route - The resolved route for this page
 * @param {string | null} [projectRoot] - Absolute path to the project root (for import rebasing)
 * @param {ResolvedI18n | null} [i18n] - Validated locale config, when the project declares one
 * @param {readonly TranslationMember[]} [translations] - This route's translation set
 * @returns {JxDocument} The mutated document
 */
export function injectContext(
  doc: JxDocument,
  projectConfig: ProjectConfig,
  route: SiteRoute,
  projectRoot: string | null = null,
  i18n: ResolvedI18n | null = null,
  translations: readonly TranslationMember[] = [],
): JxDocument {
  return injectContextWith(
    doc,
    projectConfig,
    route,
    projectRoot === null ? null : nodeImportRebaser(projectRoot),
    i18n,
    translations,
  );
}
