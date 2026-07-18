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
