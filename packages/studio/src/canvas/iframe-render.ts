/// <reference lib="dom" />
/**
 * In-iframe render core — turns a fully-resolved document into live DOM via @jxsuite/runtime,
 * stamping `data-jx-path` so the editor can map nodes back to document paths across the frame
 * boundary. The parent does the heavy resolution (layout distribution, site-context, `$head`,
 * components, edit-mode transforms) and posts the result; this core stays dependency-light (runtime
 * + reactivity + the pure path-mapping helpers) so the iframe bundle is small.
 *
 * Because the iframe is served from the real project origin, the runtime's verbatim
 * `el.setAttribute("src", "/images/foo.jpg")` resolves natively — the fix that motivated the whole
 * migration, with no data: URL rewriting.
 */

import { buildScope, renderNode, setSkipServerFunctions } from "@jxsuite/runtime";
import { effectScope } from "../reactivity";
import { classifyRenderNode, serializeJxPath } from "./path-mapping";
import type { CanvasMode } from "./iframe-protocol";
import type { EffectScope } from "../reactivity";
import type { JxDocument } from "@jxsuite/schema/types";
import type { PathMapCtx } from "./path-mapping";

export interface RenderHandle {
  /** Stop the render's reactive effect scope (call before re-rendering to avoid effect leaks). */
  dispose: () => void;
}

/** Build the `onNodeCreated` hook that stamps `data-jx-path` / `data-jx-layout` on rendered nodes. */
export function makeStamper(ctx: PathMapCtx) {
  return (created: Node, path: (string | number)[], def: unknown) => {
    if (!(created instanceof HTMLElement)) {
      return;
    }
    const classified = classifyRenderNode(path, def, ctx);
    if (classified.kind === "layout") {
      created.dataset.jxLayout = "";
      return;
    }
    created.dataset.jxPath = serializeJxPath(classified.path);
  };
}

/**
 * Render a resolved document into `container`, replacing its current children. `mode` controls
 * whether server functions run (live in `preview`; skipped in `design`/`edit`). Returns a handle
 * whose `dispose()` stops the reactive scope.
 */
export async function renderResolvedDocument(opts: {
  container: HTMLElement;
  doc: JxDocument;
  docBase: string;
  mode: CanvasMode;
  mapperCtx: PathMapCtx;
}): Promise<RenderHandle> {
  setSkipServerFunctions(opts.mode !== "preview");
  const scope: EffectScope = effectScope(true);
  const $defs = await buildScope(opts.doc, {}, opts.docBase);
  const onNodeCreated = makeStamper(opts.mapperCtx);
  const el = scope.run(() =>
    renderNode(opts.doc, $defs, { _path: [], onNodeCreated }),
  ) as HTMLElement;
  opts.container.replaceChildren(el);
  return {
    dispose: () => scope.stop(),
  };
}
