/// <reference lib="dom" />
/**
 * Canvas iframe entry — runs INSIDE the canvas iframe. It opens a postMessage channel to the parent
 * editor, announces `ready`, and renders the documents the parent posts via `render`. Kept tiny: it
 * pulls in only the render core, so the iframe bundle stays small.
 */

import { postMessageChannel } from "./iframe-channel";
import { renderResolvedDocument } from "./iframe-render";
import { measureHits, startInteraction } from "./iframe-interaction";
import { applyIframePatch } from "./iframe-patch";
import type { IframeChannel } from "./iframe-channel";
import type { IframeToParent, ParentToIframe } from "./iframe-protocol";
import type { JxDocument, JxMutableNode } from "@jxsuite/schema/types";
import type { RenderHandle } from "./iframe-render";

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

  // Report pointer hit/hover (resolved to data-jx-path) to the parent, which owns selection +
  // Overlays — the cross-origin bridge means the parent never reads our DOM directly.
  const stopInteraction = startInteraction(channel, container.ownerDocument);

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
      if (gen > renderedGen || !shadowDoc) {
        // The render this patch targets hasn't landed yet; let the parent escalate to a full render.
        channel.post({ gen, kind: "patchError", message: "patch-ahead-of-render" });
        return;
      }
      try {
        applyIframePatch(shadowDoc, msg.forwardOps, container);
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
    if (msg.kind !== "render" || msg.gen < latestGen) {
      return;
    }
    latestGen = msg.gen;
    const { gen, mapperCtx } = msg;
    const rawDoc = msg.shadowDoc as JxMutableNode;
    void (async () => {
      try {
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
          // Adopt this generation's shadow doc only once it's the live render (not superseded).
          shadowDoc = rawDoc;
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
