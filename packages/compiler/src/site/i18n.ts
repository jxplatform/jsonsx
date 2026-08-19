/**
 * Locale routing: which language a route is in, and what that means for the page it produces.
 *
 * The `i18n` key has been in the project schema since the beginning and **nothing read it**. A site
 * with `pages/fr/about.json` got a French page only because `fr` happened to be an ordinary path
 * segment; the config beside it was decoration. This module is the reader.
 *
 * Deliberately not a translation system. Jx has no message catalogue, no `t()` and no fallback
 * chain — a locale here is a property of a _route_, and what the route serves is whatever the
 * author put in that directory. That is the whole model, and everything below follows from it.
 *
 * @docs framework/site/i18n
 */

import { canonicalizeLocale, localeDirection } from "@jxsuite/schema/locale";
import type { ResolvedI18n, TextDirection } from "@jxsuite/schema/locale";

/*
 * `resolveI18n` and the two types beside it live in `@jxsuite/schema/locale` rather than here.
 * Studio needs the same answer and cannot import this package — there is no `./site/i18n` export,
 * the dependency graph carries `sharp` and `esbuild`, and Studio bundles for a browser. One
 * resolution with two hosts is the only shape in which the tag Studio offers is certain to be the
 * tag the build accepts.
 *
 * Everything below is route-shaped and has no Studio consumer, so it stays.
 */
export { resolveI18n } from "@jxsuite/schema/locale";
export type { LocaleRouting, ResolvedI18n } from "@jxsuite/schema/locale";

/**
 * The locale a URL belongs to.
 *
 * Matching is on the **first path segment**, compared canonically, so `/fr-CA/about/` resolves for
 * a project that declared `fr-ca`. A path under no declared locale is the default locale — under
 * `prefix-except-default` that is the point, and under `prefix-always` it is a page the author put
 * outside the locale tree, which is theirs to place.
 *
 * @param {string} urlPattern - Site-absolute route pattern, e.g. `/fr/about/`
 * @param {ResolvedI18n | null} i18n
 * @returns {string | null} A canonical tag, or null when the project has no i18n
 */
export function localeOfRoute(urlPattern: string, i18n: ResolvedI18n | null): string | null {
  if (i18n === null) {
    return null;
  }
  const first = urlPattern.split("/").find(Boolean);
  if (first === undefined) {
    return i18n.defaultLocale;
  }
  const canonical = canonicalizeLocale(first);
  return canonical !== null && i18n.locales.includes(canonical) ? canonical : i18n.defaultLocale;
}

/**
 * Routes sitting outside the locale tree under `prefix-always`.
 *
 * `prefix-always` is a promise that **every** URL names its language. A page at `/about/` under it
 * breaks that promise silently: it builds, it serves, and `localeOfRoute` calls it the default
 * locale — so a site that declared "no unprefixed URLs" ships them anyway, and the only reader who
 * finds out is a visitor who lands on one and sees the wrong language with no way to switch.
 *
 * Reported rather than rejected. The author may genuinely mean it — a `/robots-info/` page, a
 * landing page with no translations — and failing their build over a page that works would be the
 * compiler overruling a decision it cannot see the reason for. Naming it is enough.
 *
 * `/` is excluded: under `prefix-always` the site root is the one URL that exists precisely to send
 * a visitor somewhere else, and negotiation (`locale-negotiation.ts`) is what it is for.
 *
 * @param {readonly { urlPattern: string }[]} routes
 * @param {ResolvedI18n | null} i18n
 * @returns {string[]} Offending URL patterns, in route order
 */
export function unprefixedRoutes(
  routes: readonly { urlPattern: string }[],
  i18n: ResolvedI18n | null,
): string[] {
  if (i18n === null || i18n.routing !== "prefix-always") {
    return [];
  }
  const offenders: string[] = [];
  for (const route of routes) {
    if (route.urlPattern === "/") {
      continue;
    }
    const first = route.urlPattern.split("/").find(Boolean);
    const canonical = canonicalizeLocale(first);
    if (canonical === null || !i18n.locales.includes(canonical)) {
      offenders.push(route.urlPattern);
    }
  }
  return offenders;
}

/**
 * A route prefix that looks like one of the declared locales but is not one of them.
 *
 * The precise mistake this catches: `i18n.locales` says `fr-CA` and the pages live in `pages/fr/`.
 * The segment is a well-formed tag, the directory is obviously meant to be French, and nothing
 * matches — so every page under it silently becomes the default locale and claims the wrong
 * language in `<html lang>`. Left alone that is invisible; there is no error and the page looks
 * fine.
 *
 * Scoped to the **primary language** of a declared locale on purpose. Any 2-to-8-letter segment is
 * a well-formed language tag — `/docs/`, `/api/`, `/it/` — so warning on "looks like a tag" would
 * fire on ordinary paths. Warning on "looks like a locale you declared" fires only on the mistake.
 *
 * @param {string} urlPattern
 * @param {ResolvedI18n | null} i18n
 * @returns {{ segment: string; meant: string } | null}
 */
export function undeclaredLocalePrefix(
  urlPattern: string,
  i18n: ResolvedI18n | null,
): { segment: string; meant: string } | null {
  if (i18n === null) {
    return null;
  }
  const first = urlPattern.split("/").find(Boolean);
  const canonical = canonicalizeLocale(first);
  if (first === undefined || canonical === null || i18n.locales.includes(canonical)) {
    return null;
  }
  const meant = i18n.locales.find(
    (locale) => locale !== canonical && locale.split("-")[0] === canonical.split("-")[0],
  );
  return meant === undefined ? null : { meant, segment: first };
}

/**
 * A route's identity across locales: its path with the locale prefix removed.
 *
 * `/fr-ca/about/` and `/about/` share the key `about/`, which is what makes them translations of
 * one another. The directory layout is the default mapping, and it is enough whenever the paths are
 * parallel.
 *
 * A **localized slug** is not parallel, and that is the case this cannot derive: `/fr-ca/a-propos/`
 * shares nothing with `/about/`. A document says so itself with `$translationKey`, which overrides
 * this exactly as `$lang` overrides the locale its route implies (§13.4) — one key, and the whole
 * annotation follows.
 *
 * @param {string} urlPattern
 * @param {ResolvedI18n | null} i18n
 * @returns {string}
 */
export function translationKey(urlPattern: string, i18n: ResolvedI18n | null): string {
  const segments = urlPattern.split("/").filter(Boolean);
  const canonical = canonicalizeLocale(segments[0]);
  if (i18n !== null && canonical !== null && i18n.locales.includes(canonical)) {
    return segments.slice(1).join("/");
  }
  return segments.join("/");
}

/** One `<link rel="alternate">` / sitemap `xhtml:link`. */
export interface LocaleAlternate {
  hreflang: string;
  href: string;
}

/** One route in a translation set: the locale it serves, and where it lives. */
export interface TranslationMember {
  /** Canonical BCP 47 tag. */
  locale: string;
  /** Site-absolute route pattern, e.g. `/fr-ca/about/`. */
  urlPattern: string;
}

/** A route as translation grouping sees it: its URL, and the key its document declared. */
export interface TranslationRoute {
  /** From the document's `$translationKey`; absent when the key is derived from the path. */
  translationKey?: string | undefined;
  urlPattern: string;
}

/** Two routes claiming to be the same page in the same language. */
export interface TranslationConflict {
  /** True when at least one of them said so with `$translationKey`. */
  declared: boolean;
  key: string;
  locale: string;
  /** In route order; the first is the one that keeps the set. */
  urlPatterns: string[];
}

/** Everything a page needs to know about its own locale, gathered once per build. */
export interface PageLocaleContext {
  /** Absolute alternates for `<head>` and the sitemap; empty without a site `url`. */
  alternates: readonly LocaleAlternate[];
  i18n: ResolvedI18n | null;
  /** The page's translation set, site-absolute and including itself. */
  translations: readonly TranslationMember[];
}

/**
 * Group routes into translation sets: for each route, every route that is the same page in another
 * language, itself included, ordered by tag.
 *
 * One derivation, two readers. {@link localeAlternates} turns a set into absolute `<link
 * rel="alternate">` hrefs for crawlers; `injectContext` turns it into `$page.alternates` for a
 * language switcher a reader can click. Deriving it twice is how the two would come to disagree
 * about which pages are translations of one another — and the disagreement would be invisible,
 * because one of them is only ever read by a machine.
 *
 * **A set of one is kept here and dropped there.** A lone `hreflang` pointing at itself is noise in
 * `<head>` (§13.5), but a template asking "which languages is this page in" wants the honest
 * answer, and dropping the page itself would leave a switcher unable to mark where the reader is.
 *
 * URLs stay **site-absolute** rather than becoming absolute hrefs, because a switcher is a link
 * within the site and works before `url` is configured — which is every project during
 * development.
 *
 * @param {readonly TranslationRoute[]} routes - Concrete routes only
 * @param {ResolvedI18n | null} i18n
 * @returns {{ conflicts: TranslationConflict[]; sets: Map<string, TranslationMember[]> }} Sets are
 *   keyed by `urlPattern`; members of one set share one array
 */
export function translationSets(
  routes: readonly TranslationRoute[],
  i18n: ResolvedI18n | null,
): { conflicts: TranslationConflict[]; sets: Map<string, TranslationMember[]> } {
  const out = new Map<string, TranslationMember[]>();
  const conflicts: TranslationConflict[] = [];
  if (i18n === null) {
    return { conflicts, sets: out };
  }

  const sets = new Map<string, TranslationMember[]>();
  const declared = new Set<string>();
  for (const route of routes) {
    /*
     * Slashes at the ends are trimmed so a declared key can be written the way the URL reads.
     * The derived form has none — `/about/` reduces to `about` — and a `"/about"` that silently
     * matched nothing would look exactly like a key that was ignored.
     */
    const key =
      route.translationKey === undefined
        ? translationKey(route.urlPattern, i18n)
        : route.translationKey.replaceAll(/^\/+|\/+$/g, "");
    if (route.translationKey !== undefined) {
      declared.add(route.urlPattern);
    }
    const locale = localeOfRoute(route.urlPattern, i18n);
    if (locale === null) {
      continue;
    }
    const members = sets.get(key) ?? [];
    /*
     * A duplicate locale in one set means two routes claim to be the same page in one language.
     * The first wins, which keeps the set single-valued rather than advertising a contradiction;
     * the loser is keyed nowhere, so it carries no alternates and no switcher.
     *
     * How loudly to say so is the caller's decision, and it turns on which kind of collision it
     * is: a declared one is a promise the author wrote down and broke, while a derived one may be
     * a deliberate alias the compiler cannot see the reason for.
     */
    const taken = members.find((m) => m.locale === locale);
    if (taken === undefined) {
      members.push({ locale, urlPattern: route.urlPattern });
    } else {
      conflicts.push({
        declared: declared.has(taken.urlPattern) || route.translationKey !== undefined,
        key,
        locale,
        urlPatterns: [taken.urlPattern, route.urlPattern],
      });
    }
    sets.set(key, members);
  }

  for (const members of sets.values()) {
    const ordered = members.toSorted((a, b) =>
      a.locale === b.locale ? 0 : a.locale < b.locale ? -1 : 1,
    );
    for (const member of members) {
      out.set(member.urlPattern, ordered);
    }
  }
  return { conflicts, sets: out };
}

/**
 * Group routes into translation sets and give each one its alternates.
 *
 * A page with no translations gets **none** — a lone `hreflang` pointing at itself is noise, and
 * the standards it would satisfy expect a set. `x-default` names the default locale's URL, which is
 * the convention search engines act on for "the page to send an unmatched visitor to"; it is
 * omitted when the set has no default-locale member, since inventing one would advertise a URL that
 * does not exist.
 *
 * Reciprocity is automatic: every member of a set lists every member **including itself**, which is
 * what the annotation is specified to do and what validators check for.
 *
 * @param {readonly TranslationRoute[]} routes - Concrete routes only
 * @param {ResolvedI18n | null} i18n
 * @param {string} siteUrl - Absolute site URL; alternates must be absolute
 * @returns {Map<string, LocaleAlternate[]>} Keyed by `urlPattern`
 */
export function localeAlternates(
  routes: readonly TranslationRoute[],
  i18n: ResolvedI18n | null,
  siteUrl: string,
): Map<string, LocaleAlternate[]> {
  const out = new Map<string, LocaleAlternate[]>();
  if (i18n === null || siteUrl === "") {
    return out;
  }

  /* Built once per set rather than once per member: every member advertises the same list. */
  const built = new Map<readonly TranslationMember[], LocaleAlternate[]>();
  for (const [urlPattern, members] of translationSets(routes, i18n).sets) {
    if (members.length < 2) {
      continue;
    }
    let alternates = built.get(members);
    if (alternates === undefined) {
      alternates = members.map((m) => ({
        href: new URL(m.urlPattern, siteUrl).href,
        hreflang: m.locale,
      }));
      const fallback = members.find((m) => m.locale === i18n.defaultLocale);
      if (fallback !== undefined) {
        alternates.push({
          href: new URL(fallback.urlPattern, siteUrl).href,
          hreflang: "x-default",
        });
      }
      built.set(members, alternates);
    }
    out.set(urlPattern, alternates);
  }
  return out;
}

/**
 * The `lang` and `dir` a page ships with.
 *
 * An explicit `$lang` on the document wins over the locale its route implies: a page really can be
 * a French translation living at `/en/a-propos/`, and the author who wrote that down means it.
 *
 * `dir` is emitted only when it is `rtl` or when the author asked for something. `ltr` is the
 * default for every element in HTML, so writing it on every page of a left-to-right site is noise
 * that says nothing.
 *
 * @param {object} args
 * @returns {{ lang: string; dir?: TextDirection | string }}
 */
export function pageLanguage({
  pageLang,
  pageDir,
  routeLocale,
  defaults,
}: {
  pageLang?: string | undefined;
  pageDir?: string | undefined;
  routeLocale?: string | null;
  defaults?: { lang?: string | undefined; dir?: string | undefined } | undefined;
}): { lang: string; dir?: string } {
  const lang = pageLang ?? routeLocale ?? defaults?.lang ?? "en";
  const explicit = pageDir ?? defaults?.dir;
  if (explicit !== undefined) {
    return { dir: explicit, lang };
  }
  const derived: TextDirection = localeDirection(lang);
  return derived === "rtl" ? { dir: "rtl", lang } : { lang };
}
