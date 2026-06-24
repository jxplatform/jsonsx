/// <reference lib="dom" />
/**
 * Preview render — extracted from studio.js (Phase 4m). Structural preview renderer that creates
 * DOM from Jx node trees as a fallback when runtime rendering fails.
 */

import { elToPath } from "../store";
import { isMappedArray, isRef } from "@jxsuite/schema/guards";
import { activeTab } from "../workspace/workspace";
import { applyCanvasStyle } from "../utils/canvas-media";
import { resolveDefaultForCanvas } from "../panels/signals-panel";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";

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
export function renderCanvasNode(
  node: JxMutableNode | string | number | boolean | null | undefined,
  path: JxPath,
  parent: HTMLElement,
  activeBreakpoints: Set<string>,
  featureToggles: Record<string, boolean>,
) {
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    parent.append(document.createTextNode(String(node)));
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }

  // Array pseudo-element: render as a repeater perimeter at the array's own path, with a single
  // Template instance inside (matches the edit-mode visual).
  if (isMappedArray(node)) {
    const wrapper = document.createElement("div");
    wrapper.className = "repeater-perimeter";
    elToPath.set(wrapper, path);
    const template = node.map;
    if (template && typeof template === "object") {
      renderCanvasNode(template, [...path, "map"], wrapper, activeBreakpoints, featureToggles);
    }
    wrapper.style.pointerEvents = "none";
    parent.append(wrapper);
    return wrapper;
  }

  const tag = node.tagName || "div";
  const el = document.createElement(tag);

  elToPath.set(el, path);

  if (typeof node.textContent === "string") {
    el.textContent = node.textContent;
  } else if (isRef(node.textContent)) {
    const tc = node.textContent;
    const resolved = resolveDefaultForCanvas(tc, activeTab.value?.doc.document?.state);
    el.textContent = typeof resolved === "string" ? resolved : null;
    el.style.opacity = "0.7";
    el.style.fontStyle = "italic";
    el.title = `Bound: ${tc.$ref}`;
  }

  if (node.id) {
    el.id = node.id;
  }
  if (node.className) {
    el.className = node.className;
  }

  applyCanvasStyle(el, node.style, activeBreakpoints, featureToggles);

  if (node.attributes && typeof node.attributes === "object") {
    for (const [attr, val] of Object.entries(node.attributes)) {
      try {
        if (isRef(val)) {
          const resolved = resolveDefaultForCanvas(val, activeTab.value?.doc.document?.state);
          el.setAttribute(attr, String(resolved ?? ""));
        } else {
          el.setAttribute(attr, String(val));
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
  } else if (isMappedArray(node.children)) {
    const template = node.children.map;
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
      el.append(wrapper);
    }
  }

  if (node.$switch && node.cases && typeof node.cases === "object") {
    const keys = Object.keys(node.cases);
    const placeholder = document.createElement("div");
    placeholder.textContent = `[$switch: ${keys.join(" | ")}]`;
    placeholder.style.cssText =
      "font-family:var(--font-mono);font-size:var(--spectrum-font-size-50,11px);padding:6px 10px;background:color-mix(in srgb, var(--danger) 8%, transparent);border:1px dashed color-mix(in srgb, var(--danger) 40%, transparent);border-radius:var(--radius);color:var(--danger);font-style:italic";
    el.append(placeholder);
  }

  el.style.pointerEvents = "none";
  parent.append(el);
  return el;
}
