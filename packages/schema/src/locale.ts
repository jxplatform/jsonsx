/**
 * BCP 47 language tags: well-formedness, canonical case, and writing direction.
 *
 * One implementation for the repo — `i18n.locales`, a document's `$lang`, and anything else that
 * accepts a language tag all come through here, so a tag that builds in one place cannot fail in
 * another.
 *
 * The grammar and the case conventions come from `Intl.Locale`, which is ECMA-402's parser for
 * exactly this and is already in every runtime Jx targets. Note what that does and does not buy:
 * `Intl.Locale` enforces the RFC 5646 **grammar**, so `en_US` and `en--US` are rejected, but it
 * does not consult the IANA registry, so `zz` and `xx-YY` are well-formed tags for languages that
 * do not exist. Registry membership is not checked here either; a typo'd region is the author's to
 * catch.
 *
 * Pure string math and `Intl` — no node imports — so browser hosts can import this module.
 *
 * @docs framework/site/i18n
 */

/* Type-only, so this module still imports nothing at runtime and a browser host can load it. */
import type { ProjectConfig } from "../types.ts";

/**
 * Scripts written right to left (ISO 15924, per UAX #9).
 *
 * Direction is decided by **script**, not by language, and not by `Intl.Locale`'s own
 * `getTextInfo()`. That method answers from the language's CLDR entry, which gets two ordinary
 * cases wrong: `dv` (Dhivehi, written in Thaana) reports `ltr` where an ICU build lacks its data,
 * and `az-Arab` — Azerbaijani deliberately written in the Arabic script — reports `ltr` because the
 * language's default script is Latin. Maximizing the tag and reading the script is right in both.
 */
const RTL_SCRIPTS = new Set([
  "Adlm",
  "Arab",
  "Aran",
  "Armi",
  "Avst",
  "Cprt",
  "Egyd",
  "Egyh",
  "Elym",
  "Gara",
  "Hatr",
  "Hebr",
  "Hluw",
  "Hung",
  "Khar",
  "Lydi",
  "Mand",
  "Mani",
  "Mend",
  "Merc",
  "Mero",
  "Narb",
  "Nbat",
  "Nkoo",
  "Orkh",
  "Palm",
  "Phli",
  "Phlp",
  "Phnx",
  "Prti",
  "Rohg",
  "Samr",
  "Sarb",
  "Sogd",
  "Sogo",
  "Syrc",
  "Thaa",
  "Todr",
  "Yezi",
]);

/** Writing direction of a language tag's text. */
export type TextDirection = "ltr" | "rtl";

/**
 * The shape of a language tag, as a regular expression a JSON Schema `pattern` can hold.
 *
 * Deliberately **looser** than {@link canonicalizeLocale}, and deliberately not RFC 5646's grammar.
 * That grammar distinguishes subtags by length _and_ position, and admits grandfathered and
 * private-use forms (`i-klingon`, `x-whatever`); a regex encoding all of it would be unreadable and
 * still wrong at the edges. What this catches is the class of mistake an author actually makes — an
 * underscore where a hyphen belongs (`en_US`), an empty subtag (`en--US`, `en-US-`), a one-letter
 * primary language, a subtag past eight characters.
 *
 * The direction of the inequality is the contract: this accepts **every** tag `Intl.Locale`
 * accepts, so a value the build canonicalizes can never fail `jx validate`. The reverse is allowed
 * and expected — `zh-min-nan` matches here and throws there — because the build stays the authority
 * on well-formedness. This only closes the case where author-time accepted a value build-time was
 * certain to reject.
 */
export const LANGUAGE_TAG_PATTERN = "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$";

/**
 * The canonical spelling of a well-formed language tag, or null when the tag is malformed.
 *
 * Canonical case is BCP 47's: language lowercase, script titlecase, region uppercase. `EN-us`
 * becomes `en-US`, which matters because a tag is compared as a string in a route table and in a
 * `hreflang` attribute.
 *
 * @param {unknown} tag
 * @returns {string | null}
 */
export function canonicalizeLocale(tag: unknown): string | null {
  if (typeof tag !== "string" || tag.trim() === "") {
    return null;
  }
  try {
    return new Intl.Locale(tag.trim()).toString();
  } catch {
    return null;
  }
}

/** True when the tag is a well-formed BCP 47 language tag. */
export function isWellFormedLocale(tag: unknown): boolean {
  return canonicalizeLocale(tag) !== null;
}

/**
 * The writing direction a tag's text is set in.
 *
 * A malformed tag is `"ltr"` rather than an error: this is called while rendering, where the
 * validation has already happened at config load, and guessing left-to-right is what every browser
 * does with an unusable `lang`.
 *
 * @param {unknown} tag
 * @returns {TextDirection}
 */
export function localeDirection(tag: unknown): TextDirection {
  const canonical = canonicalizeLocale(tag);
  if (canonical === null) {
    return "ltr";
  }
  // No try/catch: `canonicalizeLocale` already constructed this exact tag, so the constructor
  // Cannot throw here and a guard would be an untestable branch pretending otherwise.
  const locale = new Intl.Locale(canonical);
  // An explicit script wins; otherwise CLDR's likely-subtags (UTS #35) supplies one.
  const script = locale.script ?? locale.maximize().script;
  return script !== undefined && RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
}

/**
 * A locale's name **in its own language**: `français` for `fr`, `العربية` for `ar`.
 *
 * The autonym, not the name in the site's language, because that is what a reader looking for their
 * own language scans a switcher for — a menu that says "French" is unreadable to precisely the
 * person it exists for.
 *
 * Resolved here rather than left to `Intl/displayName` in the document, because a switcher is a
 * mapped array and a map template interpolates scope values rather than evaluating expressions:
 * without this the only label available to an author is one they typed themselves, which is the
 * hand-kept table CLDR exists to replace.
 *
 * Falls back to the tag. `Intl.DisplayNames` answers with the code itself for a language it has no
 * name for, which is the same answer and a better one than an empty menu entry.
 *
 * No try/catch, for the reason {@link localeDirection} gives: the tag has already been through
 * `Intl.Locale` here, so neither the constructor nor `of` can reject it, and a guard would be an
 * untestable branch pretending otherwise.
 *
 * @param {unknown} tag
 * @returns {string}
 */
export function localeLabel(tag: unknown): string {
  const canonical = canonicalizeLocale(tag);
  if (canonical === null) {
    return typeof tag === "string" ? tag : "";
  }
  return new Intl.DisplayNames([canonical], { type: "language" }).of(canonical) ?? canonical;
}

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
 * Validate and canonicalize a project's `i18n` block.
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
 * The URL prefix a locale's pages carry: `/fr-ca`, or `""` for a locale that is not prefixed.
 *
 * The one rule `routing` expresses, in the one form every URL-shaped consumer needs. Under
 * `prefix-except-default` the default locale owns the unprefixed URL space; under `prefix-always`
 * every locale is named, including the default. An extension that spells this itself is how a
 * search result or a feed entry comes to link at the default locale's URL for a French post.
 *
 * Lowercase, matching the directory the build reads (see {@link translationPathFor}).
 *
 * @param {string | null | undefined} locale
 * @param {ResolvedI18n | null} i18n
 * @returns {string} `""` or `/<tag>`
 */
export function localeUrlPrefix(
  locale: string | null | undefined,
  i18n: ResolvedI18n | null,
): string {
  if (i18n === null) {
    return "";
  }
  const canonical = canonicalizeLocale(locale);
  if (canonical === null || !i18n.locales.includes(canonical)) {
    return "";
  }
  if (canonical === i18n.defaultLocale && i18n.routing === "prefix-except-default") {
    return "";
  }
  return `/${canonical.toLowerCase()}`;
}

/**
 * The locale a project **file** belongs to: the first path segment that canonicalizes to a declared
 * locale, or null when no segment does.
 *
 * One rule for both layouts §13 defines — `pages/fr/about.json` and `content/blog/fr/hello.md` —
 * because the locale is a directory in both and its position is not the same in the two.
 *
 * `null` for `pages/about.json` is the honest answer rather than the default locale: under
 * `prefix-except-default` that file is the default locale's copy, and under `prefix-always` it is a
 * page outside the locale tree. Which of those it is depends on `routing`, which is the caller's
 * question, not this function's.
 *
 * @param {string} path - Project-relative, `/`-separated
 * @param {ResolvedI18n | null} i18n
 * @returns {string | null}
 */
export function localeOfPath(path: string, i18n: ResolvedI18n | null): string | null {
  const index = localeSegment(pathSegments(path), i18n);
  if (index === -1 || i18n === null) {
    return null;
  }
  return canonicalizeLocale(pathSegments(path)[index]);
}

/**
 * The locale a **page** is served as, which is {@link localeOfPath} plus the one thing routing
 * says.
 *
 * `localeOfPath` answers null for `pages/about.json` because the path alone cannot tell you whether
 * that file is the default locale's copy or a page outside the locale tree — `routing` decides, and
 * that is the caller's question. This is the caller that has it: under `prefix-except-default` the
 * unprefixed page **is** the default locale's, and a surface that could filter to French and Arabic
 * but never to English is a language filter that cannot answer the question it is most often
 * asked.
 *
 * Scoped to `pages/` deliberately. An unlocalized **collection** expands under every locale's route
 * (§13.3), so calling its entries the default language would be a claim about content that is in
 * none — and a layout is shared by every locale rather than belonging to one.
 *
 * @param {string} path - Project-relative
 * @param {ResolvedI18n | null} i18n
 * @returns {string | null}
 */
export function servedLocaleOfPath(path: string, i18n: ResolvedI18n | null): string | null {
  const own = localeOfPath(path, i18n);
  if (own !== null || i18n === null || i18n.routing !== "prefix-except-default") {
    return own;
  }
  return pathSegments(path)[0] === "pages" ? i18n.defaultLocale : null;
}

/**
 * A file's identity across languages: its path with the locale segment removed.
 *
 * `pages/fr/about.json` and `pages/about.json` share the key `pages/about.json`. The file-shaped
 * sibling of the compiler's route-shaped `translationKey`, and the same idea: what makes two
 * documents the same page is that they agree once the language is taken out.
 *
 * @param {string} path
 * @param {ResolvedI18n | null} i18n
 * @returns {string}
 */
export function translationKeyOfPath(path: string, i18n: ResolvedI18n | null): string {
  const segments = pathSegments(path);
  const index = localeSegment(segments, i18n);
  return index === -1 ? segments.join("/") : segments.filter((_, i) => i !== index).join("/");
}

/**
 * Where this file's copy in `locale` lives — the inverse of {@link translationKeyOfPath}.
 *
 * **`routing` decides whether the default locale is prefixed**, and that asymmetry is its whole
 * meaning: under `prefix-except-default` the default locale's copy is the unprefixed path, under
 * `prefix-always` it is prefixed like every other. A caller that ignores it creates the file in a
 * place nothing serves.
 *
 * Null when the project declares no locales, when the tag is not one of them, or when the path
 * cannot carry a locale at all — a layout, a component, a bare file at the project root. Inventing
 * a location for those would put a translation somewhere no router looks.
 *
 * @param {string} path
 * @param {string} locale
 * @param {ResolvedI18n | null} i18n
 * @returns {string | null}
 */
export function translationPathFor(
  path: string,
  locale: string,
  i18n: ResolvedI18n | null,
): string | null {
  if (i18n === null) {
    return null;
  }
  const canonical = canonicalizeLocale(locale);
  if (canonical === null || !i18n.locales.includes(canonical)) {
    return null;
  }
  const segments = pathSegments(path);
  const existing = localeSegment(segments, i18n);
  const slot = existing === -1 ? localeSlot(segments) : existing;
  if (slot === -1) {
    return null;
  }
  const bare = existing === -1 ? segments : segments.filter((_, i) => i !== existing);
  if (canonical === i18n.defaultLocale && i18n.routing === "prefix-except-default") {
    return bare.join("/");
  }
  /*
   * Lowercase on disk. The build matches a directory to a locale case-insensitively, so `fr-CA/`
   * would work — but the URL it produces would carry the capitals, and the warning the build
   * already gives an author with a mismatched directory tells them to write the lowercase form.
   * One spelling, and it is the one the site's own URLs use.
   */
  return bare.toSpliced(slot, 0, canonical.toLowerCase()).join("/");
}

/** Project-relative segments, tolerating a leading `./`. */
function pathSegments(path: string): string[] {
  return path.replace(/^\.\//, "").split("/").filter(Boolean);
}

/** The index of the segment naming a declared locale, or -1. */
function localeSegment(segments: readonly string[], i18n: ResolvedI18n | null): number {
  if (i18n === null) {
    return -1;
  }
  return segments.findIndex((segment) => {
    const canonical = canonicalizeLocale(segment);
    return canonical !== null && i18n.locales.includes(canonical);
  });
}

/**
 * Where a locale segment would go in a path that has none, or -1 when it could not have one.
 *
 * Immediately below the routing root: `pages/<locale>/…` and `content/<type>/<locale>/…`, which is
 * where §13.1 puts a locale directory and where §13.3's `source: "./blog/{locale}/"` expands to. A
 * file that is neither is not addressable per language — a layout is shared by every locale, and a
 * component has no URL to be a translation of.
 */
function localeSlot(segments: readonly string[]): number {
  if (segments[0] === "pages" && segments.length > 1) {
    return 1;
  }
  if (segments[0] === "content" && segments.length > 2) {
    return 2;
  }
  return -1;
}

/** The primary language subtag of a tag: `en` for `en-GB`, `zh` for `zh-Hant-TW`. */
export function primaryLanguage(tag: unknown): string | null {
  const canonical = canonicalizeLocale(tag);
  return canonical === null ? null : (canonical.split("-")[0] ?? null);
}
