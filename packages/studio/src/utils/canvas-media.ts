/** Canvas media/breakpoint utilities — pure functions extracted for testability. */

import type { JxStyle } from "@jxsuite/schema/types";

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
export function parseMediaEntries(mediaDef: Record<string, string> | null | undefined) {
  if (!mediaDef) return { sizeBreakpoints: [], featureQueries: [], baseWidth: 320 };
  const sizes = [],
    features = [];
  let baseWidth = 320;
  for (const [name, query] of Object.entries(mediaDef)) {
    if (name === "--") {
      const wm = String(query).match(/^(\d+)\s*px$/);
      baseWidth = wm ? parseFloat(wm[1]) : 320;
      continue;
    }
    const minMatch = query.match(/min-width:\s*([\d.]+)px/);
    const maxMatch = query.match(/max-width:\s*([\d.]+)px/);
    if (minMatch) sizes.push({ name, query, width: parseFloat(minMatch[1]), type: "min" });
    else if (maxMatch) sizes.push({ name, query, width: parseFloat(maxMatch[1]), type: "max" });
    else features.push({ name, query });
  }
  sizes.sort((a, b) => (a.type === "min" ? a.width - b.width : b.width - a.width));
  return { sizeBreakpoints: sizes, featureQueries: features, baseWidth };
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
    if (bp.type === "min" && canvasWidth >= bp.width) active.add(bp.name);
    else if (bp.type === "max" && canvasWidth <= bp.width) active.add(bp.name);
  }
  return active;
}

/**
 * Apply styles to a canvas element, including active media overrides. Base (flat) styles applied
 * first, then matching media overrides in source order.
 *
 * @param {HTMLElement} el
 * @param {JxStyle | null | undefined} styleDef
 * @param {Set<string>} activeBreakpoints
 * @param {Record<string, boolean>} featureToggles
 */
export function applyCanvasStyle(
  el: HTMLElement,
  styleDef: JxStyle | null | undefined,
  activeBreakpoints: Set<string>,
  featureToggles: Record<string, boolean>,
) {
  if (!styleDef || typeof styleDef !== "object") return;
  for (const [prop, val] of Object.entries(styleDef)) {
    if (typeof val === "string" || typeof val === "number") {
      try {
        if (prop.startsWith("--")) el.style.setProperty(prop, String(val));
        else (el.style as unknown as Record<string, unknown>)[prop] = val;
      } catch {}
    }
  }
  for (const [key, val] of Object.entries(styleDef)) {
    if (!key.startsWith("@") || typeof val !== "object" || val === null) continue;
    const mediaName = key.slice(1);
    if (mediaName === "--") continue;
    if (activeBreakpoints.has(mediaName) || featureToggles[mediaName]) {
      for (const [prop, v] of Object.entries(/** @type {Record<string, unknown>} */ (val))) {
        if (typeof v === "string" || typeof v === "number") {
          try {
            if (prop.startsWith("--")) el.style.setProperty(prop, String(v));
            else (el.style as unknown as Record<string, unknown>)[prop] = v;
          } catch {}
        }
      }
    }
  }
}

/**
 * Scan stylesheets for @media rules matching active breakpoints, collecting the CSS declarations
 * that should be applied as inline overrides per data-jx element.
 *
 * Returns a Map of data-jx uid → Map of CSS property → value.
 *
 * @param {Iterable<CSSStyleSheet>} styleSheets
 * @param {Set<string>} activeBreakpoints
 * @returns {Map<string, Map<string, string>>}
 */
export function collectMediaOverrides(
  styleSheets: Iterable<CSSStyleSheet>,
  activeBreakpoints: Set<string>,
) {
  const overrides: Map<string, Map<string, string>> = new Map();
  if (!activeBreakpoints.size) return overrides;

  for (const sheet of styleSheets) {
    /** @type {CSSRuleList | null} */
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (let ri = 0; ri < rules.length; ri++) {
      const rule = rules[ri];
      if (!(rule instanceof CSSMediaRule)) continue;
      if (!activeBreakpoints.has(rule.conditionText)) continue;
      for (let mi = 0; mi < rule.cssRules.length; mi++) {
        const mediaRule = rule.cssRules[mi];
        if (!(mediaRule instanceof CSSStyleRule)) continue;
        const selector = mediaRule.selectorText;
        const jxMatch = selector.match(/\[data-jx="([^"]+)"\]/);
        if (!jxMatch) continue;
        const uid = jxMatch[1];
        if (!overrides.has(uid)) overrides.set(uid, new Map());
        const props = overrides.get(uid) as Map<string, string>;
        for (let i = 0; i < mediaRule.style.length; i++) {
          const prop = mediaRule.style[i];
          props.set(prop, mediaRule.style.getPropertyValue(prop));
        }
      }
    }
  }
  return overrides;
}

/**
 * Apply collected media overrides to elements within a canvas.
 *
 * @param {Element} canvasEl
 * @param {Map<string, Map<string, string>>} overrides
 */
export function applyOverridesToCanvas(
  canvasEl: Element,
  overrides: Map<string, Map<string, string>>,
) {
  for (const [uid, props] of overrides) {
    const els = canvasEl.querySelectorAll(`[data-jx="${uid}"]`);
    for (const el of els) {
      for (const [prop, val] of props) {
        try {
          (el as HTMLElement).style.setProperty(prop, val);
        } catch {}
      }
    }
  }
}
