// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { afterAll, describe, expect, test } from "bun:test";

// Covers src/chromium/platform.ts's `findReferences` bridge — the usage query behind the delete
// Confirmation and the inspector's "used on N pages". The target object is the params payload
// Itself (no wrapper key), so a mock server that answers FROM the params it received proves both
// The shape on the wire and the value handed back.

// ─── Embedded mock RPC server ──────────────────────────────────────────────

interface ReceivedMessage {
  method: string;
  params?: Record<string, unknown>;
}

const received: ReceivedMessage[] = [];

const server = Bun.serve({
  fetch(req, srv) {
    if (srv.upgrade(req)) {
      return;
    }
    return new Response("Not Found", { status: 404 });
  },
  port: 0,
  websocket: {
    message(ws, raw) {
      const msg = JSON.parse(raw as string) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      received.push({ method: msg.method, ...(msg.params ? { params: msg.params } : {}) });

      if (msg.method !== "findReferences") {
        ws.send(JSON.stringify({ error: `Unknown method: ${msg.method}`, id: msg.id }));
        return;
      }

      // Answer from the params as received: the backend reads `path`/`tagName` off the top level of
      // The payload, so a platform that nested the target under a key gets a null-and-empty answer.
      const target = (msg.params ?? {}) as { path?: string; tagName?: string };
      if (target.path === "components/missing.json") {
        ws.send(JSON.stringify({ error: "No such file: components/missing.json", id: msg.id }));
        return;
      }
      const files =
        target.path === "components/card.json"
          ? [
              {
                count: 2,
                path: "pages/index.json",
                refs: [
                  { count: 1, ref: "../components/card.json", refType: "$ref" },
                  { count: 1, ref: "<desk-card>", refType: "tagName" },
                ],
              },
            ]
          : target.tagName === "desk-solo"
            ? [
                {
                  count: 1,
                  path: "pages/solo.json",
                  refs: [{ count: 1, ref: "<desk-solo>", refType: "tagName" }],
                },
              ]
            : [];
      ws.send(
        JSON.stringify({
          id: msg.id,
          result: {
            errors: [],
            files,
            filesReferencing: files.length,
            path: target.path ?? null,
            refsTotal: files.reduce((sum, f) => sum + f.count, 0),
            tagName: target.tagName ?? (target.path ? "desk-card" : null),
          },
        }),
      );
    },
  },
});

const TEST_HOST = `localhost:${server.port}`;

Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { host: TEST_HOST, href: `http://${TEST_HOST}/`, search: "" },
  writable: true,
});

// If a DOM shim replaced WebSocket, restore Bun's native implementation.
const wsStr = globalThis.WebSocket?.toString() ?? "";
if (wsStr.includes("WebSocketImplementation") || wsStr.includes("DOMException")) {
  // @ts-expect-error -- deleting a required global; Bun re-exposes its built-in WebSocket
  delete globalThis.WebSocket;
}

// ─── Import after globals are set ──────────────────────────────────────────

const { createDesktopPlatform } = await import("../src/chromium/platform");
const platform = createDesktopPlatform();

afterAll(() => {
  void server.stop();
});

function lastRequest(): ReceivedMessage | undefined {
  return received.at(-1);
}

describe("chromium platform: findReferences", () => {
  test("a path query is sent as the params payload itself and answers with the usage sweep", async () => {
    const result = await platform.findReferences({ path: "components/card.json" });

    expect(lastRequest()).toEqual({
      method: "findReferences",
      params: { path: "components/card.json" },
    });
    // Echoed back from the params the backend saw — null here would mean the target was wrapped.
    expect(result.path).toBe("components/card.json");
    expect(result.tagName).toBe("desk-card");
    expect(result.files.map((f) => f.path)).toEqual(["pages/index.json"]);
    expect(result.filesReferencing).toBe(1);
    // Both the $ref and the tag instance count, so the delete prompt says 2, not 1.
    expect(result.refsTotal).toBe(2);
    expect(result.errors).toEqual([]);
  });

  test("a tag-only query carries no path key and answers with a null path", async () => {
    const result = await platform.findReferences({ tagName: "desk-solo" });

    expect(lastRequest()).toEqual({
      method: "findReferences",
      params: { tagName: "desk-solo" },
    });
    expect(result.path).toBeNull();
    expect(result.tagName).toBe("desk-solo");
    expect(result.files.map((f) => f.path)).toEqual(["pages/solo.json"]);
    expect(result.refsTotal).toBe(1);
  });

  test("a backend refusal rejects rather than resolving to an empty result", async () => {
    // An empty `files` would read as "nothing references this" and green-light a destructive
    // Delete; the error has to reach the caller.
    await expect(platform.findReferences({ path: "components/missing.json" })).rejects.toThrow(
      "No such file: components/missing.json",
    );
  });
});
