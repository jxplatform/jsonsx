/**
 * Diff captured computed styles against UA-default baselines. Produces a minimal set of meaningful
 * style declarations per element.
 */

import type { CapturedStyle } from "./style-capture.ts";

export interface DiffedStyle {
  path: number[];
  style: Record<string, string | number>;
}

/** Convert a kebab-case CSS property to camelCase for Jx style objects. */
export function kebabToCamel(prop: string): string {
  if (prop.startsWith("-webkit-") || prop.startsWith("-moz-") || prop.startsWith("-ms-")) {
    const withoutPrefix = prop.replace(/^-(?:webkit|moz|ms)-/, "");
    const camel = withoutPrefix.replaceAll(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const vendor = prop.startsWith("-webkit-") ? "webkit" : prop.startsWith("-moz-") ? "moz" : "ms";
    return `${vendor}${camel[0]!.toUpperCase()}${camel.slice(1)}`;
  }
  return prop.replaceAll(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Values that are effectively "no value set" — drop them even if they differ from UA default
 * (they're computed noise, not intentional styling).
 */
const NOISE_VALUES = new Set([
  "auto",
  "normal",
  "none",
  "0px",
  "0s",
  "start",
  "baseline",
  "stretch",
  "visible",
  "content-box",
  "currentcolor",
  "medium none currentcolor",
]);

/**
 * Properties where "auto" / "normal" / "none" IS meaningful and should not be dropped — e.g.,
 * overflow: hidden vs overflow: visible.
 */
const KEEP_NOISE_FOR = new Set([
  "overflow",
  "overflow-x",
  "overflow-y",
  "display",
  "visibility",
  "position",
  "pointer-events",
  "cursor",
  "white-space",
  "text-overflow",
  "object-fit",
  "flex-wrap",
  "flex-direction",
  "box-sizing",
  "text-align",
  "text-decoration",
  "text-decoration-line",
  "text-transform",
  "word-break",
  "overflow-wrap",
  "list-style-type",
  "table-layout",
  "border-collapse",
  "appearance",
  "resize",
  "user-select",
]);

/**
 * Try to convert a CSS value to a number where appropriate (e.g., "0" → 0, opacity "0.5" → 0.5).
 * Keeps strings for anything with units or complex values.
 */
function maybeNumeric(value: string): string | number {
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

/**
 * Diff a single element's captured styles against its tagName's UA defaults. Returns only the
 * declarations that represent intentional styling.
 */
export function diffStyles(
  captured: Record<string, string>,
  uaDefaults: Record<string, string>,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};

  for (const [prop, value] of Object.entries(captured)) {
    const uaValue = uaDefaults[prop] ?? "";

    // Same as default → skip
    if (value === uaValue) {
      continue;
    }

    // Drop noise values unless the property's noise values are meaningful
    if (!KEEP_NOISE_FOR.has(prop) && NOISE_VALUES.has(value)) {
      continue;
    }

    // Even for KEEP_NOISE_FOR properties, skip if value equals UA default
    // (already handled above) — but don't skip if it's a meaningful override

    const camelProp = kebabToCamel(prop);
    result[camelProp] = maybeNumeric(value);
  }

  return result;
}

/**
 * Diff all captured elements against UA defaults. Returns an array of { path, style } for elements
 * with non-empty diffs.
 */
export function diffAllStyles(
  elements: CapturedStyle[],
  uaDefaults: Record<string, Record<string, string>>,
): DiffedStyle[] {
  const results: DiffedStyle[] = [];

  for (const el of elements) {
    const defaults = uaDefaults[el.tagName] ?? {};
    const style = diffStyles(el.styles, defaults);

    if (Object.keys(style).length > 0) {
      results.push({ path: el.path, style });
    }
  }

  return results;
}

/**
 * Compute style deltas between a base capture and a breakpoint capture. Returns only properties
 * that changed at the new viewport width.
 */
export function computeMediaDelta(
  baseElements: CapturedStyle[],
  bpElements: CapturedStyle[],
  uaDefaults: Record<string, Record<string, string>>,
): DiffedStyle[] {
  const baseByPath = new Map<string, CapturedStyle>();
  for (const el of baseElements) {
    baseByPath.set(el.path.join(","), el);
  }

  const deltas: DiffedStyle[] = [];

  for (const bpEl of bpElements) {
    const key = bpEl.path.join(",");
    const baseEl = baseByPath.get(key);
    if (!baseEl) {
      continue;
    }

    const defaults = uaDefaults[bpEl.tagName] ?? {};
    const baseStyle = diffStyles(baseEl.styles, defaults);
    const bpStyle = diffStyles(bpEl.styles, defaults);

    // Only keep properties that changed from base
    const delta: Record<string, string | number> = {};
    for (const [prop, val] of Object.entries(bpStyle)) {
      if (baseStyle[prop] !== val) {
        delta[prop] = val;
      }
    }

    if (Object.keys(delta).length > 0) {
      deltas.push({ path: bpEl.path, style: delta });
    }
  }

  return deltas;
}
