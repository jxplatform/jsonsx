/**
 * Sending a visitor to their own language: RFC 4647 Lookup over `Accept-Language`.
 *
 * Discovery already ships — a translated page advertises its siblings with `hreflang` alternates
 * and `xhtml:link` entries, so a crawler can find every translation. What that does **not** do is
 * route a person. A visitor arriving at the bare `/` gets whatever `/` happens to hold, and their
 * `Accept-Language` header — the one thing that says which language they read — is never
 * consulted.
 *
 * **Not every deployment can fix that, and the honest thing is to say which.** Negotiation needs a
 * request, and adapter-less static output has no runtime that sees one: `dist/` is files, and the
 * preview server is a pure file mapper. That is a permanent property of the output shape, not
 * missing work. A site with `build.adapter` set gets a generated worker, the worker sees the
 * request, and this is where it decides.
 *
 * Two things this deliberately does NOT do:
 *
 * - **It negotiates the bare `/` only.** A visitor who asked for `/fr/about/` has expressed a
 *   preference far stronger than a header, and overriding it would make a shared link mean
 *   different things to different people.
 * - **It never guesses from an IP address.** Where someone is has never been what they read.
 *
 * @docs framework/site/i18n
 */

import type { ResolvedI18n } from "./i18n.ts";

/** One `Accept-Language` entry: a language range and the quality it was offered at. */
interface WeightedRange {
  range: string;
  quality: number;
}

/**
 * Parse `Accept-Language` into ranges, best first (RFC 9110 §12.5.4).
 *
 * `q=0` means **not acceptable**, so those ranges are dropped rather than ranked last — a visitor
 * who wrote `de;q=0` is saying "not German", and treating that as a weak preference for German
 * would be exactly backwards. Ties keep their header order, which is the conventional reading of an
 * unweighted list.
 *
 * @param {string} header
 * @returns {WeightedRange[]}
 */
export function parseAcceptLanguage(header: string): WeightedRange[] {
  const parsed: { entry: WeightedRange; at: number }[] = [];
  for (const [index, part] of header.split(",").entries()) {
    const [rawRange, ...params] = part.split(";");
    const range = (rawRange ?? "").trim().toLowerCase();
    if (range === "") {
      continue;
    }
    let quality = 1;
    for (const param of params) {
      const [name, value] = param.split("=");
      if ((name ?? "").trim().toLowerCase() === "q") {
        // A malformed qvalue is a malformed header field; NaN falls through to the drop below.
        const parsedQuality = Number((value ?? "").trim());
        quality = Number.isNaN(parsedQuality) ? 0 : parsedQuality;
      }
    }
    if (quality <= 0) {
      continue;
    }
    parsed.push({ at: index, entry: { quality, range } });
  }
  return parsed
    .toSorted((a, b) => b.entry.quality - a.entry.quality || a.at - b.at)
    .map((p) => p.entry);
}

/**
 * The available tag a single language range selects, or null (RFC 4647 §3.4, Lookup).
 *
 * Lookup, not Filtering, and the difference is the whole point: Filtering returns every tag that
 * matches, which is the right answer for a content-negotiation menu and the wrong one for "which
 * page do I send this person to". A visitor gets one page.
 *
 * The algorithm is progressive truncation — `de-CH-1901` tries `de-CH-1901`, then `de-CH`, then
 * `de`. A single-character subtag is removed together with the one before it, because a lone `x` or
 * `u` is an extension singleton and never a tag on its own.
 *
 * @param {string} range - A lower-cased language range
 * @param {readonly string[]} available - Canonical tags, in preference order
 * @returns {string | null}
 */
export function lookupRange(range: string, available: readonly string[]): string | null {
  let candidate = range;
  while (candidate !== "") {
    const wanted = candidate;
    const match = available.find((tag) => tag.toLowerCase() === wanted);
    if (match !== undefined) {
      return match;
    }
    const cut = candidate.lastIndexOf("-");
    if (cut === -1) {
      return null;
    }
    candidate = candidate.slice(0, cut);
    // A trailing single-character subtag is a singleton, never a tag — drop it with its parent.
    const previous = candidate.lastIndexOf("-");
    if (candidate.length - previous === 2) {
      candidate = candidate.slice(0, previous);
    }
  }
  return null;
}

/**
 * The locale to serve a request carrying this `Accept-Language`, always one of `available`.
 *
 * `*` selects the first available locale, which is the declared default: the range means "anything
 * is acceptable", and the site's own preference is the only tie-break there is.
 *
 * @param {string | null | undefined} header - The raw `Accept-Language`, if any
 * @param {readonly string[]} available - Canonical tags, default first
 * @param {string} fallback - The locale to serve when nothing matches
 * @returns {string}
 */
export function negotiateLocale(
  header: string | null | undefined,
  available: readonly string[],
  fallback: string,
): string {
  if (typeof header !== "string" || header.trim() === "") {
    return fallback;
  }
  for (const { range } of parseAcceptLanguage(header)) {
    if (range === "*") {
      return available[0] ?? fallback;
    }
    const match = lookupRange(range, available);
    if (match !== null) {
      return match;
    }
  }
  return fallback;
}

/**
 * The site-absolute path a locale's home page lives at.
 *
 * Under `prefix-except-default` the default locale has no prefix, which is what makes `/` a real
 * page there and a redirect target nowhere else.
 *
 * @param {string} locale - A canonical tag
 * @param {ResolvedI18n} i18n
 * @returns {string}
 */
export function localeHome(locale: string, i18n: ResolvedI18n): string {
  if (i18n.routing === "prefix-except-default" && locale === i18n.defaultLocale) {
    return "/";
  }
  return `/${locale.toLowerCase()}/`;
}

/**
 * The negotiation middleware for the generated worker, or `""` when there is nothing to negotiate.
 *
 * Emitted as source text rather than imported, matching every other generated artefact here — the
 * worker is bundled from the _project_ root, so a compiler-internal import would not resolve. The
 * copy cannot silently drift: a test evaluates this source and runs the same corpus through it as
 * through {@link negotiateLocale}, failing on the first disagreement.
 *
 * **Middleware, not a route.** When negotiation lands on the locale `/` already serves, the request
 * must continue down the ordinary chain — the ASSETS binding on Cloudflare, static serving
 * elsewhere. A route would have to reproduce whichever of those the adapter uses; `await next()`
 * does not have to know.
 *
 * **`Vary: Accept-Language` is not optional.** Without it any cache in front of the site stores the
 * first visitor's answer and serves it to everyone, which turns a helpful default into a site stuck
 * in one language for every later reader. That is worse than not negotiating at all, and it is
 * invisible to the author — whose own browser was the first visitor.
 *
 * @param {ResolvedI18n | null} i18n
 * @returns {string} JS source, or "" when the site declares fewer than two locales
 */
export function localeNegotiationMiddleware(i18n: ResolvedI18n | null): string {
  if (i18n === null || i18n.locales.length < 2) {
    return "";
  }
  const locales = JSON.stringify(i18n.locales);
  const fallback = JSON.stringify(i18n.defaultLocale);
  const homes = JSON.stringify(
    Object.fromEntries(i18n.locales.map((locale) => [locale, localeHome(locale, i18n)])),
  );

  return `
// ─── Locale negotiation (RFC 4647 Lookup over Accept-Language) ───────────────
const JX_LOCALES = ${locales}
const JX_DEFAULT_LOCALE = ${fallback}
const JX_LOCALE_HOMES = ${homes}

function jxParseAcceptLanguage(header) {
  const parsed = []
  header.split(',').forEach((part, index) => {
    const [rawRange, ...params] = part.split(';')
    const range = (rawRange || '').trim().toLowerCase()
    if (range === '') return
    let quality = 1
    for (const param of params) {
      const [name, value] = param.split('=')
      if ((name || '').trim().toLowerCase() === 'q') {
        const q = Number((value || '').trim())
        quality = Number.isNaN(q) ? 0 : q
      }
    }
    if (quality <= 0) return
    parsed.push({ at: index, quality, range })
  })
  return parsed.sort((a, b) => b.quality - a.quality || a.at - b.at).map((p) => p.range)
}

function jxLookupRange(range, available) {
  let candidate = range
  while (candidate !== '') {
    const wanted = candidate
    const match = available.find((tag) => tag.toLowerCase() === wanted)
    if (match !== undefined) return match
    const cut = candidate.lastIndexOf('-')
    if (cut === -1) return null
    candidate = candidate.slice(0, cut)
    const previous = candidate.lastIndexOf('-')
    if (candidate.length - previous === 2) candidate = candidate.slice(0, previous)
  }
  return null
}

function jxNegotiateLocale(header, available, fallback) {
  if (typeof header !== 'string' || header.trim() === '') return fallback
  for (const range of jxParseAcceptLanguage(header)) {
    if (range === '*') return available[0] || fallback
    const match = jxLookupRange(range, available)
    if (match !== null) return match
  }
  return fallback
}

app.use('/', async (c, next) => {
  const locale = jxNegotiateLocale(c.req.header('accept-language'), JX_LOCALES, JX_DEFAULT_LOCALE)
  const home = JX_LOCALE_HOMES[locale] || '/'
  if (home !== '/') {
    // 302, never 301: the target depends on the request, so it must never be cached as permanent.
    return new Response(null, {
      headers: { 'Content-Language': locale, Location: home, Vary: 'Accept-Language' },
      status: 302,
    })
  }
  // '/' already holds this locale (prefix-except-default). Let the chain serve it, then say the
  // Response depended on the header — a cache that missed this would pin every visitor to it.
  await next()
  const res = new Response(c.res.body, c.res)
  res.headers.set('Vary', 'Accept-Language')
  res.headers.set('Content-Language', locale)
  c.res = res
})
`;
}
