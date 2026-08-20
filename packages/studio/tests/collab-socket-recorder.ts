/**
 * Records what a platform adapter passes to the WebSocket constructor when it opens its collab
 * socket. Both adapters are under the same contract — the URL they build and the subprotocol they
 * offer — so both read this rather than each keeping a stub.
 *
 * The socket never answers, so the returned `openDoc` promise never resolves; that is deliberate.
 * The session-level timeout owns fallback, and only the handshake inputs are under test here.
 */

export interface RecordedSocket {
  protocols?: string[];
  url: string;
}

/**
 * Install a recording WebSocket, ask the platform for a collab handle, and return what it built.
 *
 * @param {() => { collab?: (path: string) => Promise<unknown> }} makePlatform
 * @param {number} opens How many `collab()` calls to make (2 proves the socket is multiplexed).
 * @returns {Promise<RecordedSocket[]>}
 */
export async function recordCollabSockets(
  makePlatform: () => { collab?: (path: string) => Promise<unknown> },
  opens = 1,
): Promise<RecordedSocket[]> {
  const seen: RecordedSocket[] = [];
  class RecordingWebSocket {
    binaryType = "";
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: unknown) => void) | null = null;
    sent = 0;
    constructor(url: string, protocols?: string[]) {
      seen.push(protocols === undefined ? { url } : { protocols, url });
    }
    send(): void {
      this.sent += 1;
    }
    close(): void {
      this.sent = -1;
    }
  }
  const realWs = (globalThis as Record<string, unknown>)["WebSocket"];
  (globalThis as Record<string, unknown>)["WebSocket"] = RecordingWebSocket;
  try {
    const platform = makePlatform();
    for (let i = 0; i < opens; i++) {
      void platform.collab?.(`pages/${String.fromCodePoint(97 + i)}.md`);
    }
    const deadline = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((resolveSleep) => {
        setTimeout(resolveSleep, 10);
      });
    }
  } finally {
    (globalThis as Record<string, unknown>)["WebSocket"] = realWs;
  }
  return seen;
}
