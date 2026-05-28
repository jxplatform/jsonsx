/**
 * Canvas live render — extracted from studio.js (Phase 4p). Async runtime rendering pipeline that
 * builds live canvas DOM using @jxsuite/runtime. Handles element registration, scope building, path
 * mapping ($map remapping), site-level style injection, and $head element injection.
 */

import { elToPath, stripEventHandlers, projectState } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { view } from "../view.js";
import { toRaw } from "../reactivity.js";
import {
  renderNode as runtimeRenderNode,
  buildScope,
  defineElement,
  setSkipServerFunctions,
} from "@jxsuite/runtime";
import {
  getEffectiveElements,
  getEffectiveImports,
  getEffectiveMedia,
  getEffectiveHead,
  getEffectiveLayoutPath,
  resolveLayoutDoc,
  distributePageIntoLayout,
} from "../site-context.js";
import { componentRegistry, computeRelativePath } from "../files/components.js";
import { prepareForEditMode } from "../utils/edit-display.js";
import { getActiveElement } from "../editor/inline-edit.js";
import { buildNestedSiteCSS } from "./nested-site-style.js";

export { buildNestedSiteCSS } from "./nested-site-style.js";

/** @type {{ getCanvasMode: () => string } | null} */
let _ctx = null;

/** Set of DOM elements that originated from the layout (not page content). */
export const layoutElements = new WeakSet();

/** Cache of element HREFs that failed to load — prevents infinite retry loops. */
const _failedElements = new Set();

/** @type {string | null} */
let _failedElementsDocPath = null;

/**
 * Walk the merged document tree to find the path prefix where page children were distributed into
 * the layout slot. Returns the path to the container whose children are the page content (first
 * non-$__layout children array).
 *
 * @param {JxMutableNode} node
 * @param {(string | number)[]} [path]
 * @returns {(string | number)[] | null}
 */
function findPageContentPrefix(node, path = []) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child && typeof child === "object" && !child.$__layout) {
        return [...path, "children"];
      }
    }
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child && typeof child === "object" && child.$__layout) {
        const found = findPageContentPrefix(child, [...path, "children", i]);
        if (found) return found;
      }
    }
  }
  return null;
}

/** The path of the currently active layout file, or null. */
export let activeLayoutPath = /** @type {string | null} */ (null);

/**
 * Recursively mark all nodes in a layout doc tree with $__layout: true so we can identify which
 * rendered DOM elements came from the layout vs page content.
 */
function markLayoutNodes(/** @type {JxMutableNode} */ node) {
  if (!node || typeof node !== "object") return;
  node.$__layout = true;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (typeof child === "string") continue;
      markLayoutNodes(child);
    }
  }
  if (node.$elements) {
    for (const el of node.$elements) {
      if (typeof el !== "string") markLayoutNodes(el);
    }
  }
}

/**
 * Initialize the canvas live render module.
 *
 * @param {{
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
 * @param {JxMutableNode} doc
 * @param {HTMLElement} canvasEl
 */
export async function renderCanvasLive(gen, doc, canvasEl) {
  const tab = activeTab.value;
  const S = { documentPath: tab?.documentPath, mode: tab?.doc.mode, document: tab?.doc.document };
  const canvasMode = /** @type {{ getCanvasMode: () => string }} */ (_ctx).getCanvasMode();

  if (S.documentPath !== _failedElementsDocPath) {
    _failedElements.clear();
    _failedElementsDocPath = S.documentPath ?? null;
  }

  // Suppress server function resolution in non-preview modes to avoid
  // failed proxy calls and infinite reactive retries (also covers
  // async custom element connectedCallbacks that run after this function returns)
  setSkipServerFunctions(canvasMode !== "preview");

  let renderDoc =
    canvasMode === "preview"
      ? structuredClone(toRaw(doc))
      : prepareForEditMode(stripEventHandlers(doc));

  // ─── Layout wrapping ────────────────────────────────────────────────────
  // For page documents, resolve the layout and wrap content in the layout shell.
  // Layout-originated nodes are marked with $__layout so we can distinguish them.
  let layoutWrapped = false;
  activeLayoutPath = null;

  const isPage =
    S.documentPath &&
    projectState?.isSiteProject &&
    (S.documentPath.startsWith("pages/") || S.documentPath.startsWith("./pages/"));

  /** @type {(string | number)[] | null} Path prefix in merged doc where page children live */
  let pageContentPrefix = null;

  if (isPage) {
    const layoutPath = getEffectiveLayoutPath(doc.$layout);
    if (layoutPath) {
      const layoutDoc = await resolveLayoutDoc(layoutPath);
      if (layoutDoc) {
        if (gen !== view.renderGeneration) return null;
        activeLayoutPath = layoutPath.replace(/^\.\//, "");
        markLayoutNodes(layoutDoc);
        const pageForSlots = canvasMode === "preview" ? structuredClone(toRaw(doc)) : renderDoc;
        const merged = distributePageIntoLayout(layoutDoc, pageForSlots);
        renderDoc =
          canvasMode === "preview" ? merged : prepareForEditMode(stripEventHandlers(merged));
        layoutWrapped = true;
        pageContentPrefix = findPageContentPrefix(merged);
      }
    }
  }

  // In edit mode, collect paths where children use $prototype:"Array"
  // so we can remap runtime paths (children,map,N,...) → (children,map,...)
  const mapParentPaths = new Set();
  if (canvasMode === "design" || canvasMode === "edit") {
    (function findMapParents(
      /** @type {JxMutableNode} */ node,
      /** @type {(string | number)[]} */ path,
    ) {
      if (!node || typeof node !== "object") return;
      if (
        node.children &&
        typeof node.children === "object" &&
        /** @type {{ $prototype?: string }} */ (node.children).$prototype === "Array"
      ) {
        mapParentPaths.add(path.join("/"));
      }
      if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          if (typeof child === "string") continue;
          findMapParents(child, [...path, "children", i]);
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
    let effectiveElements = getEffectiveElements(
      /** @type {(JxElement | string)[]} */ (renderDoc.$elements),
    );

    // In content mode (markdown), auto-discover components for directive-based
    // custom elements that have no explicit $elements registration.
    if (S.mode === "content" && componentRegistry.length > 0) {
      const existingRefs = new Set(
        effectiveElements.map((/** @type {JxElement | string} */ e) =>
          typeof e === "string" ? e : e?.$ref,
        ),
      );
      /** @param {JxMutableNode} node */
      const collectTags = (node) => {
        /** @type {Set<string>} */
        const tags = new Set();
        if (!node || typeof node !== "object") return tags;
        if (node.tagName) tags.add(node.tagName);
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            if (typeof child === "string") continue;
            for (const t of collectTags(child)) tags.add(t);
          }
        }
        return tags;
      };
      for (const tag of collectTags(renderDoc)) {
        const comp = componentRegistry.find(
          (/** @type {import("../files/components.js").ComponentEntry} */ c) => c.tagName === tag,
        );
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
      renderDoc.$elements = /** @type {(JxMutableNode | string | { $ref: string })[]} */ (
        /** @type {unknown} */ (effectiveElements)
      );
      for (const entry of effectiveElements) {
        if (typeof entry === "string") {
          try {
            const specifier =
              entry.startsWith("/") || entry.startsWith(".") ? entry : `/node_modules/${entry}`;
            await import(specifier);
          } catch (/** @type {unknown} */ e) {
            console.warn("Studio: failed to import package", entry, e);
          }
        } else if (entry?.$ref) {
          let href;
          try {
            href = new URL(entry.$ref, docBase).href;
          } catch (/** @type {unknown} */ urlErr) {
            console.warn("Studio: invalid element URL", { ref: entry.$ref, docBase }, urlErr);
            continue;
          }
          if (_failedElements.has(href)) continue;
          try {
            await defineElement(href);
          } catch (/** @type {unknown} */ e) {
            _failedElements.add(href);
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
    const viewport = /** @type {HTMLElement | null} */ (canvasEl.closest(".canvas-panel-viewport"));
    const editSurface =
      canvasMode === "edit"
        ? /** @type {HTMLElement | null} */ (canvasEl.closest(".content-edit-canvas"))
        : null;
    const siteStyle = projectState?.projectConfig?.style;
    if (viewport) {
      viewport.style.cssText = "";
      if (siteStyle && typeof siteStyle === "object") {
        for (const [k, v] of Object.entries(siteStyle)) {
          if (v !== null && typeof v === "object" && !Array.isArray(v)) continue;
          if (k.startsWith("--")) {
            viewport.style.setProperty(k, String(v));
          } else {
            /** @type {Record<string, string>} */ (/** @type {unknown} */ (viewport.style))[k] =
              String(v);
          }
        }
      }
    }
    if (editSurface) {
      if (siteStyle && typeof siteStyle === "object") {
        for (const [k, v] of Object.entries(siteStyle)) {
          if (v !== null && typeof v === "object" && !Array.isArray(v)) continue;
          if (k.startsWith("--")) {
            editSurface.style.setProperty(k, String(v));
          } else {
            /** @type {Record<string, string>} */ (/** @type {unknown} */ (editSurface.style))[k] =
              String(v);
          }
        }
      }
    }
    if (siteStyle && typeof siteStyle === "object") {
      for (const [k, v] of Object.entries(siteStyle)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) continue;
        if (!k.startsWith("--")) {
          /** @type {Record<string, string>} */ (/** @type {unknown} */ (canvasEl.style))[k] =
            String(v);
        }
      }
    }

    // Generate a <style> tag for nested selector rules (e.g. table, thead, etc.)
    if (siteStyle && typeof siteStyle === "object") {
      const scopeAttr = `data-jx-site`;
      canvasEl.setAttribute(scopeAttr, "");
      const css = buildNestedSiteCSS(siteStyle, `[${scopeAttr}]`);

      if (css) {
        const existingStyleEl = document.getElementById("jx-site-style");
        if (existingStyleEl) existingStyleEl.remove();
        const styleEl = document.createElement("style");
        styleEl.id = "jx-site-style";
        styleEl.textContent = css;
        document.head.appendChild(styleEl);
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
        for (const key of ["href", "src"]) {
          const val = attrs[key];
          if (
            typeof val === "string" &&
            !val.startsWith("/") &&
            !val.startsWith(".") &&
            !val.startsWith("http")
          ) {
            attrs[key] = `/node_modules/${val}`;
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
        onNodeCreated(
          /** @type {HTMLElement | Text} */ el,
          /** @type {(string | number)[]} */ path,
          /** @type {Record<string, unknown>} */ def,
        ) {
          if (!(el instanceof HTMLElement)) return;
          // Track layout-originated elements — don't store in elToPath to avoid
          // path collisions with remapped page content paths
          if (layoutWrapped && def?.$__layout) {
            layoutElements.add(el);
            if (el.setAttribute) el.setAttribute("data-jx-layout", "");
            return;
          }

          // Remap layout-wrapped paths: strip the layout prefix so paths are
          // relative to the original page document (which is what S.document holds)
          let mappedPath = path;
          if (layoutWrapped && pageContentPrefix) {
            const pfx = pageContentPrefix;
            if (
              path.length >= pfx.length &&
              pfx.every(
                (/** @type {string | number} */ seg, /** @type {number} */ i) => path[i] === seg,
              )
            ) {
              mappedPath = ["children", ...path.slice(pfx.length)];
            }
          }

          // Remap $map paths: renderMappedArray produces paths like
          // [..., "children", "map", N, ...] for each rendered item. Map them
          // back to [..., "children", "map", ...] (the template definition path).
          if ((canvasMode === "design" || canvasMode === "edit") && mapParentPaths.size > 0) {
            for (let i = 0; i < mappedPath.length - 1; i++) {
              if (mappedPath[i] === "children" && mappedPath[i + 1] === "map") {
                const parentKey = mappedPath.slice(0, i).join("/");
                if (mapParentPaths.has(parentKey)) {
                  if (mappedPath.length > i + 2 && typeof mappedPath[i + 2] === "number") {
                    // Strip the item index: [..., "children", "map", N, rest] → [..., "children", "map", rest]
                    mappedPath = [...mappedPath.slice(0, i + 2), ...mappedPath.slice(i + 3)];
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
        /** @type {HTMLElement} */ (child).style.pointerEvents = "none";
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
      requestAnimationFrame(() => {
        const editingEl = getActiveElement();
        for (const child of canvasEl.querySelectorAll("*")) {
          if (view.componentInlineEdit && child === view.componentInlineEdit.el) continue;
          if (editingEl && child === editingEl) continue;
          /** @type {HTMLElement} */ (child).style.pointerEvents = "none";
        }
      });
    }
    return $defs;
  } catch (/** @type {unknown} */ err) {
    console.warn("renderCanvasLive failed:", /** @type {Error} */ (err).message, err);
    return null;
  }
}
