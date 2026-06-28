/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * In-iframe subtree rendering for surgical structural patches (insert / replace / attribute edits).
 * The cross-frame analog of `canvas-subtree-render.ts`: it re-renders a single shadow-doc node into
 * fresh DOM using the SAME edit-mode transform, runtime renderer, scope (`$defs`), path mapping,
 * and mode the full render used — so a patched subtree is indistinguishable from a full re-render.
 *
 * Dependency-light (runtime + reactivity + the pure path/edit helpers) so it stays inside the slim
 * canvas-iframe bundle. Where the legacy patcher records render scopes in the `elToRenderScope`
 * WeakMap, this stamps `data-jx-path` and tracks per-subtree effect scopes locally.
 */

import { elementStyleTags, renderNode } from "@jxsuite/runtime";
import { effectScope } from "../reactivity";
import { getNodeAtPath } from "../state";
import { makeStamper } from "./iframe-render";
import { prepareForEditMode } from "../utils/edit-display";
import { stripEventHandlers } from "../utils/strip-events";
import type { EffectScope } from "../reactivity";
import type { IframeRenderCtx } from "./iframe-render";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** The effect scope each surgically-rendered subtree root owns (for disposal on remove/replace). */
const elScope = new WeakMap<HTMLElement, EffectScope>();
/** Every live subtree scope, so a full re-render can stop them all (they're detached roots). */
const liveScopes = new Set<EffectScope>();

/**
 * Render the shadow-doc node at `docPath` into a detached DOM subtree, stamped with `data-jx-path`
 * and edit-mode-prepared exactly like the full render. Throws when the path resolves to nothing.
 */
export function renderSubtreeIframe(
  shadowDoc: JxMutableNode,
  docPath: JxPath,
  ctx: IframeRenderCtx,
): HTMLElement | Text {
  const node = getNodeAtPath(shadowDoc, docPath) as JxMutableNode | string | undefined;
  if (node === undefined) {
    throw new Error(`iframe-patch-node-not-found:${docPath.join("/")}`);
  }
  const def = typeof node === "string" ? node : prepareForEditMode(stripEventHandlers(node));
  const scope = effectScope(true);
  const rendered = scope.run(() =>
    renderNode(def, ctx.defs, {
      _path: docPathToRenderPath(docPath, ctx),
      onNodeCreated: makeStamper(ctx.mapperCtx),
    }),
  )!;
  // Track the scope for bulk dispose on full re-render; element scopes are also keyed by their root
  // Element so a targeted remove/replace can stop just that subtree (a bare text node owns none).
  liveScopes.add(scope);
  if (rendered instanceof HTMLElement) {
    elScope.set(rendered, scope);
  }
  return rendered;
}

/**
 * Release a removed/replaced subtree: stop the effect scopes rooted inside it and drop the scoped
 * `<style>` tags the runtime emitted for its elements (otherwise they orphan in the iframe head).
 */
export function disposeSubtree(el: Element): void {
  const targets: Element[] = [el, ...el.querySelectorAll("*")];
  for (const t of targets) {
    if (!(t instanceof HTMLElement)) {
      continue;
    }
    const tag = elementStyleTags.get(t);
    if (tag) {
      tag.remove();
      elementStyleTags.delete(t);
    }
    const scope = elScope.get(t);
    if (scope) {
      scope.stop();
      liveScopes.delete(scope);
      elScope.delete(t);
    }
  }
}

/** Stop every live subtree scope — called before a full re-render replaces the whole document. */
export function disposeAllSubtrees(): void {
  for (const scope of liveScopes) {
    scope.stop();
  }
  liveScopes.clear();
}

/**
 * Inverse of the path mapper's layout-prefix strip: shadow-doc paths are page-relative, render
 * paths are layout-merged. Re-applies the slot-container offset so the runtime renders the subtree
 * at the same render path the full render used. ($map/$switch paths never reach here — they
 * escalate.)
 */
function docPathToRenderPath(docPath: JxPath, ctx: IframeRenderCtx): (string | number)[] {
  const { mapperCtx } = ctx;
  if (mapperCtx.layoutWrapped && mapperCtx.pageContentPrefix && docPath[0] === "children") {
    const [, idx] = docPath;
    return typeof idx === "number"
      ? [
          ...mapperCtx.pageContentPrefix,
          idx + (mapperCtx.pageContentOffset ?? 0),
          ...docPath.slice(2),
        ]
      : [...mapperCtx.pageContentPrefix, ...docPath.slice(1)];
  }
  return docPath;
}
