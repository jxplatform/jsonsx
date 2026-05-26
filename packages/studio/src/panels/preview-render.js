/**
 * Preview render — extracted from studio.js (Phase 4m). Structural preview renderer that creates
 * DOM from Jx node trees as a fallback when runtime rendering fails.
 */

import { elToPath } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { applyCanvasStyle } from "../utils/canvas-media.js";
import { resolveDefaultForCanvas } from "../panels/signals-panel.js";

/**
 * Recursively render a Jx node to the canvas DOM. Media-aware: applies base styles + active
 * breakpoint/feature overrides.
 *
 * @param {JxMutableNode | string | number | boolean | null | undefined} node
 * @param {JxPath} path
 * @param {HTMLElement} parent
 * @param {Set<string>} activeBreakpoints
 * @param {Record<string, boolean>} featureToggles
 */
export function renderCanvasNode(node, path, parent, activeBreakpoints, featureToggles) {
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    parent.appendChild(document.createTextNode(String(node)));
    return;
  }
  if (!node || typeof node !== "object") return;

  const tag = node.tagName || "div";
  const el = document.createElement(tag);

  elToPath.set(el, path);

  if (typeof node.textContent === "string") {
    el.textContent = node.textContent;
  } else if (typeof node.textContent === "object" && node.textContent !== null) {
    const tc = /** @type {Record<string, unknown>} */ (node.textContent);
    if (tc.$ref) {
      const resolved = resolveDefaultForCanvas(tc, activeTab.value?.doc.document?.state);
      el.textContent = /** @type {string | null} */ (resolved);
      el.style.opacity = "0.7";
      el.style.fontStyle = "italic";
      el.title = `Bound: ${tc.$ref}`;
    }
  }

  if (node.id) el.id = node.id;
  if (node.className) el.className = node.className;

  applyCanvasStyle(el, node.style, activeBreakpoints, featureToggles);

  if (node.attributes && typeof node.attributes === "object") {
    for (const [attr, val] of Object.entries(node.attributes)) {
      try {
        if (
          typeof val === "object" &&
          val !== null &&
          /** @type {Record<string, unknown>} */ (val).$ref
        ) {
          const resolved = resolveDefaultForCanvas(val, activeTab.value?.doc.document?.state);
          el.setAttribute(attr, /** @type {string} */ (resolved));
        } else {
          el.setAttribute(attr, val);
        }
      } catch {}
    }
  }

  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      renderCanvasNode(
        node.children[i],
        [...path, "children", i],
        el,
        activeBreakpoints,
        featureToggles,
      );
    }
  } else if (
    node.children &&
    typeof node.children === "object" &&
    /** @type {Record<string, unknown>} */ (node.children).$prototype === "Array"
  ) {
    const childrenObj = /** @type {Record<string, unknown>} */ (node.children);
    const template = childrenObj.map;
    if (template && typeof template === "object") {
      const wrapper = document.createElement("div");
      wrapper.className = "repeater-perimeter";
      elToPath.set(wrapper, [...path, "children"]);
      renderCanvasNode(
        template,
        [...path, "children", "map"],
        wrapper,
        activeBreakpoints,
        featureToggles,
      );
      el.appendChild(wrapper);
    }
  }

  if (node.$switch && node.cases && typeof node.cases === "object") {
    const keys = Object.keys(node.cases);
    const placeholder = document.createElement("div");
    placeholder.textContent = `[$switch: ${keys.join(" | ")}]`;
    placeholder.style.cssText =
      "font-family:monospace;font-size:11px;padding:6px 10px;background:color-mix(in srgb, var(--danger) 8%, transparent);border:1px dashed color-mix(in srgb, var(--danger) 40%, transparent);border-radius:4px;color:var(--danger);font-style:italic";
    el.appendChild(placeholder);
  }

  el.style.pointerEvents = "none";
  parent.appendChild(el);
  return el;
}
