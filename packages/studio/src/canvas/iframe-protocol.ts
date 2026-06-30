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

import type { JxDocOp } from "../tabs/patch-ops";
import type { JxContentResult, SlashCommand } from "../editor/inline-edit";
import type { JxMutableNode } from "@jxsuite/schema/types";

/**
 * The wire form of a value-carrying document op (the `forward` half of a recorded
 * {@link JxDocOpPair} — see {@link file://../tabs/patch-ops.ts}). It is structurally a
 * {@link JxDocOp}: it carries the inserted/replaced `node` and the set `value`, NOT just a path, so
 * the iframe can fold it into its shadow doc and re-render subtrees without ever reading the
 * parent's reactive document.
 */
export type WireDocOp = JxDocOp;

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
      // The RAW (pre-resolution) page document the forward ops are recorded against. The iframe
      // Keeps it as a non-reactive shadow doc — its patch source-of-truth. `doc` above is the
      // Resolved render doc (layout-wrapped); this raw doc's paths match the forward-op paths and
      // The stamped data-jx-path attributes.
      shadowDoc: unknown;
      mode: CanvasMode;
      docBase: string;
      mapperCtx: WireMapperCtx;
      siteStyle: Record<string, unknown> | null;
      gen: number;
    }
  // Ask the iframe to measure the given document paths and post their current rects back. Used to
  // Draw the selection overlay regardless of where the selection change originated (canvas click,
  // Layers panel, keyboard) — the parent can't measure iframe nodes itself (cross-origin bridge).
  | { kind: "measure"; paths: (string | number)[][]; reqId: number }
  // Apply a surgical edit: fold each value-carrying forward op into the shadow doc and patch the DOM
  // In place. `gen` matches the last render so the iframe drops patches superseded by a re-render.
  | { kind: "patch"; forwardOps: WireDocOp[]; gen: number }
  // Enter inline editing on the node at `path` (used to re-enter after a split/insert re-renders).
  | { kind: "enterEdit"; path: (string | number)[] }
  // Apply a format/link/insert intent to the iframe's cached selection range (4b-2 format toolbar).
  // The parent toolbar lives in the parent realm but never touches the iframe Selection — it posts
  // The author's intent and the iframe applies it where the edited DOM (and its Selection) live.
  | {
      kind: "applyFormat";
      intent:
        | {
            command:
              | "bold"
              | "italic"
              | "underline"
              | "strikethrough"
              | "subscript"
              | "superscript"
              | "code";
          }
        | { command: "link"; href: string | null } // Null/"" = remove
        | { command: "insertData"; token: string };
    }
  // ─── Cross-frame DnD (Phase 4c spike) ──────────────────────────────────────
  // Begin a drag session in the iframe: `src` is the realm-agnostic source kind, `dragSeq` is the
  // Per-session id (parent drops any reply with a different seq), `gen` is the render the session
  // Started against (parent drops dragOver/dropResult whose gen != the iframe's last-rendered gen).
  | { kind: "dragStart"; src: DragSrcKind; dragSeq: number; gen: number }
  // The pointer moved over the canvas. `cursor` is already converted to IFRAME-VIEWPORT coords.
  | { kind: "dragMove"; cursor: { x: number; y: number }; dragSeq: number }
  // The pointer was released over the canvas — the iframe computes the drop FRESH and posts dropResult.
  | { kind: "drop"; cursor: { x: number; y: number }; dragSeq: number }
  // The pointer left this canvas (dropped elsewhere / migrated to another panel): the iframe forgets
  // The session + stops any auto-scroll. `dragMove`/`drop` arriving after are no-ops.
  | { kind: "dragEnd"; dragSeq: number }
  // The drag was cancelled (Escape/abort from the parent realm) — same teardown as dragEnd.
  | { kind: "dragCancel"; dragSeq: number };

/** A node's bounding box, in the iframe's own viewport coordinates. */
export interface SerializableRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Cross-frame drag-and-drop (Phase 4c) ──────────────────────────────────────

/**
 * The structural placement a drop resolves to, applied via the realm-agnostic
 * `applyDropInstruction`.
 */
export type DropInstructionType = "reorder-above" | "reorder-below" | "make-child";

/**
 * The kind of thing being dragged. `tree-node` carries the source's existing document path (a
 * move); `block` carries nothing on the wire — its full `fragment` (a {@link JxMutableNode}) is
 * retained PARENT-SIDE keyed by `dragSeq` and never crosses the boundary.
 */
export type DragSrcKind = { type: "tree-node"; path: (string | number)[] } | { type: "block" };

/**
 * A display-only drop preview the iframe posts on `dragOver`: where the drop indicator should draw
 * (`referenceRect`, in iframe-viewport coords) and the resolved structural placement. `edge` is the
 * geometric side (added for the indicator slice; unused in the spike). The actual drop is
 * recomputed FRESH in the `drop` handler — a preview is never the source of truth for the applied
 * mutation.
 */
export interface DropPreview {
  instruction: DropInstructionType;
  targetPath: (string | number)[];
  referenceRect: SerializableRect;
  edge: "top" | "bottom" | "inside";
}

/** A document path plus the iframe-space rect of the node it resolves to. */
export interface NodeHit {
  path: (string | number)[];
  rect: SerializableRect;
}

/**
 * A keyboard event flattened for the bridge. The iframe forwards the global-shortcut subset (so
 * undo/redo/save/delete/… still fire when focus is inside the canvas iframe); the parent rebuilds a
 * synthetic `keydown` from these fields and dispatches it to its existing shortcut handler.
 */
export interface SerializedKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Messages the canvas iframe sends back to the editor (parent). */
export type IframeToParent =
  | { kind: "ready" }
  | { kind: "renderComplete"; gen: number }
  | { kind: "renderError"; gen: number; message: string }
  // The iframe's measured content height in CSS px. The host sizes the iframe ELEMENT to this so the
  // Canvas never scrolls internally — the parent canvas pans/scrolls instead, every node stays inside
  // The iframe box (hit-testable), and the parent-drawn overlay tracks it (it can't follow an internal
  // Scroll). Viewport units are transposed to container units (runtime `transposeCanvasUnits`) so a
  // `100vh` section can't feed back into an ever-growing height. Posted after each render and on reflow.
  | { kind: "contentHeight"; height: number }
  | { kind: "hit"; hit: NodeHit }
  | { kind: "hover"; hit: NodeHit | null }
  // Response to `measure`: the rects of whichever requested paths resolved to a node (missing paths
  // Are simply omitted). `reqId` echoes the request so the parent can drop stale responses.
  | { kind: "geometry"; reqId: number; hits: NodeHit[] }
  // A patch applied cleanly (echoes gen so the host can re-measure the selection overlay).
  | { kind: "patchComplete"; gen: number }
  // A patch could not be applied surgically — the parent escalates to a full render.
  | { kind: "patchError"; gen: number; message: string }
  // A global-shortcut keystroke captured inside the iframe, for the parent to re-dispatch.
  | { kind: "forwardKey"; event: SerializedKey }
  // Inline editing started in the iframe (the parent shows the format toolbar from here).
  | { kind: "editStart"; path: (string | number)[] }
  // Committed inline-edit content (rich `children` else `textContent`) for the parent to persist.
  | {
      kind: "editCommit";
      path: (string | number)[];
      children: (JxMutableNode | string)[] | null;
      textContent: string | null;
    }
  // Enter split a paragraph: keep `before` in the node, insert a new one with `after`.
  | {
      kind: "editSplit";
      path: (string | number)[];
      before: JxContentResult;
      after: JxContentResult;
    }
  // Slash-insert: swap the tag in place when empty, else commit + insert a new element after.
  | {
      kind: "editInsert";
      path: (string | number)[];
      cmd: SlashCommand;
      commitData: JxContentResult | undefined;
    }
  // A serializable selection snapshot for the parent format toolbar (4b-2). The iframe owns the
  // Selection; the parent renders pressed-state/position from this and never reads the iframe DOM.
  | {
      kind: "selectionChanged";
      // Monotonic per edit session; the parent drops snapshots with a stale (<=) seq.
      seq: number;
      path: (string | number)[];
      // Strong/em/u/del/sub/sup/code/a active across the WHOLE selection (both endpoints).
      activeTags: string[];
      // Caret/selection bbox in IFRAME-VIEWPORT coords (null when unmeasurable).
      rect: SerializableRect | null;
      collapsed: boolean;
      link: { active: boolean; href: string | null };
      // D-B: always null this phase — repeater item/index merge-tag scope is a follow-up.
      localScope: null;
    }
  // The inline-edit session ended.
  | { kind: "editEnd" }
  // ─── Cross-frame DnD (Phase 4c spike) ──────────────────────────────────────
  // Flow 3 (grab-anywhere): the iframe detected a drag begin on an element body (pointerdown past a
  // Movement threshold on a `[data-jx-path]`, NOT during an inline-edit). The parent starts a
  // Coordinator session as a `tree-node` source with this `path` and synthesizes dragMove from its
  // Own pointermove over the iframe. `dragSeq` is the iframe's pre-allocated session hint; the parent
  // Bumps its own authoritative seq in beginDragSession.
  | { kind: "dragOriginate"; path: (string | number)[]; dragSeq: number }
  // The iframe cancelled a flow-3 (iframe-originated) drag locally (Escape during a body-grab): the
  // Parent tears down its ghost/indicator. Single-sourced through the iframe for that case so cancel
  // Never double-fires (the parent-source flows cancel via pragmatic instead).
  | { kind: "dragEnd"; dragSeq: number }
  // A display-only drop preview for the parent's indicator. `gen` lets the parent drop previews
  // Computed against a superseded render; `preview` is null when the cursor resolves to no drop.
  // `cursor` is present ONLY for flow-3 (iframe-driven) drags, in IFRAME-VIEWPORT coords: the parent
  // Has no pointer during an iframe-originated drag, so it positions the ghost by forward-converting
  // This cursor. Parent-driven flows (1/2/4) omit it (the parent already has the raw cursor).
  | {
      kind: "dragOver";
      dragSeq: number;
      gen: number;
      preview: DropPreview | null;
      cursor?: { x: number; y: number };
    }
  // The resolved drop, computed FRESH from the current DOM. The parent (if non-stale, non-null)
  // Applies it via applyDropInstruction with the retained source data.
  | {
      kind: "dropResult";
      dragSeq: number;
      gen: number;
      instruction: DropInstructionType | null;
      targetPath: (string | number)[] | null;
    };

/** The iframe→parent selection snapshot that drives the parent format toolbar. */
export type SelectionSnapshot = Extract<IframeToParent, { kind: "selectionChanged" }>;

/** The author's format/link/insert intent the parent toolbar posts back to the iframe. */
export type ApplyFormatIntent = Extract<ParentToIframe, { kind: "applyFormat" }>["intent"];

/** The parent→iframe drag-session start message (Phase 4c). */
export type DragStartMsg = Extract<ParentToIframe, { kind: "dragStart" }>;

/** The iframe→parent display-only drop-preview message (Phase 4c). */
export type DragOverMsg = Extract<IframeToParent, { kind: "dragOver" }>;
