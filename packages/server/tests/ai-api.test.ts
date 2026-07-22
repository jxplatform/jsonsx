/**
 * Ai-api.test.js — Tests for the AI proxy endpoints in @jxsuite/server
 *
 * Tests handleChat (SSE streaming proxy), handleModels (model listing), and handleAiApi (route
 * dispatcher).
 *
 * @module @jxsuite/server/tests
 */

import { describe, it, expect } from "bun:test";
import { handleAiApi } from "../src/ai-api.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read all SSE events from a Response stream.
 *
 * @param {Response} response
 * @returns {Promise<object[]>}
 */
async function readSSEEvents(response: Response): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  const reader = response.body?.getReader();
  if (!reader) {
    return events;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) {
          continue;
        }
        const dataStr = trimmed.slice(6);
        try {
          events.push(JSON.parse(dataStr));
        } catch {
          // Skip unparseable
        }
      }
    }
  } catch {
    // Stream ended
  }

  return events;
}

/**
 * Create a mock Request object.
 *
 * @param {string} pathname
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {object} [opts.body]
 * @param {Record<string, string>} [opts.headers]
 * @returns {Request}
 */
function mockReq(
  pathname: string,
  {
    method = "GET",
    body,
    headers = {},
  }: { method?: string; body?: object; headers?: Record<string, string> } = {},
): Request {
  const url = new URL(`http://localhost${pathname}`);
  const init: RequestInit = { method, headers: new Headers(headers) };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

// ─── /__studio/ai/models ─────────────────────────────────────────────────────

describe("GET /__studio/ai/models", () => {
  it("returns 200 with models array and configured flag", async () => {
    const req = mockReq("/__studio/ai/models");
    const url = new URL("http://localhost/__studio/ai/models");
    const res = await handleAiApi(req, url);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const data = await res!.json();
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models.length).toBeGreaterThanOrEqual(2);
    expect(data.models[0]).toHaveProperty("id");
    expect(data.models[0]).toHaveProperty("name");
    expect(data.models[0]).toHaveProperty("contextWindow");
    expect(typeof data.configured).toBe("boolean");
  });

  it("includes all expected model variants", async () => {
    const req = mockReq("/__studio/ai/models");
    const url = new URL("http://localhost/__studio/ai/models");
    const res = await handleAiApi(req, url);
    const data = await res!.json();

    const ids = data.models.map((m: { id: string }) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("gpt-4.1");
    expect(ids).toContain("gpt-4.1-mini");
    expect(ids).toContain("gpt-4o-mini");
  });

  it("returns content-type application/json", async () => {
    const req = mockReq("/__studio/ai/models");
    const url = new URL("http://localhost/__studio/ai/models");
    const res = await handleAiApi(req, url);

    expect(res!.headers.get("Content-Type")).toBe("application/json");
  });
});

// ─── /__studio/ai/chat — error handling ──────────────────────────────────────

describe("POST /__studio/ai/chat — error handling", () => {
  it("returns 401 when no API key is configured", async () => {
    // Ensure no env var or header
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const req = mockReq("/__studio/ai/chat", {
      method: "POST",
      body: {
        messages: [{ role: "user", content: "Hello" }],
        tools: [],
        systemPrompt: "Be helpful.",
        model: "gpt-4o",
      },
    });
    const url = new URL("http://localhost/__studio/ai/chat");
    const res = await handleAiApi(req, url);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);

    const data = await res!.json();
    expect(data.error).toBeDefined();
    expect(data.error).toContain("API key");

    // Restore
    if (prevKey) {
      process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("returns 400 when messages is not an array", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const req = mockReq("/__studio/ai/chat", {
      method: "POST",
      body: { messages: "not-an-array", tools: [], systemPrompt: "", model: "gpt-4o" },
      headers: { "X-Api-Key": "test-key" },
    });
    const url = new URL("http://localhost/__studio/ai/chat");
    const res = await handleAiApi(req, url);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);

    const data = await res!.json();
    expect(data.error).toBeDefined();
    expect(data.error).toContain("messages");

    delete process.env.OPENAI_API_KEY;
  });

  it("returns 400 for invalid JSON body", async () => {
    const url = new URL("http://localhost/__studio/ai/chat");
    // Create a Request whose body parsing will fail
    const req = new Request("http://localhost/__studio/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "test-key" },
      body: "not valid json {{{",
    });
    process.env.OPENAI_API_KEY = "test-key";

    const res = await handleAiApi(req, url);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);

    delete process.env.OPENAI_API_KEY;
  });
});

// ─── /__studio/ai/chat — SSE streaming integration ───────────────────────────

describe("POST /__studio/ai/chat — SSE streaming", () => {
  it("returns SSE content-type on success", async () => {
    // Verify the response has correct SSE headers and that the upstream stream is normalized.
    // The upstream fetch is mocked so the test never depends on a real network endpoint — a real
    // URL (e.g. httpstat.us) makes this hang and time out under load or offline.
    process.env.OPENAI_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    // A non-SSE 200 body: the proxy reads the (data-less) stream to completion and emits `done`.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("200 OK", { status: 200, headers: { "Content-Type": "text/plain" } }),
      )) as unknown as typeof fetch;

    try {
      const req = mockReq("/__studio/ai/chat", {
        method: "POST",
        body: {
          messages: [{ role: "user", content: "Hello" }],
          tools: [],
          systemPrompt: "Be helpful.",
          model: "gpt-4o",
        },
        headers: { "X-Api-Key": "test-key" },
      });
      const url = new URL("http://localhost/__studio/ai/chat");
      const res = await handleAiApi(req, url);

      expect(res).not.toBeNull();
      expect(res!.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res!.headers.get("Cache-Control")).toBe("no-cache");

      const events = await readSSEEvents(res!);
      expect(events.length).toBeGreaterThan(0);
      const errorEvents = events.filter((e) => e.type === "error");
      const doneEvents = events.filter((e) => e.type === "done");
      expect(errorEvents.length + doneEvents.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("respects X-Api-Key header over Bearer token", async () => {
    // Ensure no env key
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const req = mockReq("/__studio/ai/chat", {
      method: "POST",
      body: {
        messages: [{ role: "user", content: "Hello" }],
        tools: [],
        systemPrompt: "",
        model: "gpt-4o",
      },
      headers: { "X-Api-Key": "header-key" },
    });
    const url = new URL("http://localhost/__studio/ai/chat");
    const res = await handleAiApi(req, url);

    // Should NOT get 401 — X-Api-Key header is used
    // The upstream will fail (invalid key) but 401 is from OUR handler, not upstream
    expect(res).not.toBeNull();
    // 401 from our handler means no key found; anything else means key was found
    // And passed to upstream (which will fail with a different error)
    expect(res!.status).not.toBe(401);

    if (prevKey) {
      process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("falls back to OPENAI_API_KEY env var", async () => {
    process.env.OPENAI_API_KEY = "env-key";

    const req = mockReq("/__studio/ai/chat", {
      method: "POST",
      body: {
        messages: [{ role: "user", content: "Hello" }],
        tools: [],
        systemPrompt: "",
        model: "gpt-4o",
      },
      // No X-Api-Key or Authorization header
    });
    const url = new URL("http://localhost/__studio/ai/chat");
    const res = await handleAiApi(req, url);

    // Should NOT get 401 — env var is used
    expect(res).not.toBeNull();
    expect(res!.status).not.toBe(401);

    delete process.env.OPENAI_API_KEY;
  });
});

// ─── /__studio/ai/chat — SSE event shape validation ──────────────────────────

describe("POST /__studio/ai/chat — SSE event shape", () => {
  it("events from error response have correct shape", async () => {
    // Force a 401 by using an obviously invalid key against OpenAI
    process.env.OPENAI_API_KEY = "invalid-key-for-testing";

    const req = mockReq("/__studio/ai/chat", {
      method: "POST",
      body: {
        messages: [{ role: "user", content: "Hello" }],
        tools: [],
        systemPrompt: "",
        model: "gpt-4o",
      },
      headers: { "X-Api-Key": "invalid-key-for-testing" },
    });
    const url = new URL("http://localhost/__studio/ai/chat");
    const res = await handleAiApi(req, url);

    expect(res).not.toBeNull();
    const events = await readSSEEvents(res!);

    // Should have an error event with proper shape
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    const message = errorEvent!.message as string;
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);

    delete process.env.OPENAI_API_KEY;
  });

  it("model list returns at least gpt-4o and gpt-4.1", async () => {
    const req = mockReq("/__studio/ai/models");
    const url = new URL("http://localhost/__studio/ai/models");
    const res = await handleAiApi(req, url);
    const data = await res!.json();

    const ids = data.models.map((m: { id: string }) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("gpt-4.1");
  });
});

// ─── Route dispatch ──────────────────────────────────────────────────────────

describe("handleAiApi — route dispatch", () => {
  it("routes /__studio/ai/chat POST to handleChat", async () => {
    const req = mockReq("/__studio/ai/chat", { method: "POST" });
    const url = new URL("http://localhost/__studio/ai/chat");
    const res = await handleAiApi(req, url);
    // Should handle (not null) — 401 means it reached handleChat
    expect(res).not.toBeNull();
  });

  it("routes /__studio/ai/models GET to handleModels", async () => {
    const req = mockReq("/__studio/ai/models");
    const url = new URL("http://localhost/__studio/ai/models");
    const res = await handleAiApi(req, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  it("returns null for unknown AI routes", async () => {
    const req = mockReq("/__studio/ai/unknown");
    const url = new URL("http://localhost/__studio/ai/unknown");
    const res = await handleAiApi(req, url);
    expect(res).toBeNull();
  });

  it("rejects POST on /__studio/ai/models (only GET allowed)", async () => {
    const req = mockReq("/__studio/ai/models", { method: "POST" });
    const url = new URL("http://localhost/__studio/ai/models");
    const res = await handleAiApi(req, url);
    expect(res).toBeNull();
  });

  it("rejects GET on /__studio/ai/chat (only POST allowed)", async () => {
    const req = mockReq("/__studio/ai/chat");
    const url = new URL("http://localhost/__studio/ai/chat");
    const res = await handleAiApi(req, url);
    expect(res).toBeNull();
  });
});

// ─── /__studio/ai/chat — upstream SSE parsing (mocked upstream) ───────────────

/** Build a mocked upstream Response whose body is an OpenAI-style SSE stream. */
function sseUpstream(dataObjects: (object | "[DONE]")[], status = 200): Response {
  const body = dataObjects
    .map((o) => `data: ${o === "[DONE]" ? "[DONE]" : JSON.stringify(o)}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
    status,
  });
}

/** Run `fn` with `globalThis.fetch` and OPENAI_API_KEY stubbed, restoring both afterward. */
async function withUpstream(fetchImpl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prevKey;
    }
  }
}

function chatReq() {
  return mockReq("/__studio/ai/chat", {
    body: { messages: [{ content: "Hi", role: "user" }], model: "gpt-4o", systemPrompt: "" },
    headers: { "X-Api-Key": "test-key" },
    method: "POST",
  });
}

describe("POST /__studio/ai/chat — upstream SSE parsing", () => {
  it("normalizes content deltas and a stop finish_reason", async () => {
    await withUpstream(
      (() =>
        Promise.resolve(
          sseUpstream([
            { choices: [{ delta: { content: "Hello" } }] },
            { choices: [{ delta: { content: " world" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ]),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        const deltas = events.filter((e) => e.type === "delta").map((e) => e.content);
        expect(deltas).toEqual(["Hello", " world"]);
        const done = events.find((e) => e.type === "done");
        expect(done!.stopReason).toBe("stop");
      },
    );
  });

  it("normalizes a streamed tool call across fragments", async () => {
    await withUpstream(
      (() =>
        Promise.resolve(
          sseUpstream([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: '{"path"', name: "set_text" },
                        id: "call_1",
                        index: 0,
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [{ delta: { tool_calls: [{ function: { arguments: ":[]}" }, index: 0 }] } }],
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        const start = events.find((e) => e.type === "tool_call_start");
        expect(start!.name).toBe("set_text");
        const args = events
          .filter((e) => e.type === "tool_call_delta")
          .map((e) => e.args)
          .join("");
        expect(args).toBe('{"path":[]}');
        expect(events.some((e) => e.type === "tool_call_end")).toBe(true);
        expect(events.find((e) => e.type === "done")!.stopReason).toBe("tool_calls");
      },
    );
  });

  it("ends a tool call cleanly on an explicit [DONE]", async () => {
    await withUpstream(
      (() =>
        Promise.resolve(
          sseUpstream([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ function: { name: "read_document" }, id: "call_9", index: 0 }],
                  },
                },
              ],
            },
            "[DONE]",
          ]),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        expect(events.some((e) => e.type === "tool_call_end")).toBe(true);
        expect(events.find((e) => e.type === "done")!.stopReason).toBe("stop");
      },
    );
  });

  it("surfaces an upstream error body as an error event", async () => {
    await withUpstream(
      (() =>
        Promise.resolve(
          Response.json({ error: { message: "rate limited" } }, { status: 429 }),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        const err = events.find((e) => e.type === "error");
        expect(err!.message).toBe("rate limited");
        expect(err!.code).toBe("429");
      },
    );
  });

  it("surfaces a string-form upstream error body", async () => {
    await withUpstream(
      (() =>
        Promise.resolve(
          Response.json({ error: "bad request" }, { status: 400 }),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        expect(events.find((e) => e.type === "error")!.message).toBe("bad request");
      },
    );
  });

  it("reports a network failure when the upstream fetch throws", async () => {
    await withUpstream(
      (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        expect(events.find((e) => e.type === "error")!.message).toContain("Network error: boom");
      },
    );
  });
});

// ─── /__studio/ai/models — upstream proxy (mocked upstream) ──────────────────

describe("GET /__studio/ai/models — upstream proxy", () => {
  function modelsReq() {
    return mockReq("/__studio/ai/models", { headers: { "X-Api-Key": "test-key" } });
  }

  it("maps the upstream model list when a key is configured", async () => {
    await withUpstream(
      (() =>
        Promise.resolve(
          Response.json({
            data: [{ context_window: 4096, id: "m-1", owned_by: "acme" }],
          }),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(modelsReq(), new URL("http://localhost/__studio/ai/models"));
        const data = (await res!.json()) as {
          configured: boolean;
          models: { contextWindow: number; id: string }[];
        };
        expect(data.configured).toBe(true);
        expect(data.models[0]!.id).toBe("m-1");
        expect(data.models[0]!.contextWindow).toBe(4096);
      },
    );
  });

  it("falls back to defaults when the upstream /models call is not ok", async () => {
    await withUpstream(
      (() => Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(modelsReq(), new URL("http://localhost/__studio/ai/models"));
        const data = (await res!.json()) as { upstreamError: number };
        expect(data.upstreamError).toBe(500);
      },
    );
  });

  it("falls back to defaults when the upstream /models call throws", async () => {
    await withUpstream(
      (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(modelsReq(), new URL("http://localhost/__studio/ai/models"));
        const data = (await res!.json()) as { upstreamError: string };
        expect(data.upstreamError).toBe("network");
      },
    );
  });
});

// ─── /__studio/ai/chat — auth, config & stream edge cases ────────────────────

describe("POST /__studio/ai/chat — auth, config & stream edge cases", () => {
  it("accepts a Bearer token, a base-URL override, and forwards tools", async () => {
    const realFetch = globalThis.fetch;
    let seenUrl = "";
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY; // Force reliance on the Bearer token
    globalThis.fetch = ((url: string) => {
      seenUrl = url;
      return Promise.resolve(sseUpstream([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
    }) as unknown as typeof fetch;
    try {
      const req = mockReq("/__studio/ai/chat", {
        body: {
          messages: [{ content: "Hi", role: "user" }],
          model: "gpt-4o",
          systemPrompt: "",
          tools: [{ function: { name: "x" }, type: "function" }],
        },
        headers: { Authorization: "Bearer tok-1", "X-Api-Base-URL": "https://alt.example/v1" },
        method: "POST",
      });
      const res = await handleAiApi(req, new URL("http://localhost/__studio/ai/chat"));
      expect(res!.status).toBe(200);
      expect(seenUrl).toBe("https://alt.example/v1/chat/completions");
      const events = await readSSEEvents(res!);
      expect(events.find((e) => e.type === "done")).toBeDefined();
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey !== undefined) {
        process.env.OPENAI_API_KEY = prevKey;
      }
    }
  });

  it("errors when the upstream returns no response body", async () => {
    await withUpstream(
      (() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        expect(events.find((e) => e.type === "error")!.message).toContain("No response body");
      },
    );
  });

  it("skips unparseable data lines and still completes", async () => {
    await withUpstream(
      (() =>
        Promise.resolve(
          new Response("data: {not valid json\n\ndata: [DONE]\n\n", { status: 200 }),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        expect(events.find((e) => e.type === "done")!.stopReason).toBe("stop");
      },
    );
  });

  it("closes a pending tool call when the finish reason is a plain stop", async () => {
    await withUpstream(
      (() =>
        Promise.resolve(
          sseUpstream([
            {
              choices: [
                { delta: { tool_calls: [{ function: { name: "t" }, id: "c1", index: 0 }] } },
              ],
            },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ]),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        expect(events.some((e) => e.type === "tool_call_end")).toBe(true);
        expect(events.find((e) => e.type === "done")!.stopReason).toBe("stop");
      },
    );
  });

  it("closes a pending tool call when the stream ends without a finish reason", async () => {
    await withUpstream(
      (() =>
        Promise.resolve(
          sseUpstream([
            {
              choices: [
                { delta: { tool_calls: [{ function: { name: "t" }, id: "c2", index: 0 }] } },
              ],
            },
          ]),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        expect(events.some((e) => e.type === "tool_call_end")).toBe(true);
        expect(events.find((e) => e.type === "done")!.stopReason).toBe("stop");
      },
    );
  });

  it("emits a cancelled done when the upstream fetch is aborted", async () => {
    await withUpstream(
      (() =>
        Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        )) as unknown as typeof fetch,
      async () => {
        const res = await handleAiApi(chatReq(), new URL("http://localhost/__studio/ai/chat"));
        const events = await readSSEEvents(res!);
        expect(events.find((e) => e.type === "done")!.stopReason).toBe("cancelled");
      },
    );
  });
});

// ─── Provenance / SSRF hardening ─────────────────────────────────────────────

describe("AI proxy key-provenance + SSRF hardening", () => {
  const withEnvKey = async (fn: () => Promise<void>) => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-server-secret";
    try {
      await fn();
    } finally {
      if (prev === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prev;
      }
    }
  };

  it("refuses to forward the env key to a caller-supplied base URL (401, no upstream fetch)", async () => {
    await withEnvKey(async () => {
      let fetched = false;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (() => {
        fetched = true;
        return Promise.resolve(new Response("", { status: 200 }));
      }) as typeof fetch;
      try {
        const req = mockReq("/__studio/ai/chat", {
          method: "POST",
          body: { messages: [{ role: "user", content: "hi" }] },
          headers: { "X-Api-Base-URL": "https://attacker.example/v1" },
        });
        const res = await handleAiApi(req, new URL("http://localhost/__studio/ai/chat"));
        expect(res!.status).toBe(401);
        expect(fetched).toBe(false);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it("blocks a base URL pointing at the cloud metadata endpoint (403)", async () => {
    const req = mockReq("/__studio/ai/chat", {
      method: "POST",
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { "X-Api-Base-URL": "http://169.254.169.254/latest", "X-Api-Key": "sk-user" },
    });
    const res = await handleAiApi(req, new URL("http://localhost/__studio/ai/chat"));
    expect(res!.status).toBe(403);
  });

  it("models endpoint also refuses a caller base URL without a caller key (401)", async () => {
    await withEnvKey(async () => {
      const req = mockReq("/__studio/ai/models", {
        headers: { "X-Api-Base-URL": "https://attacker.example/v1" },
      });
      const res = await handleAiApi(req, new URL("http://localhost/__studio/ai/models"));
      expect(res!.status).toBe(401);
    });
  });
});
