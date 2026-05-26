/**
 * Generate scoped CSS from nested style objects (e.g. `table: { width: "100%", thead: { ... } }`).
 * Returns a CSS string with rules scoped under the given selector.
 *
 * @param {Record<string, any>} styleObj - The full style object (flat + nested)
 * @param {string} scope - The scoping selector (e.g. `[data-jx-site]`)
 * @returns {string} Generated CSS text
 */
export function buildNestedSiteCSS(styleObj, scope) {
  let css = "";

  function emit(/** @type {string} */ parentSel, /** @type {Record<string, any>} */ rules) {
    const props = Object.entries(rules)
      .filter(([, val]) => val === null || typeof val !== "object" || Array.isArray(val))
      .map(([p, val]) => `${camelToKebab(p)}: ${val}`)
      .join("; ");
    if (props) css += `${parentSel} { ${props} }\n`;
    for (const [sel, sub] of Object.entries(rules)) {
      if (sub === null || typeof sub !== "object" || Array.isArray(sub)) continue;
      const resolved = sel.startsWith("&")
        ? sel.replace("&", parentSel)
        : sel.startsWith("[") || sel.startsWith(":") || sel.startsWith(".")
          ? `${parentSel}${sel}`
          : `${parentSel} ${sel}`;
      emit(resolved, sub);
    }
  }

  for (const [k, v] of Object.entries(styleObj)) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    const resolved = k.startsWith("&")
      ? k.replace("&", scope)
      : k.startsWith("[") || k.startsWith(":") || k.startsWith(".")
        ? `${scope}${k}`
        : `${scope} ${k}`;
    emit(resolved, v);
  }

  return css;
}

/**
 * Convert camelCase to kebab-case.
 *
 * @param {string} s
 * @returns {string}
 */
function camelToKebab(s) {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
