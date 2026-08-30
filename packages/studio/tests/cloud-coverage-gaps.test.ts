/**
 * Coverage-gap tests for the cloud platform adapter (src/platforms/cloud.ts):
 *
 * - ParseEditPath with undecodable percent-escapes
 * - Manifest reads with unparseable package.json and failing manifest writes
 * - ProbeRootProject failure degradation and listDirectory mapping
 * - WriteFile/deleteFile error surfacing
 * - Collab hydratePath seam
 * - Session-event socket reconnect backoff
 * - GetUser with a signed-out body
 * - CfConnect's DOM-less guard, foreign-origin message filtering, single-flight, and every ending its
 *   poll and popup can reach — including the two a healthy-looking row must NOT reach
 * - CfApi JSON-body requests
 */
import "./harness";
import { afterEach, describe, expect, mock, test } from "bun:test";

interface CollabOpts {
  hydratePath: (path: string) => Promise<void>;
  url: string;
}
let collabOpts: CollabOpts | null = null;
void mock.module("@jxsuite/collab/client", () => ({
  createWsCollabConnection: (opts: CollabOpts) => {
    collabOpts = opts;
    return { openDoc: (path: string) => ({ docPath: path }) };
  },
}));

const { createCloudPlatform, parseEditPath } = await import("../src/platforms/cloud");

const PROJECT = { branch: "main", owner: "octocat", repo: "my-site" };
const BASE = "/api/v1/p/octocat/my-site/main/studio";

const realFetch = globalThis.fetch;
/* Bound before any test replaces window.setTimeout: `drain` and `until` must keep running on the
   real clock inside a test that has taken the platform's clock away. */
const hostSetTimeout = globalThis.setTimeout.bind(globalThis);

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Let the real event loop turn a few times, so stubbed fetches and their `.json()` bodies land. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => {
      hostSetTimeout(resolve, 0);
    });
  }
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (done()) {
      return;
    }
    await new Promise((resolve) => {
      hostSetTimeout(resolve, 0);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Call {
  url: string;
  init?: RequestInit | undefined;
}

/** Route fetches by URL substring (first match wins); unmatched calls get an empty 200. */
function mockFetch(routes: Record<string, { status?: number; body: unknown }> = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ init, url });
    for (const [needle, response] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return Promise.resolve(Response.json(response.body, { status: response.status ?? 200 }));
      }
    }
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  return calls;
}

describe("parseEditPath robustness", () => {
  test("undecodable percent-escapes yield null instead of throwing", () => {
    expect(parseEditPath("/edit/%E0%A4%A")).toBeNull();
  });
});

describe("manifest edge cases", () => {
  test("an unparseable package.json reads as an empty manifest", async () => {
    mockFetch({ "/file?path=package.json": { body: { content: "{not json" } } });
    const p = createCloudPlatform(PROJECT);
    expect(await p.listPackages()).toEqual([]);
  });

  test("a failing manifest write surfaces the backend error", async () => {
    mockFetch({
      "/file?path=package.json": { body: { content: "{}" } },
      "/file": { body: { error: "branch is read-only" }, status: 403 },
    });
    const p = createCloudPlatform(PROJECT);
    expect(p.addPackage("hono")).rejects.toThrow(/read-only/);
  });
});

describe("project probing and directory listing", () => {
  test("probeRootProject nulls when project-info fails", async () => {
    mockFetch({ "/project-info": { body: { error: "boom" }, status: 500 } });
    const p = createCloudPlatform(PROJECT);
    expect(await p.probeRootProject()).toBeNull();
  });

  test("listDirectory maps entries and surfaces failures", async () => {
    const calls = mockFetch({
      "/files?dir=pages": { body: [{ name: "index.md", path: "pages/index.md", type: "file" }] },
      "/files?dir=nope": { body: { error: "no such dir" }, status: 404 },
    });
    const p = createCloudPlatform(PROJECT);
    expect(await p.listDirectory("pages")).toEqual([
      { name: "index.md", path: "pages/index.md", type: "file" },
    ]);
    expect(calls[0]?.url).toBe(`${BASE}/files?dir=pages`);
    expect(p.listDirectory("nope")).rejects.toThrow(/no such dir/);
  });
});

describe("file write/delete failures", () => {
  test("writeFile surfaces the backend error", async () => {
    mockFetch({ "/file": { body: { error: "disk full" }, status: 507 } });
    const p = createCloudPlatform(PROJECT);
    expect(p.writeFile("a.md", "x")).rejects.toThrow(/disk full/);
  });

  test("deleteFile throws on non-404 failures", async () => {
    mockFetch({ "/file?path=locked.md": { body: { error: "protected path" }, status: 403 } });
    const p = createCloudPlatform(PROJECT);
    expect(p.deleteFile("locked.md")).rejects.toThrow(/protected path/);
  });
});

describe("collab hydratePath seam", () => {
  test("the connection's hydratePath reads the file through the session base", async () => {
    const calls = mockFetch({});
    collabOpts = null;
    const p = createCloudPlatform(PROJECT);
    const doc = (await p.collab!("pages/a.md")) as unknown as { docPath: string };
    expect(doc.docPath).toBe("pages/a.md");
    expect(collabOpts).not.toBeNull();
    await collabOpts!.hydratePath("pages/x.md");
    expect(calls.some((c) => c.url === `${BASE}/file?path=pages%2Fx.md`)).toBeTrue();
  });
});

describe("session-event reconnect", () => {
  interface WsLike {
    url: string;
    listeners: Record<string, ((ev: unknown) => void)[]>;
    closed: boolean;
  }
  const instances: WsLike[] = [];

  class MockWebSocket {
    url: string;
    listeners: Record<string, ((ev: unknown) => void)[]> = {};
    closed = false;
    constructor(url: string) {
      this.url = url;
      instances.push(this as unknown as WsLike);
    }
    addEventListener(type: string, handler: (ev: unknown) => void) {
      (this.listeners[type] ??= []).push(handler);
    }
    emit(type: string, ev: unknown) {
      for (const handler of this.listeners[type] ?? []) {
        handler(ev);
      }
    }
    close() {
      this.closed = true;
    }
  }

  test("a dropped socket schedules a reconnect; unsubscribe stops the loop", () => {
    const realWs = (globalThis as Record<string, unknown>)["WebSocket"];
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as Record<string, unknown>)["WebSocket"] = MockWebSocket;
    instances.length = 0;
    const scheduled: { fn: () => void; ms: number }[] = [];
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return 0;
    }) as unknown as typeof setTimeout;
    try {
      mockFetch({});
      const p = createCloudPlatform(PROJECT);
      const unsubscribe = p.subscribeFileEvents?.(() => {});
      const first = instances[0] as unknown as MockWebSocket;
      first.emit("close", {});
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.ms).toBe(1000);

      scheduled[0]!.fn(); // Run the reconnect → a second socket with doubled backoff on file.
      expect(instances).toHaveLength(2);
      const second = instances[1] as unknown as MockWebSocket;
      second.emit("open", {}); // Successful reconnect resets the backoff.
      second.emit("close", {});
      expect(scheduled).toHaveLength(2);
      expect(scheduled[1]!.ms).toBe(1000);

      scheduled[1]!.fn();
      const third = instances[2] as unknown as MockWebSocket;
      unsubscribe?.();
      expect(third.closed).toBeTrue();
      third.emit("close", {}); // After unsubscribe, no further reconnects.
      expect(scheduled).toHaveLength(2);
    } finally {
      (globalThis as Record<string, unknown>)["WebSocket"] = realWs;
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe("identity edge cases", () => {
  test("getUser nulls on a signed-out body", async () => {
    mockFetch({ "/api/v1/me": { body: { user: null } } });
    const p = createCloudPlatform(null);
    expect(await p.getUser?.()).toBeNull();
  });
});

/**
 * A hand-driven browser for one connect flow: a fake popup, and a timer table nothing fires but the
 * test. The poll re-arms itself forever, so a stub that ran its callback eagerly would spin — and
 * these tests are precisely about the polls that must NOT settle.
 */
function stubConnectWindow() {
  const realOpen = window.open;
  const realTimeout = window.setTimeout;
  const realClear = window.clearTimeout;
  const popup = { close: mock(() => {}), closed: false, focus: mock(() => {}) };
  const open = mock(() => popup);
  const armed = new Map<number, () => void>();
  const delays: (number | undefined)[] = [];
  const cleared: number[] = [];
  let nextId = 0;
  (window as { open: unknown }).open = open;
  (window as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
    nextId += 1;
    armed.set(nextId, fn);
    delays.push(ms);
    return nextId;
  }) as unknown as typeof window.setTimeout;
  (window as { clearTimeout: unknown }).clearTimeout = ((id: number) => {
    cleared.push(id);
    armed.delete(id);
  }) as unknown as typeof window.clearTimeout;
  return {
    armed,
    cleared,
    delays,
    open,
    popup,
    /** The baseline read now happens BEFORE the popup opens; wait for both. */
    async started(count = 1): Promise<void> {
      await until(() => open.mock.calls.length >= count, "the connect popup");
      await drain();
    },
    /** Fire the armed poll exactly as the browser would: consumed, then run, then drained. */
    async tick(): Promise<void> {
      const [id] = [...armed.keys()];
      if (id === undefined) {
        throw new Error("no poll timer is armed");
      }
      const fn = armed.get(id)!;
      armed.delete(id);
      fn();
      await drain();
    },
    restore(): void {
      (window as { open: unknown }).open = realOpen;
      (window as { setTimeout: unknown }).setTimeout = realTimeout;
      (window as { clearTimeout: unknown }).clearTimeout = realClear;
    },
  };
}

/** Serve /api/v1/cf/connection from a function of the call index, counting the calls. */
function serveConnection(body: (call: number) => unknown): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (!String(input).includes("/api/v1/cf/connection")) {
      return Promise.resolve(Response.json({}));
    }
    state.calls += 1;
    return Promise.resolve(Response.json(body(state.calls)));
  }) as unknown as typeof fetch;
  return state;
}

describe("cfConnect fallbacks", () => {
  test("nulls when no DOM window exists (SSR guard)", async () => {
    mockFetch({});
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    try {
      const p = createCloudPlatform(null);
      expect(await p.cfConnect?.()).toBeNull();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "window", descriptor);
      }
    }
  });

  test("ignores messages from foreign origins and still settles via the relay", async () => {
    mockFetch({ "/api/v1/cf/connection": { body: { accountId: "acct", connected: true } } });
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "jx-cf", status: "error", reason: "spoofed" },
          origin: "https://evil.example",
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { reason: null, source: "jx-cf", status: "connected" },
          origin: location.origin,
        }),
      );
      expect(await pending).toEqual({
        connection: { accountId: "acct", connected: true },
        status: "connected",
      });
    } finally {
      w.restore();
    }
  });

  test("the poll ignores a healthy row that predates the flow", async () => {
    /* The connection was already good before the popup opened — the production defect exactly: the
       poll saw `connected` at t=0, closed the window over the user's half-typed Cloudflare login,
       and the callback was never reached. */
    const served = serveConnection(() => ({ accountId: "acct", connected: true }));
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      expect(served.calls).toBe(1); // The baseline.
      await w.tick();
      expect(served.calls).toBe(2);
      expect([...w.armed.values()]).toHaveLength(1); // Re-armed instead of settling…
      expect(w.popup.close).not.toHaveBeenCalled(); // …and the popup is still the user's.
      await w.tick();
      expect(w.popup.close).not.toHaveBeenCalled();

      // Only the relay can prove this flow ran, so only the relay may settle it.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "jx-cf", status: "connected" },
          origin: location.origin,
        }),
      );
      expect(await pending).toEqual({
        connection: { accountId: "acct", connected: true },
        status: "connected",
      });
      expect(w.popup.close).toHaveBeenCalled();
    } finally {
      w.restore();
    }
  });

  test("a lapsed row never satisfies the poll", async () => {
    const served = serveConnection(() => ({
      code: "cf_reconnect_required",
      connected: true,
      needsReconnect: true,
    }));
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      await w.tick();
      await w.tick();
      expect([...w.armed.values()]).toHaveLength(1);
      expect(w.popup.close).not.toHaveBeenCalled();
      expect(served.calls).toBe(3);

      // The only ending a row that never heals can have: the user gives up and closes the popup.
      w.popup.closed = true;
      await w.tick();
      expect(await pending).toEqual({ status: "canceled" });
    } finally {
      w.restore();
    }
  });

  test("a reconnect settles once needsReconnect flips false", async () => {
    let lapsed = true;
    const served = serveConnection(() =>
      lapsed
        ? { code: "cf_reconnect_required", connected: true, needsReconnect: true }
        : { accountId: "acct", connected: true },
    );
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      await w.tick();
      expect(w.popup.close).not.toHaveBeenCalled();

      // `needsReconnect` going false is the poll's proof that the callback stored a fresh token.
      lapsed = false;
      await w.tick();
      expect(await pending).toEqual({
        connection: { accountId: "acct", connected: true },
        status: "connected",
      });
      expect(served.calls).toBe(3);
    } finally {
      w.restore();
    }
  });

  test("the poll settles once a fresh connection appears", async () => {
    const served = serveConnection((call) =>
      call < 3 ? { connected: false } : { accountId: "acct", connected: true },
    );
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      await w.tick(); // Nothing brokered yet: re-arm.
      expect([...w.armed.values()]).toHaveLength(1);
      await w.tick();
      expect(await pending).toEqual({
        connection: { accountId: "acct", connected: true },
        status: "connected",
      });
      expect(served.calls).toBe(3);
      expect(w.delays).toEqual([1500, 1500]);
      expect(w.popup.close).toHaveBeenCalled();
    } finally {
      w.restore();
    }
  });

  test("a poll whose fetch throws re-arms instead of settling", async () => {
    /* A blip is not an answer. Treating a thrown fetch as "nothing brokered" would be harmless; it
       is treating it as an ANSWER that matters, and the popup-closed branch below it must not run
       off a read that never happened. */
    let calls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      if (!String(input).includes("/api/v1/cf/connection")) {
        return Promise.resolve(Response.json({}));
      }
      calls += 1;
      if (calls === 2) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve(
        Response.json(calls < 3 ? { connected: false } : { accountId: "acct", connected: true }),
      );
    }) as unknown as typeof fetch;
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      await w.tick();
      expect([...w.armed.values()]).toHaveLength(1);
      expect(w.popup.close).not.toHaveBeenCalled();
      await w.tick();
      expect(await pending).toEqual({
        connection: { accountId: "acct", connected: true },
        status: "connected",
      });
    } finally {
      w.restore();
    }
  });

  test("a popup closed with nothing stored is a cancellation, not a failure", async () => {
    serveConnection(() => ({ connected: false }));
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      w.popup.closed = true;
      await w.tick();
      expect(await pending).toEqual({ status: "canceled" });
      // Already closed, so cleanup leaves it alone.
      expect(w.popup.close).not.toHaveBeenCalled();
    } finally {
      w.restore();
    }
  });

  test("a popup closed after a real callback still resolves connected", async () => {
    /* The row lands between the poll's own read and the final one — a shell that closes its popup
       before the broker has committed the row is the ordinary race here, not an exotic one. */
    const served = serveConnection((call) =>
      call < 3 ? { connected: false } : { accountId: "acct", connected: true },
    );
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      w.popup.closed = true;
      await w.tick();
      expect(await pending).toEqual({
        connection: { accountId: "acct", connected: true },
        status: "connected",
      });
      expect(served.calls).toBe(3);
    } finally {
      w.restore();
    }
  });

  test("the poll gives up past the deadline", async () => {
    serveConnection(() => ({ connected: false }));
    const w = stubConnectWindow();
    const realNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      now = 10_000_000; // Well past the 180s deadline the flow computed at t=0.
      await w.tick();
      expect(await pending).toEqual({ status: "timeout" });
      expect(w.popup.close).toHaveBeenCalled();
    } finally {
      Date.now = realNow;
      w.restore();
    }
  });

  test("a relayed status the platform cannot confirm is a timeout, not a connection", async () => {
    // An older shell can relay "connected" before the broker has a row; the row adjudicates.
    serveConnection(() => ({ connected: false }));
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "jx-cf", status: "connected" },
          origin: location.origin,
        }),
      );
      expect(await pending).toEqual({ status: "timeout" });
    } finally {
      w.restore();
    }
  });

  test("a pick-account relay resolves with an accountId-less connection", async () => {
    serveConnection(() => ({
      code: "cf_account_required",
      connected: true,
      needsAccount: true,
    }));
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "jx-cf", status: "pick-account" },
          origin: location.origin,
        }),
      );
      // Connected and usable; the account picker is the caller's next step, not a failure here.
      expect(await pending).toEqual({
        connection: { code: "cf_account_required", connected: true, needsAccount: true },
        status: "connected",
      });
    } finally {
      w.restore();
    }
  });

  test("the relay path survives a rejecting confirmation fetch", async () => {
    /* This promise carried no rejection handler, so a single network blip during confirmation left
       the listener installed, the timer armed and the popup open for the rest of the session. */
    let fetches = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetches += 1;
      if (fetches === 1) {
        return Promise.resolve(Response.json({ connected: false }));
      }
      return Promise.reject(new Error(`offline: ${String(input)}`));
    }) as unknown as typeof fetch;
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await w.started();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "jx-cf", status: "connected" },
          origin: location.origin,
        }),
      );
      expect(pending).rejects.toThrow(/could not be confirmed/);
      await drain();
      expect(w.popup.close).toHaveBeenCalled();
      expect(w.armed.size).toBe(0);

      // The listener went with it: a second relay asks the broker nothing.
      const settledAt = fetches;
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "jx-cf", status: "connected" },
          origin: location.origin,
        }),
      );
      await drain();
      expect(fetches).toBe(settledAt);
    } finally {
      w.restore();
    }
  });

  test("concurrent cfConnect calls share one in-flight flow", async () => {
    /* Both calls would open the SAME "cf-connect" target, and the first one's cleanup would then
       close the popup the second is waiting on. */
    serveConnection(() => ({ accountId: "acct", connected: true }));
    const w = stubConnectWindow();
    try {
      const p = createCloudPlatform(null);
      const first = p.cfConnect?.();
      const second = p.cfConnect?.();
      expect(second).toBe(first!);
      await w.started();
      expect(w.open.mock.calls).toHaveLength(1);

      // A caller arriving after the popup exists is given it, rather than a second one.
      const third = p.cfConnect?.();
      expect(third).toBe(first!);
      expect(w.popup.focus).toHaveBeenCalled();

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "jx-cf", status: "connected" },
          origin: location.origin,
        }),
      );
      const outcome = {
        connection: { accountId: "acct", connected: true },
        status: "connected",
      } as const;
      expect(await first).toEqual(outcome);
      expect(await second).toEqual(outcome);
      expect(await third).toEqual(outcome);

      // The flow released its slot, so a later connect really does open a new popup.
      const again = p.cfConnect?.();
      await w.started(2);
      expect(w.open.mock.calls).toHaveLength(2);
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "jx-cf", status: "connected" },
          origin: location.origin,
        }),
      );
      expect(await again).toEqual(outcome);
    } finally {
      w.restore();
    }
  });
});

describe("cfApi request bodies", () => {
  test("JSON-encodes the body and sets the content type", async () => {
    const calls = mockFetch({
      "/api/v1/cf/proxy/pages": { body: { result: { id: "p1" }, success: true } },
    });
    const p = createCloudPlatform(null);
    expect(await p.cfApi?.("/pages/projects", { body: { name: "site" }, method: "POST" })).toEqual({
      id: "p1",
    });
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]!.init!.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: "site" });
  });
});
