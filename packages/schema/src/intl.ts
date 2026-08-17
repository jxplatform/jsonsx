/**
 * The blessed `Intl` helpers: one list, read by everything that needs to know them.
 *
 * **The list used to exist in four places** — the runtime's allow-set, the runtime's dispatch
 * table, the compiler's emitter, and a prose JSON-Schema description enumerating them by name. The
 * description was the dangerous one: nothing checked it, so a helper could ship and the schema go
 * on telling authors it did not exist. The names live here; the runtime and the schema description
 * both read them, and a test asserts the two agree.
 *
 * **Why helpers and not the constructors.** ECMA-402's formatters are constructors, and a formula
 * is a pure call — `new` is not in the expression grammar and should not be. Each helper wraps
 * construct-then-format, which is the shape a document author wants anyway.
 *
 * **Every helper takes an explicit locale.** `new Intl.NumberFormat(undefined)` reads the _host's_
 * locale, so the same document compiled on two machines emits different text. Passing the project's
 * locale is what makes a build reproducible; see `site-architecture.md` §13.7.
 *
 * Pure data and no imports, so a browser bundle, the compiler and the schema generator can all read
 * it without pulling anything else in.
 *
 * @docs studio/logic/formulas
 */

/**
 * The locale a helper uses when a formula names none.
 *
 * **Not the host's.** `new Intl.NumberFormat(undefined)` reads the machine's locale, so the same
 * document renders `1,234.5` on one build machine and `1.234,5` on another, and a site's output
 * stops being a function of its input. A fixed default is the only value that makes a build
 * reproducible; an author who wants a different one passes it, which is what the parameter is for.
 */
export const DEFAULT_FORMAT_LOCALE = "en-US";

/**
 * The time zone `Intl/formatDate` uses when the formula's options name none.
 *
 * The same determinism argument as the locale, and worse in effect: a locale changes how a date
 * reads, a time zone can change **which day it is**. A post timestamped `2026-08-16T02:00Z` renders
 * as the 16th in UTC and the 15th in New York, so a build machine's zone would silently move dates
 * in published HTML. UTC is the one zone that is the same everywhere.
 */
export const DEFAULT_TIME_ZONE = "UTC";

/** One blessed helper: its callee path (after `window#/`) and what it wraps. */
export interface IntlHelper {
  /** The callee path an expression names, e.g. `Intl/formatNumber`. */
  path: string;
  /** The ECMA-402 constructor it wraps. */
  api: string;
  /** Parameter names, in order, for documentation and for the compiled call. */
  params: string[];
  /** One line, for the formula catalogue and the schema description. */
  summary: string;
}

/**
 * Every blessed `Intl` helper, in the order they are documented.
 *
 * **`DurationFormat` is deliberately absent.** Its baseline support is not universal, and a blessed
 * global that throws on a browser Jx claims to support is worse than one that does not exist: the
 * author writes a formula that works on their machine and fails on a visitor's.
 */
export const INTL_HELPERS: readonly IntlHelper[] = [
  {
    api: "Intl.NumberFormat",
    params: ["value", "locale", "options"],
    path: "Intl/formatNumber",
    summary: "Format a number for a locale — grouping, decimals, currency, percent, units.",
  },
  {
    api: "Intl.DateTimeFormat",
    params: ["value", "locale", "options"],
    path: "Intl/formatDate",
    summary: "Format a date or timestamp for a locale. Pass `timeZone` in options.",
  },
  {
    api: "Intl.RelativeTimeFormat",
    params: ["value", "unit", "locale", "options"],
    path: "Intl/formatRelativeTime",
    summary: 'Format a relative time — `-3, "day"` becomes "3 days ago".',
  },
  {
    api: "Intl.ListFormat",
    params: ["values", "locale", "options"],
    path: "Intl/formatList",
    summary: 'Join a list the way a locale does — "a, b, and c", not a hand-written comma join.',
  },
  {
    api: "Intl.PluralRules",
    params: ["value", "locale", "options"],
    path: "Intl/plural",
    summary:
      'Which plural category a number falls in ("one", "few", "other") — many languages have ' +
      "more than two, so a ternary on `n === 1` is wrong outside English.",
  },
  {
    api: "Intl.Collator",
    params: ["a", "b", "locale", "options"],
    path: "Intl/compare",
    summary:
      "Compare two strings for sorting. `<` and `sort()` order by UTF-16 code unit, which puts " +
      '"Zebra" before "apple" and sorts every accented word into the wrong place.',
  },
  {
    api: "Intl.DisplayNames",
    params: ["code", "type", "locale", "options"],
    path: "Intl/displayName",
    summary:
      'The name of a language, region, script or currency in a locale — "de" as "German" or ' +
      '"Deutsch", from CLDR rather than a hand-kept table.',
  },
  {
    api: "Intl.Segmenter",
    params: ["value", "granularity", "locale"],
    path: "Intl/segment",
    summary:
      "Split text into graphemes, words or sentences (UAX #29). `[...str]` splits code points, " +
      "so it cuts an emoji with a skin-tone modifier in half.",
  },
] as const;

/** Just the callee paths, for the runtime's allow-set. */
export const INTL_HELPER_PATHS: readonly string[] = INTL_HELPERS.map((helper) => helper.path);

/**
 * The helper names as one clause, for the `call` operator's JSON-Schema description.
 *
 * Generated rather than typed out, because a hand-written enumeration is what let the schema drift
 * from the implementation in the first place.
 *
 * @returns {string}
 */
export function intlHelpersClause(): string {
  return `the Intl helpers ${INTL_HELPER_PATHS.join(", ")}`;
}
