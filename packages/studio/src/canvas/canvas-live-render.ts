/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Canvas live render — extracted from studio.js (Phase 4p). Async runtime rendering pipeline that
 * builds live canvas DOM using @jxsuite/runtime. Handles element registration, scope building, path
 * mapping ($map remapping), site-level style injection, and $head element injection.
 */

import { elToPath, elToScope, projectState, stripEventHandlers } from "../store";
import { errorMessage } from "@jxsuite/schema/parse";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { effectScope, toRaw } from "../reactivity";
import {
  buildScope,
  defineElement,
  renderNode as runtimeRenderNode,
  setSkipServerFunctions,
} from "@jxsuite/runtime";
import {
  distributePageIntoLayout,
  getEffectiveElements,
  getEffectiveHead,
  getEffectiveImports,
  getEffectiveLayoutPath,
  getEffectiveMedia,
  resolveLayoutDoc,
} from "../site-context";
import { componentRegistry, computeRelativePath } from "../files/components";
import { prepareForEditMode } from "../utils/edit-display";
import { getActiveElement } from "../editor/inline-edit";
import { buildNestedSiteCSS } from "./nested-site-style";

import type { JxDocument, JxElement, JxMutableNode } from "@jxsuite/schema/types";
import type { ComponentEntry } from "../files/components.js";
import type { CanvasPanel } from "../types";
import type { EffectScope } from "../reactivity";

export { buildNestedSiteCSS } from "./nested-site-style";

/** @param {Event} e */
function _preventNav(e: Event) {
  if ((e.target as HTMLElement).closest("a[href]")) {
    e.preventDefault();
  }
}

/** Canvas elements that already have the delegated nav guard listener. */
const _navGuarded = new WeakSet();

let _ctx: { getCanvasMode: () => string } | null = null;

/** Set of DOM elements that originated from the layout (not page content). */
export const layoutElements = new WeakSet();

/** Cache of element HREFs that failed to load — prevents infinite retry loops. */
const _failedElements = new Set();

let _failedElementsDocPath: string | null = null;

/**
 * Walk the merged document tree to find where page children were distributed into the layout slot.
 * Returns the `prefix` path to the container whose children hold the page content (first container
 * with a non-$__layout child), plus the `offset` — the index of the first page-content child within
 * that container's children array. The offset is non-zero when the layout places sibling nodes
 * (e.g. a `<noscript>`) before the `<slot>`, which shifts every page child's render index relative
 * to its page-document index. The path mapper subtracts this offset so canvas paths line up with
 * the page document (and thus the layers panel).
 *
 * @param {JxMutableNode} node
 * @param {(string | number)[]} [path]
 * @returns {{ prefix: (string | number)[]; offset: number } | null}
 */
function findPageContentPrefix(
  node: JxMutableNode,
  path: (string | number)[] = [],
): { prefix: (string | number)[]; offset: number } | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (Array.isArray(node.children)) {
    const firstPageIdx = node.children.findIndex(
      (child) => child && typeof child === "object" && !child.$__layout,
    );
    if (firstPageIdx !== -1) {
      return { offset: firstPageIdx, prefix: [...path, "children"] };
    }
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child && typeof child === "object" && child.$__layout) {
        const found = findPageContentPrefix(child, [...path, "children", i]);
        if (found) {
          return found;
        }
      }
    }
  }
  return null;
}

/** The path of the currently active layout file, or null. */
export let activeLayoutPath = null as string | null;

/**
 * Recursively mark all nodes in a layout doc tree with $__layout: true so we can identify which
 * rendered DOM elements came from the layout vs page content.
 */
function markLayoutNodes(node: JxMutableNode) {
  if (!node || typeof node !== "object") {
    return;
  }
  node.$__layout = true;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (typeof child === "string") {
        continue;
      }
      markLayoutNodes(child);
    }
  }
  if (node.$elements) {
    for (const el of node.$elements) {
      if (typeof el !== "string") {
        markLayoutNodes(el as JxMutableNode);
      }
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
export function initCanvasLiveRender(ctx: { getCanvasMode: () => string }) {
  _ctx = ctx;
}

/** Context needed to map runtime render paths back to document paths. */
export interface PathMapperCtx {
  canvasMode: string;
  layoutWrapped: boolean;
  pageContentPrefix: (string | number)[] | null;
  /** Index of the first page-content child within the slot container (leading layout siblings). */
  pageContentOffset?: number;
  /** Document paths of every mapped-array node, used to remap edit-mode repeater perimeters. */
  arrayPaths: Set<string>;
}

/**
 * Build the onNodeCreated callback that records each rendered element's document path in elToPath.
 * Handles layout-prefix stripping and repeater-perimeter/template remapping. Shared by full panel
 * renders and isolated subtree re-renders so path bookkeeping stays consistent.
 */
export function makePathMapper(ctx: PathMapperCtx) {
  const { canvasMode, layoutWrapped, pageContentPrefix, pageContentOffset, arrayPaths } = ctx;
  return function onNodeCreated(
    created: Node,
    path: (string | number)[],
    def: unknown,
    state?: Record<string, unknown>,
  ) {
    if (!(created instanceof HTMLElement)) {
      return;
    }
    if (state) {
      elToScope.set(created, state);
    }
    // Track layout-originated elements — don't store in elToPath to avoid
    // Path collisions with remapped page content paths
    if (layoutWrapped && typeof def === "object" && (def as JxMutableNode)?.$__layout) {
      layoutElements.add(created);
      created.dataset.jxLayout = "";
      return;
    }

    // Remap layout-wrapped paths: strip the layout prefix so paths are
    // Relative to the original page document (which is what S.document holds)
    let mappedPath = path;
    if (layoutWrapped && pageContentPrefix) {
      const pfx = pageContentPrefix;
      if (
        path.length >= pfx.length &&
        pfx.every((seg: string | number, i: number) => path[i] === seg)
      ) {
        // Page children render at container indices [offset, offset+1, …] when the layout places
        // Sibling nodes before the <slot>. Subtract the offset so they map back to the page
        // Document's 0-based child indices (what flattenTree / the layers panel use).
        const rest = path.slice(pfx.length);
        const [containerIdx] = rest;
        mappedPath =
          typeof containerIdx === "number"
            ? ["children", containerIdx - (pageContentOffset ?? 0), ...rest.slice(1)]
            : ["children", ...rest];
      }
    }

    // Remap repeater perimeters: prepareForEditMode renders each mapped-array node as a
    // `<div class="repeater-perimeter">` at the array's own child index, with the map template as
    // Its single child[0]. The perimeter's render path already equals the array's document path,
    // So only the template hop needs collapsing: for any array document path P, a render path of
    // `[...P, "children", 0, ...rest]` maps to `[...P, "map", ...rest]`. Looping handles nested
    // Repeaters (an array whose template contains another array).
    if ((canvasMode === "design" || canvasMode === "edit") && arrayPaths.size > 0) {
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 1; i < mappedPath.length - 1; i++) {
          if (
            mappedPath[i] === "children" &&
            mappedPath[i + 1] === 0 &&
            arrayPaths.has(mappedPath.slice(0, i).join("/"))
          ) {
            mappedPath = [...mappedPath.slice(0, i), "map", ...mappedPath.slice(i + 2)];
            changed = true;
            break;
          }
        }
      }
    }
    elToPath.set(created, mappedPath);
  };
}

/**
 * Render a Jx document into a canvas element using the real runtime. Populates elToPath for each
 * created element via onNodeCreated callback. Returns the live state scope on success, null on
 * failure.
 *
 * @param {number} gen - Render generation for staleness detection
 * @param {JxMutableNode} doc
 * @param {HTMLElement} canvasEl
 * @param {CanvasPanel | null} [panel] - Panel to persist render context on (for surgical patches)
 */
export async function renderCanvasLive(
  gen: number,
  doc: JxMutableNode,
  canvasEl: HTMLElement,
  panel: CanvasPanel | null = null,
) {
  const tab = activeTab.value;
  const S = {
    document: tab?.doc.document,
    documentPath: tab?.documentPath,
    mode: tab?.doc.mode,
  };
  const canvasMode = _ctx!.getCanvasMode();

  if (S.documentPath !== _failedElementsDocPath) {
    _failedElements.clear();
    _failedElementsDocPath = S.documentPath ?? null;
  }

  // Suppress server function resolution in non-preview modes to avoid
  // Failed proxy calls and infinite reactive retries (also covers
  // Async custom element connectedCallbacks that run after this function returns)
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
  /** Index of the first page child within the slot container (offset by leading layout siblings). */
  let pageContentOffset = 0;

  if (isPage) {
    const layoutPath = getEffectiveLayoutPath(doc.$layout);
    if (layoutPath) {
      const layoutDoc = (await resolveLayoutDoc(layoutPath)) as JxMutableNode | null;
      if (layoutDoc) {
        if (gen !== view.renderGeneration) {
          return null;
        }
        activeLayoutPath = layoutPath.replace(/^\.\//, "");
        markLayoutNodes(layoutDoc);
        const pageForSlots = canvasMode === "preview" ? structuredClone(toRaw(doc)) : renderDoc;
        const merged = distributePageIntoLayout(layoutDoc, pageForSlots);
        renderDoc =
          canvasMode === "preview" ? merged : prepareForEditMode(stripEventHandlers(merged));
        layoutWrapped = true;
        const pageContent = findPageContentPrefix(merged);
        pageContentPrefix = pageContent?.prefix ?? null;
        pageContentOffset = pageContent?.offset ?? 0;
      }
    }
  }

  // In edit mode, collect the document path of every mapped-array node so the path mapper can
  // Remap their edit-mode perimeters (and templates) back to document paths.
  const arrayPaths = new Set<string>();
  let renderScope: EffectScope | null = null;
  if (canvasMode === "design" || canvasMode === "edit") {
    (function findArrayPaths(node: JxMutableNode, path: (string | number)[]) {
      if (!node || typeof node !== "object") {
        return;
      }
      // The node itself is a mapped array (reached as a member or whole-children slot).
      if ((node as unknown as { $prototype?: string }).$prototype === "Array") {
        arrayPaths.add(path.join("/"));
        const mapDef = (node as JxMutableNode).map;
        if (mapDef && typeof mapDef === "object") {
          findArrayPaths(mapDef, [...path, "map"]);
        }
        return;
      }
      if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          if (typeof child === "string") {
            continue;
          }
          findArrayPaths(child!, [...path, "children", i]);
        }
      } else if (
        node.children &&
        typeof node.children === "object" &&
        (node.children as unknown as { $prototype?: string }).$prototype === "Array"
      ) {
        // Legacy whole-children repeater.
        findArrayPaths(node.children as JxMutableNode, [...path, "children"]);
      }
      if (node.$switch && node.cases) {
        for (const [k, v] of Object.entries(node.cases)) {
          findArrayPaths(v, [...path, "cases", k]);
        }
      }
    })(doc, []);
  }

  try {
    const root = projectState?.projectRoot || "";
    const docPrefix = root ? `${root}/` : "";
    const docBase = S.documentPath ? `${location.origin}/${docPrefix}${S.documentPath}` : undefined;

    // Register custom elements so the runtime can render them
    const effectiveElements = getEffectiveElements(renderDoc.$elements as (JxElement | string)[]);

    // In content mode (markdown) or when a layout is applied, auto-discover components
    // For custom elements that have no explicit $elements registration.
    if ((S.mode === "content" || layoutWrapped) && componentRegistry.length > 0) {
      const existingRefs = new Set(
        effectiveElements.map((e: JxElement | string) => (typeof e === "string" ? e : e?.$ref)),
      );
      /** @param {JxMutableNode} node */
      const collectTags = (node: JxMutableNode) => {
        const tags = new Set<string>();
        if (!node || typeof node !== "object") {
          return tags;
        }
        if (node.tagName) {
          tags.add(node.tagName);
        }
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            if (typeof child === "string") {
              continue;
            }
            for (const t of collectTags(child)) {
              tags.add(t);
            }
          }
        }
        return tags;
      };
      for (const tag of collectTags(renderDoc)) {
        const comp = componentRegistry.find((c: ComponentEntry) => c.tagName === tag);
        if (comp && comp.source !== "npm" && comp.path) {
          const relPath = computeRelativePath(S.documentPath ?? null, comp.path);
          if (!existingRefs.has(relPath)) {
            effectiveElements.push({ $ref: relPath });
            existingRefs.add(relPath);
          }
        }
      }
    }

    if (effectiveElements.length > 0) {
      renderDoc.$elements = effectiveElements as (string | JxMutableNode | { $ref: string })[];
      for (const entry of effectiveElements) {
        if (typeof entry === "string") {
          try {
            const specifier =
              entry.startsWith("/") || entry.startsWith(".") ? entry : `/node_modules/${entry}`;
            await import(specifier);
          } catch (error) {
            console.warn("Studio: failed to import package", entry, error);
          }
        } else if (entry?.$ref) {
          let href;
          try {
            ({ href } = new URL(entry.$ref, docBase));
          } catch (error) {
            console.warn("Studio: invalid element URL", { docBase, ref: entry.$ref }, error);
            continue;
          }
          if (_failedElements.has(href)) {
            continue;
          }
          try {
            await defineElement(href);
          } catch (error) {
            _failedElements.add(href);
            console.warn("Studio: failed to register element", entry.$ref, error);
          }
        }
      }
    }

    // Bail out if a newer render started while we were importing elements
    if (gen !== view.renderGeneration) {
      return null;
    }

    // Inject site-level imports so buildScope can resolve $prototype names
    renderDoc.imports = getEffectiveImports(renderDoc.imports);

    // Apply project-level styles mirroring the compiler convention:
    //   Viewport ≈ :root  → CSS custom properties (they inherit down)
    //   CanvasEl ≈ body   → regular CSS properties (inline beats CSS defaults)
    // This ensures project font-family, color, etc. override the
    // Content-mode fallback typography rules in the stylesheet.
    // In edit mode, propagate to the .content-edit-canvas wrapper for seamless appearance.
    const viewport = canvasEl.closest(".canvas-panel-viewport") as HTMLElement | null;
    const editSurface =
      canvasMode === "edit"
        ? (canvasEl.closest(".content-edit-canvas") as HTMLElement | null)
        : null;
    const siteStyle = projectState?.projectConfig?.style;
    if (viewport) {
      viewport.style.cssText = "";
      if (siteStyle && typeof siteStyle === "object") {
        for (const [k, v] of Object.entries(siteStyle)) {
          if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            continue;
          }
          if (k.startsWith("--")) {
            viewport.style.setProperty(k, String(v));
          } else {
            (viewport.style as unknown as Record<string, string>)[k] = String(v);
          }
        }
      }
    }
    if (editSurface && siteStyle && typeof siteStyle === "object") {
      for (const [k, v] of Object.entries(siteStyle)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          continue;
        }
        if (k.startsWith("--")) {
          editSurface.style.setProperty(k, String(v));
        } else {
          (editSurface.style as unknown as Record<string, string>)[k] = String(v);
        }
      }
    }
    if (siteStyle && typeof siteStyle === "object") {
      for (const [k, v] of Object.entries(siteStyle)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          continue;
        }
        if (!k.startsWith("--")) {
          (canvasEl.style as unknown as Record<string, string>)[k] = String(v);
        }
      }
    }

    // Generate a <style> tag for nested selector rules (e.g. table, thead, etc.)
    if (siteStyle && typeof siteStyle === "object") {
      const scopeAttr = `data-jx-site`;
      canvasEl.setAttribute(scopeAttr, "");
      const css = buildNestedSiteCSS(siteStyle, `[${scopeAttr}]`);

      if (css) {
        const existingStyleEl = document.querySelector("#jx-site-style");
        if (existingStyleEl) {
          existingStyleEl.remove();
        }
        const styleEl = document.createElement("style");
        styleEl.id = "jx-site-style";
        styleEl.textContent = css;
        document.head.append(styleEl);
      }
    }

    // Inject site-level $media so runtime can resolve media queries in styles
    renderDoc.$media = getEffectiveMedia(renderDoc.$media);

    // Inject $head elements (link/meta/script) into document.head
    const effectiveHead = getEffectiveHead(renderDoc.$head);
    if (effectiveHead.length > 0) {
      for (const entry of effectiveHead) {
        if (!entry?.tagName) {
          continue;
        }
        const tag = entry.tagName.toLowerCase();
        // Skip inline scripts — they can contain arbitrary JS/HTML that throws
        // When the browser tries to execute it in the studio context
        if (tag === "script" && !entry.attributes?.src) {
          continue;
        }
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
        if (selector !== tag && document.head.querySelector(selector)) {
          continue;
        }
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
          el.setAttribute(k, String(v));
        }
        if (entry.textContent) {
          el.textContent = entry.textContent;
        }
        document.head.append(el);
      }
    }

    const $defs = await buildScope(renderDoc as JxDocument, {}, docBase);
    // Bail out if a newer render started while buildScope was running
    if (gen !== view.renderGeneration) {
      return null;
    }
    const pathMapper = makePathMapper({
      arrayPaths,
      canvasMode,
      layoutWrapped,
      pageContentOffset,
      pageContentPrefix,
    });
    // Render inside a detached effect scope so the tree's reactive effects (template bindings,
    // $map/$switch containers) can be disposed when the panel is rebuilt, instead of leaking.
    renderScope = effectScope(true);
    const el = renderScope.run(() =>
      runtimeRenderNode(renderDoc, $defs, {
        _path: [],
        onNodeCreated: pathMapper,
      }),
    )! as HTMLElement;
    if ((canvasMode === "design" || canvasMode === "edit") && el instanceof HTMLElement) {
      // Disable pointer events on all rendered elements for edit mode
      el.style.pointerEvents = "none";
      for (const child of el.querySelectorAll("*")) {
        (child as HTMLElement).style.pointerEvents = "none";
      }
    }
    // Clear and append atomically — ensures the canvas is never left empty if a
    // Newer render starts and this one would have bailed after clearing.
    canvasEl.innerHTML = "";
    if (S.mode === "content") {
      canvasEl.dataset.contentMode = "";
    } else {
      delete canvasEl.dataset.contentMode;
    }

    canvasEl.append(el);

    // Delegated click handler prevents link navigation in all canvas modes.
    // Attached once per canvasEl (survives reactive re-renders that replace children).
    if (!_navGuarded.has(canvasEl)) {
      canvasEl.addEventListener("click", _preventNav);
      _navGuarded.add(canvasEl);
    }

    if (canvasMode === "design" || canvasMode === "edit") {
      requestAnimationFrame(() => {
        const editingEl = getActiveElement();
        for (const child of canvasEl.querySelectorAll("*")) {
          if (view.componentInlineEdit && child === view.componentInlineEdit.el) {
            continue;
          }
          if (editingEl && child === editingEl) {
            continue;
          }
          (child as HTMLElement).style.pointerEvents = "none";
        }
      });
    }
    if (panel) {
      panel.renderScope?.stop();
      panel.renderScope = renderScope;
      panel.liveCtx = {
        arrayPaths,
        canvasMode,
        layoutWrapped,
        pageContentOffset,
        pageContentPrefix,
        pathMapper,
        scope: $defs as Record<string, unknown>,
      };
    }
    return $defs;
  } catch (error) {
    renderScope?.stop();
    console.warn("renderCanvasLive failed:", errorMessage(error), error);
    return null;
  }
}
