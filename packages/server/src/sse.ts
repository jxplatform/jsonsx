/**
 * The live-reload stream contract, in one place.
 *
 * Two surfaces speak it — the dev server's `/__reload` ({@link ./watch.ts}) and the live preview
 * origin's own channel ({@link ./live-preview.ts}) — and what they share is not "an SSE endpoint"
 * but a specific reading of the HTML Standard's EventSource contract that took a defect report to
 * arrive at (specs/server.md §3.1). Re-deriving it per surface is how one of them ends up with a
 * reconnect that silently never fires.
 *
 * The two halves that are easy to omit and expensive to omit:
 *
 * - **`retry:`** sets the reconnection time. The default is user-agent defined and is measured in
 *   seconds; during a server restart that is long enough to watch a save do nothing. 500 ms is
 *   loopback, so the reconnect costs nothing and lands inside the restart.
 * - **`Last-Event-ID`** is how the browser says "I was here before", and it is the ONLY way the
 *   server can tell a reconnection from a first connection. A reconnecting client gets exactly one
 *   reload and no replay; a first connection gets none at all, because reloading a page that just
 *   loaded is a reload loop.
 *
 * A hub broadcasts to every client it holds. Membership is the socket's whole lifetime — added on
 * open, dropped on cancel — so a broadcast after a tab closes reaches nobody rather than throwing.
 */

/**
 * Reconnection time advertised on the stream, in milliseconds (HTML Standard, `retry:`).
 *
 * Both endpoints are on loopback, so a reconnect costs nothing and half a second lands inside a
 * typical restart.
 */
export const RECONNECT_MS = 500;

/** How often a comment frame is sent to keep an idle connection from being reaped. */
const HEARTBEAT_MS = 15_000;

/** A broadcast hub for one stream. */
export interface SseHub {
  /** Send the default (unnamed) `reload` message, stamped with the next `id:`. */
  broadcast: () => void;
  /**
   * Send a _named_ event.
   *
   * A consumer wired as `onmessage` sees only the unnamed message, so a named event reaches a
   * listener that asked for it without triggering everyone else's reload. That is what lets the
   * studio shell subscribe to `fs` on the same connection the preview reloads on.
   */
  broadcastEvent: (event: string, payload: unknown) => void;
  /** Open the stream. Pass the request so `Last-Event-ID` can be read. */
  handleSSE: (request?: Request) => Response;
  /** How many clients are connected right now. */
  clientCount: () => number;
}

/** Create a hub. Nothing is shared between hubs — a project's clients are its own. */
export function createSseHub(): SseHub {
  const clients = new Set<(msg: string) => void>();
  const encoder = new TextEncoder();

  /*
   * Monotonic reload counter, sent as the SSE `id:` of every reload frame.
   *
   * Its only job is to arm the browser: a stream that has never sent an `id:` makes the client omit
   * `Last-Event-ID` on reconnect, and then the server cannot tell a first connection from a
   * reconnection. **Nothing is buffered against it and nothing is replayed.** A reconnecting client
   * gets exactly one reload, because the page it is holding was built before the disconnect and a
   * full reload subsumes every event it missed — one is as correct as a hundred and finishes
   * sooner. Do not "complete" this into a replay buffer; there is no per-event state to replay.
   */
  let lastEventId = 0;

  function broadcast() {
    lastEventId += 1;
    const frame = `id: ${lastEventId}\ndata: reload\n\n`;
    for (const send of clients) {
      send(frame);
    }
  }

  function broadcastEvent(event: string, payload: unknown) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const send of clients) {
      send(frame);
    }
  }

  function handleSSE(request?: Request) {
    const resuming = (request?.headers.get("Last-Event-ID") ?? "") !== "";
    let send: ((msg: string) => void) | undefined;
    const stream = new ReadableStream({
      cancel() {
        if (send) {
          clients.delete(send);
        }
      },
      start(c) {
        send = (msg: string) => {
          try {
            c.enqueue(encoder.encode(msg));
          } catch {}
        };
        clients.add(send);
        // The retry interval is a stream-level field, so it is set once, before any event.
        send(`retry: ${RECONNECT_MS}\n\n`);
        if (resuming) {
          lastEventId += 1;
          send(`id: ${lastEventId}\ndata: reload\n\n`);
        }
        const hb = setInterval(() => {
          try {
            c.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            clearInterval(hb);
          }
        }, HEARTBEAT_MS);
      },
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      },
    });
  }

  return { broadcast, broadcastEvent, clientCount: () => clients.size, handleSSE };
}
