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
import { view } from "../view";
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
 * Render `doc` into the iframe canvas mounted in `canvasEl`. Resolves the document parent-side and
 * posts it (queued until the iframe is `ready`). Stale generations are dropped.
 */
export async function mountIframeCanvas(
  gen: number,
  doc: JxMutableNode,
  canvasEl: HTMLElement,
): Promise<void> {
  const state = ensureHost(canvasEl);
  const resolved = await resolveCanvasDocument(gen, doc);
  if (!resolved || gen !== view.renderGeneration) {
    return;
  }
  const message: ParentToIframe = {
    doc: resolved.renderDoc,
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
