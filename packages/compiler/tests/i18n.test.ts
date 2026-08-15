import { describe, expect, test } from "bun:test";
import {
  localeAlternates,
  localeOfRoute,
  pageLanguage,
  resolveI18n,
  translationKey,
  undeclaredLocalePrefix,
} from "../src/site/i18n.ts";
import type { ProjectConfig } from "@jxsuite/schema/types";

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

describe("localeOfRoute", () => {
  const { i18n } = resolveI18n(project({ defaultLocale: "en", locales: ["en", "fr-ca", "ar"] }));

  test("the first segment decides, compared canonically", () => {
    expect(localeOfRoute("/fr-ca/about/", i18n)).toBe("fr-CA");
    expect(localeOfRoute("/FR-CA/about/", i18n)).toBe("fr-CA");
    expect(localeOfRoute("/ar/", i18n)).toBe("ar");
  });

  test("an unprefixed route is the default locale", () => {
    expect(localeOfRoute("/about/", i18n)).toBe("en");
    expect(localeOfRoute("/", i18n)).toBe("en");
  });

  test("a project without i18n has no locale at all", () => {
    expect(localeOfRoute("/fr/about/", null)).toBeNull();
  });
});

describe("undeclaredLocalePrefix", () => {
  const { i18n } = resolveI18n(project({ defaultLocale: "en", locales: ["en", "fr-ca"] }));

  /*
   * The mistake worth catching: `locales` says `fr-CA`, the pages live in `pages/fr/`, and every
   * page under it silently becomes English. There is no error and the page looks fine.
   */
  test("catches a directory naming the language of a declared locale", () => {
    expect(undeclaredLocalePrefix("/fr/about/", i18n)).toEqual({ meant: "fr-CA", segment: "fr" });
  });

  // Any 2-to-8-letter segment is a well-formed tag, so "looks like a tag" would fire on /docs/.
  test("says nothing about ordinary path segments", () => {
    for (const path of ["/docs/", "/api/v1/", "/it/", "/about/", "/"]) {
      expect(undeclaredLocalePrefix(path, i18n)).toBeNull();
    }
  });

  test("says nothing about a correctly declared prefix", () => {
    expect(undeclaredLocalePrefix("/fr-ca/about/", i18n)).toBeNull();
    expect(undeclaredLocalePrefix("/en/about/", i18n)).toBeNull();
  });

  test("says nothing when the project has no i18n", () => {
    expect(undeclaredLocalePrefix("/fr/", null)).toBeNull();
  });
});

describe("pageLanguage", () => {
  test("the route's locale becomes the page's lang", () => {
    expect(pageLanguage({ routeLocale: "fr-CA" })).toEqual({ lang: "fr-CA" });
  });

  // A page really can be a French translation at /en/a-propos/, and an author who writes `$lang`
  // Down means it.
  test("an explicit $lang beats the route", () => {
    expect(pageLanguage({ pageLang: "fr", routeLocale: "en" })).toEqual({ lang: "fr" });
  });

  test("falls back to defaults.lang, then to en", () => {
    expect(pageLanguage({ defaults: { lang: "de" } })).toEqual({ lang: "de" });
    expect(pageLanguage({})).toEqual({ lang: "en" });
  });

  // `ltr` is HTML's default for every element, so writing it on every page says nothing.
  test("dir is emitted only for right-to-left text", () => {
    expect(pageLanguage({ routeLocale: "en" })).toEqual({ lang: "en" });
    expect(pageLanguage({ routeLocale: "ar" })).toEqual({ dir: "rtl", lang: "ar" });
  });

  test("an explicit dir wins over the derived one", () => {
    expect(pageLanguage({ pageDir: "auto", routeLocale: "ar" })).toEqual({
      dir: "auto",
      lang: "ar",
    });
    expect(pageLanguage({ defaults: { dir: "ltr" }, routeLocale: "ar" })).toEqual({
      dir: "ltr",
      lang: "ar",
    });
  });
});

describe("translationKey", () => {
  const { i18n } = resolveI18n(project({ defaultLocale: "en", locales: ["en", "fr-ca"] }));

  /*
   * The directory layout IS the translation mapping — Jx has no per-page id to join on. Which also
   * names the limitation: a localized slug is not recognized as a translation.
   */
  test("strips a declared locale prefix and nothing else", () => {
    expect(translationKey("/fr-ca/about/", i18n)).toBe("about");
    expect(translationKey("/about/", i18n)).toBe("about");
    expect(translationKey("/docs/guide/", i18n)).toBe("docs/guide");
    expect(translationKey("/", i18n)).toBe("");
  });

  test("a localized slug is a different page, and says so", () => {
    expect(translationKey("/fr-ca/a-propos/", i18n)).not.toBe(translationKey("/about/", i18n));
  });
});

describe("localeAlternates", () => {
  const { i18n } = resolveI18n(project({ defaultLocale: "en", locales: ["en", "fr-ca", "ar"] }));
  const routes = [
    { urlPattern: "/about/" },
    { urlPattern: "/fr-ca/about/" },
    { urlPattern: "/ar/about/" },
    { urlPattern: "/only-english/" },
  ];
  const map = localeAlternates(routes, i18n, "https://x.example");

  // Reciprocity including self is what the annotation means, and what a validator checks for.
  test("every member of a set lists every member, itself included", () => {
    for (const pattern of ["/about/", "/fr-ca/about/", "/ar/about/"]) {
      expect(map.get(pattern)?.map((a) => a.hreflang)).toEqual(["ar", "en", "fr-CA", "x-default"]);
    }
  });

  test("hrefs are absolute", () => {
    expect(map.get("/about/")?.find((a) => a.hreflang === "fr-CA")?.href).toBe(
      "https://x.example/fr-ca/about/",
    );
  });

  test("x-default points at the default locale", () => {
    expect(map.get("/ar/about/")?.find((a) => a.hreflang === "x-default")?.href).toBe(
      "https://x.example/about/",
    );
  });

  // A lone hreflang pointing at itself is noise; the annotation is about a set.
  test("a page with no translations gets none", () => {
    expect(map.has("/only-english/")).toBe(false);
  });

  test("nothing without i18n, and nothing without an absolute site URL", () => {
    expect(localeAlternates(routes, null, "https://x.example").size).toBe(0);
    expect(localeAlternates(routes, i18n, "").size).toBe(0);
  });

  // Two routes claiming one translation would emit a contradiction; the first wins instead.
  test("a duplicate locale in a set is ignored rather than emitted twice", () => {
    const dup = localeAlternates(
      [{ urlPattern: "/about/" }, { urlPattern: "/also-about/" }, { urlPattern: "/ar/about/" }],
      i18n,
      "https://x.example",
    );
    expect(dup.get("/about/")?.filter((a) => a.hreflang === "en")).toHaveLength(1);
  });

  test("x-default is omitted when the set has no default-locale member", () => {
    const noDefault = localeAlternates(
      [{ urlPattern: "/ar/about/" }, { urlPattern: "/fr-ca/about/" }],
      i18n,
      "https://x.example",
    );
    expect(noDefault.get("/ar/about/")?.map((a) => a.hreflang)).toEqual(["ar", "fr-CA"]);
  });
});
