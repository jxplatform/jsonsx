// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
/**
 * The chromium RPC transport's TIME-BOUND paths, over a socket the test owns.
 *
 * Its sibling `chromium-transport.test.ts` drives a real `Bun.serve` and covers what a real
 * disconnection does. Three behaviours cannot be reached that way in a test that finishes: the
 * keepalive fires every 30s, an unanswered request times out after 300s, and the reconnect must NOT
 * happen once the window has gone. Each needs the clock and the socket under the test's control, so
 * both are faked here and the platform is built on top of them.
 *
 * The long timers are INTERCEPTED rather than faked wholesale: `jest.useFakeTimers()` replaces the
 * clock the test runner itself schedules on and hangs the run. Only callbacks armed for a second or
 * more are captured, which is exactly the keepalive and the request timeout and nothing the runner
 * uses; everything shorter goes to the real clock. `canvas-render.test.ts`'s `withFastTimers` takes
 * the same approach to the same problem.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/** Frames the platform put on the wire, newest last. */
const sent: Record<string, unknown>[] = [];
/** Every live fake socket, in the order the platform opened them. */
const sockets: FakeSocket[] = [];

type Listener = (event?: unknown) => void;

/** A WebSocket the test opens, closes and answers by hand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  /** The URL the transport dialled, so a test can assert it carried the token. */
  url: string;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  send(data: string): void {
    // Recorded on the module's log rather than per-socket: what a test asserts is the sequence of
    // Frames the transport put on the wire, across whichever socket was live at the time.
    void this.readyState;
    sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.fire("close");
  }

  /** Complete the handshake, the way a server accepting the upgrade does. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.fire("open");
  }

  /** Deliver a server frame. */
  deliver(frame: Record<string, unknown>): void {
    this.fire("message", { data: JSON.stringify(frame) });
  }

  private fire(type: string, event?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }
}

const windowListeners = new Map<string, () => void>();

Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { host: "unit.test", href: "http://unit.test/?token=T", search: "?token=T" },
  writable: true,
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    addEventListener: (type: string, handler: () => void) => windowListeners.set(type, handler),
    focus: () => {},
    open: () => null,
  },
  writable: true,
});
Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  value: FakeSocket,
  writable: true,
});

/** Anything armed for at least this long is the transport's, not the test runner's. */
const LONG_MS = 1000;

/** Captured long timers, by the handle the caller was given. */
const armed = new Map<number, { run: () => unknown; repeats: boolean }>();
let nextHandle = 0;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

function capture(repeats: boolean, real: typeof globalThis.setTimeout) {
  return ((cb: () => unknown, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === "number" && ms >= LONG_MS) {
      nextHandle += 1;
      armed.set(nextHandle, { repeats, run: cb });
      return { __armed: nextHandle } as unknown as ReturnType<typeof setTimeout>;
    }
    return real(cb as () => void, ms, ...(rest as []));
  }) as typeof globalThis.setTimeout;
}

function release(real: (handle: never) => void) {
  return ((handle: unknown) => {
    const id = (handle as { __armed?: number } | null | undefined)?.__armed;
    if (typeof id === "number") {
      armed.delete(id);
      return;
    }
    real(handle as never);
  }) as typeof globalThis.clearTimeout;
}

/** Fire every armed timer once, the way the clock reaching their deadline would. */
function fireArmed(): number {
  const due = [...armed.entries()];
  for (const [id, timer] of due) {
    if (!timer.repeats) {
      armed.delete(id);
    }
    timer.run();
  }
  return due.length;
}

globalThis.setTimeout = capture(false, realSetTimeout);
globalThis.setInterval = capture(true, realSetInterval as typeof globalThis.setTimeout);
globalThis.clearTimeout = release(realClearTimeout as (h: never) => void);
globalThis.clearInterval = release(realClearInterval as (h: never) => void);

const { createDesktopPlatform } = await import("../src/chromium/platform");

let platform: ReturnType<typeof createDesktopPlatform>;

beforeAll(() => {
  platform = createDesktopPlatform();
  sockets[0]!.open();
});

afterAll(() => {
  windowListeners.get("pagehide")?.();
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.clearInterval = realClearInterval;
});

/** The frames sent since the marker, so one test does not read another's traffic. */
function since(mark: number): Record<string, unknown>[] {
  return sent.slice(mark);
}

describe("the keepalive", () => {
  test("pings on its interval while the socket is open", async () => {
    /* The server's idle timeout is 120s and the shell can be quiet for far longer — an import runs
       for minutes over a SEPARATE HTTP stream and touches this socket not at all. */
    const mark = sent.length;
    fireArmed();
    fireArmed();

    const pings = since(mark).filter((f) => f.method === "__ping");
    expect(pings).toHaveLength(2);
    expect(pings[0]).toEqual({ id: 0, method: "__ping" });
  });

  test("says nothing into a socket that is not open", async () => {
    const socket = sockets.at(-1)!;
    socket.readyState = FakeSocket.CLOSED;
    const mark = sent.length;
    fireArmed();

    expect(since(mark)).toEqual([]);
    socket.readyState = FakeSocket.OPEN;
  });
});

describe("a request that is never answered", () => {
  test("rejects on the timeout rather than waiting for a reply nobody will write", async () => {
    /* THE FAILURE THIS TRANSPORT EXISTS TO RULE OUT. A pending entry can only be settled by the
       message listener, so a frame the server never answers used to pin the request — and with it
       `platformInFlight()` and the idle probe — for the life of the session. */
    const pending = platform.readFile("never/answered.json");
    await Promise.resolve();
    fireArmed();
    await expect(pending).rejects.toThrow('The backend did not answer "readFile" in time.');
  });

  test("a reply that does arrive cancels its own timeout", async () => {
    const answered = platform.getProjectRoot();
    await Promise.resolve();
    const id = sent.at(-1)!.id as number;
    sockets.at(-1)!.deliver({ id, result: { root: "/abs/proj" } });
    await expect(answered).resolves.toEqual({ root: "/abs/proj" });

    /* Its timeout was cleared on the way out, so nothing is left armed to reject a request that has
       already settled — the clear is what stops a late timer calling `reject` on a live promise. */
    expect(fireArmed()).toBe(1); // The keepalive, and only the keepalive.
    await expect(answered).resolves.toEqual({ root: "/abs/proj" });
  });
});

describe("a request made while the socket is down", () => {
  test("rejects immediately rather than dropping its frame into the void", async () => {
    /*
     * THE REPORTED BUG, at its narrowest. Per WHATWG, `send()` on a CLOSING or CLOSED socket does
     * not throw — it discards the data, and the browser may log "WebSocket is already in CLOSING or
     * CLOSED state" to the console, which was the entire observable evidence. Without this guard the
     * frame vanishes and the caller waits forever for a reply nobody will ever write, which is why
     * Open Project did nothing at all: no toast, no log, no failed state.
     */
    const socket = sockets.at(-1)!;
    socket.readyState = FakeSocket.CLOSED;
    const mark = sent.length;
    try {
      await expect(platform.readFile("x.json")).rejects.toThrow("Lost connection");
      expect(since(mark)).toEqual([]);
    } finally {
      socket.readyState = FakeSocket.OPEN;
    }
  });
});

describe("once the window has gone", () => {
  test("a close does not schedule another reconnect", async () => {
    /* `pagehide` means the shell is being torn down and the server with it. Reconnecting there
       would leave a backoff timer re-dialling a port that is gone for as long as the process runs. */
    const states: { online: boolean }[] = [];
    platform.subscribeConnection!((state) => states.push(state));

    windowListeners.get("pagehide")!();
    const before = sockets.length;
    sockets.at(-1)!.close();
    fireArmed();
    await Promise.resolve();

    expect(sockets.length).toBe(before);
    // And nobody is told to expect a recovery that is not coming.
    expect(states).toEqual([]);
  });
});
