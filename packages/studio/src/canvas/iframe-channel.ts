/// <reference lib="dom" />
/**
 * IframeChannel — the typed message boundary between the editor (parent) and the canvas iframe.
 *
 * Per the migration's cross-origin bridge decision, the parent never touches the iframe's
 * `contentDocument`; everything (render commands, patches, geometry, selection, hit-tests) crosses
 * as serializable messages through this one interface. Phases 1+ instantiate it with concrete
 * message unions (`ParentToIframe`/`IframeToParent`); this module owns only the transport contract
 * plus an in-memory `fakeChannelPair` so cross-frame logic is unit-testable without a live iframe.
 */

/**
 * A typed, bidirectional message channel. `TOut` is what this side sends; `TIn` is what it
 * receives. Implementations: a real `postMessage` channel over an `<iframe>` (added with the iframe
 * host), and {@link fakeChannelPair} for tests.
 */
export interface IframeChannel<TOut, TIn> {
  /** Send a message to the other side. */
  post: (message: TOut) => void;
  /** Subscribe to messages from the other side. Returns an unsubscribe function. */
  onMessage: (handler: (message: TIn) => void) => () => void;
  /** Detach all handlers and release the transport. */
  dispose: () => void;
}

/**
 * Two in-memory channels wired to each other for tests. A message `parent.post(x)` is delivered to
 * the `iframe` side's handlers (and vice versa) only when `flush()` is called — so tests drive the
 * inherently-async postMessage ordering deterministically. Messages posted _during_ a flush are
 * queued for the next flush, never delivered re-entrantly.
 */
export function fakeChannelPair<ParentOut, IframeOut>(): {
  parent: IframeChannel<ParentOut, IframeOut>;
  iframe: IframeChannel<IframeOut, ParentOut>;
  flush: () => void;
  /** Number of messages waiting to be delivered (both directions). */
  pending: () => number;
} {
  let toIframe: ParentOut[] = [];
  let toParent: IframeOut[] = [];
  const iframeHandlers = new Set<(m: ParentOut) => void>();
  const parentHandlers = new Set<(m: IframeOut) => void>();

  const parent: IframeChannel<ParentOut, IframeOut> = {
    dispose() {
      parentHandlers.clear();
    },
    onMessage(handler) {
      parentHandlers.add(handler);
      return () => parentHandlers.delete(handler);
    },
    post(message) {
      toIframe.push(message);
    },
  };

  const iframe: IframeChannel<IframeOut, ParentOut> = {
    dispose() {
      iframeHandlers.clear();
    },
    onMessage(handler) {
      iframeHandlers.add(handler);
      return () => iframeHandlers.delete(handler);
    },
    post(message) {
      toParent.push(message);
    },
  };

  function flush() {
    const forIframe = toIframe;
    const forParent = toParent;
    toIframe = [];
    toParent = [];
    for (const message of forIframe) {
      for (const handler of iframeHandlers) {
        handler(message);
      }
    }
    for (const message of forParent) {
      for (const handler of parentHandlers) {
        handler(message);
      }
    }
  }

  return {
    flush,
    iframe,
    parent,
    pending: () => toIframe.length + toParent.length,
  };
}
