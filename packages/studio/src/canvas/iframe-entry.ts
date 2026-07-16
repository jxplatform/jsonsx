/// <reference lib="dom" />
/**
 * Canvas iframe entry — runs INSIDE the canvas iframe. It opens a postMessage channel to the parent
 * editor, announces `ready`, and renders the documents the parent posts via `render`. Kept tiny: it
 * pulls in only the render core, so the iframe bundle stays small.
 */

import { postMessageChannel } from "./iframe-channel";
import { installCanvasImageRetry, renderResolvedDocument } from "./iframe-render";
import { measureHits, startInteraction } from "./iframe-interaction";
import {
  AUTO_SCROLL_STEP,
  clearIframeDrag,
  computeDropInstruction,
  resolveDropTarget,
  scrollDirection,
  startGrabDetector,
} from "./iframe-drop";
import { startIframeInlineEdit } from "./iframe-inline-edit";
import { startIframeSlashBridge } from "./iframe-slash";
import { startKeyForwarding } from "./iframe-keys";
import { applyIframePatch } from "./iframe-patch";
import { disposeAllSubtrees } from "./iframe-subtree";
import { evaluateLiveExprs } from "./iframe-eval";
import { serializeDataScope } from "./serialize-scope";
import { getActivePath, isEditing, stopEditing } from "../editor/inline-edit";
import { isAncestor } from "../state";
import type { JxDocOp } from "../tabs/patch-ops";
import type { JxPath } from "../state";
// ObserveScope MUST come from the runtime: the $defs refs are created by the runtime's copy of
// @vue/reactivity, and dep tracking is per module instance — an effect from the studio's own copy
// Would never re-run when a dev-proxy data source settles.
import { observeScope, reapplyStyle, setResolveToken } from "@jxsuite/runtime";
import type { IframeChannel } from "./iframe-channel";
import type { CanvasMode, DragSrcKind, IframeToParent, ParentToIframe } from "./iframe-protocol";
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
    getMode: () => currentMode,
    getShadowDoc: () => shadowDoc,
  });
  // Forward global-shortcut keystrokes to the parent — its shortcut handler is bound to the editor
  // Document, so without this they'd be swallowed whenever focus is inside the canvas iframe.
  const stopKeyForwarding = startKeyForwarding(channel, container.ownerDocument);
  // Run inline editing (contenteditable) here, posting committed/split/insert results to the parent.
  // The shadow-doc accessor gates prop-bound sessions on the RAW instance prop value (template/$ref
  // Valued props render display sugar and must not be plain-text edited).
  const stopInlineEdit = startIframeInlineEdit(channel, container, {
    getMode: () => currentMode,
    getShadowDoc: () => shadowDoc,
  });
  // Bridge the engine's slash menu to the parent's Spectrum menu (show/nav/select over the channel).
  const stopSlashBridge = startIframeSlashBridge(channel, container.ownerDocument);
  // Flow 3 (grab-anywhere): detect an element-body drag and DRIVE it locally. A drag that begins in
  // The iframe gets its held-button moves in the IFRAME document (not the parent), so the iframe
  // Computes the preview/drop from its own cursor and posts dragOver/dropResult directly; the parent
  // Only adopts the seq, draws the indicator, and positions the ghost from the posted cursor. The
  // Detector reuses the SAME previewAt + auto-scroll loop the dragMove/drop handlers use.
  const stopGrabDetector = startGrabDetector(channel, container.ownerDocument, {
    armAutoScroll: (cursor, dragSeq, src) =>
      updateAutoScroll(cursor, dragSeq, { gen: renderedGen, src }),
    gen: () => renderedGen,
    getMode: () => currentMode,
    previewAt: (cursor, src) =>
      shadowDoc ? previewAt(cursor, src, shadowDoc, container.ownerDocument) : null,
    stopAutoScroll,
  });
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
    }
  }
  const ResizeObs = win?.ResizeObserver;
  const heightObserver = ResizeObs ? new ResizeObs(() => postContentHeight()) : null;
  heightObserver?.observe(container);

  // ─── Wheel forwarding (canvas zoom/pan) ─────────────────────────────────────
  // The iframe is sized to its content (never scrolls itself), so wheel events over it are meant for
  // The parent canvas: ctrl/cmd+wheel = zoom, plain = pan. A cross-origin OOPIF doesn't bubble wheel to
  // The parent, so forward the deltas + modifiers + cursor; the host redispatches to its wheel handler.
  const onWheel = (e: WheelEvent) => {
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
  const onNativeDragOver = (e: DragEvent) => {
    if (!dragSrc) {
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
    clearIframeDrag();
  };
  container.ownerDocument.addEventListener("dragenter", onNativeDragOver, true);
  container.ownerDocument.addEventListener("dragover", onNativeDragOver, true);
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
        // A newer full render already supersedes this edit — drop it.
        return;
      }
      if (gen > renderedGen || !shadowDoc || !renderCtx) {
        // The render this patch targets hasn't landed yet; let the parent escalate to a full render.
        channel.post({ gen, kind: "patchError", message: "patch-ahead-of-render" });
        return;
      }
      // A structural/subtree op that re-renders the active editable (or an ancestor) would detach
      // The session's element mid-edit — commit and end the session first (in-place style/text
      // Patches elsewhere leave it alone).
      if (isEditing() && patchDisturbsActiveEdit(msg.forwardOps)) {
        stopEditing();
      }
      try {
        applyIframePatch(shadowDoc, msg.forwardOps, container, renderCtx);
        channel.post({ gen, kind: "patchComplete" });
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
      clearIframeDrag();
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
      clearIframeDrag();
      return;
    }
    if (msg.kind !== "render" || msg.gen < latestGen) {
      return;
    }
    // A render replaces the DOM under a live edit session — COMMIT it first (never discard). The
    // Resulting editCommit/editEnd post synchronously here, so on the FIFO channel they precede
    // This render's renderComplete and the parent routes them by the host's not-yet-flipped tab
    // Identity — a commit racing a tab switch still lands in the document it belonged to.
    if (isEditing()) {
      stopEditing();
    }
    latestGen = msg.gen;
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
        });
        if (gen === latestGen) {
          // Adopt this generation's shadow doc + render context only once it's the live render.
          shadowDoc = rawDoc;
          renderCtx = handle.ctx;
          renderedGen = gen;
          currentMode = msg.mode;
          channel.post({ gen, kind: "renderComplete" });
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
    stopGrabDetector();
    stopImageRetry();
    stopAutoScroll();
    heightObserver?.disconnect();
    container.ownerDocument.removeEventListener("wheel", onWheel);
    container.ownerDocument.removeEventListener("dragenter", onNativeDragOver, true);
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
