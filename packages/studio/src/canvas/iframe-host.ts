/// <reference lib="dom" />
/**
 * Parent-side iframe canvas host — manages the `<iframe>` that renders a panel's document. It keeps
 * one iframe per canvas element (reused across re-renders), resolves the document parent-side via
 * {@link resolveCanvasDocument}, and posts it over the authenticated channel once the iframe
 * signals `ready`. The parent never reads the iframe's DOM (cross-origin bridge model); it only
 * sends.
 */

import { postMessageChannel } from "./iframe-channel";
import { resolveCanvasDocument } from "./canvas-live-render";
import { canvasRectToParent, createOverlayLayer } from "./iframe-overlay";
import { effect, effectScope } from "../reactivity";
import { pathsEqual } from "../store";
import { activeTab } from "../workspace/workspace";
import type { CanvasMode, IframeToParent, NodeHit, ParentToIframe } from "./iframe-protocol";
import type { IframeChannel } from "./iframe-channel";
import type { OverlayLayer } from "./iframe-overlay";
import type { JxMutableNode } from "@jxsuite/schema/types";

interface HostState {
  iframe: HTMLIFrameElement;
  channel: IframeChannel<ParentToIframe, IframeToParent>;
  ready: boolean;
  pending: ParentToIframe | null;
  overlay: OverlayLayer;
  /** Document path of the current selection (mirrors `session.selection`), for hover de-dupe. */
  selectionPath: (string | number)[] | null;
  /** Id of the most recent selection `measure` request, so stale `geometry` replies are dropped. */
  selReqId: number;
}

const hosts = new WeakMap<HTMLElement, HostState>();

/** Every live host, so the selection watcher can re-measure each one when selection changes. */
const liveHosts = new Set<HostState>();

let selectionWatch: { stop: () => void } | null = null;

/** Lazily start one reactive watcher that re-measures the selection in every live iframe host. */
function ensureSelectionWatch(): void {
  if (selectionWatch) {
    return;
  }
  const scope = effectScope(true);
  scope.run(() => {
    effect(() => {
      const sel = activeTab.value?.session.selection ?? null;
      for (const host of liveHosts) {
        requestSelection(host, sel);
      }
    });
  });
  selectionWatch = { stop: () => scope.stop() };
}

/** Track the selection on a host and ask its iframe to measure it (or clear the box when null). */
function requestSelection(host: HostState, sel: (string | number)[] | null): void {
  host.selectionPath = sel;
  if (!host.iframe.isConnected) {
    liveHosts.delete(host);
    return;
  }
  if (!sel) {
    host.overlay.setSelection(null);
    return;
  }
  if (!host.ready) {
    return;
  }
  host.selReqId += 1;
  // Post a plain copy: `session.selection` is a reactive proxy, and only serializable values may
  // Cross the postMessage boundary.
  host.channel.post({ kind: "measure", paths: [[...sel]], reqId: host.selReqId });
}

/** The iframe document URL (a static shell that boots the slim canvas bundle). */
const CANVAS_URL = "/packages/studio/canvas.html";

function ensureHost(canvasEl: HTMLElement): HostState {
  const existing = hosts.get(canvasEl);
  if (existing) {
    return existing;
  }
  const { origin } = location;
  const token = crypto.randomUUID();
  const iframe = document.createElement("iframe");
  iframe.className = "jx-canvas-iframe";
  iframe.style.cssText =
    "width:100%;min-height:480px;height:100%;border:0;display:block;background:#fff";
  iframe.src = `${CANVAS_URL}?parentOrigin=${encodeURIComponent(origin)}&token=${token}`;
  // Overlay boxes are positioned within the canvas element, so it must be a positioned ancestor.
  if (!canvasEl.style.position) {
    canvasEl.style.position = "relative";
  }
  const overlay = createOverlayLayer(document);
  canvasEl.replaceChildren(iframe, overlay.root);

  const channel = postMessageChannel<ParentToIframe, IframeToParent>({
    acceptOrigin: origin,
    source: window,
    // Read contentWindow lazily: a freshly-navigated iframe swaps its window, so never capture it.
    target: {
      postMessage: (message, targetOrigin) =>
        iframe.contentWindow?.postMessage(message, targetOrigin),
    },
    targetOrigin: origin,
    token,
  });

  const state: HostState = {
    channel,
    iframe,
    overlay,
    pending: null,
    ready: false,
    selectionPath: null,
    selReqId: 0,
  };
  channel.onMessage((msg) => handleMessage(state, msg));
  hosts.set(canvasEl, state);
  liveHosts.add(state);
  ensureSelectionWatch();
  return state;
}

/** Handle a message the iframe posted back: ready handshake, pointer hit/hover, measured geometry. */
function handleMessage(state: HostState, msg: IframeToParent): void {
  switch (msg.kind) {
    case "ready": {
      state.ready = true;
      if (state.pending) {
        state.channel.post(state.pending);
        state.pending = null;
      }
      // Re-measure the current selection now that the iframe can answer.
      requestSelection(state, state.selectionPath);
      return;
    }
    case "hit": {
      // A click in the canvas selects the node; the selection watcher redraws the box via `measure`.
      state.selectionPath = msg.hit.path;
      const tab = activeTab.value;
      if (tab) {
        tab.session.selection = msg.hit.path;
      }
      // Draw immediately from the posted rect for snappiness (the measure round-trip confirms it).
      state.overlay.setSelection(canvasRectToParent(msg.hit.rect));
      return;
    }
    case "hover": {
      drawHover(state, msg.hit);
      return;
    }
    case "geometry": {
      if (msg.reqId === state.selReqId) {
        const [hit] = msg.hits;
        state.overlay.setSelection(hit ? canvasRectToParent(hit.rect) : null);
      }
      return;
    }
    case "renderComplete": {
      // The DOM (and so all geometry) just changed — re-measure the selection box.
      requestSelection(state, state.selectionPath);
      return;
    }
    default: {
      break;
    }
  }
}

/** Draw the hover box, hidden when there's no hover or it coincides with the current selection. */
function drawHover(state: HostState, hit: NodeHit | null): void {
  if (!hit || pathsEqual(hit.path, state.selectionPath)) {
    state.overlay.setHover(null);
    return;
  }
  state.overlay.setHover(canvasRectToParent(hit.rect));
}

/**
 * Render `doc` into the iframe canvas mounted in `canvasEl`: resolve the document parent-side and
 * post it (queued until the iframe is `ready`).
 */
export async function mountIframeCanvas(
  gen: number,
  doc: JxMutableNode,
  canvasEl: HTMLElement,
): Promise<void> {
  const state = ensureHost(canvasEl);
  // Always resolve and post the latest render. The iframe drops stale generations itself (via its
  // Own `latestGen`), so the parent must NOT gate on `view.renderGeneration`: during boot many
  // Renders fire and the generation is usually stale by the time resolution finishes, which would
  // Otherwise drop every post.
  const resolved = await resolveCanvasDocument(doc);
  // The doc must be structured-cloneable to cross postMessage. A Jx document is JSON by contract, so
  // A JSON round-trip (NOT structuredClone, which would throw) drops residual functions / reactive
  // Proxy artifacts that would otherwise raise DataCloneError and silently drop the entire message.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  const cloneableDoc = JSON.parse(JSON.stringify(resolved.renderDoc)) as unknown;
  const message: ParentToIframe = {
    doc: cloneableDoc,
    docBase: resolved.docBase ?? `${location.origin}/`,
    gen,
    kind: "render",
    mapperCtx: resolved.mapperCtx,
    mode: resolved.mapperCtx.canvasMode as CanvasMode,
    siteStyle: resolved.siteStyle,
  };
  if (state.ready) {
    state.channel.post(message);
  } else {
    state.pending = message;
  }
}
