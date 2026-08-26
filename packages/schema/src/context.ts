/**
 * $page and $site context injection
 *
 * Injects project-level and page-level context variables into a page's state before compilation.
 * These are available as $site.* and $page.* in template expressions.
 *
 * Per site-architecture spec §10: $site.name — from project.json name $site.url — from project.json
 * url $site.state.* — site-wide reactive state $page.url — current page URL path $page.title — page
 * title $page.params — dynamic route parameters (if any) $page.locale/$page.dir — the route's
 * language and writing direction (§13.4) $page.alternates — this page in every language it exists
 * in (§13.5)
 *
 * The site build is not the only thing that has to produce this state. A page rendered live — on
 * the studio's canvas, or by the cloud's preview origin — binds `${$site.name}` and `${$page.url}`
 * exactly as a built page does, and a host that improvised its own subset would differ from the
 * build in whichever field it forgot. So the injection lives here, with no platform imports; the
 * one thing that genuinely needed a filesystem, rebasing relative `imports` onto the page's own
 * directory, is injected as {@link ImportRebaser} and simply absent where there are no
 * directories.
 *
 * @docs framework/site/i18n
 */

import type { JxDocument, JxElement, JxStateDefinition, ProjectConfig } from "../types.ts";
import { localeDirection, localeLabel, localeOfRoute } from "./locale.ts";
import type { ResolvedI18n } from "./locale.ts";

/** One member of a route's translation set — the shape `<head>` and `$page.alternates` share. */
export interface TranslationMember {
  locale: string;
  urlPattern: string;
}

/** The route a page is being injected for. */
export interface SiteRoute {
  urlPattern: string;
  sourcePath?: string;
  _pathParams?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Rewrite one project-level relative `imports` entry so it resolves from the PAGE's directory.
 *
 * Only a host with real directories can answer this — and only one needs to. A live renderer serves
 * the project at a root where the authored path already means what it says, so it passes nothing
 * and the entry is used as written.
 */
export type ImportRebaser = (src: string, route: SiteRoute) => string;

/**
 * Inject $site and $page context into a page document's state.
 *
 * @param {JxDocument} doc - The page document (mutated)
 * @param {ProjectConfig} projectConfig - Loaded project configuration
 * @param {SiteRoute} route - The resolved route for this page
 * @param {ImportRebaser | null} [rebaseImport] - Rebases relative `imports` onto the page directory
 * @param {ResolvedI18n | null} [i18n] - Validated locale config, when the project declares one
 * @param {readonly TranslationMember[]} [translations] - This route's translation set, itself
 *   included
 * @returns {JxDocument} The mutated document
 */
export function injectContext(
  doc: JxDocument,
  projectConfig: ProjectConfig,
  route: SiteRoute,
  rebaseImport: ImportRebaser | null = null,
  i18n: ResolvedI18n | null = null,
  translations: readonly TranslationMember[] = [],
) {
  if (!doc.state) {
    doc.state = {};
  }

  // $site context — read-only project-level data
  doc.state.$site = {
    name: projectConfig.name ?? "Jx Site",
    url: projectConfig.url ?? "",
    ...(i18n === null ? {} : { defaultLocale: i18n.defaultLocale, locales: i18n.locales }),
    ...projectConfig.state,
  };

  /*
   * $page context — read-only page-level data.
   *
   * The locale lives here rather than as a top-level `$locale` because that is what it is: a
   * property of the route, not a third ambient namespace beside $site and $page. A document's own
   * `$lang` still wins over the route's locale, so this is the resolved answer, not the prefix.
   */
  const pageLang =
    (typeof doc.$lang === "string" ? doc.$lang : undefined) ??
    localeOfRoute(route.urlPattern, i18n) ??
    projectConfig.defaults?.lang;
  /*
   * The same translation set `<head>` advertises, in the shape a template can render: a language
   * switcher is the one part of a multilingual site the framework cannot write for the author, and
   * without this it could only be hand-maintained — a hardcoded list of URLs that goes stale the
   * moment a page gains or loses a translation, silently, in the one place a reader would use it.
   *
   * Site-absolute URLs, not the absolute hrefs `<head>` needs: a switcher is an internal link, and
   * it has to work before `url` is configured. `current` marks the member this route *is*, taken
   * from the route rather than from `$page.locale`, because a document whose `$lang` disagrees with
   * its directory is still served from that directory.
   */
  const alternates = translations.map((member) => ({
    code: member.locale,
    current: member.urlPattern === route.urlPattern,
    dir: localeDirection(member.locale),
    label: localeLabel(member.locale),
    url: member.urlPattern,
  }));
  doc.state.$page = {
    params: route._pathParams ?? {},
    title: doc.title ?? doc._pageTitle ?? projectConfig.name ?? "",
    url: route.urlPattern,
    ...(alternates.length > 0 && { alternates }),
    ...(pageLang === undefined ? {} : { dir: localeDirection(pageLang), locale: pageLang }),
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
        doc.imports[name] =
          rebaseImport && (src.startsWith("./") || src.startsWith("../"))
            ? rebaseImport(src, route)
            : src;
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
