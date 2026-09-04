/**
 * Extract `@media` breakpoints from captured CSS and orchestrate style re-capture at each kept
 * breakpoint width to produce per-node `$media` style deltas.
 *
 * The set of breakpoints a project keeps is decided in `breakpoint-plan.ts`, BEFORE anything is
 * re-captured — each kept breakpoint costs a viewport change and a full style walk, so a limited
 * import does less work rather than merely emitting less.
 *
 * A folded-away width is not sampled at all, and does not need to be. The computed style at a kept
 * width is already the site's own cascade resolved AT that width, folded rules included; merging a
 * separately-sampled delta on top of it could only disagree with the browser. The fold map exists
 * so the import can SAY where a width went, not so its styles can be recovered.
 */

import type { ImportPage } from "./capture.ts";
import type { CapturedStyle } from "./style-capture.ts";
import { captureStylesAtWidth } from "./style-capture.ts";
import { computeMediaDelta } from "./style-diff.ts";
import { analyzeMediaQueries, parseWidthQuery, planBreakpoints } from "./breakpoint-plan.ts";
import type { Breakpoint, BreakpointPolicy } from "./breakpoint-plan.ts";
import type { DiffedStyle } from "./style-diff.ts";

/* The query analysis is pure and lives with the planner; it is re-exported here because this is the
   module a caller reaches for when it is thinking about media. */
export { analyzeMediaQueries, skippedWidthQueries } from "./breakpoint-plan.ts";
export type {
  Breakpoint,
  BreakpointPolicy,
  BreakpointPlanResult,
  BreakpointRounding,
} from "./breakpoint-plan.ts";

export interface MediaExtractionResult {
  /** Breakpoints to add to `project.json`'s `$media`. */
  breakpoints: Record<string, string>;
  /** Per-breakpoint style deltas keyed by breakpoint name. */
  deltas: Record<string, DiffedStyle[]>;
}

export interface ExtractMediaOptions {
  /** The base viewport width to restore after extraction. */
  originalWidth?: number;
  /** Which of the discovered breakpoints to keep (default: the three-breakpoint limit). */
  policy?: BreakpointPolicy | undefined;
  /**
   * An already-decided plan, used verbatim instead of planning from this page's own queries.
   *
   * A crawl needs this. Planning per page would let page 2 keep a width page 1 folded away, so the
   * project's `$media` would be the UNION of several plans — the very thing a limit is for — and
   * the breakpoint names a node carries would depend on which page it came from. One plan, decided
   * on the first page that declares any width, is what keeps the names meaning one thing.
   */
  plan?: readonly Breakpoint[] | undefined;
}

/**
 * How far inside its own band the corroborating sample sits. Wide enough that a fluid element
 * measures differently, narrow enough to stay clear of the neighbouring breakpoint.
 */
const SECOND_SAMPLE_OFFSET = 40;

/**
 * A second viewport width INSIDE the same media band.
 *
 * The direction is the whole point: for `(max-width: N)` the band runs downward, so the second
 * sample is narrower; for `(min-width: N)` it runs upward and the sample must be wider, or it
 * leaves the band and measures the rules this breakpoint exists to distinguish itself from.
 */
export function secondSampleWidth(bp: Breakpoint): number {
  const parsed = parseWidthQuery(bp.query);
  const direction = parsed?.type === "min" ? 1 : -1;
  return Math.max(1, bp.testWidth + direction * SECOND_SAMPLE_OFFSET);
}

/**
 * Keep only the declarations two samples of the same band AGREE on.
 *
 * `getComputedStyle` returns used values, so `width` and `height` come back as the pixels the
 * element happens to occupy - never the authored `100%` or `auto`. Diffing one sample against the
 * base therefore reported a "change" for every fluid element at every breakpoint: two thirds of all
 * responsive declarations in a real import were the viewport's own width written back as the
 * element's, which does not merely waste space but PINS the layout and defeats the reflow the
 * breakpoint existed for.
 *
 * Measuring twice inside the band separates the two cases without knowing which properties are
 * geometry. An authored value is the same at both widths and survives; a resolved one moves with
 * the viewport and is dropped. A property whose value legitimately differs across the band (a
 * percentage-positioned element) is dropped too - that is the intended trade, since nothing in a
 * computed-style capture can tell it from noise.
 */
export function agreedDeltas(
  primary: readonly DiffedStyle[],
  corroborating: readonly DiffedStyle[],
): DiffedStyle[] {
  const second = new Map(corroborating.map((d) => [d.path.join(","), d.style]));
  const agreed: DiffedStyle[] = [];

  for (const delta of primary) {
    const other = second.get(delta.path.join(","));
    if (!other) {
      continue;
    }
    const style: Record<string, string | number> = {};
    for (const [prop, value] of Object.entries(delta.style)) {
      if (other[prop] === value) {
        style[prop] = value;
      }
    }
    if (Object.keys(style).length > 0) {
      agreed.push({ path: delta.path, style });
    }
  }
  return agreed;
}

/**
 * Extract `$media` style deltas by re-capturing at each KEPT breakpoint width.
 *
 * @param {ImportPage} page - Browser page (must still have the target page loaded)
 * @param {CapturedStyle[]} baseElements - Style capture from the base viewport
 * @param {Record<string, Record<string, string>>} uaDefaults - UA-default baselines per tagName
 * @param {readonly string[]} mediaQueries - `@media` queries discovered in the page's stylesheets
 * @param {ExtractMediaOptions} [options]
 * @returns {Promise<MediaExtractionResult>}
 */
export async function extractMedia(
  page: ImportPage,
  baseElements: CapturedStyle[],
  uaDefaults: Record<string, Record<string, string>>,
  mediaQueries: readonly string[],
  options: ExtractMediaOptions = {},
): Promise<MediaExtractionResult> {
  const { originalWidth = 1440, plan, policy } = options;
  const keep = plan ?? planBreakpoints(analyzeMediaQueries(mediaQueries), policy).keep;

  if (keep.length === 0) {
    return { breakpoints: {}, deltas: {} };
  }

  const projectBreakpoints: Record<string, string> = {};
  const allDeltas: Record<string, DiffedStyle[]> = {};

  for (const bp of keep) {
    const primary = computeMediaDelta(
      baseElements,
      await captureStylesAtWidth(page, bp.testWidth),
      uaDefaults,
    );
    const corroborating = computeMediaDelta(
      baseElements,
      await captureStylesAtWidth(page, secondSampleWidth(bp)),
      uaDefaults,
    );
    const deltas = agreedDeltas(primary, corroborating);

    if (deltas.length > 0) {
      projectBreakpoints[bp.name] = bp.query;
      allDeltas[bp.name] = deltas;
    }
  }

  // Restore original viewport
  await page.setViewport({ width: originalWidth, height: 900 });

  return { breakpoints: projectBreakpoints, deltas: allDeltas };
}
