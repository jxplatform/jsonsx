/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Isolated subtree rendering for surgical canvas patches. Re-renders a single document node into
 * fresh DOM using the same edit-mode transform, runtime renderer, scope, and path mapper as the
 * panel's last full render — so the patched DOM is indistinguishable from a full re-render.
 */

import { elToRenderScope, elToScope, getNodeAtPath, stripEventHandlers } from "../store";
import { prepareForEditMode } from "../utils/edit-display";
import { renderNode as runtimeRenderNode } from "@jxsuite/runtime";
import { effectScope } from "../reactivity";
import { canvasPerf } from "./canvas-perf";

import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { CanvasPanel, PanelLiveCtx } from "../types";

/**
 * Render the document node at docPath into a detached DOM subtree for the given panel.
 *
 * The scope comes from the parent element's recorded render scope (elToScope), falling back to the
 * panel's root scope — so $-bindings, $media, and state references resolve exactly as they did in
 * the full render. Throws when the panel has no live render context.
 *
 * @param {CanvasPanel} panel
 * @param {JxMutableNode} doc Raw (non-reactive) document root
 * @param {JxPath} docPath
 * @param {Element} parentEl The rendered parent element (scope source)
 */
export function renderSubtree(
  panel: CanvasPanel,
  doc: JxMutableNode,
  docPath: JxPath,
  parentEl: Element,
): HTMLElement | Text {
  const { liveCtx } = panel;
  if (!liveCtx) {
    throw new Error("panel-missing-live-ctx");
  }
  const node = getNodeAtPath(doc, docPath) as JxMutableNode | string | undefined;
  if (node === undefined) {
    throw new Error(`node-not-found:${docPath.join("/")}`);
  }
  const def = typeof node === "string" ? node : prepareForEditMode(stripEventHandlers(node));
  const scope = elToScope.get(parentEl) ?? liveCtx.scope;

  // Render inside an effect scope parented to the panel's render scope: disposable on its own
  // When the subtree is later replaced/removed, and disposed with the panel on full renders.
  const render = () => {
    const subScope = effectScope();
    const rendered = subScope.run(() =>
      runtimeRenderNode(def, scope, {
        _path: docPathToRenderPath(docPath, liveCtx),
        onNodeCreated: liveCtx.pathMapper,
      }),
    )!;
    if (rendered instanceof HTMLElement) {
      elToRenderScope.set(rendered, subScope);
    }
    return rendered;
  };
  const el = panel.renderScope ? panel.renderScope.run(render)! : render();
  canvasPerf.subtreeRenders += 1;

  // Match full-render edit display: canvas content never receives pointer events directly.
  if (el instanceof HTMLElement) {
    el.style.pointerEvents = "none";
    for (const child of el.querySelectorAll("*")) {
      (child as HTMLElement).style.pointerEvents = "none";
    }
  }
  return el;
}

/**
 * Inverse of makePathMapper's layout-prefix strip: document paths are relative to the page doc,
 * render paths to the layout-merged doc. ($map/$switch paths never reach here — the patcher
 * escalates them.)
 *
 * @param {JxPath} docPath
 * @param {PanelLiveCtx} liveCtx
 */
function docPathToRenderPath(docPath: JxPath, liveCtx: PanelLiveCtx): (string | number)[] {
  if (liveCtx.layoutWrapped && liveCtx.pageContentPrefix && docPath[0] === "children") {
    // Re-apply the slot-container offset stripped by makePathMapper: page child index N renders at
    // Container index N + offset (offset = leading layout siblings before the <slot>).
    const [, idx] = docPath;
    return typeof idx === "number"
      ? [...liveCtx.pageContentPrefix, idx + (liveCtx.pageContentOffset ?? 0), ...docPath.slice(2)]
      : [...liveCtx.pageContentPrefix, ...docPath.slice(1)];
  }
  return docPath;
}

/**
 * The DOM node currently occupying children[index] of the rendered parent, or null when appending
 * at the end. The runtime renders an optional leading text node (from textContent) followed by one
 * DOM node per children entry, in order.
 *
 * @param {Element} parentEl
 * @param {JxMutableNode} parentNode
 * @param {number} index
 */
export function domChildReference(
  parentEl: Element,
  parentNode: JxMutableNode,
  index: number,
): ChildNode | null {
  const text = parentNode.textContent;
  const textOffset = text != null && String(text) !== "" ? 1 : 0;
  return parentEl.childNodes[textOffset + index] ?? null;
}
