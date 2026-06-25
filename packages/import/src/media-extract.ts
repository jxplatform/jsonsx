/**
 * Extract @media breakpoints from captured CSS and orchestrate style re-capture at each breakpoint
 * width to produce per-node $media style deltas.
 */

import type { Page } from "puppeteer-core";
import type { CapturedStyle } from "./style-capture.ts";
import { captureStylesAtWidth } from "./style-capture.ts";
import { computeMediaDelta } from "./style-diff.ts";
import type { DiffedStyle } from "./style-diff.ts";

export interface Breakpoint {
  /** Jx breakpoint name, e.g. "--md" */
  name: string;
  /** CSS media query string, e.g. "(max-width: 768px)" */
  query: string;
  /** The width in px to test this breakpoint at */
  testWidth: number;
}

export interface MediaExtractionResult {
  /** Breakpoints to add to project.json.$media */
  breakpoints: Record<string, string>;
  /** Per-breakpoint style deltas keyed by breakpoint name */
  deltas: Record<string, DiffedStyle[]>;
}

/**
 * Parse a media query string and extract a pixel width if it's a simple min-width or max-width
 * query. Returns null for complex/non-size queries.
 */
function parseWidthQuery(query: string): { type: "min" | "max"; width: number } | null {
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

/** Generate a Jx breakpoint name from a width, e.g. 768 → "--768" */
function breakpointName(width: number): string {
  return `--${width}`;
}

/**
 * Analyze discovered @media queries and produce a set of testable breakpoints. Only picks up simple
 * min-width / max-width queries — complex queries (orientation, hover, prefers-*) are logged and
 * skipped.
 */
export function analyzeMediaQueries(queries: string[]): Breakpoint[] {
  const seen = new Set<number>();
  const breakpoints: Breakpoint[] = [];

  for (const query of queries) {
    const parsed = parseWidthQuery(query);
    if (!parsed) {
      continue;
    }
    if (seen.has(parsed.width)) {
      continue;
    }
    seen.add(parsed.width);

    // For max-width: test AT that width (it's the upper bound)
    // For min-width: test AT that width (it's the lower bound — styles kick in here)
    breakpoints.push({
      name: breakpointName(parsed.width),
      query,
      testWidth: parsed.width,
    });
  }

  // Sort by width ascending
  breakpoints.sort((a, b) => a.testWidth - b.testWidth);
  return breakpoints;
}

/**
 * Extract $media style deltas by re-capturing at each breakpoint width.
 *
 * @param page - Puppeteer page (must still have the target page loaded)
 * @param baseElements - Style capture from the base viewport (1440px)
 * @param uaDefaults - UA-default baselines per tagName
 * @param mediaQueries - @media queries discovered in the page's stylesheets
 * @param originalWidth - The base viewport width to restore after extraction
 */
export async function extractMedia(
  page: Page,
  baseElements: CapturedStyle[],
  uaDefaults: Record<string, Record<string, string>>,
  mediaQueries: string[],
  originalWidth = 1440,
): Promise<MediaExtractionResult> {
  const breakpoints = analyzeMediaQueries(mediaQueries);

  if (breakpoints.length === 0) {
    return { breakpoints: {}, deltas: {} };
  }

  const projectBreakpoints: Record<string, string> = {};
  const allDeltas: Record<string, DiffedStyle[]> = {};

  for (const bp of breakpoints) {
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
