/**
 * Canvas live render — extracted from studio.js (Phase 4p). Async runtime rendering pipeline that
 * builds live canvas DOM using @jxsuite/runtime. Handles element registration, scope building, path
 * mapping ($map remapping), site-level style injection, and $head element injection.
 */

import { elToPath, stripEventHandlers, projectState } from "../store.js";
import { view } from "../view.js";
import { renderNode as runtimeRenderNode, buildScope, defineElement } from "@jxsuite/runtime";
import {
  getEffectiveElements,
  getEffectiveImports,
  getEffectiveMedia,
  getEffectiveHead,
} from "../site-context.js";
import { componentRegistry, computeRelativePath } from "../files/components.js";
import { prepareForEditMode } from "../utils/edit-display.js";
import { getActiveElement } from "../editor/inline-edit.js";

/** @type {any} */
let _ctx = null;

/**
 * Initialize the canvas live render module.
 *
 * @param {{
 *   getState: () => any;
 *   getCanvasMode: () => string;
 * }} ctx
 */
export function initCanvasLiveRender(ctx) {
  _ctx = ctx;
}

/**
 * Render a Jx document into a canvas element using the real runtime. Populates elToPath for each
 * created element via onNodeCreated callback. Returns the live state scope on success, null on
 * failure.
 *
 * @param {number} gen - Render generation for staleness detection
 * @param {any} doc
 * @param {any} canvasEl
 */
export async function renderCanvasLive(gen, doc, canvasEl) {
  const S = _ctx.getState();
  const canvasMode = _ctx.getCanvasMode();

  const renderDoc =
    canvasMode === "preview" ? structuredClone(doc) : prepareForEditMode(stripEventHandlers(doc));

  // In edit mode, collect paths where $map templates were inlined as children[0]
  // so we can remap runtime paths (children,0,...) → (children,map,...)
  const mapParentPaths = new Set();
  if (canvasMode === "design" || canvasMode === "edit") {
    (function findMapParents(/** @type {any} */ node, /** @type {any[]} */ path) {
      if (!node || typeof node !== "object") return;
      if (
        node.children &&
        typeof node.children === "object" &&
        node.children.$prototype === "Array"
      ) {
        mapParentPaths.add(path.join("/"));
      }
      if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          findMapParents(node.children[i], [...path, "children", i]);
        }
      }
      if (node.$switch && node.cases) {
        for (const [k, v] of Object.entries(node.cases)) {
          findMapParents(v, [...path, "cases", k]);
        }
      }
    })(doc, []);
  }

  try {
    const root = projectState?.projectRoot || "";
    const docPrefix = root ? `${root}/` : "";
    const docBase = S.documentPath ? `${location.origin}/${docPrefix}${S.documentPath}` : undefined;

    // Register custom elements so the runtime can render them
    let effectiveElements = getEffectiveElements(renderDoc.$elements);

    // In content mode (markdown), auto-discover components for directive-based
    // custom elements that have no explicit $elements registration.
    if (S.mode === "content" && componentRegistry.length > 0) {
      const existingRefs = new Set(
        effectiveElements.map((/** @type {any} */ e) => (typeof e === "string" ? e : e?.$ref)),
      );
      /** @param {any} node */
      const collectTags = (node) => {
        /** @type {Set<string>} */
        const tags = new Set();
        if (!node || typeof node !== "object") return tags;
        if (node.tagName) tags.add(node.tagName);
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            for (const t of collectTags(child)) tags.add(t);
          }
        }
        return tags;
      };
      for (const tag of collectTags(renderDoc)) {
        const comp = componentRegistry.find((/** @type {any} */ c) => c.tagName === tag);
        if (comp && comp.source !== "npm") {
          const relPath = computeRelativePath(S.documentPath, comp.path);
          if (!existingRefs.has(relPath)) {
            effectiveElements.push({ $ref: relPath });
            existingRefs.add(relPath);
          }
        }
      }
    }

    if (effectiveElements.length) {
      renderDoc.$elements = effectiveElements;
      for (const entry of effectiveElements) {
        if (typeof entry === "string") {
          try {
            const specifier =
              entry.startsWith("/") || entry.startsWith(".")
                ? entry
                : `/${projectState?.projectRoot || ""}/node_modules/${entry}`.replace(/\/+/g, "/");
            await import(specifier);
          } catch (/** @type {any} */ e) {
            console.warn("Studio: failed to import package", entry, e);
          }
        } else if (entry?.$ref) {
          let href;
          try {
            href = new URL(entry.$ref, docBase).href;
          } catch (/** @type {any} */ urlErr) {
            console.warn("Studio: invalid element URL", { ref: entry.$ref, docBase }, urlErr);
            continue;
          }
          try {
            await defineElement(href);
          } catch (/** @type {any} */ e) {
            console.warn("Studio: failed to register element", entry.$ref, e);
          }
        }
      }
    }

    // Bail out if a newer render started while we were importing elements
    if (gen !== view.renderGeneration) return null;

    // Inject site-level imports so buildScope can resolve $prototype names
    renderDoc.imports = getEffectiveImports(renderDoc.imports);

    // Apply project-level styles mirroring the compiler convention:
    //   viewport ≈ :root  → CSS custom properties (they inherit down)
    //   canvasEl ≈ body   → regular CSS properties (inline beats CSS defaults)
    // This ensures project font-family, color, etc. override the
    // content-mode fallback typography rules in the stylesheet.
    // In edit mode, propagate to the .content-edit-canvas wrapper for seamless appearance.
    const viewport = canvasEl.closest(".canvas-panel-viewport");
    const editSurface = canvasMode === "edit" ? canvasEl.closest(".content-edit-canvas") : null;
    const siteStyle = projectState?.projectConfig?.style;
    if (viewport) {
      viewport.style.cssText = "";
      if (siteStyle && typeof siteStyle === "object") {
        for (const [k, v] of Object.entries(siteStyle)) {
          if (k.startsWith("--")) {
            viewport.style.setProperty(k, String(v));
          } else {
            /** @type {any} */ (viewport.style)[k] = v;
          }
        }
      }
    }
    if (editSurface) {
      if (siteStyle && typeof siteStyle === "object") {
        for (const [k, v] of Object.entries(siteStyle)) {
          if (k.startsWith("--")) {
            /** @type {any} */ (editSurface).style.setProperty(k, String(v));
          } else {
            /** @type {any} */ (editSurface.style)[k] = v;
          }
        }
      }
    }
    if (siteStyle && typeof siteStyle === "object") {
      for (const [k, v] of Object.entries(siteStyle)) {
        if (!k.startsWith("--")) {
          /** @type {any} */ (canvasEl.style)[k] = v;
        }
      }
    }

    // Inject site-level $media so runtime can resolve media queries in styles
    renderDoc.$media = getEffectiveMedia(renderDoc.$media);

    // Inject $head elements (link/meta/script) into document.head
    const effectiveHead = getEffectiveHead(renderDoc.$head);
    if (effectiveHead.length) {
      for (const entry of effectiveHead) {
        if (!entry?.tagName) continue;
        const tag = entry.tagName.toLowerCase();
        const attrs = { ...entry.attributes };
        const headRoot = projectState?.projectRoot || "";
        for (const key of ["href", "src"]) {
          if (
            attrs[key] &&
            !attrs[key].startsWith("/") &&
            !attrs[key].startsWith(".") &&
            !attrs[key].startsWith("http")
          ) {
            attrs[key] = `/${headRoot}/node_modules/${attrs[key]}`.replace(/\/+/g, "/");
          }
        }
        const selector = `${tag}${attrs.href ? `[href="${attrs.href}"]` : ""}${attrs.src ? `[src="${attrs.src}"]` : ""}`;
        if (selector !== tag && document.head.querySelector(selector)) continue;
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, /** @type {string} */ (v));
        if (entry.textContent) el.textContent = entry.textContent;
        document.head.appendChild(el);
      }
    }

    const $defs = await buildScope(renderDoc, {}, docBase);
    // Bail out if a newer render started while buildScope was running
    if (gen !== view.renderGeneration) return null;
    const el = /** @type {HTMLElement} */ (
      runtimeRenderNode(renderDoc, $defs, {
        onNodeCreated(/** @type {any} */ el, /** @type {any} */ path) {
          // Remap $map paths: wrapper and template children → real document paths
          // prepareForEditMode wraps $map template in: children[0] (wrapper) > children[0] (template)
          // Real paths: wrapper → ['children'] ($map container), template → ['children', 'map']
          let mappedPath = path;
          if ((canvasMode === "design" || canvasMode === "edit") && mapParentPaths.size > 0) {
            for (let i = 0; i < path.length - 1; i++) {
              if (path[i] === "children" && path[i + 1] === 0) {
                const parentKey = path.slice(0, i).join("/");
                if (mapParentPaths.has(parentKey)) {
                  if (path.length === i + 2) {
                    // Wrapper div itself → $map container path
                    mappedPath = path.slice(0, i + 1);
                  } else if (
                    path.length >= i + 4 &&
                    path[i + 2] === "children" &&
                    path[i + 3] === 0
                  ) {
                    // Template or its descendants → children/map/...rest
                    mappedPath = [...path.slice(0, i), "children", "map", ...path.slice(i + 4)];
                  }
                  break;
                }
              }
            }
          }
          elToPath.set(el, mappedPath);
        },
        _path: [],
      })
    );
    if (canvasMode === "design" || canvasMode === "edit") {
      // Disable pointer events on all rendered elements for edit mode
      el.style.pointerEvents = "none";
      for (const child of el.querySelectorAll("*")) {
        /** @type {any} */ (child).style.pointerEvents = "none";
      }
    }
    // Clear and append atomically — ensures the canvas is never left empty if a
    // newer render starts and this one would have bailed after clearing.
    canvasEl.innerHTML = "";
    if (S.mode === "content") {
      canvasEl.setAttribute("data-content-mode", "");
    } else {
      canvasEl.removeAttribute("data-content-mode");
    }
    canvasEl.appendChild(el);
    if (canvasMode === "design" || canvasMode === "edit") {
      // Custom element connectedCallbacks render children asynchronously —
      // sweep again after they've had a chance to run
      requestAnimationFrame(() => {
        const editingEl = getActiveElement();
        for (const child of canvasEl.querySelectorAll("*")) {
          // Preserve pointer-events on the actively-edited element
          if (view.componentInlineEdit && child === view.componentInlineEdit.el) continue;
          if (editingEl && child === editingEl) continue;
          /** @type {any} */ (child).style.pointerEvents = "none";
        }
      });
    }
    return $defs;
  } catch (/** @type {any} */ err) {
    console.warn("renderCanvasLive failed:", err.message, err);
    return null;
  }
}
