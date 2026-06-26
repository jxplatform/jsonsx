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
import type { CanvasMode, IframeToParent, ParentToIframe } from "./iframe-protocol";
import type { IframeChannel } from "./iframe-channel";
import type { JxMutableNode } from "@jxsuite/schema/types";

interface HostState {
  iframe: HTMLIFrameElement;
  channel: IframeChannel<ParentToIframe, IframeToParent>;
  ready: boolean;
  pending: ParentToIframe | null;
}

const hosts = new WeakMap<HTMLElement, HostState>();

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
  canvasEl.replaceChildren(iframe);

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

  const state: HostState = { channel, iframe, pending: null, ready: false };
  channel.onMessage((msg) => {
    if (msg.kind === "ready") {
      state.ready = true;
      if (state.pending) {
        channel.post(state.pending);
        state.pending = null;
      }
    }
  });
  hosts.set(canvasEl, state);
  return state;
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
