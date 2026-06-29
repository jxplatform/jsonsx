/// <reference lib="dom" />
/**
 * Canvas iframe entry — runs INSIDE the canvas iframe. It opens a postMessage channel to the parent
 * editor, announces `ready`, and renders the documents the parent posts via `render`. Kept tiny: it
 * pulls in only the render core, so the iframe bundle stays small.
 */

import { postMessageChannel } from "./iframe-channel";
import { renderResolvedDocument } from "./iframe-render";
import { measureHits, startInteraction } from "./iframe-interaction";
import { computeDropInstruction, resolveDropTarget } from "./iframe-drop";
import { startIframeInlineEdit } from "./iframe-inline-edit";
import { startKeyForwarding } from "./iframe-keys";
import { applyIframePatch } from "./iframe-patch";
import { disposeAllSubtrees } from "./iframe-subtree";
import type { IframeChannel } from "./iframe-channel";
import type { DragSrcKind, IframeToParent, ParentToIframe } from "./iframe-protocol";
import type { JxDocument, JxMutableNode } from "@jxsuite/schema/types";
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
  let latestGen = -1;
  // The raw page doc the current DOM was rendered from — the patch source-of-truth. `renderedGen`
  // Tracks which generation it (and the DOM) reflect, so patches for an in-flight/superseded render
  // Are handled correctly rather than applied against the wrong tree.
  let shadowDoc: JxMutableNode | null = null;
  let renderedGen = -1;
  // The current render's retained context (scope/mapping), used to render subtrees for structural
  // Patches. Set together with `shadowDoc`, so it's non-null whenever a patch is applied.
  let renderCtx: IframeRenderCtx | null = null;

  // Cross-frame drag session (Phase 4c). `dragStart` records the source kind + the gen the session
  // Began against; dragMove/drop tag every reply with both so the parent can stale-gate them.
  let dragSrc: DragSrcKind | null = null;
  let dragGen = -1;

  // Report pointer hit/hover (resolved to data-jx-path) to the parent, which owns selection +
  // Overlays — the cross-origin bridge means the parent never reads our DOM directly.
  const stopInteraction = startInteraction(channel, container.ownerDocument);
  // Forward global-shortcut keystrokes to the parent — its shortcut handler is bound to the editor
  // Document, so without this they'd be swallowed whenever focus is inside the canvas iframe.
  const stopKeyForwarding = startKeyForwarding(channel, container.ownerDocument);
  // Run inline editing (contenteditable) here, posting committed/split/insert results to the parent.
  const stopInlineEdit = startIframeInlineEdit(channel, container);

  const off = channel.onMessage((msg) => {
    if (msg.kind === "measure") {
      channel.post({
        hits: measureHits(msg.paths, container.ownerDocument),
        kind: "geometry",
        reqId: msg.reqId,
      });
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
    if (msg.kind === "dragStart") {
      // Begin a drag session: retain the source kind + the gen it targets. dragMove/drop replies are
      // Tagged with this gen so the parent drops any that arrive after a re-render superseded it.
      dragSrc = msg.src;
      dragGen = msg.gen;
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
      return;
    }
    if (msg.kind !== "render" || msg.gen < latestGen) {
      return;
    }
    latestGen = msg.gen;
    const { gen, mapperCtx } = msg;
    const rawDoc = msg.shadowDoc as JxMutableNode;
    void (async () => {
      try {
        // Drop the previous render's reactive scopes (root + any surgically-rendered subtrees).
        disposeAllSubtrees();
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
          channel.post({ gen, kind: "renderComplete" });
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
  const parentOrigin = params.get("parentOrigin") || "*";
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
