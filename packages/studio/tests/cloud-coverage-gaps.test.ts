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
 * - CfConnect DOM-less guard, foreign-origin message filtering, and the poll fallback
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

afterEach(() => {
  globalThis.fetch = realFetch;
});

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
    const realOpen = window.open;
    const popup = { close: mock(() => {}), closed: false };
    (window as { open: unknown }).open = mock(() => popup);
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
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
      expect(await pending).toEqual({ accountId: "acct", connected: true });
    } finally {
      (window as { open: unknown }).open = realOpen;
    }
  });

  test("the poll fallback resolves once the brokered connection appears", async () => {
    mockFetch({ "/api/v1/cf/connection": { body: { accountId: "acct", connected: true } } });
    const realOpen = window.open;
    const realTimeout = window.setTimeout;
    const popup = { close: mock(() => {}), closed: false };
    (window as { open: unknown }).open = mock(() => popup);
    (window as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 1;
    }) as unknown as typeof window.setTimeout;
    try {
      const p = createCloudPlatform(null);
      expect(await p.cfConnect?.()).toEqual({ accountId: "acct", connected: true });
    } finally {
      (window as { open: unknown }).open = realOpen;
      (window as { setTimeout: unknown }).setTimeout = realTimeout;
    }
  });

  test("the poll fallback re-checks once the popup closes without a relay", async () => {
    mockFetch({ "/api/v1/cf/connection": { body: { connected: false } } });
    const realOpen = window.open;
    const realTimeout = window.setTimeout;
    const popup = { close: mock(() => {}), closed: true };
    (window as { open: unknown }).open = mock(() => popup);
    (window as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 1;
    }) as unknown as typeof window.setTimeout;
    try {
      const p = createCloudPlatform(null);
      expect(await p.cfConnect?.()).toBeNull();
    } finally {
      (window as { open: unknown }).open = realOpen;
      (window as { setTimeout: unknown }).setTimeout = realTimeout;
    }
  });

  test("the poll fallback gives up past the deadline", async () => {
    mockFetch({ "/api/v1/cf/connection": { body: { connected: false } } });
    const realOpen = window.open;
    const realTimeout = window.setTimeout;
    const realNow = Date.now;
    const popup = { close: mock(() => {}), closed: false };
    (window as { open: unknown }).open = mock(() => popup);
    (window as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 1;
    }) as unknown as typeof window.setTimeout;
    let calls = 0;
    Date.now = () => {
      calls += 1;
      return calls === 1 ? 0 : 10_000_000; // Deadline computed at 180s; every later check is past it.
    };
    try {
      const p = createCloudPlatform(null);
      expect(await p.cfConnect?.()).toBeNull();
    } finally {
      Date.now = realNow;
      (window as { open: unknown }).open = realOpen;
      (window as { setTimeout: unknown }).setTimeout = realTimeout;
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
