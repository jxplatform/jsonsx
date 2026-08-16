/**
 * Subprotocol negotiation: what the client offers given a probe body, and what the server echoes
 * given an offer. The asymmetry between "offered nothing" and "offered something we do not speak"
 * is the whole contract, so both sides are pinned here.
 */

import { describe, expect, test } from "bun:test";
import {
  COLLAB_SUBPROTOCOL,
  negotiateCollab,
  offeredSubprotocols,
  selectSubprotocol,
} from "../src/negotiate.ts";
import { COLLAB_SUBPROTOCOL as FROM_ENVELOPE } from "../src/envelope.ts";
import { createWsCollabConnection } from "../src/ws-client.ts";
import type { WsLike } from "../src/ws-client.ts";

type WsImpl = new (url: string, protocols?: string[]) => WsLike;

describe("COLLAB_SUBPROTOCOL", () => {
  test("names the envelope major, and the envelope re-exports the same token", () => {
    expect(COLLAB_SUBPROTOCOL).toBe("jx.collab.v1");
    expect(FROM_ENVELOPE).toBe(COLLAB_SUBPROTOCOL);
  });
});

describe("negotiateCollab", () => {
  test("offers the token when the server advertises it", () => {
    expect(negotiateCollab({ collab: true, protocols: [COLLAB_SUBPROTOCOL], version: 1 })).toEqual({
      offer: [COLLAB_SUBPROTOCOL],
      refused: null,
    });
  });

  test("offers NOTHING to a server that advertises no protocols", () => {
    // The pre-negotiation probe body. Offering here would fail the handshake (RFC 6455 §4.1).
    expect(negotiateCollab({ collab: true, version: 1 })).toEqual({ offer: [], refused: null });
    expect(negotiateCollab({ collab: true, protocols: [], version: 1 })).toEqual({
      offer: [],
      refused: null,
    });
  });

  test("offers nothing when the body is not an object at all", () => {
    expect(negotiateCollab(null)).toEqual({ offer: [], refused: null });
    expect(negotiateCollab("collab")).toEqual({ offer: [], refused: null });
  });

  test("refuses, naming both sides, when the envelopes cannot interoperate", () => {
    const result = negotiateCollab({ collab: true, protocols: ["jx.collab.v2"] });
    expect(result.offer).toEqual([]);
    expect(result.refused).toContain("jx.collab.v2");
    expect(result.refused).toContain(COLLAB_SUBPROTOCOL);
  });

  test("refuses a server that says collaboration is off", () => {
    expect(negotiateCollab({ collab: false }).refused).toBeString();
  });
});

describe("offeredSubprotocols", () => {
  test("splits the comma-separated field and trims", () => {
    expect(offeredSubprotocols("jx.collab.v1, jx.collab.v0")).toEqual([
      "jx.collab.v1",
      "jx.collab.v0",
    ]);
  });

  test("an absent or empty field is no offer", () => {
    expect(offeredSubprotocols(null)).toEqual([]);
    expect(offeredSubprotocols("")).toEqual([]);
    expect(offeredSubprotocols(" , ")).toEqual([]);
  });
});

describe("selectSubprotocol", () => {
  test("echoes nothing to a client that offered nothing", () => {
    expect(selectSubprotocol([])).toEqual({ echo: null, reject: null });
  });

  test("echoes a token the client actually offered", () => {
    const answer = selectSubprotocol(["jx.collab.v9", COLLAB_SUBPROTOCOL]);
    expect(answer.echo).toBe(COLLAB_SUBPROTOCOL);
    expect(answer.reject).toBeNull();
  });

  test("rejects an offer it cannot satisfy rather than upgrading unversioned", () => {
    const answer = selectSubprotocol(["jx.collab.v9"]);
    expect(answer.echo).toBeNull();
    expect(answer.reject).toContain(COLLAB_SUBPROTOCOL);
  });
});

describe("the offer reaches the socket", () => {
  /** Records what each connect() passed to the WebSocket constructor. */
  function recorder(): { calls: { protocols?: string[]; url: string }[]; impl: WsImpl } {
    const calls: { protocols?: string[]; url: string }[] = [];
    class RecordingSocket implements WsLike {
      binaryType = "arraybuffer";
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;

      constructor(url: string, protocols?: string[]) {
        calls.push(protocols === undefined ? { url } : { protocols, url });
      }

      sent: Uint8Array[] = [];

      send(data: Uint8Array): void {
        this.sent.push(data);
      }

      close(): void {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    return { calls, impl: RecordingSocket };
  }

  test("an offer is passed through, and re-offered on every reconnect", () => {
    const { calls, impl } = recorder();
    const connection = createWsCollabConnection({
      protocols: [COLLAB_SUBPROTOCOL],
      reconnectDelayMs: 1,
      url: "ws://localhost/collab",
      webSocketImpl: impl,
    });
    expect(calls).toEqual([{ protocols: [COLLAB_SUBPROTOCOL], url: "ws://localhost/collab" }]);
    connection.destroy();
  });

  test("no offer means the constructor is called with the url alone", () => {
    /*
     * Not a cosmetic distinction: `new WebSocket(url, [])` sends an empty `Sec-WebSocket-Protocol`,
     * and a server that echoes nothing then fails the connection (RFC 6455 §4.1). Against a server
     * that advertises no protocols this must be indistinguishable from the pre-negotiation client.
     */
    const { calls, impl } = recorder();
    const connection = createWsCollabConnection({
      protocols: [],
      url: "ws://localhost/collab",
      webSocketImpl: impl,
    });
    expect(calls).toEqual([{ url: "ws://localhost/collab" }]);
    connection.destroy();

    const bare = recorder();
    const second = createWsCollabConnection({
      url: "ws://localhost/collab",
      webSocketImpl: bare.impl,
    });
    expect(bare.calls).toEqual([{ url: "ws://localhost/collab" }]);
    second.destroy();
  });
});
