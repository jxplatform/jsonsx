/**
 * Date coercion for content entries — the one pass that gives a `format: "date"` field a value the
 * rest of the pipeline can actually compare.
 *
 * **Why a normalized string and not a `Date`.** `JSON.stringify(new Date("2025-03-04"))` yields an
 * instant, so a Studio save would silently rewrite `2025-03-04` to `2025-03-04T00:00:00.000Z` —
 * which is _March 3_ anywhere west of UTC. That off-by-one is the classic blog-date bug, and a
 * format that round-trips through JSON cannot afford it. A `Temporal.PlainDate` is semantically
 * right and fails differently: `<` and `>` on one yield NaN, and the sort in `content.ts` compares
 * with exactly those.
 *
 * **Why UTC for date-times.** Mixed offsets do not sort lexicographically —
 * `2025-03-04T01:00:00+02:00` sorts _after_ `2025-03-04T00:00:00Z` as text and is _earlier_ in
 * time. Normalizing to `Z` makes the existing raw string comparison correct by construction rather
 * than correct by accident.
 *
 * **Why an ambiguous string is refused rather than guessed.** `03/04/2025` is March 4th or April
 * 3rd depending on where the author lives, and `new Date()` resolves it by implementation-defined
 * rules. Silently picking one is the bug this pass exists to prevent, so refusing it _is_ the
 * feature.
 *
 * @docs framework/site/content-collections
 */

import type { ContentTypeSchema } from "@jxsuite/schema/types";
import type { ContentLoaderEntry } from "./types.ts";

/** The two JSON Schema `format` values that carry build behavior. */
export const DATE_FORMATS = ["date", "date-time"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function isDateFormat(format: unknown): format is DateFormat {
  return typeof format === "string" && (DATE_FORMATS as readonly string[]).includes(format);
}

/** `YYYY-MM-DD`, with no time part. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** RFC 3339 date-time: a date, a `T`, a time, and an offset or `Z`. */
const RFC_3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** A `Date` to `YYYY-MM-DD`, read in UTC so the calendar day matches what was stored. */
function toDateOnly(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A `Date` to RFC 3339 in UTC, without fractional seconds. */
function toInstant(d: Date): string {
  return `${toDateOnly(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/**
 * Coerce one authored value to RFC 3339, or null when it is not an unambiguous date.
 *
 * Accepts, in order: a `Date` (YAML frontmatter parsers routinely produce one for an unquoted
 * `date: 2025-03-04`), an RFC 3339 string, and a bare `YYYY-MM-DD`. Everything else is refused.
 */
export function parseDateValue(value: unknown, format: DateFormat): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : format === "date"
        ? toDateOnly(value)
        : toInstant(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (text === "") {
    return null;
  }

  if (DATE_ONLY.test(text)) {
    // A bare date has no zone. Reading it as UTC midnight is the only reading that does not move
    // The calendar day, which is the whole point of a date-only field.
    const d = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      return null;
    }
    return format === "date" ? text : toInstant(d);
  }

  if (RFC_3339.test(text)) {
    // A date-time with no offset is a local time with no way to know which locality, so it is read
    // As UTC rather than as the build machine's zone — a build must not depend on where it runs.
    const normalized = /[Zz]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}Z`;
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) {
      return null;
    }
    return format === "date" ? toDateOnly(d) : toInstant(d);
  }

  return null;
}

/** Whether a value is already in one of the two normalized forms this module emits. */
export function isCoercedDate(value: string): boolean {
  return DATE_ONLY.test(value) || RFC_3339.test(value);
}

/** Where a coercion pass records what it could not read. */
export interface DateCoercionWarning {
  entryId: string;
  field: string;
  value: unknown;
  message: string;
}

/**
 * Coerce every schema-declared date field on every entry, in place.
 *
 * The original text is kept at `entry._meta.rawDates[field]`, because an events collection that
 * genuinely means "7pm local" needs it back and the normalized instant has thrown that away.
 */
export function coerceEntryDates(
  entries: ContentLoaderEntry[],
  schema: ContentTypeSchema | undefined,
  contentTypeName: string,
): DateCoercionWarning[] {
  const warnings: DateCoercionWarning[] = [];
  const properties = schema?.properties;
  if (!properties) {
    return warnings;
  }

  const dateFields: [string, DateFormat][] = Object.entries(properties)
    .map(([field, def]): [string, unknown] => [field, (def as { format?: unknown }).format])
    .filter((pair): pair is [string, DateFormat] => isDateFormat(pair[1]));
  if (dateFields.length === 0) {
    return warnings;
  }

  for (const entry of entries) {
    for (const [field, format] of dateFields) {
      const raw = entry.data[field];
      if (raw === undefined || raw === null || raw === "") {
        continue;
      }
      const coerced = parseDateValue(raw, format);
      if (coerced === null) {
        warnings.push({
          entryId: entry.id,
          field,
          message:
            `Content dates: "${contentTypeName}/${entry.id}" field "${field}" is ` +
            `${JSON.stringify(raw)}, which is not an unambiguous ${format}. Write it as ` +
            `${format === "date" ? "YYYY-MM-DD" : "YYYY-MM-DDTHH:MM:SSZ"} — a form like ` +
            `"03/04/2025" means two different days depending on who reads it, so it is left as ` +
            `authored rather than guessed.`,
          value: raw,
        });
        continue;
      }
      if (coerced !== raw) {
        const meta = (entry._meta ??= {});
        const rawDates = ((meta as { rawDates?: Record<string, unknown> }).rawDates ??= {});
        rawDates[field] = raw;
      }
      entry.data[field] = coerced;
    }
  }
  return warnings;
}

/**
 * Comparable form for a filter comparison.
 *
 * `>` and `<` pushed both sides through `Number()`, so a date comparison was ALWAYS false — `NaN`
 * compares false against everything. Normalized RFC 3339 strings compare chronologically as text,
 * so the fix is to notice when both sides are dates and stay in string space.
 */
export function parseComparable(a: unknown, b: unknown): [number, number] | [string, string] {
  const aDate = typeof a === "string" && (DATE_ONLY.test(a) || RFC_3339.test(a));
  const bDate = typeof b === "string" && (DATE_ONLY.test(b) || RFC_3339.test(b));
  if (aDate && bDate) {
    return [a as string, b as string];
  }
  return [Number(a), Number(b)];
}
