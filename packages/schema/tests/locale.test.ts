import { describe, expect, test } from "bun:test";
import {
  canonicalizeLocale,
  isWellFormedLocale,
  localeDirection,
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

describe("primaryLanguage", () => {
  test("is the first subtag of a canonical tag", () => {
    expect(primaryLanguage("zh-Hant-TW")).toBe("zh");
    expect(primaryLanguage("EN-us")).toBe("en");
    expect(primaryLanguage("nope_")).toBeNull();
  });
});
