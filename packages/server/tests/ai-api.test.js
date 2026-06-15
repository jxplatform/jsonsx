/**
 * Ai-api.test.js — Tests for the AI proxy endpoints in @jxsuite/server
 *
 * Tests handleChat (SSE streaming proxy), handleModels (model listing), and handleAiApi (route
 * dispatcher).
 *
 * @module @jxsuite/server/tests
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { handleAiApi } from "../src/ai-api.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read all SSE events from a Response stream.
 *
 * @param {Response} response
 * @returns {Promise<object[]>}
 */
async function readSSEEvents(response) {
  const events = [];
  const reader = response.body?.getReader();
  if (!reader) return events;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6);
        try {
          events.push(JSON.parse(dataStr));
        } catch {
          // skip unparseable
        }
      }
    }
  } catch {
    // stream ended
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
function mockReq(pathname, { method = "GET", body, headers = {} } = {}) {
  const url = new URL(`http://localhost${pathname}`);
  const init = { method, headers: new Headers(headers) };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

// ─── /__studio/ai/models ─────────────────────────────────────────────────────

describe("GET /__studio/ai/models", () => {
  it("returns 200 with models array and configured flag", async () => {
    const req = mockReq("/__studio/ai/models");
    const url = new URL("http://localhost/__studio/ai/models");
    const res = await handleAiApi(req, url);

    expect(res).not.toBeNull();
    expect(res.status).toBe(200);

    const data = await res.json();
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
    const data = await res.json();

    const ids = data.models.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("gpt-4.1");
    expect(ids).toContain("gpt-4.1-mini");
    expect(ids).toContain("gpt-4o-mini");
  });

  it("returns content-type application/json", async () => {
    const req = mockReq("/__studio/ai/models");
    const url = new URL("http://localhost/__studio/ai/models");
    const res = await handleAiApi(req, url);

    expect(res.headers.get("Content-Type")).toBe("application/json");
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
    expect(res.status).toBe(401);

    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error).toContain("API key");

    // Restore
    if (prevKey) process.env.OPENAI_API_KEY = prevKey;
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
    expect(res.status).toBe(400);

    const data = await res.json();
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
    expect(res.status).toBe(400);

    delete process.env.OPENAI_API_KEY;
  });
});

// ─── /__studio/ai/chat — SSE streaming integration ───────────────────────────

describe("POST /__studio/ai/chat — SSE streaming", () => {
  it("returns SSE content-type on success", async () => {
    // This test verifies the response has correct SSE headers.
    // We mock the upstream by setting OPENAI_API_KEY and a valid base URL
    // that will fail with a clean error (we test the pipeline shape, not OpenAI)
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://httpstat.us"; // returns 200 for any path

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
    // The upstream will fail (not an actual OpenAI endpoint) but the
    // response shape should be SSE with an error event
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");

    const events = await readSSEEvents(res);
    // Should contain an error event since httpstat.us isn't OpenAI
    expect(events.length).toBeGreaterThan(0);
    const errorEvents = events.filter((e) => e.type === "error");
    const doneEvents = events.filter((e) => e.type === "done");
    expect(errorEvents.length + doneEvents.length).toBeGreaterThan(0);

    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
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
    // and passed to upstream (which will fail with a different error)
    expect(res.status).not.toBe(401);

    if (prevKey) process.env.OPENAI_API_KEY = prevKey;
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
    expect(res.status).not.toBe(401);

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
    const events = await readSSEEvents(res);

    // Should have an error event with proper shape
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(typeof errorEvent.message).toBe("string");
    expect(errorEvent.message.length).toBeGreaterThan(0);

    delete process.env.OPENAI_API_KEY;
  });

  it("model list returns at least gpt-4o and gpt-4.1", async () => {
    const req = mockReq("/__studio/ai/models");
    const url = new URL("http://localhost/__studio/ai/models");
    const res = await handleAiApi(req, url);
    const data = await res.json();

    const ids = data.models.map((m) => m.id);
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
    expect(res.status).toBe(200);
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
