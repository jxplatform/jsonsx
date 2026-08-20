/**
 * Locale negotiation: RFC 4647 Lookup over `Accept-Language`, and the worker source that runs it.
 *
 * The last third of this file is the part that matters most. The worker cannot import the
 * implementation — it is bundled from the project root, not from the compiler — so the algorithm
 * exists twice, once in TypeScript and once as emitted JavaScript. Two copies of an algorithm
 * drift, and the drift is silent because each half passes its own tests. So the emitted source is
 * evaluated and driven through the _same corpus_ as the implementation, asserting agreement case by
 * case rather than asserting that both are individually plausible.
 */

import { describe, expect, test } from "bun:test";
import {
  localeHome,
  localeNegotiationMiddleware,
  lookupRange,
  negotiateLocale,
  parseAcceptLanguage,
} from "../src/site/locale-negotiation.ts";
import type { ResolvedI18n } from "../src/site/i18n.ts";

const SITE: ResolvedI18n = {
  defaultLocale: "en",
  locales: ["en", "fr-CA", "de", "zh-Hant-TW"],
  routing: "prefix-except-default",
};

/**
 * Every header the two implementations are held to agree on. Kept as one list so the drift test
 * cannot quietly cover less than the unit tests do.
 */
const CORPUS: (string | null)[] = [
  null,
  "",
  "   ",
  "en",
  "EN",
  "fr",
  "fr-CA",
  "fr-ca",
  "fr-FR",
  "de-CH-1901",
  "zh-Hant",
  "zh-Hant-TW",
  "zh-Hans-CN",
  "*",
  "en;q=0.1, de;q=0.9",
  "de;q=0, fr",
  "de;q=0",
  "fr;q=0.9, de;q=0.9",
  "ja, ko, fr",
  "ja, ko",
  "en-US,en;q=0.9,fr;q=0.8",
  "de-DE-u-co-phonebk",
  ", , en",
  "en;q=bogus, de",
  "en;q=1.0",
  "q=0.5",
];

describe("parseAcceptLanguage", () => {
  test("orders by quality, keeping header order on a tie", () => {
    expect(parseAcceptLanguage("en;q=0.1, de;q=0.9, fr;q=0.9").map((r) => r.range)).toEqual([
      "de",
      "fr",
      "en",
    ]);
  });

  /*
   * `q=0` means NOT acceptable (RFC 9110 §12.5.4). Ranking it last instead of dropping it would
   * make "de;q=0" — an explicit refusal — behave as a weak preference for German the moment
   * nothing else matched.
   */
  test("drops a range offered at q=0 rather than ranking it last", () => {
    expect(parseAcceptLanguage("de;q=0, fr").map((r) => r.range)).toEqual(["fr"]);
    expect(parseAcceptLanguage("de;q=0")).toEqual([]);
  });

  test("ignores empty entries and lower-cases ranges", () => {
    expect(parseAcceptLanguage(", , EN-us").map((r) => r.range)).toEqual(["en-us"]);
  });

  // A malformed qvalue is a malformed header field; the range goes rather than becoming q=1.
  test("drops a range whose q is not a number", () => {
    expect(parseAcceptLanguage("en;q=bogus, de").map((r) => r.range)).toEqual(["de"]);
  });
});

describe("lookupRange", () => {
  test("matches exactly, case-insensitively", () => {
    expect(lookupRange("fr-ca", SITE.locales)).toBe("fr-CA");
    expect(lookupRange("en", SITE.locales)).toBe("en");
  });

  /*
   * The whole of Lookup: truncate and retry. `fr-FR` is not offered, but `fr-CA` is not the answer
   * either — truncating gives `fr`, which the site does not declare, so this is a miss. Getting
   * that wrong would silently serve Canadian French to a French visitor because the strings looked
   * similar.
   */
  test("truncates progressively, and a truncation that matches nothing is a miss", () => {
    expect(lookupRange("de-ch-1901", SITE.locales)).toBe("de");
    expect(lookupRange("zh-hant-tw", SITE.locales)).toBe("zh-Hant-TW");
    expect(lookupRange("fr-fr", SITE.locales)).toBeNull();
    expect(lookupRange("ja", SITE.locales)).toBeNull();
  });

  // A lone `u` or `x` is an extension singleton, never a tag; it leaves with its parent subtag.
  test("removes a singleton subtag together with the one before it", () => {
    expect(lookupRange("de-de-u-co-phonebk", SITE.locales)).toBe("de");
    expect(lookupRange("en-a-bbb", ["en"])).toBe("en");
  });

  test("an empty range matches nothing", () => {
    expect(lookupRange("", SITE.locales)).toBeNull();
  });
});

describe("negotiateLocale", () => {
  test("an absent or empty header is the default", () => {
    expect(negotiateLocale(null, SITE.locales, "en")).toBe("en");
    expect(negotiateLocale(undefined, SITE.locales, "en")).toBe("en");
    expect(negotiateLocale("   ", SITE.locales, "en")).toBe("en");
  });

  test("the best acceptable range wins, not the first", () => {
    expect(negotiateLocale("en;q=0.1, de;q=0.9", SITE.locales, "en")).toBe("de");
  });

  test("an unmatched preference falls through to the next", () => {
    expect(negotiateLocale("ja, ko, fr-CA", SITE.locales, "en")).toBe("fr-CA");
    expect(negotiateLocale("ja, ko", SITE.locales, "en")).toBe("en");
  });

  // `*` means "anything is acceptable"; the site's own first-declared locale is the only tie-break.
  test("a wildcard takes the site's default", () => {
    expect(negotiateLocale("*", SITE.locales, "en")).toBe("en");
    expect(negotiateLocale("*", ["de", "en"], "de")).toBe("de");
  });

  test("the result is always one of the available locales", () => {
    for (const header of CORPUS) {
      expect(SITE.locales).toContain(negotiateLocale(header, SITE.locales, "en"));
    }
  });
});

describe("localeHome", () => {
  test("the default locale owns / under prefix-except-default", () => {
    expect(localeHome("en", SITE)).toBe("/");
    expect(localeHome("fr-CA", SITE)).toBe("/fr-ca/");
  });

  // Under prefix-always nothing lives at `/`, which is what makes negotiation load-bearing there.
  test("every locale has a prefix under prefix-always", () => {
    const always: ResolvedI18n = { ...SITE, routing: "prefix-always" };
    expect(localeHome("en", always)).toBe("/en/");
    expect(localeHome("fr-CA", always)).toBe("/fr-ca/");
  });
});

describe("localeNegotiationMiddleware", () => {
  test("emits nothing when there is nothing to negotiate", () => {
    expect(localeNegotiationMiddleware(null)).toBe("");
    expect(
      localeNegotiationMiddleware({
        defaultLocale: "en",
        locales: ["en"],
        routing: "prefix-always",
      }),
    ).toBe("");
  });

  /*
   * Without `Vary`, a cache stores the first visitor's answer and serves it to everyone — which is
   * worse than not negotiating, and invisible to the author, whose own browser was that visitor.
   */
  test("both branches say the response depended on the header", () => {
    const source = localeNegotiationMiddleware(SITE);
    expect(source.match(/Vary/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("Accept-Language");
  });

  // 301 would let a cache pin one visitor's language permanently, for everyone, forever.
  test("the redirect is temporary", () => {
    expect(localeNegotiationMiddleware(SITE)).toContain("status: 302");
    expect(localeNegotiationMiddleware(SITE)).not.toContain("status: 301");
  });

  test("it registers as middleware on / so the chain can still serve the page", () => {
    const source = localeNegotiationMiddleware(SITE);
    expect(source).toContain("app.use('/'");
    expect(source).toContain("await next()");
  });

  test("the site's own locales and home paths are baked in", () => {
    const source = localeNegotiationMiddleware(SITE);
    expect(source).toContain(JSON.stringify(SITE.locales));
    expect(source).toContain('"fr-CA":"/fr-ca/"');
    expect(source).toContain('"en":"/"');
  });
});

/*
 * ── The drift guard ────────────────────────────────────────────────────────────
 *
 * The emitted JavaScript is evaluated here and driven through the same corpus as the TypeScript.
 * This is the only thing standing between two copies of one algorithm and a silent divergence, so
 * it compares answers rather than checking that each half looks reasonable on its own.
 */
describe("the emitted worker copy agrees with the implementation", () => {
  /** Pull `jxNegotiateLocale` out of the generated source by evaluating just its function block. */
  function emittedNegotiator(i18n: ResolvedI18n) {
    const source = localeNegotiationMiddleware(i18n);
    const start = source.indexOf("function jxParseAcceptLanguage");
    const end = source.indexOf("app.use(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = `${source.slice(start, end)}\nreturn jxNegotiateLocale`;
    // oxlint-disable-next-line no-new-func -- evaluating the emitted artefact IS the assertion here.
    return new Function(body)() as (
      header: string | null | undefined,
      available: readonly string[],
      fallback: string,
    ) => string;
  }

  test("every header in the corpus produces the same locale", () => {
    const emitted = emittedNegotiator(SITE);
    for (const header of CORPUS) {
      expect({ answer: emitted(header, SITE.locales, "en"), header }).toEqual({
        answer: negotiateLocale(header, SITE.locales, "en"),
        header,
      });
    }
  });

  test("and under prefix-always, where the locale set is the same but the homes are not", () => {
    const always: ResolvedI18n = { ...SITE, routing: "prefix-always" };
    const emitted = emittedNegotiator(always);
    for (const header of CORPUS) {
      expect({ answer: emitted(header, always.locales, "en"), header }).toEqual({
        answer: negotiateLocale(header, always.locales, "en"),
        header,
      });
    }
  });

  test("the baked-in home map matches localeHome for every locale", () => {
    for (const routing of ["prefix-except-default", "prefix-always"] as const) {
      const i18n: ResolvedI18n = { ...SITE, routing };
      const source = localeNegotiationMiddleware(i18n);
      const baked = JSON.parse(
        source.match(/const JX_LOCALE_HOMES = (\{.*?\})\n/)?.[1] ?? "{}",
      ) as Record<string, string>;
      for (const locale of i18n.locales) {
        expect({ [locale]: baked[locale] }).toEqual({ [locale]: localeHome(locale, i18n) });
      }
    }
  });
});
