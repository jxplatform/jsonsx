/**
 * The live-reload stream contract, tested where it now lives.
 *
 * `watch.test.ts` and `watch-gaps.test.ts` still exercise it through the dev server, which is what
 * proves the recomposition changed nothing. These tests pin the contract itself — in particular the
 * two halves that are easy to omit and whose absence is silent: `retry:`, and the `id:` that arms
 * `Last-Event-ID` so a reconnection can be told from a first connection.
 */
import { describe, expect, test } from "bun:test";
import { RECONNECT_MS, createSseHub } from "../src/sse";

/** Read one frame off the stream. */
async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  return new TextDecoder().decode(chunk.value);
}

function open(hub: ReturnType<typeof createSseHub>, headers?: Record<string, string>) {
  const request = headers ? new Request("http://127.0.0.1/__reload", { headers }) : undefined;
  const response = hub.handleSSE(request);
  return { reader: (response.body as ReadableStream<Uint8Array>).getReader(), response };
}

describe("the stream itself", () => {
  test("is an event-stream that is never cached", () => {
    const { response } = open(createSseHub());
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("the retry interval is the first thing sent, before any event", async () => {
    // It is a stream-level field, so it is set once — and without it the browser's own
    // Reconnection time is measured in seconds, long enough for a save to look like a no-op.
    const { reader } = open(createSseHub());
    expect(await readFrame(reader)).toBe(`retry: ${RECONNECT_MS}\n\n`);
  });

  test("half a second, because both ends are on loopback", () => {
    expect(RECONNECT_MS).toBe(500);
  });
});

describe("a first connection versus a reconnection", () => {
  test("a first connection is pushed nothing — reloading a page that just loaded is a loop", async () => {
    const hub = createSseHub();
    const { reader } = open(hub);
    expect(await readFrame(reader)).toBe(`retry: ${RECONNECT_MS}\n\n`);
    hub.broadcast();
    expect(await readFrame(reader)).toBe("id: 1\ndata: reload\n\n");
  });

  test("a client presenting Last-Event-ID is pushed exactly ONE reload, and no replay", async () => {
    const hub = createSseHub();
    hub.broadcast();
    hub.broadcast();
    hub.broadcast();
    const { reader } = open(hub, { "Last-Event-ID": "1" });
    expect(await readFrame(reader)).toBe(`retry: ${RECONNECT_MS}\n\n`);
    // One frame, not the two it "missed": a reload is idempotent and total, so one subsumes them.
    expect(await readFrame(reader)).toBe("id: 4\ndata: reload\n\n");
    hub.broadcast();
    expect(await readFrame(reader)).toBe("id: 5\ndata: reload\n\n");
  });

  test("an empty Last-Event-ID is a first connection, not a resume", async () => {
    const hub = createSseHub();
    const { reader } = open(hub, { "Last-Event-ID": "" });
    expect(await readFrame(reader)).toBe(`retry: ${RECONNECT_MS}\n\n`);
    hub.broadcast();
    expect(await readFrame(reader)).toBe("id: 1\ndata: reload\n\n");
  });
});

describe("broadcasting", () => {
  test("every reload frame carries the next id, which is what arms the browser", async () => {
    const hub = createSseHub();
    const { reader } = open(hub);
    await readFrame(reader);
    hub.broadcast();
    hub.broadcast();
    expect(await readFrame(reader)).toBe("id: 1\ndata: reload\n\n");
    expect(await readFrame(reader)).toBe("id: 2\ndata: reload\n\n");
  });

  test("a named event does not reach an onmessage consumer's reload", async () => {
    const hub = createSseHub();
    const { reader } = open(hub);
    await readFrame(reader);
    hub.broadcastEvent("navigate", { route: "/blog/hello/" });
    const frame = await readFrame(reader);
    expect(frame).toBe('event: navigate\ndata: {"route":"/blog/hello/"}\n\n');
    expect(frame).not.toContain("data: reload");
  });

  test("every connected client receives the same frame", async () => {
    const hub = createSseHub();
    const a = open(hub);
    const b = open(hub);
    await readFrame(a.reader);
    await readFrame(b.reader);
    hub.broadcast();
    expect(await readFrame(a.reader)).toBe("id: 1\ndata: reload\n\n");
    expect(await readFrame(b.reader)).toBe("id: 1\ndata: reload\n\n");
  });

  test("broadcasting with nobody connected is a no-op, not a throw", () => {
    const hub = createSseHub();
    expect(() => {
      hub.broadcast();
      hub.broadcastEvent("navigate", {});
    }).not.toThrow();
  });
});

describe("clientCount", () => {
  test("counts the clients the hub is actually holding", async () => {
    const hub = createSseHub();
    expect(hub.clientCount()).toBe(0);
    const a = open(hub);
    await readFrame(a.reader);
    expect(hub.clientCount()).toBe(1);
    const b = open(hub);
    await readFrame(b.reader);
    expect(hub.clientCount()).toBe(2);
  });

  test("a cancelled stream drops out of the hub", async () => {
    // This is the whole premise of "is a preview tab still open": a closed tab cancels, and the
    // Count is what the retarget decision reads.
    const hub = createSseHub();
    const { reader } = open(hub);
    await readFrame(reader);
    expect(hub.clientCount()).toBe(1);
    await reader.cancel();
    expect(hub.clientCount()).toBe(0);
  });

  test("two hubs share nothing — one project's clients are its own", async () => {
    const one = createSseHub();
    const two = createSseHub();
    const { reader } = open(one);
    await readFrame(reader);
    expect(one.clientCount()).toBe(1);
    expect(two.clientCount()).toBe(0);
    two.broadcast();
    one.broadcast();
    expect(await readFrame(reader)).toBe("id: 1\ndata: reload\n\n");
  });
});
