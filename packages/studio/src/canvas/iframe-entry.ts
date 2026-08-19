/// <reference lib="dom" />
/**
 * Canvas iframe entry — runs INSIDE the canvas iframe. It opens a postMessage channel to the parent
 * editor, announces `ready`, and renders the documents the parent posts via `render`. Kept tiny: it
 * pulls in only the render core, so the iframe bundle stays small.
 */

import { postMessageChannel } from "./iframe-channel";
import { displayTagName } from "@jxsuite/schema/guards";
import {
  applyPreviewColorScheme,
  applySiteStyle,
  installCanvasImageRetry,
  renderResolvedDocument,
} from "./iframe-render";
import { measureHits, startInteraction } from "./iframe-interaction";
import { parseJxPath, serializeJxPath } from "./path-mapping";
import {
  AUTO_SCROLL_STEP,
  computeDropInstruction,
  rectFor,
  resolveDropTarget,
  scrollDirection,
} from "./iframe-drop";
import { startIframeInlineEdit } from "./iframe-inline-edit";
import { startIframeSlashBridge } from "./iframe-slash";
import { NO_TABLE, startKeyForwarding } from "./iframe-keys";
import type { ForwardTable } from "./iframe-keys";
import { applyIframePatch } from "./iframe-patch";
import { disposeAllSubtrees } from "./iframe-subtree";
import { evaluateLiveExprs } from "./iframe-eval";
import { serializeDataScope } from "./serialize-scope";
import {
  getActivePath,
  isEditableBlock,
  isEditing,
  setEditableVerdicts,
  stopEditing,
} from "../editor/inline-edit";
import { captureDocSelection, restoreDocSelection } from "./iframe-editable-root";
import { getNodeAtPath, isAncestor } from "../state";
import type { JxDocOp } from "../tabs/patch-ops";
import type { JxPath } from "../state";
// ObserveScope MUST come from the runtime: the $defs refs are created by the runtime's copy of
// @vue/reactivity, and dep tracking is per module instance — an effect from the studio's own copy
// Would never re-run when a dev-proxy data source settles.
import { observeScope, reapplyStyle, setResolveToken } from "@jxsuite/runtime";
import type { IframeChannel } from "./iframe-channel";
import type {
  CanvasMode,
  DragSrcKind,
  FileDropHit,
  IframeToParent,
  LayoutHit,
  ParentToIframe,
} from "./iframe-protocol";
import type { JxDocument, JxMutableNode, JxStyle } from "@jxsuite/schema/types";
import type { IframeRenderCtx, RenderHandle } from "./iframe-render";

/**
 * Resolve the drop placement for a forwarded cursor: point hit-test → nearest `[data-jx-path]` →
 * pure {@link computeDropInstruction}. Returns null when the cursor resolves to no droppable target.
 * Shared by the `dragMove` (display-only preview) and `drop` (fresh, authoritative) handlers.
 */
function previewAt(
  cursor: { x: number; y: number },
  src: DragSrcKind,
  shadowDoc: JxMutableNode,
  doc: Document,
) {
  const targetEl = resolveDropTarget(cursor.x, cursor.y, doc);
  if (!targetEl) {
    return null;
  }
  return computeDropInstruction(targetEl, cursor.y, shadowDoc, src);
}

/**
 * Whether a native drag carries OS files rather than an in-app pragmatic source. `types` is the one
 * part of `dataTransfer` readable during dragover (`files` is empty until drop, by design).
 */
export function isExternalFileDrag(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

/**
 * The drag source a file drop is placed as. A dropped file becomes a NEW element, so it resolves
 * exactly like a palette block — `canDrop` never rejects it and `computeDropInstruction` needs no
 * file-specific branch.
 */
const FILE_DRAG_SRC: DragSrcKind = { type: "block" };

/**
 * Describe the node under a file drag for the parent: its path, rect, and resolved tag. The tag
 * comes from the SHADOW DOC (the document's own `tagName`) when the path resolves there, because
 * that is what the parent will mutate; the rendered element's tag can differ for a component
 * instance, whose custom element renders as its template root.
 */
export function fileDropHitFor(
  targetEl: HTMLElement,
  shadowDoc: JxMutableNode | null,
): FileDropHit | null {
  const serialized = targetEl.dataset?.jxPath;
  if (serialized == null) {
    return null;
  }
  const path = parseJxPath(serialized);
  const node = shadowDoc ? (getNodeAtPath(shadowDoc, path as JxPath) as JxMutableNode) : undefined;
  return {
    path,
    rect: rectFor(targetEl),
    tagName: (displayTagName(node?.tagName) || targetEl.tagName).toLowerCase(),
  };
}

/**
 * Resolve a click to the layout-chrome node it landed on, or null when it did not land on one.
 *
 * Page content wins outright: a `[data-jx-path]` ancestor means the runtime rendered this node from
 * the page document, and {@link file://./iframe-interaction.ts} already reports it as a normal
 * `hit`. Only when no page node claims the click does the nearest `[data-jx-layout-region]` — the
 * dimmed, frozen chrome the layout contributed — answer for it.
 */
export function layoutHitFor(target: EventTarget | null): LayoutHit | null {
  if (!(target instanceof Element)) {
    return null;
  }
  if (target.closest("[data-jx-path]")) {
    return null;
  }
  const el = target.closest("[data-jx-layout-region]");
  if (!(el instanceof HTMLElement)) {
    return null;
  }
  return {
    className: typeof el.className === "string" ? el.className : "",
    layoutFile: el.dataset.jxLayoutFile ?? "",
    layoutPath: parseJxPath(el.dataset.jxLayoutPath ?? "[]"),
    rect: rectFor(el),
    tagName: el.tagName.toLowerCase(),
  };
}

/** Set-key keys the patcher applies IN PLACE (never a subtree re-render) — safe under a live edit. */
const IN_PLACE_KEYS = new Set(["style", "textContent"]);

/**
 * Whether applying `forwardOps` would re-render/detach the element of the live edit session: any op
 * that is NOT an in-place set-key (style/text/event) whose affected node is an ancestor-or-self of
 * the active edit path. Structural ops affect the PARENT's children (any sibling churn under an
 * ancestor can reflow/replace the edited element's position), so their parent path is compared.
 */
export function patchDisturbsActiveEdit(forwardOps: JxDocOp[]): boolean {
  const activePath = getActivePath();
  if (!activePath) {
    return false;
  }
  for (const op of forwardOps) {
    let affected: JxPath;
    if (op.op === "set-key") {
      if (IN_PLACE_KEYS.has(op.key) || op.key.startsWith("on")) {
        continue;
      }
      affected = op.path;
    } else if (op.op === "move-child") {
      affected = op.fromParentPath;
      if (isAncestor(affected, activePath) || isAncestor(op.toParentPath, activePath)) {
        return true;
      }
      continue;
    } else {
      affected = op.parentPath;
    }
    if (isAncestor(affected, activePath)) {
      return true;
    }
  }
  return false;
}

/** Consecutive quiet animation frames before the frame declares itself settled (§13.4). */
export const IDLE_QUIET_FRAMES = 2;

/**
 * How long the idle watcher keeps sampling before it stops.
 *
 * A page with an endless animation never reaches two quiet frames, and a rAF loop that runs for the
 * life of the tab to prove it is not free. Giving up is safe because the last posted sample already
 * names the animation — the parent stays honestly "not idle" rather than being told a comfortable
 * lie.
 */
export const IDLE_WATCH_MAX_MS = 5000;

/**
 * How long after a failed image load a retry may still be in flight.
 *
 * `installCanvasImageRetry` re-fires at 150/300/450 ms; each further failure re-arms the window, so
 * a per-error grace comfortably covers the whole chain without encoding its schedule twice.
 */
export const IMAGE_RETRY_WINDOW_MS = 500;

/**
 * Drive a channel: render each `render` message into `container`, dropping stale generations, and
 * acknowledge with `renderComplete`/`renderError`. Exposed (rather than inlined in {@link boot}) so
 * tests can exercise it with a fake channel. Returns a teardown function.
 */
export function startCanvasIframe(opts: {
  channel: IframeChannel<IframeToParent, ParentToIframe>;
  container: HTMLElement;
}): () => void {
  const { channel, container } = opts;
  let handle: RenderHandle | null = null;
  // Disposer for the live render's dataScope re-post effect (see the render handler); stopped
  // Alongside the handle so a superseded render's refs can't keep posting.
  let stopDataScopeWatch: (() => void) | null = null;
  let latestGen = -1;
  // The raw page doc the current DOM was rendered from — the patch source-of-truth. `renderedGen`
  // Tracks which generation it (and the DOM) reflect, so patches for an in-flight/superseded render
  // Are handled correctly rather than applied against the wrong tree.
  let shadowDoc: JxMutableNode | null = null;
  let renderedGen = -1;
  // The mode of the LIVE render — gates the interactive surfaces (inline editing, insert zones,
  // Grab-drags) that only design/edit modes own. Adopted alongside shadowDoc.
  let currentMode: CanvasMode = "design";
  /* The host's chord table. Empty until the first `keymap` message, which the host posts on
     `ready` — before any render, so there is nothing to type into during the gap. An empty table
     forwards nothing, which is the honest cold-start answer: the frame does not guess at what the
     parent might bind, and it never `preventDefault`s a key it cannot name. */
  let forwardTable: ForwardTable = NO_TABLE;
  // The current render's retained context (scope/mapping), used to render subtrees for structural
  // Patches. Set together with `shadowDoc`, so it's non-null whenever a patch is applied.
  let renderCtx: IframeRenderCtx | null = null;

  // Cross-frame drag session (Phase 4c). `dragStart` records the source kind + the gen the session
  // Began against; dragMove/drop tag every reply with both so the parent can stale-gate them.
  let dragSrc: DragSrcKind | null = null;
  let dragGen = -1;
  // The parent-session id (from dragStart), so NATIVE drag events routed into this frame can post
  // DragOver/dropResult tagged for the parent's seq gate.
  let sessionSeq = -1;

  // ─── Auto-scroll (commit 6) — a SELF-SUSTAINING rAF loop. When a dragMove lands in an edge band,
  // The loop each frame scrolls the viewport AND re-hit-tests the CACHED cursor (elementFromPoint is
  // Viewport-relative, so the same x,y now resolves to a different node after the scroll) and re-posts
  // The over-preview. It is NOT driven by dragMove (the pointer is stationary at an edge-hold). Stops
  // On: band exit (next dragMove, dir 0), drop/dragEnd/dragCancel, or scroll extent reached (scrollY
  // Unchanged). The win/rAF body is the only uncovered line; scrollDirection is PURE + unit-tested.
  let autoScrollFrame = 0;
  // The cached edge-hold cursor. For a flow-3 (iframe-driven) drag it also carries the drag `src`
  // (the parent never posts a dragStart, so `dragSrc`/`dragGen` are null) and `withCursor`, so the
  // Loop re-posts dragOver WITH the cursor to keep the parent's ghost tracking during an edge-hold
  // (the parent has no pointer of its own then). Parent-driven flows (1/2/4) leave `src` undefined
  // And `withCursor` false — the tick falls back to `dragSrc`/`dragGen` and the parent moves the
  // Ghost from its own raw pointer.
  let autoScrollCursor: {
    x: number;
    y: number;
    dragSeq: number;
    withCursor: boolean;
    src?: DragSrcKind;
    gen?: number;
  } | null = null;
  const win = container.ownerDocument.defaultView;

  function stopAutoScroll(): void {
    if (autoScrollFrame && win) {
      win.cancelAnimationFrame(autoScrollFrame);
    }
    autoScrollFrame = 0;
    autoScrollCursor = null;
  }

  function autoScrollTick(): void {
    autoScrollFrame = 0;
    // Flow 3 supplies its own src on the cached cursor; flows 1/2/4 use the session's dragSrc.
    const src = autoScrollCursor?.src ?? dragSrc;
    if (!win || !autoScrollCursor || !src || !shadowDoc) {
      return;
    }
    const dir = scrollDirection(autoScrollCursor.y, win.innerHeight);
    if (dir === 0) {
      return;
    }
    const before = win.scrollY;
    win.scrollBy(0, dir * AUTO_SCROLL_STEP);
    if (win.scrollY === before) {
      // Scroll extent reached — nothing more to reveal, so stop the loop.
      return;
    }
    const preview = previewAt(autoScrollCursor, src, shadowDoc, container.ownerDocument);
    channel.post({
      // Flow 3 (withCursor) re-posts the cursor so the parent keeps tracking the ghost at an edge-hold.
      ...(autoScrollCursor.withCursor
        ? { cursor: { x: autoScrollCursor.x, y: autoScrollCursor.y } }
        : {}),
      dragSeq: autoScrollCursor.dragSeq,
      gen: autoScrollCursor.gen ?? dragGen,
      kind: "dragOver",
      preview,
    });
    autoScrollFrame = win.requestAnimationFrame(autoScrollTick);
  }

  /**
   * (Re)evaluate auto-scroll for a dragMove cursor: arm the loop in a band, stop it outside. The
   * optional `flow3` carries the iframe-driven drag's src/gen (and forces the cursor to be
   * re-posted during edge-holds); parent-driven flows pass nothing and the loop uses
   * `dragSrc`/`dragGen`.
   */
  function updateAutoScroll(
    cursor: { x: number; y: number },
    dragSeq: number,
    flow3?: { src: DragSrcKind; gen: number },
  ): void {
    if (!win || scrollDirection(cursor.y, win.innerHeight) === 0) {
      stopAutoScroll();
      return;
    }
    autoScrollCursor = {
      dragSeq,
      withCursor: flow3 != null,
      x: cursor.x,
      y: cursor.y,
      ...(flow3 ? { gen: flow3.gen, src: flow3.src } : {}),
    };
    if (!autoScrollFrame) {
      autoScrollFrame = win.requestAnimationFrame(autoScrollTick);
    }
  }

  // Report pointer hit/hover (resolved to data-jx-path) to the parent, which owns selection +
  // Overlays — the cross-origin bridge means the parent never reads our DOM directly. The shadow-doc
  // Accessor feeds the insertion "+" zone computation hung off the same pointermove (the parent
  // Draws the clickable "+" and runs the slash-menu → mutateInsertNode flow on click).
  const stopInteraction = startInteraction(channel, container.ownerDocument, {
    getGen: () => renderedGen,
    getMode: () => currentMode,
    getShadowDoc: () => shadowDoc,
  });
  // Report clicks that land on LAYOUT chrome. The interaction wiring above only knows about
  // `[data-jx-path]` nodes, and layout chrome has none — so this is the listener that makes "My
  // Site" in the header answer a click at all. It runs in CAPTURE alongside the interaction click
  // Handler; the two are disjoint by construction (`layoutHitFor` refuses anything a page node
  // Claims), so exactly one of them posts per click.
  const onLayoutClick = (e: Event) => {
    if (currentMode !== "design" && currentMode !== "edit") {
      return;
    }
    const hit = layoutHitFor(e.target);
    if (hit) {
      channel.post({ hit, kind: "layoutHit" });
    }
  };
  container.ownerDocument.addEventListener("click", onLayoutClick, true);
  // Forward global-shortcut keystrokes to the parent — its shortcut handler is bound to the editor
  // Document, so without this they'd be swallowed whenever focus is inside the canvas iframe.
  // `isEditing` is the real "is a caret session live" predicate: the canvas root is PERMANENTLY
  // Contenteditable, so "the target is editable" is true even with no session, and the clipboard
  // Chords have to be split on the session — not on editability — to reach the right owner.
  const stopKeyForwarding = startKeyForwarding(
    channel,
    container.ownerDocument,
    isEditing,
    () => forwardTable,
    () => currentMode,
  );
  // Run inline editing (contenteditable) here, posting committed/split/insert results to the parent.
  // The shadow-doc accessor gates prop-bound sessions on the RAW instance prop value (template/$ref
  // Valued props render display sugar and must not be plain-text edited).
  const stopInlineEdit = startIframeInlineEdit(channel, container, {
    getMode: () => currentMode,
    getShadowDoc: () => shadowDoc,
  });
  // Bridge the engine's slash menu to the parent's Spectrum menu (show/nav/select over the channel).
  const stopSlashBridge = startIframeSlashBridge(channel, container.ownerDocument);
  // Auto-recover canvas images that 404 on a cold first render (component <img>s created in
  // ConnectedCallback fire late, before the loopback server is warm). Re-fires the failed request a
  // Few times — what the manual data-sidebar "Refresh" does, but without a full re-render.
  const stopImageRetry = installCanvasImageRetry(container);

  // ─── Content-height auto-sizing ─────────────────────────────────────────────
  // Measure the content height and post it so the host sizes the iframe to fit — the canvas then never
  // Scrolls internally (the parent overlay can't follow an internal scroll, and every node stays inside
  // The iframe box so it's hit-testable). The runtime transposes viewport units to container units, so
  // This converges instead of feeding back; `MAX` is a backstop if some unit slips through. `container`
  // Is `#jx-canvas-root`, which overflows the fixed-size query container freely, so its scrollHeight is
  // The true content height.
  const MAX_CANVAS_HEIGHT = 30_000;
  let lastPostedHeight = -1;
  function postContentHeight(): void {
    const measured = Math.min(container.scrollHeight, MAX_CANVAS_HEIGHT);
    if (measured > 0 && Math.abs(measured - lastPostedHeight) >= 1) {
      lastPostedHeight = measured;
      // A component-definition root (marked by makeStamper) is a fragment, not a page — tell the host
      // So it can drop its 480px iframe floor and let a short component hug its content.
      const root = container.firstElementChild;
      const fragment = root instanceof HTMLElement && root.dataset.jxDefinitionRoot !== undefined;
      channel.post({ fragment, height: measured, kind: "contentHeight" });
      // The content box moved, so fonts/animations/images may not be where they were.
      armIdleWatch();
    }
  }
  const ResizeObs = win?.ResizeObserver;
  const heightObserver = ResizeObs ? new ResizeObs(() => postContentHeight()) : null;

  // ─── Cross-realm quiescence ─────────────────────────────────────────────────
  // The frame answers "have I settled?" instead of being polled (§13.4 condition 5). Nothing in the
  // Parent realm can look inside a cross-origin frame, so the alternative was `wait: {ms}` — and 115
  // Of those were 115 places a slow subsystem got answered with +500 ms and the wrong picture was
  // Accepted. Sampling lives HERE, next to the render that changes the answer.
  const frameDoc = container.ownerDocument;
  let idleFrame = 0;
  let quietFrames = 0;
  let idleDeadline = 0;
  let lastIdleKey = "";
  /** Images whose load failed, and the moment `installCanvasImageRetry` can no longer be waiting. */
  const retryingImages = new Map<HTMLImageElement, number>();

  /**
   * Images with a retry still outstanding.
   *
   * `installCanvasImageRetry` re-fires at 150/300/450 ms and bounds itself at three attempts, so an
   * error puts the image back in flight for at most that long; each further error extends the
   * window. Only the app knows this is pending — a `<img>` mid-retry looks exactly like one that
   * settled broken.
   */
  function pendingImageRetries(): number {
    const now = Date.now();
    for (const [img, deadline] of retryingImages) {
      if (deadline <= now) {
        retryingImages.delete(img);
      }
    }
    return retryingImages.size;
  }

  function sampleIdle(): Extract<IframeToParent, { kind: "idle" }> {
    const running =
      typeof frameDoc.getAnimations === "function"
        ? frameDoc.getAnimations().filter((a) => a.playState === "running").length
        : 0;
    return {
      animations: running,
      fonts: frameDoc.fonts ? frameDoc.fonts.status === "loaded" : true,
      gen: renderedGen,
      images: pendingImageRetries(),
      kind: "idle",
    };
  }

  function idleTick(): void {
    idleFrame = 0;
    const sample = sampleIdle();
    const key = `${sample.gen}|${sample.fonts}|${sample.animations}|${sample.images}`;
    const changed = key !== lastIdleKey;
    if (changed) {
      lastIdleKey = key;
      channel.post(sample);
    }
    const quiet = sample.fonts && sample.animations === 0 && sample.images === 0;
    quietFrames = quiet ? (changed ? 1 : quietFrames + 1) : 0;
    // Two consecutive quiet frames, then stop — the state is stable and any change re-arms us.
    if (quietFrames >= IDLE_QUIET_FRAMES) {
      return;
    }
    // A page with a genuinely endless animation never goes quiet. Give up rather than burn a rAF
    // Loop forever: the last posted sample already NAMES the animation, which is the honest answer.
    if (Date.now() >= idleDeadline) {
      return;
    }
    idleFrame = win ? win.requestAnimationFrame(idleTick) : 0;
  }

  /** Something changed the frame's DOM or assets — re-sample until it is quiet again. */
  function armIdleWatch(): void {
    quietFrames = 0;
    idleDeadline = Date.now() + IDLE_WATCH_MAX_MS;
    if (!idleFrame && win) {
      idleFrame = win.requestAnimationFrame(idleTick);
    }
  }

  const onImageError = (event: Event): void => {
    if (event.target instanceof HTMLImageElement) {
      retryingImages.set(event.target, Date.now() + IMAGE_RETRY_WINDOW_MS);
      armIdleWatch();
    }
  };
  const onImageLoad = (event: Event): void => {
    if (event.target instanceof HTMLImageElement && retryingImages.delete(event.target)) {
      armIdleWatch();
    }
  };
  // Capture: neither `error` nor `load` bubbles from an <img>.
  container.addEventListener("error", onImageError, true);
  container.addEventListener("load", onImageLoad, true);
  armIdleWatch();
  // Observed only once the quiescence state above exists: a reflow arms the watcher.
  heightObserver?.observe(container);

  // ─── Wheel forwarding (canvas zoom/pan) ─────────────────────────────────────
  // The iframe is sized to its content (never scrolls itself), so wheel events over it are meant for
  // The parent canvas: ctrl/cmd+wheel = zoom, plain = pan. A cross-origin OOPIF doesn't bubble wheel to
  // The parent, so forward the deltas + modifiers + cursor; the host redispatches to its wheel handler.
  //
  // PREVIEW is the exception, and it is not a small one. There the host keeps the iframe at the
  // Preview stage's own height and the document scrolls FOR REAL, which is the whole point of the
  // View — sticky headers, scroll-driven animation and IntersectionObserver reveals only fire when
  // Something actually scrolls. Swallowing the wheel here (this handler used to preventDefault
  // Unconditionally) made the one view whose job is fidelity the one view you could not scroll.
  const onWheel = (e: WheelEvent) => {
    if (currentMode === "preview") {
      /* The document scrolls for real, so the plain wheel is ITS wheel and this handler takes no
         part in it. Ctrl/⌘ — and the trackpad pinch that arrives as exactly this event — is not
         that gesture: the browser reads it as page zoom, and the page it would scale is the whole
         Studio window rather than the previewed document, which is neither what the author asked
         for nor recoverable from inside the frame. The host cannot block it on this frame's behalf
         (a cross-origin OOPIF's wheel never reaches it, and preview is the one mode that forwards
         nothing), so the block belongs here. */
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
      return;
    }
    e.preventDefault();
    channel.post({
      ctrlKey: e.ctrlKey,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      kind: "forwardWheel",
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      x: e.clientX,
      y: e.clientY,
    });
  };
  container.ownerDocument.addEventListener("wheel", onWheel, { passive: false });

  // ─── Native drag routing (flows 1/2/4 over the canvas) ─────────────────────
  // Chromium delivers native dragover/drop to the frame UNDER THE CURSOR, so once a
  // Parent-originated drag (palette / layers / ⠿ handle) crosses onto the canvas the parent stops
  // Seeing dragover — it can't forward dragMove, and cross-origin nothing preventDefaults here,
  // Giving the "not allowed" cursor and a dead drop. So handle the native stream directly: while a
  // Parent session is live (dragSrc set), accept the drag, post dragOver previews from OUR
  // ClientX/y (already iframe-local — no rect conversion), and on drop post the authoritative
  // DropResult. The cursor rides on dragOver so the parent can keep its ghost tracking (it has no
  // Pointer stream of its own while the drag is over this frame).
  //
  // A native stream arriving with NO session yet (dragSrc null) is a parent drag that crossed onto
  // The canvas before the parent could bind a host (it never sees a cursor inside the iframe rect) —
  // Post nativeDragEnter so the bridge binds the session here. Throttled: dragover fires
  // Continuously (~350ms even stationary), and an unclaimable stream (e.g. an OS file drag) would
  // Otherwise spam the channel forever.
  const NATIVE_ENTER_REPOST_MS = 300;
  let lastNativeEnterPost = 0;

  // Flow 5: an OS file drag. There is no parent session to bind and never will be — the parent
  // Never saw the gesture start. Accept it here (preventDefault, or the browser shows "not allowed"
  // And swallows the drop) and post geometry; the parent uploads and mutates. stopPropagation keeps
  // The event away from the contenteditable root, which would otherwise let the browser insert its
  // Own blob: <img> alongside our mutation.
  const postFileDragGeometry = (e: DragEvent, kind: "fileDragOver" | "fileDrop") => {
    e.preventDefault();
    e.stopPropagation();
    const cursor = { x: e.clientX, y: e.clientY };
    const doc = container.ownerDocument;
    const targetEl = resolveDropTarget(cursor.x, cursor.y, doc);
    const hit = targetEl ? fileDropHitFor(targetEl, shadowDoc) : null;
    const preview =
      shadowDoc && targetEl
        ? computeDropInstruction(targetEl, cursor.y, shadowDoc, FILE_DRAG_SRC)
        : null;
    if (kind === "fileDragOver") {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
      channel.post({ hit, kind: "fileDragOver", preview });
      return;
    }
    channel.post({ files: [...(e.dataTransfer?.files ?? [])], hit, kind: "fileDrop", preview });
  };

  const onNativeDragOver = (e: DragEvent) => {
    if (!dragSrc) {
      if (isExternalFileDrag(e)) {
        postFileDragGeometry(e, "fileDragOver");
        return;
      }
      const now = Date.now();
      if (now - lastNativeEnterPost >= NATIVE_ENTER_REPOST_MS) {
        lastNativeEnterPost = now;
        channel.post({ kind: "nativeDragEnter" });
      }
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    const cursor = { x: e.clientX, y: e.clientY };
    const preview = shadowDoc
      ? previewAt(cursor, dragSrc, shadowDoc, container.ownerDocument)
      : null;
    channel.post({ cursor, dragSeq: sessionSeq, gen: dragGen, kind: "dragOver", preview });
    updateAutoScroll(cursor, sessionSeq);
  };
  const onNativeDrop = (e: DragEvent) => {
    if (!dragSrc) {
      if (isExternalFileDrag(e)) {
        postFileDragGeometry(e, "fileDrop");
      }
      return;
    }
    e.preventDefault();
    const cursor = { x: e.clientX, y: e.clientY };
    const preview = shadowDoc
      ? previewAt(cursor, dragSrc, shadowDoc, container.ownerDocument)
      : null;
    channel.post({
      dragSeq: sessionSeq,
      gen: dragGen,
      instruction: preview?.instruction ?? null,
      kind: "dropResult",
      targetPath: preview?.targetPath ?? null,
    });
    dragSrc = null;
    dragGen = -1;
    sessionSeq = -1;
    stopAutoScroll();
  };
  // A file drag that leaves the frame entirely (relatedTarget escapes the document) clears the
  // Parent's overlay. Inner dragleaves fire constantly as the cursor crosses elements, so they are
  // Filtered out — otherwise the affordance would flicker on every element boundary.
  const onNativeDragLeave = (e: DragEvent) => {
    if (!dragSrc && isExternalFileDrag(e) && !e.relatedTarget) {
      channel.post({ kind: "fileDragLeave" });
    }
  };
  container.ownerDocument.addEventListener("dragenter", onNativeDragOver, true);
  container.ownerDocument.addEventListener("dragover", onNativeDragOver, true);
  container.ownerDocument.addEventListener("dragleave", onNativeDragLeave, true);
  container.ownerDocument.addEventListener("drop", onNativeDrop, true);

  const off = channel.onMessage((msg) => {
    if (msg.kind === "measure") {
      channel.post({
        hits: measureHits(msg.paths, container.ownerDocument),
        kind: "geometry",
        reqId: msg.reqId,
      });
      return;
    }
    if (msg.kind === "evalExpr") {
      // Live expression preview (M6): evaluate against the LIVE render's resolved scope — but only
      // The render the request targeted. A stale/ahead gen gets an empty reply (never values from
      // The wrong scope); the parent additionally gen-gates the reply against its own state.
      const results =
        msg.gen === renderedGen && renderCtx && shadowDoc
          ? evaluateLiveExprs(
              msg.exprs,
              renderCtx.defs as Record<string, unknown>,
              shadowDoc,
              msg.contextPath,
            )
          : [];
      channel.post({ gen: msg.gen, kind: "evalResult", reqId: msg.reqId, results });
      return;
    }
    if (msg.kind === "patch") {
      const { gen } = msg;
      if (gen < renderedGen) {
        /* BEHIND, and that is now said out loud rather than dropped.
           "A newer full render already supersedes this edit" is only true when the generation the
           patch carries came from the stage THIS frame is mounted on. It did not while
           `postPatchToHosts` took a single `gen` and fanned it to every host rendering the tab: one
           document displayed in two panes meant whichever pane had rendered more recently held the
           higher `renderedGen` and silently stopped applying patches, with a wrong picture on screen
           and not one counter moving. The parent resolves the generation per host now, so reaching
           here means the frame really is behind — an escalation, which repaints exactly this pane
           and records the reason in `__jxCanvasPerf`. */
        channel.post({ gen, kind: "patchError", message: "patch-behind-render" });
        return;
      }
      if (gen > renderedGen || !shadowDoc || !renderCtx) {
        // The render this patch targets hasn't landed yet; let the parent escalate to a full render.
        channel.post({ gen, kind: "patchError", message: "patch-ahead-of-render" });
        return;
      }
      // A structural/subtree op that re-renders the active block (or an ancestor) DETACHES the
      // Element the engine holds, so the block has to be released before the patch lands. But the
      // Caret must not be released with it: remember where it is in DOCUMENT coordinates — a block
      // Path plus a character offset — which survives the DOM underneath being rebuilt.
      //
      // This is what makes a remote co-author's edit, or a patch from any other surface, land
      // Without throwing the local writer out of their sentence.
      // An ECHOED op cannot disturb the edit — it IS the edit, already in the DOM. It must be
      // Excluded from the disturbance check as well as from the DOM write: a rich commit emits
      // `set-key children` at the active path, `children` is not an in-place key, so the check
      // Would tear the block down on the caret's own idle tick — committing again on the way out
      // And re-entering the commit→patch cycle. The caret would vanish every time you paused.
      const echoed = new Set((msg.echoPaths ?? []).map((p) => serializeJxPath(p)));
      const foreignOps =
        echoed.size === 0
          ? msg.forwardOps
          : msg.forwardOps.filter(
              (op) => !(op.op === "set-key" && echoed.has(serializeJxPath(op.path))),
            );
      const disturbs = isEditing() && patchDisturbsActiveEdit(foreignOps);
      const caret = disturbs ? captureDocSelection(container, isEditableBlock) : null;
      if (disturbs) {
        stopEditing();
      }
      try {
        applyIframePatch(shadowDoc, msg.forwardOps, container, renderCtx, msg.echoPaths);
        // Put the caret back where the author left it. Restoring the SELECTION re-activates the
        // Block through the editing host's own selectionchange path — there is no separate
        // "re-enter" step, because a caret in a block IS the edit.
        if (caret) {
          restoreDocSelection(container, caret);
        }
        channel.post({ gen, kind: "patchComplete" });
        armIdleWatch();
      } catch (error) {
        channel.post({
          gen,
          kind: "patchError",
          message: String((error as Error)?.message ?? error),
        });
      }
      return;
    }
    if (msg.kind === "styleUpdate") {
      // Stylebook live style edit: swap the ROOT's style and re-run the runtime's style applier —
      // One reapply regenerates the whole scoped-CSS cascade (real @media included) without a
      // Re-render. A stale gen is dropped; the superseding render carries the same style.
      if (msg.gen !== renderedGen || !shadowDoc) {
        return;
      }
      (shadowDoc as { style?: JxStyle }).style = msg.style as JxStyle;
      const rootEl = container.firstElementChild;
      if (rootEl instanceof HTMLElement) {
        reapplyStyle(
          rootEl,
          msg.style as JxStyle,
          (shadowDoc as { $media?: Record<string, string> }).$media ?? {},
        );
      }
      return;
    }
    if (msg.kind === "dragStart") {
      // Begin a drag session: retain the source kind + the gen it targets. dragMove/drop replies are
      // Tagged with this gen so the parent drops any that arrive after a re-render superseded it.
      dragSrc = msg.src;
      dragGen = msg.gen;
      sessionSeq = msg.dragSeq;
      return;
    }
    if (msg.kind === "dragEnd" || msg.kind === "dragCancel") {
      // The pointer left the canvas / the session was cancelled: forget the session so a late move
      // Or drop is a no-op, and clear any flow-3 (iframe-originated) drag state + auto-scroll.
      dragSrc = null;
      dragGen = -1;
      sessionSeq = -1;
      stopAutoScroll();
      return;
    }
    if (msg.kind === "dragMove") {
      // Display-only preview: hit-test the forwarded cursor, compute the placement, post dragOver.
      // Null target/instruction → post a null preview so the parent clears any stale indicator.
      const preview =
        dragSrc && shadowDoc
          ? previewAt(msg.cursor, dragSrc, shadowDoc, container.ownerDocument)
          : null;
      channel.post({ dragSeq: msg.dragSeq, gen: dragGen, kind: "dragOver", preview });
      // Arm/stop the self-sustaining auto-scroll for this cursor (an edge-hold keeps scrolling).
      updateAutoScroll(msg.cursor, msg.dragSeq);
      return;
    }
    if (msg.kind === "drop") {
      // Compute the drop FRESH from the live DOM (never from a cached preview) and post the result.
      const preview =
        dragSrc && shadowDoc
          ? previewAt(msg.cursor, dragSrc, shadowDoc, container.ownerDocument)
          : null;
      channel.post({
        dragSeq: msg.dragSeq,
        gen: dragGen,
        instruction: preview?.instruction ?? null,
        kind: "dropResult",
        targetPath: preview?.targetPath ?? null,
      });
      dragSrc = null;
      dragGen = -1;
      sessionSeq = -1;
      stopAutoScroll();
      return;
    }
    if (msg.kind === "keymap") {
      // Replaced wholesale, never merged: the host sends the whole live table, so a chord the
      // Author unbound disappears here rather than lingering as a key the canvas still swallows.
      forwardTable = { chords: msg.chords, mac: msg.mac };
      return;
    }
    if (msg.kind === "setColorScheme") {
      // Document-level attribute flip — deliberately patch-free (no render, no gen).
      applyPreviewColorScheme(container.ownerDocument, msg.scheme);
      return;
    }
    if (msg.kind === "setLocale") {
      /* The other document-level attribute flip, and the whole visible half of an axis-3 locale:
         `dir` is what makes an RTL preview actually mirror, and `lang` is what CSS's `:lang()` and
         the font stack select on. Patch-free like the scheme above — the TEXT is whatever file is
         open, because a translation in Jx is a different file rather than a different rendering.
         Cleared rather than blanked when the pane goes back to the document's own language: an
         empty `lang=""` is a document that claims to be in no language at all. */
      const root = container.ownerDocument.documentElement;
      if (msg.locale === null) {
        root.removeAttribute("lang");
        root.removeAttribute("dir");
      } else {
        root.setAttribute("lang", msg.locale);
        root.setAttribute("dir", msg.dir);
      }
      return;
    }
    if (msg.kind === "siteStyleUpdate") {
      // Live design-token edit: swap the site-style sheet in place, no re-render.
      applySiteStyle(msg.siteStyle, msg.media);
      return;
    }
    if (msg.kind !== "render" || msg.gen < latestGen) {
      return;
    }
    applyPreviewColorScheme(container.ownerDocument, msg.colorScheme ?? null);
    // A render replaces the DOM under a live edit session — COMMIT it first (never discard). The
    // Resulting editCommit/editEnd post synchronously here, so on the FIFO channel they precede
    // This render's renderComplete and the parent routes them by the host's not-yet-flipped tab
    // Identity — a commit racing a tab switch still lands in the document it belonged to.
    if (isEditing()) {
      stopEditing();
    }
    latestGen = msg.gen;
    // Adopt the document's caret vocabulary BEFORE rendering: which tags hold a caret depends on
    // The format class, and a `.md` page and a native `.json` component do not agree. Absent means
    // A document with no format, where the studio's own element metadata answers on its own.
    setEditableVerdicts(msg.editableTags ?? null);
    const { gen, mapperCtx } = msg;
    const rawDoc = msg.shadowDoc as JxMutableNode;
    void (async () => {
      try {
        // Drop the previous render's reactive scopes (root + any surgically-rendered subtrees).
        disposeAllSubtrees();
        stopDataScopeWatch?.();
        stopDataScopeWatch = null;
        handle?.dispose();
        handle = await renderResolvedDocument({
          container,
          doc: msg.doc as JxDocument,
          docBase: msg.docBase,
          mapperCtx: {
            arrayPaths: new Set(mapperCtx.arrayPaths),
            canvasMode: mapperCtx.canvasMode,
            layoutWrapped: mapperCtx.layoutWrapped,
            pageContentOffset: mapperCtx.pageContentOffset,
            pageContentPrefix: mapperCtx.pageContentPrefix,
          },
          mode: msg.mode,
          siteStyle: msg.siteStyle,
          ...(msg.allowAutoRequests ? { allowAutoRequests: true } : {}),
        });
        if (gen === latestGen) {
          // Adopt this generation's shadow doc + render context only once it's the live render.
          shadowDoc = rawDoc;
          renderCtx = handle.ctx;
          renderedGen = gen;
          currentMode = msg.mode;
          channel.post({ gen, kind: "renderComplete" });
          armIdleWatch();
          // Thread a serializable snapshot of the resolved $defs to the parent so the data-explorer
          // Panel shows live data (the iframe, not the parent, now resolves the scope). Inside a
          // Reactive effect: dev-proxy data sources ($prototype/$src) return a ref that fills AFTER
          // BuildScope returns, and serializeDataScope reads defs[key], so the effect tracks those
          // Refs and RE-POSTS an updated snapshot when the data settles (the host gen-gates stale
          // Ones). Isolated in try/catch: a serialization failure never breaks the render ack above.
          const defs = handle.ctx.defs as Record<string, unknown>;
          stopDataScopeWatch = observeScope(() => {
            try {
              channel.post({ gen, kind: "dataScope", scope: serializeDataScope(defs) });
            } catch {
              // A pathological scope can't be serialized — skip; the render itself succeeded.
            }
          });
          // Size the iframe to the freshly-rendered content (the ResizeObserver tracks later reflows).
          postContentHeight();
        }
      } catch (error) {
        channel.post({
          gen,
          kind: "renderError",
          message: String((error as Error)?.message ?? error),
        });
      }
    })();
  });

  channel.post({ kind: "ready" });
  return () => {
    off();
    stopInteraction();
    stopKeyForwarding();
    stopInlineEdit();
    stopSlashBridge();
    stopImageRetry();
    if (idleFrame && win) {
      win.cancelAnimationFrame(idleFrame);
    }
    idleFrame = 0;
    container.removeEventListener("error", onImageError, true);
    container.removeEventListener("load", onImageLoad, true);
    stopAutoScroll();
    heightObserver?.disconnect();
    container.ownerDocument.removeEventListener("click", onLayoutClick, true);
    container.ownerDocument.removeEventListener("wheel", onWheel);
    container.ownerDocument.removeEventListener("dragenter", onNativeDragOver, true);
    container.ownerDocument.removeEventListener("dragleave", onNativeDragLeave, true);
    container.ownerDocument.removeEventListener("dragover", onNativeDragOver, true);
    container.ownerDocument.removeEventListener("drop", onNativeDrop, true);
    stopDataScopeWatch?.();
    handle?.dispose();
  };
}

/** The window surface {@link bootCanvasIframe} needs — injected so it's testable without a frame. */
interface BootWindow {
  location: { search: string };
  document: { querySelector: (selectors: string) => Element | null; body: HTMLElement };
  parent: { postMessage: (message: unknown, targetOrigin: string) => void };
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
}

/**
 * Boot the entry against a window: open a token+origin-authenticated channel to the parent (origin
 * and token are passed in via the iframe URL) and render into `#jx-canvas-root` (or `<body>`).
 */
export function bootCanvasIframe(win: BootWindow): () => void {
  const params = new URLSearchParams(win.location.search);
  // Authenticate the runtime dev-proxy resolve/server fetches to the token-gated loopback server.
  // The server rpcToken rides the iframe URL as `rpcToken`; the `token` param is the separate
  // PostMessage channel secret (set by the host). Absent on dev/chromium, where setResolveToken no-ops.
  setResolveToken(params.get("rpcToken"));
  // ParentOrigin authenticates the parent peer. The host (iframe-host.ts) passes it ONLY for an
  // Http(s) parent (dev / chromium — same-origin, the origin round-trips). It OMITS it for a
  // Non-http(s) parent (electrobun views://), whose custom scheme may not surface as a postMessage
  // Origin: a missing value here means fall back to "*" — token-gated, NOT a silent omission — and
  // Log it loudly so the looser origin check is visible.
  const explicitParentOrigin = params.get("parentOrigin");
  const parentOrigin = explicitParentOrigin || "*";
  if (!explicitParentOrigin) {
    console.warn(
      "[jx-canvas] no parentOrigin in iframe URL — accepting messages from any origin (token-gated). " +
        "The parent origin did not round-trip; the channel relies on the shared token alone.",
    );
  }
  const container = (win.document.querySelector("#jx-canvas-root") ??
    win.document.body) as HTMLElement;
  const channel = postMessageChannel<IframeToParent, ParentToIframe>({
    acceptOrigin: parentOrigin,
    source: win,
    target: win.parent,
    targetOrigin: parentOrigin,
    token: params.get("token") || "",
  });
  return startCanvasIframe({ channel, container });
}

// Boot only when actually loaded as the iframe document (has a real parent frame), never in tests.
if (typeof window !== "undefined" && window.parent !== window) {
  bootCanvasIframe(window as unknown as BootWindow);
}
