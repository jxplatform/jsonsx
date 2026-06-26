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
      siteStyle: Record<string, unknown> | null;
      gen: number;
    }
  // Ask the iframe to measure the given document paths and post their current rects back. Used to
  // Draw the selection overlay regardless of where the selection change originated (canvas click,
  // Layers panel, keyboard) — the parent can't measure iframe nodes itself (cross-origin bridge).
  | { kind: "measure"; paths: (string | number)[][]; reqId: number };

/** A node's bounding box, in the iframe's own viewport coordinates. */
export interface SerializableRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A document path plus the iframe-space rect of the node it resolves to. */
export interface NodeHit {
  path: (string | number)[];
  rect: SerializableRect;
}

/** Messages the canvas iframe sends back to the editor (parent). */
export type IframeToParent =
  | { kind: "ready" }
  | { kind: "renderComplete"; gen: number }
  | { kind: "renderError"; gen: number; message: string }
  | { kind: "hit"; hit: NodeHit }
  | { kind: "hover"; hit: NodeHit | null }
  // Response to `measure`: the rects of whichever requested paths resolved to a node (missing paths
  // Are simply omitted). `reqId` echoes the request so the parent can drop stale responses.
  | { kind: "geometry"; reqId: number; hits: NodeHit[] };
