/// <reference lib="dom" />
/**
 * Parent-realm live component preview — registers a project component's custom element and
 * instantiates it in the editor document. Used by the browse grid and the components-palette DnD
 * cards. (The stylebook renders components inside the canvas iframe instead, via `$elements` refs
 * in its generated specimen doc.)
 */

import { defineElement, setSkipServerFunctions } from "@jxsuite/runtime";
import { projectState } from "../store";
import type { ComponentEntry } from "../files/components";

/**
 * Render a live component preview by registering its custom element and instantiating it.
 *
 * @param {ComponentEntry} comp
 * @returns {Promise<HTMLElement>}
 */
export async function renderComponentPreview(comp: ComponentEntry) {
  setSkipServerFunctions(true);
  try {
    if (comp.source === "npm") {
      if (!customElements.get(comp.tagName)) {
        return _componentFallback(comp.tagName);
      }
    } else {
      if (comp.path && !comp.path.endsWith(".json")) {
        // Format-class component sources (e.g. markdown) can't be imported as modules
        return _componentFallback(comp.tagName);
      }
      const root = projectState?.projectRoot;
      const url = `${location.origin}/${root ? `${root}/` : ""}${comp.path}`;
      await defineElement(url);
    }
    const el = document.createElement(comp.tagName);
    for (const p of comp.props || []) {
      if (p.default !== undefined && p.default !== "false" && p.default !== "''") {
        const val = String(p.default).replaceAll(/^'|'$/g, "");
        el.setAttribute(p.name, val);
      }
    }
    return el;
  } catch (error) {
    console.warn("Component preview failed:", comp.tagName, error);
    return _componentFallback(comp.tagName);
  }
}

/** @param {string} tagName */
function _componentFallback(tagName: string) {
  const fallback = document.createElement("div");
  fallback.style.cssText =
    "padding:12px;border:1px dashed var(--border);border-radius:var(--radius);color:var(--fg-dim)";
  fallback.textContent = `<${tagName}>`;
  return fallback;
}
