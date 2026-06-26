/// <reference lib="dom" />
/**
 * Render-path mapping — pure logic shared by the legacy in-realm path mapper (which stores paths in
 * the `elToPath` WeakMap) and the iframe host (which stamps them as `data-jx-path` attributes).
 *
 * The runtime fires `onNodeCreated(el, renderPath, def, state)` for every node. The render path is
 * not always the document path: layout-wrapped pages shift page content under a layout prefix, and
 * `prepareForEditMode` renders mapped arrays (`$prototype: Array`) as a `repeater-perimeter` whose
 * single child hop must be collapsed back to a `map` segment. {@link classifyRenderNode} resolves a
 * render path to either a document path or a "layout" marker; {@link serializeJxPath} encodes the
 * result for the `data-jx-path` attribute.
 */

import type { JxPath } from "../state";

/** Context the mapper needs, computed once per render by whoever prepared the document. */
export interface PathMapCtx {
  canvasMode: string;
  layoutWrapped: boolean;
  pageContentPrefix: JxPath | null;
  pageContentOffset: number | null;
  arrayPaths: Set<string>;
}

/** A render node either belongs to the layout chrome (no document path) or maps to a document path. */
export type RenderNodeClass = { kind: "layout" } | { kind: "path"; path: JxPath };

/**
 * Resolve a runtime render path to a document path (or flag it as layout-originated). Pure — the
 * caller decides whether to record the result in a WeakMap or a `data-jx-path` attribute.
 */
export function classifyRenderNode(path: JxPath, def: unknown, ctx: PathMapCtx): RenderNodeClass {
  // Layout-originated nodes have no page-document path; the caller marks them (data-jx-layout).
  if (ctx.layoutWrapped && typeof def === "object" && (def as { $__layout?: unknown })?.$__layout) {
    return { kind: "layout" };
  }

  let mappedPath = path;

  // Strip the layout prefix so paths are relative to the original page document.
  // Page children render at indices [offset, offset+1, …] when the layout places siblings before
  // The <slot>, so subtract the offset to recover the page's 0-based child indices.
  if (ctx.layoutWrapped && ctx.pageContentPrefix) {
    const pfx = ctx.pageContentPrefix;
    if (path.length >= pfx.length && pfx.every((seg, i) => path[i] === seg)) {
      const rest = path.slice(pfx.length);
      const [containerIdx] = rest;
      mappedPath =
        typeof containerIdx === "number"
          ? ["children", containerIdx - (ctx.pageContentOffset ?? 0), ...rest.slice(1)]
          : ["children", ...rest];
    }
  }

  // Collapse repeater-perimeter template hops: for an array document path P, a render path of
  // `[...P, "children", 0, ...rest]` maps to `[...P, "map", ...rest]`. Loop for nested repeaters.
  if ((ctx.canvasMode === "design" || ctx.canvasMode === "edit") && ctx.arrayPaths.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 1; i < mappedPath.length - 1; i++) {
        if (
          mappedPath[i] === "children" &&
          mappedPath[i + 1] === 0 &&
          ctx.arrayPaths.has(mappedPath.slice(0, i).join("/"))
        ) {
          mappedPath = [...mappedPath.slice(0, i), "map", ...mappedPath.slice(i + 2)];
          changed = true;
          break;
        }
      }
    }
  }

  return { kind: "path", path: mappedPath };
}

/** Encode a document path for the `data-jx-path` attribute (preserves string-vs-number segments). */
export function serializeJxPath(path: JxPath): string {
  return JSON.stringify(path);
}

/** Decode a `data-jx-path` attribute back into a document path. */
export function parseJxPath(serialized: string): JxPath {
  return JSON.parse(serialized) as JxPath;
}
