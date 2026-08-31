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

/**
 * A `[data-jx-path='…']` selector for a serialized path.
 *
 * Single quotes because the serialized path is JSON and only ever uses double ones; the two escapes
 * cover the characters that could still break out of an attribute-value selector. Shared because
 * two callers need the same string — `measureHits` locating a node to measure, and
 * `applyCanvasPopoverOpen` locating one to flip — and a second copy of an escaping rule is a second
 * chance to get an escape wrong.
 *
 * @param serialized A path already through {@link serializeJxPath}.
 * @returns The attribute selector, without a leading tag or combinator.
 */
export function jxPathSelector(serialized: string): string {
  const escaped = serialized.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`);
  return `[data-jx-path='${escaped}']`;
}

/** Context the mapper needs, computed once per render by whoever prepared the document. */
export interface PathMapCtx {
  canvasMode: string;
  layoutWrapped: boolean;
  pageContentPrefix: JxPath | null;
  pageContentOffset: number | null;
  arrayPaths: Set<string>;
}

/**
 * The marker `markLayoutNodes` stamps on every node of a resolved layout document (see
 * {@link file://./canvas-live-render.ts}). It names the layout FILE and the node's own path inside
 * that file — enough for the editor to select the node, label it, and open the layout at it. It
 * used to be a bare `true`, which is why clicking layout chrome on a fresh project selected nothing
 * at all: the render had thrown away the only two facts needed to act on the click.
 */
export interface LayoutMarker {
  /** Project-relative path of the layout document, e.g. `layouts/base.json`. */
  file: string;
  /** The node's path WITHIN the layout document. */
  path: JxPath;
}

/**
 * A render node either belongs to the layout (carrying its origin in the layout file, since it has
 * no page-document path) or maps to a page-document path.
 *
 * `chrome` distinguishes the two very different kinds of layout node. Most are chrome — a header, a
 * footer, a `<noscript>` — regions the page cannot edit in place. But the nodes on the path down to
 * the `<slot>` (the layout root, the `<main>` around it) WRAP the page content, so they must stay
 * transparent: dimming or freezing them would dim and freeze the whole document. Only chrome is
 * dimmed, labelled, and made `contenteditable="false"`.
 */
export type RenderNodeClass =
  | { kind: "layout"; layoutFile: string; layoutPath: JxPath; chrome: boolean }
  | { kind: "path"; path: JxPath };

/**
 * Whether `path` is the page-content container or one of its ancestors — i.e. whether this node's
 * subtree contains the distributed page content. `prefix` is the render path of the container whose
 * children hold that content (`PathMapCtx.pageContentPrefix`).
 */
export function wrapsPageContent(path: JxPath, prefix: JxPath | null): boolean {
  if (!prefix) {
    return false;
  }
  return path.length <= prefix.length && path.every((seg, i) => prefix[i] === seg);
}

/**
 * Resolve a runtime render path to a document path (or flag it as layout-originated). Pure — the
 * caller decides whether to record the result in a WeakMap or `data-jx-*` attributes.
 */
export function classifyRenderNode(path: JxPath, def: unknown, ctx: PathMapCtx): RenderNodeClass {
  // Layout-originated nodes have no page-document path; the caller stamps their origin instead
  // (data-jx-layout-path / data-jx-layout-file).
  const marker =
    ctx.layoutWrapped && typeof def === "object"
      ? (def as { $__layout?: unknown } | null)?.$__layout
      : undefined;
  if (marker) {
    const origin = (typeof marker === "object" ? marker : {}) as Partial<LayoutMarker>;
    return {
      // The root is never chrome even when the layout distributed nothing: it IS the render, and a
      // Dimmed, frozen root would be a canvas nobody can touch.
      chrome: path.length > 0 && !wrapsPageContent(path, ctx.pageContentPrefix),
      kind: "layout",
      layoutFile: typeof origin.file === "string" ? origin.file : "",
      layoutPath: Array.isArray(origin.path) ? origin.path : [],
    };
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
