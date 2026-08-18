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

/** The primary language subtag of a tag: `en` for `en-GB`, `zh` for `zh-Hant-TW`. */
export function primaryLanguage(tag: unknown): string | null {
  const canonical = canonicalizeLocale(tag);
  return canonical === null ? null : (canonical.split("-")[0] ?? null);
}
