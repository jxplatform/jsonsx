import { describe, expect, test } from "bun:test";
import {
  canonicalizeLocale,
  isWellFormedLocale,
  LANGUAGE_TAG_PATTERN,
  localeDirection,
  localeLabel,
  primaryLanguage,
} from "../src/locale.ts";

describe("canonicalizeLocale", () => {
  test("applies BCP 47 case conventions", () => {
    expect(canonicalizeLocale("EN-us")).toBe("en-US");
    expect(canonicalizeLocale("zh-hant-tw")).toBe("zh-Hant-TW");
    expect(canonicalizeLocale("  fr-ca  ")).toBe("fr-CA");
  });

  test("rejects tags that break the grammar", () => {
    for (const tag of ["en_US", "en--US", "e", "en-US-", "", "   ", 42, null]) {
      expect(canonicalizeLocale(tag)).toBeNull();
    }
    expect(canonicalizeLocale(({} as { lang?: string }).lang)).toBeNull();
  });

  /*
   * Well-formedness is not registry membership, and this is deliberate. `zz` and `xx-YY` parse as
   * language tags for languages that do not exist; catching a typo'd region is the author's job,
   * and pretending otherwise would mean shipping and maintaining a copy of the IANA registry.
   */
  test("accepts well-formed tags for languages that do not exist", () => {
    expect(canonicalizeLocale("zz")).toBe("zz");
    expect(canonicalizeLocale("xx-YY")).toBe("xx-YY");
  });

  test("keeps extension subtags", () => {
    expect(canonicalizeLocale("en-Latn-US-u-ca-gregory")).toBe("en-Latn-US-u-ca-gregory");
  });
});

describe("isWellFormedLocale", () => {
  test("agrees with canonicalizeLocale", () => {
    expect(isWellFormedLocale("pt-BR")).toBe(true);
    expect(isWellFormedLocale("pt_BR")).toBe(false);
  });
});

describe("localeDirection", () => {
  test("left to right for Latin, Cyrillic and Han", () => {
    for (const tag of ["en", "de-DE", "sr-Cyrl", "zh-Hant-TW", "ja"]) {
      expect(localeDirection(tag)).toBe("ltr");
    }
  });

  test("right to left for Arabic and Hebrew languages", () => {
    for (const tag of ["ar", "he", "fa-IR", "ur", "ckb", "yi"]) {
      expect(localeDirection(tag)).toBe("rtl");
    }
  });

  /*
   * The two cases that make this script-based rather than language-based. `Intl.Locale`'s own
   * `getTextInfo()` answers from the language's CLDR entry and calls both of these `ltr`:
   * Dhivehi where the ICU build lacks its data, and Azerbaijani-in-Arabic because the language's
   * default script is Latin. Both are written right to left.
   */
  test("follows the script, not the language's default", () => {
    expect(localeDirection("dv")).toBe("rtl");
    expect(localeDirection("az-Arab")).toBe("rtl");
    expect(localeDirection("az")).toBe("ltr");
  });

  // Called while rendering, after validation has already run. Guessing ltr is what a browser does.
  test("a malformed tag is left to right rather than an error", () => {
    expect(localeDirection("not_a_tag")).toBe("ltr");
    expect(localeDirection(({} as { lang?: string }).lang)).toBe("ltr");
  });
});

describe("localeLabel", () => {
  /*
   * The autonym is the point. A language switcher exists for the reader who does not read the
   * site's current language, and a menu that says "French" is unreadable to precisely that person.
   */
  test("names a language in its own language", () => {
    expect(localeLabel("en")).toBe("English");
    expect(localeLabel("fr")).toBe("français");
    expect(localeLabel("ar")).toBe("العربية");
    expect(localeLabel("ja")).toBe("日本語");
  });

  test("canonicalizes first, so the spelling of the tag does not change the answer", () => {
    expect(localeLabel("EN-us")).toBe(localeLabel("en-US"));
  });

  /*
   * A tag CLDR has no name for answers with itself, which is a usable menu entry. A malformed one
   * answers with what it was given — this is called while rendering, where validation has already
   * happened, and an empty entry would be worse than an odd one.
   */
  test("falls back to the tag rather than to nothing", () => {
    expect(localeLabel("zz")).toBe("zz");
    expect(localeLabel("en_US")).toBe("en_US");
    expect(localeLabel(null)).toBe("");
    expect(localeLabel(42)).toBe("");
  });
});

describe("primaryLanguage", () => {
  test("is the first subtag of a canonical tag", () => {
    expect(primaryLanguage("zh-Hant-TW")).toBe("zh");
    expect(primaryLanguage("EN-us")).toBe("en");
    expect(primaryLanguage("nope_")).toBeNull();
  });
});

describe("LANGUAGE_TAG_PATTERN", () => {
  const pattern = new RegExp(LANGUAGE_TAG_PATTERN);

  test("rejects the shape errors an author actually makes", () => {
    for (const tag of ["en_US", "en--US", "en-US-", "-en", "e", "en-verylongsubtag", ""]) {
      expect(pattern.test(tag)).toBe(false);
    }
  });

  test("accepts ordinary tags, including extensions and private use", () => {
    for (const tag of [
      "en",
      "en-US",
      "zh-Hant-TW",
      "es-419",
      "de-DE-u-co-phonebk",
      "en-GB-oxendict",
      "qaa-Qaaa-QM-x-southern",
    ]) {
      expect(pattern.test(tag)).toBe(true);
    }
  });

  /*
   * The contract that makes the pattern safe to put in the schema, stated as an assertion rather
   * than as prose: author-time must never reject what build-time accepts. The reverse is allowed —
   * `zh-min-nan` matches the pattern and throws in `Intl.Locale` — because the build stays the
   * authority. Deleting this test is how the two would silently drift back apart.
   */
  test("accepts every tag canonicalizeLocale accepts", () => {
    const corpus = [
      "en",
      "EN-us",
      "fr-CA",
      "zh-hant-tw",
      "ar",
      "he-IL",
      "sr-Latn-RS",
      "es-419",
      "und",
      "tlh",
      "cmn-Hans-CN",
      "art-lojban",
      "hy-arevela",
      "ja-JP-u-ca-japanese",
      "de-DE-u-co-phonebk",
      "en-a-bbb-x-a-ccc",
      "qaa-Qaaa-QM-x-southern",
      "en_US",
      "en--US",
      "x-private",
      "i-klingon",
      "e",
    ];
    for (const tag of corpus) {
      if (canonicalizeLocale(tag) !== null) {
        expect({ matches: pattern.test(tag.trim()), tag }).toEqual({ matches: true, tag });
      }
    }
  });
});
