/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Canvas media/breakpoint utilities — pure functions extracted for testability. */

import { pureSchemeOf } from "@jxsuite/runtime";

/**
 * True when a feature query participates in the forced-scheme contract (spec §9.5) — a pure
 * prefers-color-scheme query. These surface as the Auto/Light/Dark control, not generic toggles.
 *
 * @param {string} query
 * @returns {boolean}
 */
export function isSchemeQuery(query: string): boolean {
  return pureSchemeOf(query) !== null;
}

/**
 * The scheme a feature query targets ("light" | "dark"), or null for non-scheme queries.
 *
 * @param {string} query
 * @returns {"light" | "dark" | null}
 */
export function schemeOfQuery(query: string): "light" | "dark" | null {
  return pureSchemeOf(query);
}

/**
 * Classify $media entries into size breakpoints (get a canvas each) and feature queries (rendered
 * as toolbar toggles).
 *
 * @param {Record<string, string> | null | undefined} mediaDef
 * @returns {{
 *   sizeBreakpoints: { name: string; query: string; width: number; type: string }[];
 *   featureQueries: { name: string; query: string }[];
 *   baseWidth: number;
 * }}
 */
export function parseMediaEntries(mediaDef?: Record<string, string> | null) {
  if (!mediaDef) {
    return { baseWidth: 320, featureQueries: [], sizeBreakpoints: [] };
  }
  const features = [];
  const sizes = [];
  let baseWidth = 320;
  for (const [name, query] of Object.entries(mediaDef)) {
    if (name === "--") {
      const wm = String(query).match(/^(\d+)\s*px$/);
      baseWidth = wm ? Number(wm[1]!) : 320;
      continue;
    }
    const minMatch = query.match(/min-width:\s*([\d.]+)px/);
    const maxMatch = query.match(/max-width:\s*([\d.]+)px/);
    if (minMatch) {
      sizes.push({ name, query, type: "min", width: Number(minMatch[1]!) });
    } else if (maxMatch) {
      sizes.push({ name, query, type: "max", width: Number(maxMatch[1]!) });
    } else {
      features.push({ name, query });
    }
  }
  sizes.sort((a, b) => (a.type === "min" ? a.width - b.width : b.width - a.width));
  return { baseWidth, featureQueries: features, sizeBreakpoints: sizes };
}

/**
 * Compute which named breakpoints are active at a given canvas width.
 *
 * @param {{ name: string; width: number; type: string }[]} sizeBreakpoints
 * @param {number} canvasWidth
 * @returns {Set<string>}
 */
export function activeBreakpointsForWidth(
  sizeBreakpoints: { name: string; width: number; type: string }[],
  canvasWidth: number,
) {
  const active = new Set<string>();
  for (const bp of sizeBreakpoints) {
    if (bp.type === "min" && canvasWidth >= bp.width) {
      active.add(bp.name);
    } else if (bp.type === "max" && canvasWidth <= bp.width) {
      active.add(bp.name);
    }
  }
  return active;
}

/**
 * The ONE breakpoint a canvas of this width is rendering under, or `null` for Base.
 *
 * {@link activeBreakpointsForWidth} answers a set, because several queries genuinely match at once:
 * a desktop-first project at 700px satisfies both `(max-width: 1024px)` and `(max-width: 768px)`.
 * The rendering context is one value, though — `session.ui.activeMedia` is a single key — so this
 * picks the most specific member of that set: the one whose declared width is CLOSEST to the canvas
 * width, ties going to the narrower.
 *
 * Closest, rather than last-in-array, on purpose. Every matching `max` entry is at least as wide as
 * the canvas and every matching `min` entry at most, so "closest" reads as "narrowest" for a
 * desktop-first project and "widest" for a mobile-first one — the correct band in both. Array
 * position would agree for those two, but {@link parseMediaEntries}'s comparator decides the whole
 * sort from `a.type` alone, so it orders a project mixing `min-` and `max-width` arbitrarily.
 * Distance does not depend on the sort at all.
 *
 * @param {{ name: string; width: number; type: string }[]} sizeBreakpoints
 * @param {number} canvasWidth
 * @returns {string | null}
 */
export function mediaForWidth(
  sizeBreakpoints: { name: string; width: number; type: string }[],
  canvasWidth: number,
): string | null {
  const active = activeBreakpointsForWidth(sizeBreakpoints, canvasWidth);
  let best: { name: string; width: number } | null = null;
  for (const bp of sizeBreakpoints) {
    if (!active.has(bp.name)) {
      continue;
    }
    const distance = Math.abs(bp.width - canvasWidth);
    if (best === null) {
      best = bp;
      continue;
    }
    const bestDistance = Math.abs(best.width - canvasWidth);
    // Ties to the NARROWER entry: at a width equidistant from a `max` and a `min` neighbour, the
    // Tighter constraint is the one an author is checking.
    if (distance < bestDistance || (distance === bestDistance && bp.width < best.width)) {
      best = bp;
    }
  }
  return best?.name ?? null;
}

/**
 * Pull a dragged width onto a declared one when it comes close enough — magnetic snapping.
 *
 * The Edit canvas is dragged continuously, which is the point of it; landing EXACTLY on a declared
 * breakpoint is nevertheless the single most common intent, and a pixel-perfect drag cannot deliver
 * it. So a target within `tolerance` wins, and the caller offers Alt as the bypass — free motion
 * stays reachable rather than being traded away for the convenience.
 *
 * @param {number} width
 * @param {number[]} targets — declared breakpoint widths, plus the base width
 * @param {number} tolerance — in px, either side
 * @returns {number}
 */
export function snapEditWidth(width: number, targets: number[], tolerance = 8): number {
  let best: number | null = null;
  for (const target of targets) {
    const distance = Math.abs(target - width);
    if (distance > tolerance) {
      continue;
    }
    if (best === null || distance < Math.abs(best - width)) {
      best = target;
    }
  }
  return best ?? width;
}
