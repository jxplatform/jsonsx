import { describe, expect, test } from "bun:test";
import { fakeChannelPair } from "../src/canvas/iframe-channel";

interface P2I {
  kind: "render";
  n: number;
}
type I2P = { kind: "ready" } | { kind: "ack"; n: number };

describe("fakeChannelPair", () => {
  test("delivers parent→iframe and iframe→parent messages only on flush", () => {
    const pair = fakeChannelPair<P2I, I2P>();
    const gotByIframe: P2I[] = [];
    const gotByParent: I2P[] = [];
    pair.iframe.onMessage((m) => gotByIframe.push(m));
    pair.parent.onMessage((m) => gotByParent.push(m));

    pair.parent.post({ kind: "render", n: 1 });
    pair.iframe.post({ kind: "ready" });
    // Should deliver nothing until flush.
    expect(gotByIframe).toEqual([]);
    expect(gotByParent).toEqual([]);
    expect(pair.pending()).toBe(2);

    pair.flush();
    expect(gotByIframe).toEqual([{ kind: "render", n: 1 }]);
    expect(gotByParent).toEqual([{ kind: "ready" }]);
    expect(pair.pending()).toBe(0);
  });

  test("messages posted during a flush are deferred to the next flush (no re-entrancy)", () => {
    const pair = fakeChannelPair<P2I, I2P>();
    const order: string[] = [];
    pair.iframe.onMessage((m) => {
      order.push(`iframe:${m.kind}`);
      // Reply during delivery — must NOT be delivered re-entrantly within this flush.
      pair.iframe.post({ kind: "ack", n: m.n });
    });
    pair.parent.onMessage((m) => order.push(`parent:${m.kind}`));

    pair.parent.post({ kind: "render", n: 7 });
    pair.flush();
    expect(order).toEqual(["iframe:render"]);
    expect(pair.pending()).toBe(1); // The ack is queued for the next flush.

    pair.flush();
    expect(order).toEqual(["iframe:render", "parent:ack"]);
  });

  test("fans out to multiple handlers and unsubscribe/dispose stop delivery", () => {
    const pair = fakeChannelPair<P2I, I2P>();
    const a: P2I[] = [];
    const b: P2I[] = [];
    const offA = pair.iframe.onMessage((m) => a.push(m));
    pair.iframe.onMessage((m) => b.push(m));

    pair.parent.post({ kind: "render", n: 1 });
    pair.flush();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    offA();
    pair.parent.post({ kind: "render", n: 2 });
    pair.flush();
    expect(a).toHaveLength(1); // Unsubscribed, no longer delivered.
    expect(b).toHaveLength(2);

    pair.iframe.dispose();
    pair.parent.post({ kind: "render", n: 3 });
    pair.flush();
    expect(b).toHaveLength(2); // Disposed, no longer delivered.

    // Parent side also detaches on dispose.
    const fromIframe: I2P[] = [];
    pair.parent.onMessage((m) => fromIframe.push(m));
    pair.parent.dispose();
    pair.iframe.post({ kind: "ready" });
    pair.flush();
    expect(fromIframe).toHaveLength(0);
  });
});
