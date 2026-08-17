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
import type { ProjectConfig } from "@jxsuite/schema/types";
import type { TextDirection } from "@jxsuite/schema/locale";

/** How locales appear in URLs. */
export type LocaleRouting = "prefix-except-default" | "prefix-always";

/** A project's `i18n` block after validation, or null when the project declares none. */
export interface ResolvedI18n {
  defaultLocale: string;
  /** Canonical tags, default first, in declaration order. */
  locales: string[];
  routing: LocaleRouting;
}

const DEFAULT_ROUTING: LocaleRouting = "prefix-except-default";

/**
 * Validate and canonicalize `i18n`.
 *
 * A malformed tag is a **build error**, not a warning. A locale is a URL prefix, an `hreflang`
 * value and an `<html lang>` all at once, so a typo does not degrade — it produces a site whose
 * every page claims a language that does not exist, and nothing downstream can tell.
 *
 * @param {ProjectConfig} projectConfig
 * @returns {{ i18n: ResolvedI18n | null; errors: string[] }}
 */
export function resolveI18n(projectConfig: ProjectConfig): {
  i18n: ResolvedI18n | null;
  errors: string[];
} {
  const raw = projectConfig.i18n;
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { errors, i18n: null };
  }

  const declared = Array.isArray(raw.locales) ? raw.locales : [];
  const locales: string[] = [];
  for (const tag of declared) {
    const canonical = canonicalizeLocale(tag);
    if (canonical === null) {
      errors.push(`i18n.locales: "${String(tag)}" is not a well-formed BCP 47 language tag.`);
      continue;
    }
    if (!locales.includes(canonical)) {
      locales.push(canonical);
    }
  }

  const defaultLocale = canonicalizeLocale(raw.defaultLocale) ?? locales[0] ?? null;
  if (raw.defaultLocale !== undefined && canonicalizeLocale(raw.defaultLocale) === null) {
    errors.push(
      `i18n.defaultLocale: "${String(raw.defaultLocale)}" is not a well-formed BCP 47 language tag.`,
    );
  }
  if (defaultLocale === null) {
    errors.push("i18n is declared with no usable locale — set `defaultLocale` or `locales`.");
    return { errors, i18n: null };
  }
  if (!locales.includes(defaultLocale)) {
    // A default outside the list is a config the author cannot have meant either way round, so it
    // Joins the list rather than being rejected: the pages under it exist regardless.
    locales.unshift(defaultLocale);
  }

  const routing: LocaleRouting =
    raw.routing === "prefix-always" || raw.routing === "prefix-except-default"
      ? raw.routing
      : DEFAULT_ROUTING;

  return { errors, i18n: { defaultLocale, locales, routing } };
}

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
 * one another. Nothing else could establish that — Jx has no translation metadata, and there is no
 * per-page id to join on — so the directory layout **is** the mapping. That is a real limitation: a
 * localized slug (`/fr-ca/a-propos/`) is not recognized as a translation of `/about/`.
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
 * @param {readonly { urlPattern: string }[]} routes - Concrete routes only
 * @param {ResolvedI18n | null} i18n
 * @param {string} siteUrl - Absolute site URL; alternates must be absolute
 * @returns {Map<string, LocaleAlternate[]>} Keyed by `urlPattern`
 */
export function localeAlternates(
  routes: readonly { urlPattern: string }[],
  i18n: ResolvedI18n | null,
  siteUrl: string,
): Map<string, LocaleAlternate[]> {
  const out = new Map<string, LocaleAlternate[]>();
  if (i18n === null || siteUrl === "") {
    return out;
  }

  const sets = new Map<string, { locale: string; urlPattern: string }[]>();
  for (const route of routes) {
    const key = translationKey(route.urlPattern, i18n);
    const locale = localeOfRoute(route.urlPattern, i18n);
    if (locale === null) {
      continue;
    }
    const members = sets.get(key) ?? [];
    // A duplicate locale in one set means two routes claim the same translation; the first wins,
    // Which keeps the annotation single-valued rather than emitting a contradiction.
    if (!members.some((m) => m.locale === locale)) {
      members.push({ locale, urlPattern: route.urlPattern });
    }
    sets.set(key, members);
  }

  for (const members of sets.values()) {
    if (members.length < 2) {
      continue;
    }
    const ordered = members.toSorted((a, b) =>
      a.locale === b.locale ? 0 : a.locale < b.locale ? -1 : 1,
    );
    const alternates: LocaleAlternate[] = ordered.map((m) => ({
      href: new URL(m.urlPattern, siteUrl).href,
      hreflang: m.locale,
    }));
    const fallback = ordered.find((m) => m.locale === i18n.defaultLocale);
    if (fallback !== undefined) {
      alternates.push({
        href: new URL(fallback.urlPattern, siteUrl).href,
        hreflang: "x-default",
      });
    }
    for (const member of members) {
      out.set(member.urlPattern, alternates);
    }
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
