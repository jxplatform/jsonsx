/**
 * Inherited-style.js — Computes the effective inherited style for a given breakpoint tab.
 *
 * Walks the cascade (base → each media block in order) up to but not including the active
 * breakpoint, producing the set of property values that would apply if no explicit override exists
 * on the current tab.
 */

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
export function computeInheritedStyle(style, mediaNames, activeTab, activeSelector = null) {
  if (activeTab === null || mediaNames.length === 0) return {};

  /** @type {Record<string, string | number>} */
  let inherited = {};

  if (!activeSelector) {
    // Start with base flat props
    for (const [p, v] of Object.entries(style)) {
      if (typeof v !== "object") inherited[p] = v ?? "";
    }
    // Layer each media block in order until current tab
    for (const name of mediaNames) {
      if (name === activeTab) break;
      const block = style[`@${name}`] || {};
      for (const [p, v] of Object.entries(block)) {
        if (typeof v !== "object") inherited[p] = v ?? "";
      }
    }
  } else {
    // Selector inheritance: base selector → each media's selector block in order
    const baseSel = style[activeSelector] || {};
    for (const [p, v] of Object.entries(baseSel)) {
      if (typeof v !== "object") inherited[p] = v ?? "";
    }
    for (const name of mediaNames) {
      if (name === activeTab) break;
      const selBlock =
        /** @type {Record<string, unknown>} */ (style[`@${name}`] || {})[activeSelector] || {};
      for (const [p, v] of Object.entries(selBlock)) {
        if (typeof v !== "object") inherited[p] = v ?? "";
      }
    }
  }

  return inherited;
}
