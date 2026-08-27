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

import type { Page } from "puppeteer-core";
import type { CapturedStyle } from "./style-capture.ts";
import { captureStylesAtWidth } from "./style-capture.ts";
import { computeMediaDelta } from "./style-diff.ts";
import { analyzeMediaQueries, planBreakpoints } from "./breakpoint-plan.ts";
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
 * Extract `$media` style deltas by re-capturing at each KEPT breakpoint width.
 *
 * @param {Page} page - Puppeteer page (must still have the target page loaded)
 * @param {CapturedStyle[]} baseElements - Style capture from the base viewport
 * @param {Record<string, Record<string, string>>} uaDefaults - UA-default baselines per tagName
 * @param {readonly string[]} mediaQueries - `@media` queries discovered in the page's stylesheets
 * @param {ExtractMediaOptions} [options]
 * @returns {Promise<MediaExtractionResult>}
 */
export async function extractMedia(
  page: Page,
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
    const bpElements = await captureStylesAtWidth(page, bp.testWidth);
    const deltas = computeMediaDelta(baseElements, bpElements, uaDefaults);

    if (deltas.length > 0) {
      projectBreakpoints[bp.name] = bp.query;
      allDeltas[bp.name] = deltas;
    }
  }

  // Restore original viewport
  await page.setViewport({ width: originalWidth, height: 900 });

  return { breakpoints: projectBreakpoints, deltas: allDeltas };
}
