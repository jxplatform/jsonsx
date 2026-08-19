import { describe, expect, test } from "bun:test";
import {
  canonicalizeLocale,
  isWellFormedLocale,
  LANGUAGE_TAG_PATTERN,
  localeDirection,
  localeLabel,
  localeOfPath,
  localeUrlPrefix,
  servedLocaleOfPath,
  primaryLanguage,
  resolveI18n,
  translationKeyOfPath,
  translationPathFor,
} from "../src/locale.ts";
import type { ProjectConfig } from "../types.ts";

const project = (i18n?: ProjectConfig["i18n"]): ProjectConfig =>
  ({ name: "Test", ...(i18n === undefined ? {} : { i18n }) }) as ProjectConfig;

describe("resolveI18n", () => {
  test("a project without i18n resolves to null, not to a default", () => {
    expect(resolveI18n(project())).toEqual({ errors: [], i18n: null });
  });

  test("canonicalizes every tag", () => {
    const { i18n } = resolveI18n(project({ defaultLocale: "EN", locales: ["en", "fr-ca", "AR"] }));
    expect(i18n?.defaultLocale).toBe("en");
    expect(i18n?.locales).toEqual(["en", "fr-CA", "ar"]);
  });

  /*
   * A malformed tag is an error rather than a warning because a locale is a URL prefix, an
   * `hreflang` value and an `<html lang>` at once. It does not degrade — it produces a site whose
   * pages claim a language that does not exist, and nothing downstream can tell.
   */
  test("a malformed tag is a build error", () => {
    const { errors, i18n } = resolveI18n(project({ locales: ["en", "not_a_tag"] }));
    expect(errors[0]).toContain("not_a_tag");
    expect(i18n?.locales).toEqual(["en"]);
  });

  test("a malformed defaultLocale is reported and falls back to the first locale", () => {
    const { errors, i18n } = resolveI18n(project({ defaultLocale: "en_US", locales: ["fr"] }));
    expect(errors[0]).toContain("en_US");
    expect(i18n?.defaultLocale).toBe("fr");
  });

  // A default outside the list is a config that cannot have been meant either way, and the pages
  // Under it exist regardless — so it joins the list rather than being rejected.
  test("a default missing from locales joins the front of the list", () => {
    const { i18n } = resolveI18n(project({ defaultLocale: "de", locales: ["en", "fr"] }));
    expect(i18n?.locales).toEqual(["de", "en", "fr"]);
  });

  test("duplicates collapse after canonicalization", () => {
    const { i18n } = resolveI18n(project({ defaultLocale: "en", locales: ["en", "EN", "en-us"] }));
    expect(i18n?.locales).toEqual(["en", "en-US"]);
  });

  test("i18n with no usable locale is an error", () => {
    const { errors, i18n } = resolveI18n(project({ locales: [] }));
    expect(errors[0]).toContain("no usable locale");
    expect(i18n).toBeNull();
  });

  test("routing defaults to prefix-except-default", () => {
    expect(resolveI18n(project({ defaultLocale: "en" })).i18n?.routing).toBe(
      "prefix-except-default",
    );
    expect(
      resolveI18n(project({ defaultLocale: "en", routing: "prefix-always" })).i18n?.routing,
    ).toBe("prefix-always");
  });
});

describe("the path-shaped locale primitives", () => {
  const { i18n } = resolveI18n(project({ defaultLocale: "en", locales: ["en", "fr-CA", "ar"] }));
  const always = resolveI18n(
    project({ defaultLocale: "en", locales: ["en", "fr-CA"], routing: "prefix-always" }),
  ).i18n;

  /*
   * Studio holds files where the compiler holds routes, and the locale is a directory in both of
   * the layouts §13 defines — but not at the same depth. One rule reads both.
   */
  test("a file's locale is the segment that names a declared one", () => {
    expect(localeOfPath("pages/fr-ca/about.json", i18n)).toBe("fr-CA");
    expect(localeOfPath("content/blog/ar/hello.md", i18n)).toBe("ar");
    expect(localeOfPath("./pages/AR/index.json", i18n)).toBe("ar");
  });

  /*
   * `null` rather than the default locale, deliberately: whether an unprefixed page IS the default
   * locale's copy depends on `routing`, which is the caller's question.
   */
  test("a file under no locale segment answers null, not the default", () => {
    expect(localeOfPath("pages/about.json", i18n)).toBeNull();
    expect(localeOfPath("layouts/main.json", i18n)).toBeNull();
    expect(localeOfPath("pages/docs/guide.json", i18n)).toBeNull();
    expect(localeOfPath("pages/fr-ca/about.json", null)).toBeNull();
  });

  /*
   * Every URL-shaped consumer needs this rule and none of them may spell it themselves: a search
   * result or a feed entry that skips the prefix links a French post at the English URL.
   */
  test("a locale's URL prefix follows routing, and nothing else", () => {
    expect(localeUrlPrefix("fr-CA", i18n)).toBe("/fr-ca");
    expect(localeUrlPrefix("en", i18n)).toBe("");
    expect(localeUrlPrefix("en", always)).toBe("/en");
    expect(localeUrlPrefix("fr-CA", always)).toBe("/fr-ca");
  });

  test("an undeclared, malformed or absent locale has no prefix", () => {
    expect(localeUrlPrefix("de", i18n)).toBe("");
    expect(localeUrlPrefix("not_a_tag", i18n)).toBe("");
    expect(localeUrlPrefix(null, i18n)).toBe("");
    expect(localeUrlPrefix("fr-CA", null)).toBe("");
  });

  /*
   * The one thing the path cannot answer, answered by the caller that has `routing`: under
   * `prefix-except-default` an unprefixed page IS the default locale's copy. A surface that could
   * filter to French and Arabic but never to English is a language filter that cannot answer the
   * question it is most often asked.
   */
  test("a page with no locale segment is served as the default — where routing says so", () => {
    expect(servedLocaleOfPath("pages/about.json", i18n)).toBe("en");
    expect(servedLocaleOfPath("pages/fr-ca/about.json", i18n)).toBe("fr-CA");
    // Under prefix-always that page is outside the locale tree, which §13.2 calls a mistake rather
    // Than a language, so this says nothing about it either.
    expect(servedLocaleOfPath("pages/about.json", always)).toBeNull();
    expect(servedLocaleOfPath("pages/fr-ca/about.json", always)).toBe("fr-CA");
  });

  /*
   * Stops at `pages/`. An unlocalized collection expands under every locale's route, so calling its
   * entries the default language would be a claim about content that is in none — and a layout is
   * shared by every locale rather than belonging to one.
   */
  test("nothing outside pages/ is claimed for a language it did not name", () => {
    expect(servedLocaleOfPath("content/blog/hello.md", i18n)).toBeNull();
    expect(servedLocaleOfPath("layouts/main.json", i18n)).toBeNull();
    expect(servedLocaleOfPath("pages/about.json", null)).toBeNull();
    // A localized entry still answers with its own directory's language.
    expect(servedLocaleOfPath("content/blog/ar/hello.md", i18n)).toBe("ar");
  });

  test("two copies of one page share a key", () => {
    expect(translationKeyOfPath("pages/fr-ca/about.json", i18n)).toBe("pages/about.json");
    expect(translationKeyOfPath("pages/about.json", i18n)).toBe("pages/about.json");
    expect(translationKeyOfPath("content/blog/ar/hello.md", i18n)).toBe("content/blog/hello.md");
    expect(translationKeyOfPath("layouts/main.json", null)).toBe("layouts/main.json");
  });

  /*
   * The asymmetry `routing` exists to express: under `prefix-except-default` the default locale's
   * copy is the unprefixed path, under `prefix-always` it is prefixed like every other. Getting it
   * wrong creates the file somewhere no router looks.
   */
  test("the default locale's copy is prefixed only under prefix-always", () => {
    expect(translationPathFor("pages/fr-ca/about.json", "en", i18n)).toBe("pages/about.json");
    expect(translationPathFor("pages/fr-ca/about.json", "en", always)).toBe("pages/en/about.json");
  });

  test("a locale segment goes below the routing root, wherever that is", () => {
    expect(translationPathFor("pages/about.json", "fr-CA", i18n)).toBe("pages/fr-ca/about.json");
    expect(translationPathFor("content/blog/hello.md", "ar", i18n)).toBe(
      "content/blog/ar/hello.md",
    );
    expect(translationPathFor("pages/docs/guide.json", "ar", i18n)).toBe(
      "pages/ar/docs/guide.json",
    );
  });

  /*
   * The directory is lowercase whatever case the tag was declared in: the build matches
   * case-insensitively, but the URL carries whatever the directory says, and lowercase is what the
   * build already tells an author with a mismatched directory to write.
   */
  test("the directory is lowercase, and the tag it reads back is canonical", () => {
    expect(translationPathFor("pages/about.json", "FR-ca", i18n)).toBe("pages/fr-ca/about.json");
    expect(localeOfPath("pages/fr-ca/about.json", i18n)).toBe("fr-CA");
  });

  // Round trip: every declared locale's path reduces to the one key, for both layouts.
  test("a path and its key are inverses for every declared locale", () => {
    for (const source of ["pages/about.json", "content/blog/hello.md"]) {
      for (const locale of i18n?.locales ?? []) {
        const path = translationPathFor(source, locale, i18n)!;
        expect(translationKeyOfPath(path, i18n)).toBe(source);
        expect(localeOfPath(path, i18n) ?? i18n?.defaultLocale).toBe(locale);
      }
    }
  });

  /*
   * A layout is shared by every locale and a component has no URL to be a translation of, so
   * inventing a location for either would put a file where nothing serves it.
   */
  test("a file that cannot carry a locale gets no path, and neither does an undeclared tag", () => {
    expect(translationPathFor("layouts/main.json", "ar", i18n)).toBeNull();
    expect(translationPathFor("project.json", "ar", i18n)).toBeNull();
    expect(translationPathFor("content/blog", "ar", i18n)).toBeNull();
    expect(translationPathFor("pages/about.json", "de", i18n)).toBeNull();
    expect(translationPathFor("pages/about.json", "not_a_tag", i18n)).toBeNull();
    expect(translationPathFor("pages/about.json", "ar", null)).toBeNull();
  });
});

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
