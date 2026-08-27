/**
 * Decide which of a site's breakpoints the imported project gets.
 *
 * A real site declares breakpoints the way it grew: one framework's four, a theme's three, a
 * plugin's two, a hand-written pair for one component. Taken literally that is what the importer
 * used to emit — nine `$media` entries, unsorted, named `--767` and `--1025`, each one a canvas
 * size in Studio and a column in every style editor. Nobody authors against nine breakpoints, and
 * nobody asked for these nine.
 *
 * So the widths a site DECLARES and the widths a project KEEPS are two different questions, and
 * this module is the second one. It is pure — no browser, no page, no capture — because the
 * decision has to be made BEFORE the re-capture pass: each kept breakpoint costs a viewport change
 * and a full style walk, so planning first is what makes a limited import faster rather than merely
 * tidier.
 *
 * Nothing is thrown away silently. Every discovered width that is not kept is FOLDED into the kept
 * one nearest it under the caller's rounding rule, so the styles that width carried still reach the
 * project — at the breakpoint the project actually has.
 *
 * @docs studio/design/breakpoints
 */

/** One breakpoint: what to call it, what to emit, and the viewport width to sample it at. */
export interface Breakpoint {
  /** Jx breakpoint name, e.g. `--768`. */
  name: string;
  /** The CSS media query to write into `project.json`'s `$media`, e.g. `(max-width: 768px)`. */
  query: string;
  /**
   * The viewport width to re-capture styles at.
   *
   * Usually the query's own width, and deliberately NOT so under an explicit override: the styles
   * flip at the width the SITE declared, so that is where they must be sampled, even when the
   * project is going to call the breakpoint something else.
   */
  testWidth: number;
}

/** How a requested width is matched against the widths a site actually declares. */
export type BreakpointRounding = "nearest" | "down" | "up";

/**
 * What to do with the widths a capture discovered.
 *
 * - `all` — keep every one, sorted. What the importer did before there was a choice.
 * - `limit` — keep `count` of them, evenly spaced across the discovered range (3 → the narrowest, the
 *   middle one, and the widest). The default, because "too many breakpoints" is the complaint this
 *   exists to answer.
 * - `explicit` — keep the widths the author named, each backed by the declared width nearest it.
 */
export type BreakpointPolicy =
  | { mode: "all" }
  | { mode: "limit"; count: number; rounding: BreakpointRounding }
  | { mode: "explicit"; widths: number[]; rounding: BreakpointRounding };

/** What a new import gets when nobody says otherwise. */
export const DEFAULT_BREAKPOINT_POLICY: BreakpointPolicy = {
  count: 3,
  mode: "limit",
  rounding: "nearest",
};

/** The most breakpoints a project may be asked to keep. Past this, "limit" is not limiting. */
export const MAX_BREAKPOINTS = 12;

/** The viewport widths an override may name. Outside this a "width" is a typo, not a breakpoint. */
export const MIN_BREAKPOINT_WIDTH = 120;
export const MAX_BREAKPOINT_WIDTH = 4000;

export interface BreakpointPlanResult {
  /** The breakpoints to capture and emit, ascending by `testWidth`. */
  keep: Breakpoint[];
  /**
   * Discovered breakpoint name → the kept breakpoint name its style deltas merge into.
   *
   * A kept breakpoint maps to itself, so a caller can look up every discovered name without a
   * fallback branch.
   */
  fold: Map<string, string>;
}

/**
 * Parse a media query into a pixel width, or null when it is not a simple one-clause width query.
 *
 * Anchored and `px`-only on purpose: `(min-width: 48rem)` has no pixel width without a root font
 * size, and `(min-width:768px) and (max-width:1024px)` names a band rather than a threshold. Both
 * are real and both are refused here rather than guessed at — {@link skippedWidthQueries} is how the
 * import reports what it could not read.
 *
 * @param {string} query - A media query's condition text
 * @returns {{ type: "min" | "max"; width: number } | null}
 */
export function parseWidthQuery(query: string): { type: "min" | "max"; width: number } | null {
  const minMatch = query.match(/^\s*\(\s*min-width\s*:\s*([\d.]+)px\s*\)\s*$/);
  if (minMatch) {
    return { type: "min", width: Number(minMatch[1]) };
  }
  const maxMatch = query.match(/^\s*\(\s*max-width\s*:\s*([\d.]+)px\s*\)\s*$/);
  if (maxMatch) {
    return { type: "max", width: Number(maxMatch[1]) };
  }
  return null;
}

/** The Jx breakpoint name for a width, e.g. `768` → `--768`. */
export function breakpointName(width: number): string {
  return `--${width}`;
}

/**
 * Analyze discovered `@media` queries and produce a set of testable breakpoints. Only simple
 * one-clause `min-width` / `max-width` queries in `px` are readable as a breakpoint;
 * {@link skippedWidthQueries} names the rest, so an import can say what it could not use instead of
 * dropping it in silence.
 *
 * @param {readonly string[]} queries
 * @returns {Breakpoint[]} Ascending by width, deduplicated
 */
export function analyzeMediaQueries(queries: readonly string[]): Breakpoint[] {
  const seen = new Set<number>();
  const breakpoints: Breakpoint[] = [];

  for (const query of queries) {
    const parsed = parseWidthQuery(query);
    if (!parsed || seen.has(parsed.width)) {
      continue;
    }
    seen.add(parsed.width);

    // Both directions are tested AT the declared width: for max-width it is the upper bound of the
    // Narrow rules, for min-width it is where the wide rules start applying.
    breakpoints.push({ name: breakpointName(parsed.width), query, testWidth: parsed.width });
  }

  breakpoints.sort((a, b) => a.testWidth - b.testWidth);
  return breakpoints;
}

/**
 * The width-ish queries {@link analyzeMediaQueries} could not read — a compound condition, a `rem`
 * threshold, a range syntax. A query with no width in it at all (`prefers-color-scheme`, `hover`,
 * `print`) is not listed: it is not a breakpoint and its absence is not a loss.
 *
 * @param {readonly string[]} queries
 * @returns {string[]}
 */
export function skippedWidthQueries(queries: readonly string[]): string[] {
  const skipped: string[] = [];
  for (const query of queries) {
    if (parseWidthQuery(query)) {
      continue;
    }
    if (/\bwidth\b/i.test(query)) {
      skipped.push(query);
    }
  }
  return [...new Set(skipped)];
}

/**
 * The candidate nearest `target` under `rounding`.
 *
 * Each rule falls back to the nearest end of the range rather than to nothing: a `down` request
 * below every candidate still has an answer, and returning null there would silently drop a width
 * the author explicitly asked for.
 *
 * @param {readonly number[]} candidates - Ascending, non-empty
 * @param {number} target
 * @param {BreakpointRounding} rounding
 * @returns {number}
 */
function pickNearest(
  candidates: readonly number[],
  target: number,
  rounding: BreakpointRounding,
): number {
  if (rounding === "down") {
    let best = candidates[0]!;
    for (const width of candidates) {
      if (width <= target) {
        best = width;
      }
    }
    return best;
  }
  if (rounding === "up") {
    for (const width of candidates) {
      if (width >= target) {
        return width;
      }
    }
    return candidates.at(-1)!;
  }
  // Nearest, ties to the narrower width — deterministic, and the narrower styles are the ones a
  // Reader is more likely to have meant when two are equidistant.
  let best = candidates[0]!;
  let bestDelta = Math.abs(best - target);
  for (const width of candidates) {
    const delta = Math.abs(width - target);
    if (delta < bestDelta) {
      best = width;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * `count` indices evenly spaced across `[0, length - 1]`, both ends included.
 *
 * A single breakpoint takes the MEDIAN rather than the narrowest: asked for one, an author wants
 * the width the site's layout actually turns at, and the narrowest is usually a phone edge case.
 */
function evenIndices(length: number, count: number): number[] {
  if (count >= length) {
    return [...Array.from({ length }).keys()];
  }
  if (count === 1) {
    return [Math.floor((length - 1) / 2)];
  }
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(Math.round((i * (length - 1)) / (count - 1)));
  }
  return [...new Set(out)];
}

/**
 * Choose the breakpoints an import keeps, and where the rest of them go.
 *
 * @param {readonly Breakpoint[]} discovered - Everything the capture found, in any order
 * @param {BreakpointPolicy} policy
 * @returns {BreakpointPlanResult}
 */
export function planBreakpoints(
  discovered: readonly Breakpoint[],
  policy: BreakpointPolicy = DEFAULT_BREAKPOINT_POLICY,
): BreakpointPlanResult {
  const sorted = discovered.toSorted((a, b) => a.testWidth - b.testWidth);
  if (sorted.length === 0) {
    return { fold: new Map(), keep: [] };
  }

  const widths = sorted.map((bp) => bp.testWidth);
  const byWidth = new Map(sorted.map((bp) => [bp.testWidth, bp]));

  const keep: Breakpoint[] = [];
  if (policy.mode === "all") {
    keep.push(...sorted);
  } else if (policy.mode === "limit") {
    const count = Math.max(1, Math.min(MAX_BREAKPOINTS, Math.trunc(policy.count) || 1));
    for (const index of evenIndices(sorted.length, count)) {
      keep.push(sorted[index]!);
    }
  } else {
    /* An override names the widths the PROJECT will have; each is backed by the declared width
       nearest it, because that is where the site's own rules actually change. Two overrides that
       land on the same declared width collapse into one — emitting the same styles twice under two
       names would be two canvases showing the same thing. */
    const requested = [...new Set(policy.widths.map((w) => Math.trunc(w)))]
      .filter((w) => w >= MIN_BREAKPOINT_WIDTH && w <= MAX_BREAKPOINT_WIDTH)
      .toSorted((a, b) => a - b)
      .slice(0, MAX_BREAKPOINTS);
    const claimed = new Set<number>();
    for (const target of requested) {
      const backing = pickNearest(widths, target, policy.rounding);
      if (claimed.has(backing)) {
        continue;
      }
      claimed.add(backing);
      const source = byWidth.get(backing)!;
      const parsed = parseWidthQuery(source.query);
      keep.push({
        name: breakpointName(target),
        query: parsed ? `(${parsed.type}-width: ${target}px)` : source.query,
        testWidth: backing,
      });
    }
    keep.splice(0, keep.length, ...keep.toSorted((a, b) => a.testWidth - b.testWidth));
  }

  const fold = new Map<string, string>();
  if (keep.length === 0) {
    return { fold, keep };
  }

  const keptWidths = keep.map((bp) => bp.testWidth);
  const keptByWidth = new Map(keep.map((bp) => [bp.testWidth, bp]));
  const rounding = policy.mode === "all" ? "nearest" : policy.rounding;
  for (const bp of sorted) {
    const target =
      keptByWidth.get(bp.testWidth) ??
      keptByWidth.get(pickNearest(keptWidths, bp.testWidth, rounding))!;
    fold.set(bp.name, target.name);
  }
  return { fold, keep };
}
