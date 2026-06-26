/// <reference lib="dom" />
/**
 * The versioned message protocol spoken across the {@link IframeChannel} between the editor (parent)
 * and the canvas iframe. This is the Phase 1 message set (render the document); later phases extend
 * both unions with selection/geometry/patch/DnD/inline-edit messages.
 *
 * Every parent→iframe message and the iframe's render acknowledgements carry a `gen` (generation)
 * counter so the iframe can ignore stale commands and the parent can correlate acknowledgements —
 * the cross-frame analog of the legacy renderer's `renderGeneration` staleness guard.
 */

export const CANVAS_MODES = ["preview", "design", "edit"] as const;

/** How the iframe renders the document: live `preview`, or instrumented `design`/`edit`. */
export type CanvasMode = (typeof CANVAS_MODES)[number];

export function isCanvasMode(value: unknown): value is CanvasMode {
  return typeof value === "string" && (CANVAS_MODES as readonly string[]).includes(value);
}

/**
 * Serializable form of the render path-mapping context. `arrayPaths` is a `Set` in the renderer but
 * crosses the boundary as a string array (Sets aren't structured-clone-friendly across our wire).
 */
export interface WireMapperCtx {
  canvasMode: string;
  layoutWrapped: boolean;
  pageContentPrefix: (string | number)[] | null;
  pageContentOffset: number | null;
  arrayPaths: string[];
}

/** Messages the editor (parent) sends into the canvas iframe. */
export type ParentToIframe =
  | { kind: "init"; gen: number }
  | {
      kind: "render";
      doc: unknown;
      mode: CanvasMode;
      docBase: string;
      mapperCtx: WireMapperCtx;
      gen: number;
    };

/** Messages the canvas iframe sends back to the editor (parent). */
export type IframeToParent =
  | { kind: "ready" }
  | { kind: "renderComplete"; gen: number }
  | { kind: "renderError"; gen: number; message: string };
