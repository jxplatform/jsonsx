/**
 * Iframe channel gaps — the unsubscribe closures returned by onMessage on both the postMessage
 * channel and the fake pair.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { fakeChannelPair, postMessageChannel } from "../src/canvas/iframe-channel";

describe("onMessage unsubscribe", () => {
  test("postMessageChannel unsubscribe detaches a single handler", () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const source = {
      addEventListener: (_t: "message", l: (event: MessageEvent) => void) => listeners.add(l),
      removeEventListener: (_t: "message", l: (event: MessageEvent) => void) => listeners.delete(l),
    };
    const sent: unknown[] = [];
    const channel = postMessageChannel<{ n: number }, { n: number }>({
      acceptOrigin: "*",
      source,
      target: { postMessage: (m) => sent.push(m) },
      targetOrigin: "*",
      token: "tok",
    });

    const seen: number[] = [];
    const keep: number[] = [];
    const off = channel.onMessage((m) => seen.push(m.n));
    channel.onMessage((m) => keep.push(m.n));

    const deliver = (n: number) => {
      for (const l of listeners) {
        l({ data: { "jx:canvas": "tok", payload: { n } }, origin: "" } as MessageEvent);
      }
    };
    deliver(1);
    off();
    deliver(2);
    // The unsubscribed handler misses the second message; the other keeps receiving.
    expect(seen).toEqual([1]);
    expect(keep).toEqual([1, 2]);
    channel.dispose();
    expect(listeners.size).toBe(0);
  });

  test("fake pair unsubscribes detach handlers on both sides", () => {
    const pair = fakeChannelPair<{ p: number }, { i: number }>();
    const parentSeen: number[] = [];
    const iframeSeen: number[] = [];
    const offParent = pair.parent.onMessage((m) => parentSeen.push(m.i));
    const offIframe = pair.iframe.onMessage((m) => iframeSeen.push(m.p));

    pair.parent.post({ p: 1 });
    pair.iframe.post({ i: 1 });
    pair.flush();
    expect(parentSeen).toEqual([1]);
    expect(iframeSeen).toEqual([1]);

    offParent();
    offIframe();
    pair.parent.post({ p: 2 });
    pair.iframe.post({ i: 2 });
    pair.flush();
    expect(parentSeen).toEqual([1]);
    expect(iframeSeen).toEqual([1]);
    expect(pair.pending()).toBe(0);
  });
});
