/**
 * Inherited-style.js — Computes the effective inherited style for a given breakpoint tab.
 *
 * Walks the cascade (base → each media block in order) up to but not including the active
 * breakpoint, producing the set of property values that would apply if no explicit override exists
 * on the current tab.
 */

import type { JxStyle } from "@jxsuite/schema/types";

/**
 * Compute the inherited style object for a given breakpoint tab.
 *
 * @param {JxStyle} style — full style object (flat props + @media blocks + selectors)
 * @param {string[]} mediaNames — ordered breakpoint names (from parseMediaEntries, respects cascade
 *   direction)
 * @param {string | null} activeTab — current breakpoint tab name, or null for base
 * @param {string | null} activeSelector — current nested selector, or null
 * @returns {Record<string, string | number>} Inherited style map (prop → value)
 */
export function computeInheritedStyle(
  style: JxStyle,
  mediaNames: string[],
  activeTab: string | null,
  activeSelector: string | null = null,
) {
  if (activeTab === null || mediaNames.length === 0) {
    return {};
  }

  const inherited: Record<string, string | number> = {};

  if (!activeSelector) {
    // Start with base flat props
    for (const [p, v] of Object.entries(style)) {
      if (typeof v !== "object") {
        inherited[p] = (v as string | number) ?? "";
      }
    }
    // Layer each media block in order until current tab
    for (const name of mediaNames) {
      if (name === activeTab) {
        break;
      }
      const block = (style[`@${name}`] || {}) as JxStyle;
      for (const [p, v] of Object.entries(block)) {
        if (typeof v !== "object") {
          inherited[p] = (v as string | number) ?? "";
        }
      }
    }
  } else {
    // Selector inheritance: base selector → each media's selector block in order
    const baseSel = (style[activeSelector] || {}) as JxStyle;
    for (const [p, v] of Object.entries(baseSel)) {
      if (typeof v !== "object") {
        inherited[p] = (v as string | number) ?? "";
      }
    }
    for (const name of mediaNames) {
      if (name === activeTab) {
        break;
      }
      const selBlock = (((style[`@${name}`] || {}) as Record<string, unknown>)[activeSelector] ||
        {}) as JxStyle;
      for (const [p, v] of Object.entries(selBlock)) {
        if (typeof v !== "object") {
          inherited[p] = (v as string | number) ?? "";
        }
      }
    }
  }

  return inherited;
}
