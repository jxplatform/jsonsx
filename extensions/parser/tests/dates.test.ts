/**
 * Date coercion.
 *
 * The refusals matter as much as the conversions: a value this pass cannot read unambiguously is
 * left as authored and reported, because guessing is the bug it exists to prevent.
 */

import { describe, expect, test } from "bun:test";
import {
  coerceEntryDates,
  isCoercedDate,
  isDateFormat,
  parseComparable,
  parseDateValue,
} from "../src/dates.ts";
import type { ContentLoaderEntry } from "../src/types.ts";

function entry(id: string, data: Record<string, unknown>): ContentLoaderEntry {
  return { data, id } as ContentLoaderEntry;
}

const SCHEMA = {
  properties: {
    published: { format: "date", type: "string" },
    title: { type: "string" },
    updated: { format: "date-time", type: "string" },
  },
  type: "object",
} as never;

describe("parseDateValue", () => {
  test("a bare YYYY-MM-DD stays itself for a date field", () => {
    expect(parseDateValue("2025-03-04", "date")).toBe("2025-03-04");
  });

  test("a Date instance is read in UTC, so the calendar day does not move", () => {
    expect(parseDateValue(new Date("2025-03-04T00:00:00Z"), "date")).toBe("2025-03-04");
    expect(parseDateValue(new Date("2025-03-04T23:30:00Z"), "date")).toBe("2025-03-04");
    expect(parseDateValue(new Date("2025-03-04T23:30:00Z"), "date-time")).toBe(
      "2025-03-04T23:30:00Z",
    );
  });

  test("an offset date-time is normalized to UTC without fractional seconds", () => {
    expect(parseDateValue("2025-03-04T18:00:00+02:00", "date-time")).toBe("2025-03-04T16:00:00Z");
    expect(parseDateValue("2025-03-04T16:00:00.123Z", "date-time")).toBe("2025-03-04T16:00:00Z");
  });

  test("a date-time with no offset is read as UTC, not as the build machine's zone", () => {
    // A build must not depend on where it runs.
    expect(parseDateValue("2025-03-04T16:00:00", "date-time")).toBe("2025-03-04T16:00:00Z");
  });

  test("a bare date widens to UTC midnight for a date-time field", () => {
    expect(parseDateValue("2025-03-04", "date-time")).toBe("2025-03-04T00:00:00Z");
  });

  test("a date-time narrows to its UTC calendar day for a date field", () => {
    expect(parseDateValue("2025-03-04T23:00:00-05:00", "date")).toBe("2025-03-05");
  });

  /*
   * THE REFUSALS. `03/04/2025` is March 4th or April 3rd depending on the reader, and `new Date()`
   * picks one by implementation-defined rules. Refusing it is the feature.
   */
  test.each([
    ["03/04/2025"],
    ["March 4, 2025"],
    ["4 Mar 2025"],
    ["2025/03/04"],
    ["yesterday"],
    ["2025-13-45"],
    [""],
    ["   "],
  ])("refuses %p rather than guessing", (input) => {
    expect(parseDateValue(input, "date")).toBeNull();
  });

  test("refuses a non-string, non-Date value and an invalid Date", () => {
    expect(parseDateValue(1_741_046_400_000, "date")).toBeNull();
    expect(parseDateValue(null, "date")).toBeNull();
    expect(parseDateValue(new Date("nope"), "date")).toBeNull();
  });
});

describe("coerceEntryDates", () => {
  test("coerces declared fields and leaves everything else alone", () => {
    const entries = [
      entry("a", { published: "2025-03-04", title: "A", updated: "2025-03-04T18:00:00+02:00" }),
    ];
    const warnings = coerceEntryDates(entries, SCHEMA, "blog");
    expect(warnings).toEqual([]);
    expect(entries[0]!.data.published).toBe("2025-03-04");
    expect(entries[0]!.data.updated).toBe("2025-03-04T16:00:00Z");
    expect(entries[0]!.data.title).toBe("A");
  });

  test("keeps the authored text when it rewrote the value", () => {
    // An events collection that genuinely means "7pm local" needs the original back.
    const entries = [entry("a", { updated: "2025-03-04T19:00:00+02:00" })];
    coerceEntryDates(entries, SCHEMA, "blog");
    const meta = entries[0]!._meta as { rawDates?: Record<string, unknown> };
    expect(meta.rawDates?.updated).toBe("2025-03-04T19:00:00+02:00");
  });

  test("does not record a raw value when nothing changed", () => {
    const entries = [entry("a", { published: "2025-03-04" })];
    coerceEntryDates(entries, SCHEMA, "blog");
    expect(entries[0]!._meta).toBeUndefined();
  });

  test("an unreadable value is left as authored and reported by entry and field", () => {
    const entries = [entry("post-1", { published: "03/04/2025" })];
    const warnings = coerceEntryDates(entries, SCHEMA, "blog");
    expect(entries[0]!.data.published).toBe("03/04/2025");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.entryId).toBe("post-1");
    expect(warnings[0]!.field).toBe("published");
    expect(warnings[0]!.message).toContain("blog/post-1");
    expect(warnings[0]!.message).toContain("03/04/2025");
  });

  test("skips empty and absent values without warning", () => {
    const entries = [entry("a", { published: "" }), entry("b", {})];
    expect(coerceEntryDates(entries, SCHEMA, "blog")).toEqual([]);
  });

  test("is a no-op with no schema and with a schema declaring no dates", () => {
    const entries = [entry("a", { published: "03/04/2025" })];
    expect(coerceEntryDates(entries, undefined, "blog")).toEqual([]);
    expect(
      coerceEntryDates(entries, { properties: { title: { type: "string" } } } as never, "blog"),
    ).toEqual([]);
    expect(entries[0]!.data.published).toBe("03/04/2025");
  });
});

describe("sorting and comparison", () => {
  /*
   * Normalizing to UTC is what makes the existing raw string comparison in `content.ts` correct by
   * construction. Mixed offsets do NOT sort lexicographically.
   */
  test("normalized date-times sort chronologically as text; offset ones do not", () => {
    const earlier = "2025-03-04T00:00:00Z";
    // 23:00 on the 3rd — earlier in fact, later as text.
    const laterRaw = "2025-03-04T01:00:00+02:00";
    expect(laterRaw > earlier).toBe(true); // Wrong, as authored.
    expect(parseDateValue(laterRaw, "date-time")! > earlier).toBe(false); // Right, once normalized.
  });

  test("parseComparable keeps two dates in string space and everything else numeric", () => {
    expect(parseComparable("2025-03-04", "2025-01-01")).toEqual(["2025-03-04", "2025-01-01"]);
    expect(parseComparable("10", "9")).toEqual([10, 9]);
    // One side a date and one a number is not a date comparison.
    expect(parseComparable("2025-03-04", "9")).toEqual([Number("2025-03-04"), 9]);
  });
});

describe("predicates", () => {
  test("isDateFormat knows the two formats that carry behavior", () => {
    expect(isDateFormat("date")).toBe(true);
    expect(isDateFormat("date-time")).toBe(true);
    expect(isDateFormat("email")).toBe(false);
    expect(isDateFormat(null)).toBe(false);
  });

  test("isCoercedDate recognizes both normalized forms", () => {
    expect(isCoercedDate("2025-03-04")).toBe(true);
    expect(isCoercedDate("2025-03-04T16:00:00Z")).toBe(true);
    expect(isCoercedDate("March 4")).toBe(false);
  });
});

describe("parseDateValue — a well-shaped date that is not a date", () => {
  /*
   * RFC_3339 matches the SHAPE; it cannot know that month 13 or day 32 does not exist. A value that
   * looks right and is not must be rejected rather than coerced, or the field sorts as an Invalid
   * Date and every comparison against it silently answers false.
   */
  test("a syntactically valid but impossible date-time is null", () => {
    expect(parseDateValue("2024-13-45T00:00:00Z", "date-time")).toBeNull();
    expect(parseDateValue("2024-02-30T25:61:61Z", "date-time")).toBeNull();
  });
});
