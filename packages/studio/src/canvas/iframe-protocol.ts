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
import type { JxExpressionNode, JxMutableNode } from "@jxsuite/schema/types";

/**
 * The wire form of a value-carrying document op (the `forward` half of a recorded
 * {@link JxDocOpPair} — see {@link file://../tabs/patch-ops.ts}). It is structurally a
 * {@link JxDocOp}: it carries the inserted/replaced `node` and the set `value`, NOT just a path, so
 * the iframe can fold it into its shadow doc and re-render subtrees without ever reading the
 * parent's reactive document.
 */
export type WireDocOp = JxDocOp;

export const CANVAS_MODES = ["preview", "design", "edit", "stylebook"] as const;

/**
 * How the iframe renders the document: live `preview`, instrumented `design`/`edit`, or the
 * `stylebook` specimen catalog (hit/hover/measure only — no inline editing, DnD, or insert zones).
 */
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
  // Replace the rendered ROOT's style block in place (stylebook live style editing): the iframe
  // Folds it into the shadow doc and re-runs the runtime's reapplyStyle on the root element, which
  // Regenerates the whole scoped-CSS cascade (real @media included) without a re-render. `style` is
  // Already transposed parent-side (transposeStylebookStyle); `gen` must equal the iframe's
  // RenderedGen — a stale update is dropped (the superseding render carries the same style).
  | { kind: "styleUpdate"; style: Record<string, unknown>; gen: number }
  // Enter inline editing on the node at `path` (used to re-enter after a split/insert re-renders).
  | { kind: "enterEdit"; path: (string | number)[] }
  // Commit and end the inline-edit session if one is live (a no-op otherwise). Posted by the parent
  // When focus/intent leaves the edit surface in the PARENT realm (tab switch, layers-panel click,
  // Chrome pointerdown outside the edit toolbars) — the iframe can't observe those itself. Carries
  // No identity: each host talks to exactly one iframe, so the parent routes the resulting
  // EditCommit by the posting host's tab.
  | { kind: "endEdit" }
  // The parent slash menu resolved a selection — the iframe engine deletes the "/filter" text and
  // Runs its insert flow (which posts editInsert back).
  | { kind: "slashSelect"; cmd: SlashCommand }
  // The parent dismissed the slash menu (outside click / Escape / no matches). The iframe bridge
  // Flips closed but KEEPS its stored onSelect — the parent's select() dismisses the menu BEFORE it
  // Fires onSelect, so a slashSelect may legitimately arrive after this.
  | { kind: "slashDismissed" }
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
  // ─── Live expression preview (M6) ───────────────────────────────────────────
  // Evaluate expression nodes against the iframe's LIVE resolved scope (real repeater items, real
  // Window#/ globals) and post per-node display values back. `contextPath` is the document path of
  // The node whose scope context the expressions bind to (null = the root scope); when it sits
  // Inside a repeater template, the iframe binds the first rendered item's $map context. `reqId`
  // Correlates the reply (measure/geometry precedent); `gen` is the render the request targets —
  // The iframe refuses to evaluate against a different render, and the parent drops replies whose
  // Gen no longer matches its last-rendered one.
  | {
      kind: "evalExpr";
      exprs: { id: string; node: JxExpressionNode }[];
      contextPath: (string | number)[] | null;
      reqId: number;
      gen: number;
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

/**
 * One expression's live evaluation outcome (M6). `values` are path-key → display-string pairs — the
 * trace hook's per-node values, already formatted INSIDE the iframe (same truncation rules as the
 * parent's snapshot preview) so only postMessage-safe strings cross the boundary. `error` carries
 * the thrown message when this expression failed (its `values` then hold whatever nodes reported
 * before the throw).
 */
export interface EvalExprResult {
  id: string;
  values: [string, string][];
  error?: string;
}

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

// ─── Cross-frame insertion affordance ("+") ─────────────────────────────────────

/**
 * One candidate insertion point the iframe computed from its own pointer hit-test (the cross-origin
 * cousin of the legacy insertion-helper). `edge` is the geometric side of the hovered node the "+"
 * anchors to; the parent positions a clickable "+" from `rect` (a small anchor box in
 * iframe-viewport coords, mapped via {@link canvasRectToParent} at scale=1 like the drop indicator).
 * On click the parent runs the unchanged parent-realm slash-menu → mutateInsertNode flow with
 * `insertParentPath` + `index`. A `center` zone is an empty container (insert as its first child);
 * top/bottom/left/right insert a sibling before (`index`) or after the hovered node.
 */
export interface InsertZone {
  edge: "top" | "bottom" | "left" | "right" | "center";
  insertParentPath: (string | number)[];
  index: number;
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
  // `fragment` = the rendered root is a component DEFINITION (a fragment, not a page): the host then
  // Drops the iframe's 480px pre-measurement floor so a short component hugs its content.
  | { kind: "contentHeight"; height: number; fragment: boolean }
  // A serializable snapshot of the iframe's resolved `$defs` (buildScope's output — content
  // Collections / `$prototype` data sources eagerly resolved). The parent adopts it into
  // `S.canvas.scope` so the data-explorer panel shows live data instead of "pending" (the iframe,
  // Not the parent, now resolves the scope). `gen` lets the parent drop a snapshot from a superseded
  // Render. Posted right after `renderComplete`; values are JSON-safe deep clones (see serialize-scope).
  | { kind: "dataScope"; gen: number; scope: Record<string, unknown> }
  | { kind: "hit"; hit: NodeHit }
  | { kind: "hover"; hit: NodeHit | null }
  // Candidate insertion "+" zones for the hovered node, recomputed on pointermove (cross-origin
  // Cousin of the legacy insertion-helper). `null` clears the "+" (cursor mid-element / left the
  // Canvas). The parent draws a clickable "+" from each zone's rect and, on click, runs the
  // Parent-realm slash-menu → mutateInsertNode flow with the zone's insertParentPath + index.
  | { kind: "insertZones"; zones: InsertZone[] | null }
  // Response to `measure`: the rects of whichever requested paths resolved to a node (missing paths
  // Are simply omitted). `reqId` echoes the request so the parent can drop stale responses.
  | { kind: "geometry"; reqId: number; hits: NodeHit[] }
  // Response to `evalExpr`: one result per requested expression (empty when the request's gen no
  // Longer matches the live render — the iframe never evaluates against the wrong scope). `reqId`/
  // `gen` echo the request so the parent can drop stale replies (measure/geometry precedent).
  | { kind: "evalResult"; reqId: number; gen: number; results: EvalExprResult[] }
  // A patch applied cleanly (echoes gen so the host can re-measure the selection overlay).
  | { kind: "patchComplete"; gen: number }
  // A patch could not be applied surgically — the parent escalates to a full render.
  | { kind: "patchError"; gen: number; message: string }
  // A global-shortcut keystroke captured inside the iframe, for the parent to re-dispatch.
  | { kind: "forwardKey"; event: SerializedKey }
  // A wheel event over the canvas iframe, for the parent's zoom/pan handler. The iframe is sized to
  // Its content (never scrolls itself) and a cross-origin OOPIF doesn't bubble wheel to the parent, so
  // It forwards the deltas + modifiers + its own cursor (iframe-viewport coords) for the host to map.
  | {
      kind: "forwardWheel";
      deltaX: number;
      deltaY: number;
      x: number;
      y: number;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
    }
  // Inline editing started in the iframe (the parent shows the format toolbar from here). `prop`
  // Names the component-instance prop when the session edits prop-bound text (plain sessions).
  | { kind: "editStart"; path: (string | number)[]; prop?: string }
  // Committed inline-edit content (rich `children` else `textContent`) for the parent to persist.
  | {
      kind: "editCommit";
      path: (string | number)[];
      children: (JxMutableNode | string)[] | null;
      textContent: string | null;
    }
  // Committed prop-bound text: persist `value` into `$props[prop]` of the instance at `path`.
  | {
      kind: "editCommitProp";
      path: (string | number)[];
      prop: string;
      value: string;
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
  // ─── Slash-menu bridge ──────────────────────────────────────────────────────
  // The engine (in the iframe) detected "/" in a live edit session; the parent shows the real
  // Lit/Spectrum menu. Re-posted with a new `filter` as the author keeps typing (the engine's
  // UpdateSlashMenu drives it). `rect` is the edited element's bbox in IFRAME-VIEWPORT coords.
  | { kind: "slashShow"; rect: SerializableRect; filter: string }
  // A menu-navigation key pressed in the iframe while the parent menu is open. The iframe
  // Intercepts these four keys capture-phase (restoring the "menu captures Enter" contract) and the
  // Host drives the parent menu's key handler directly — no synthetic keydown redispatch.
  | { kind: "slashNav"; key: "ArrowUp" | "ArrowDown" | "Enter" | "Escape" }
  // Iframe-side dismissal (backspace past the "/", session end, a click inside the iframe — the
  // Parent's outside-click listener can't see iframe clicks).
  | { kind: "slashDismiss" }
  // ─── Context menu ───────────────────────────────────────────────────────────
  // Right-click in the canvas. `path` is the nearest data-jx-path node (null on empty space — the
  // Browser menu is still suppressed, legacy parity); x/y are IFRAME-VIEWPORT coords for the host
  // To convert via its empirical geometry.
  | { kind: "contextMenu"; path: (string | number)[] | null; x: number; y: number }
  // ─── Cross-frame DnD (Phase 4c spike) ──────────────────────────────────────
  // Flow 3 (grab-anywhere): the iframe detected a drag begin on an element body (pointerdown past a
  // Movement threshold on a `[data-jx-path]`, NOT during an inline-edit). The parent starts a
  // Coordinator session as a `tree-node` source with this `path` and synthesizes dragMove from its
  // Own pointermove over the iframe. `dragSeq` is the iframe's pre-allocated session hint; the parent
  // Bumps its own authoritative seq in beginDragSession.
  | { kind: "dragOriginate"; path: (string | number)[]; dragSeq: number }
  // A NATIVE drag stream entered this iframe with NO session bound here. Chromium delivers
  // Dragover/drop to the frame UNDER THE CURSOR, so a parent-originated drag (palette/layers)
  // Crosses onto the canvas without the parent ever seeing a cursor inside the iframe rect — it
  // Never binds a host. On this message the bridge binds/migrates its live pragmatic session to
  // This host (posting dragStart); the iframe's native handlers then drive dragOver/dropResult.
  | { kind: "nativeDragEnter" }
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

/** The iframe→parent insertion-affordance ("+") message. */
export type InsertZonesMsg = Extract<IframeToParent, { kind: "insertZones" }>;
