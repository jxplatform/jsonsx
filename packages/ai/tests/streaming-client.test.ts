/**
 * Tests for @jxsuite/ai streaming-client — OpenAI, Anthropic, and Proxy clients.
 *
 * Each client's streamChat is an async generator that fetches an SSE endpoint and yields normalized
 * StreamEvents. We drive each by mocking globalThis.fetch to resolve a Response whose body is a
 * plain SSE string (the client reads response.body.getReader()).
 *
 * @module @jxsuite/ai/tests
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  createOpenAIStreamingClient,
  createAnthropicStreamingClient,
  createProxyStreamingClient,
} from "../src/streaming-client.js";
import type { StreamErrorEvent, StreamEvent } from "../src/streaming-client.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Builds an SSE body string from already-serialized frame payloads (each becomes `data: <p>`). */
function sseBody(frames: string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join("");
}

/** A Response whose body streams a string, exposing a real getReader(). */
function streamingResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

/** Installs a fetch mock and records the single request's url + init. */
function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): {
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof fetch;
  return { calls };
}

/** Drains an async generator into an array of the union every client is contracted to yield. */
async function collect(gen: AsyncGenerator<unknown>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event as StreamEvent);
  }
  return events;
}

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}

// ─── OpenAI client ──────────────────────────────────────────────────────────

describe("createOpenAIStreamingClient", () => {
  it("yields text deltas and a stop done event, and posts the expected request", async () => {
    const { calls } = mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
          JSON.stringify({ choices: [{ delta: { content: " world" } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        ]),
        { status: 200 },
      ),
    );

    const client = createOpenAIStreamingClient({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      temperature: 0,
    });
    const events = await collect(
      client.streamChat(
        [{ role: "user", content: "hi" }],
        [],
        "be nice",
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      { type: "delta", content: "Hello" },
      { type: "delta", content: " world" },
      { type: "done", stopReason: "stop" },
    ]);

    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    const sent = JSON.parse(call.init.body as string) as {
      temperature?: number;
      messages: { role: string; content: string }[];
      tools?: unknown;
    };
    expect(sent.temperature).toBe(0);
    expect(sent.messages[0]).toEqual({ role: "system", content: "be nice" });
    expect(sent.tools).toBeUndefined();
  });

  it("omits temperature when undefined and forwards tools with tool_choice", async () => {
    const { calls } = mockFetch(() => streamingResponse(sseBody(["[DONE]"]), { status: 200 }));

    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    await collect(
      client.streamChat([], [{ type: "function" }], "sys", new AbortController().signal),
    );

    const sent = JSON.parse(calls[0]!.init.body as string) as {
      temperature?: number;
      tools?: unknown[];
      tool_choice?: string;
      parallel_tool_calls?: boolean;
      model: string;
    };
    expect(sent.temperature).toBeUndefined();
    expect(sent.model).toBe("gpt-4o");
    expect(sent.tools).toHaveLength(1);
    expect(sent.tool_choice).toBe("auto");
    expect(sent.parallel_tool_calls).toBe(true);
  });

  it("emits [DONE] as a stop done event", async () => {
    mockFetch(() => streamingResponse(sseBody(["[DONE]"]), { status: 200 }));
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "done", stopReason: "stop" }]);
  });

  it("emits pending tool_call_end before done on [DONE]", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "doThing" } }] },
              },
            ],
          }),
          "[DONE]",
        ]),
        { status: 200 },
      ),
    );
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_1", name: "doThing" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("streams a tool call across fragments and ends on finish_reason tool_calls", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_a",
                      function: { name: "addElement", arguments: '{"tag"' },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: ':"button"}' } }] } },
            ],
          }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]),
        { status: 200 },
      ),
    );
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_a", name: "addElement" },
      { type: "tool_call_delta", id: "call_a", args: '{"tag"' },
      { type: "tool_call_delta", id: "call_a", args: ':"button"}' },
      { type: "tool_call_end", id: "call_a" },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("handles a tool call with no initial arguments and a missing name", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: {} }] } }],
          }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        ]),
        { status: 200 },
      ),
    );
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "tool_call_start", id: "c1", name: "" },
      { type: "tool_call_end", id: "c1" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("ignores an argument fragment that arrives before any tool_call_start", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "orphan" } }] } }],
          }),
          "[DONE]",
        ]),
        { status: 200 },
      ),
    );
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "done", stopReason: "stop" }]);
  });

  it("maps finish_reason length to a length done event", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({ choices: [{ delta: { content: "x" } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
        ]),
        { status: 200 },
      ),
    );
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "delta", content: "x" },
      { type: "done", stopReason: "length" },
    ]);
  });

  it("emits pending tool_call_end on finish_reason stop", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "t9", function: { name: "n" } }] } }],
          }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        ]),
        { status: 200 },
      ),
    );
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "tool_call_start", id: "t9", name: "n" },
      { type: "tool_call_end", id: "t9" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("skips unparseable data lines and lines without a data prefix", async () => {
    mockFetch(() =>
      streamingResponse(
        [
          "data: not-json\n\n",
          ": a comment line\n\n",
          "\n",
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200 },
      ),
    );
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "delta", content: "ok" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("skips chunks with no choices and chunks whose choice has no delta", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({}),
          JSON.stringify({ choices: [] }),
          JSON.stringify({ choices: [{ finish_reason: null }] }),
          JSON.stringify({ choices: [{ delta: { content: "z" } }] }),
          "[DONE]",
        ]),
        { status: 200 },
      ),
    );
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "delta", content: "z" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("ends the stream with a stop done event when the body closes without finish_reason", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: "open", function: { name: "n" } }] } },
            ],
          }),
          JSON.stringify({ choices: [{ delta: { content: "tail" } }] }),
        ]),
        { status: 200 },
      ),
    );
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "tool_call_start", id: "open", name: "n" },
      { type: "delta", content: "tail" },
      { type: "tool_call_end", id: "open" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("yields an error event for a non-ok response using the body text", async () => {
    mockFetch(() => streamingResponse("rate limited", { status: 429 }));
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "error", message: "API error 429: rate limited", code: "429" },
    ]);
  });

  it("falls back to statusText when a non-ok response has an empty body", async () => {
    mockFetch(() => new Response("", { status: 503, statusText: "Service Unavailable" }));
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toHaveLength(1);
    const event = events[0] as StreamErrorEvent;
    expect(event.type).toBe("error");
    expect(event.message).toBe("API error 503: Service Unavailable");
    expect(event.code).toBe("503");
  });

  it("yields a network error event when fetch rejects with a non-abort error", async () => {
    mockFetch(() => Promise.reject(new Error("boom")));
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "Network error: boom" }]);
  });

  it("yields a cancelled done event when fetch rejects with an AbortError", async () => {
    mockFetch(() => Promise.reject(abortError("aborted")));
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "done", stopReason: "cancelled" }]);
  });

  it("yields an error event when the response has no body", async () => {
    const noBody = { ok: true, body: null } as unknown as Response;
    mockFetch(() => noBody);
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "No response body" }]);
  });

  it("yields an error event when reading the non-ok body text throws", async () => {
    const failingText = {
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: () => Promise.reject(new Error("read fail")),
    } as unknown as Response;
    mockFetch(() => failingText);
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "error", message: "API error 500: Server Error", code: "500" },
    ]);
  });

  it("yields a stream error event when reading the body throws mid-stream", async () => {
    const reader = {
      read: () => Promise.reject(new Error("reader exploded")),
      cancel: () => Promise.resolve(),
    };
    const fakeResponse = {
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response;
    mockFetch(() => fakeResponse);
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "Stream error: reader exploded" }]);
  });

  it("yields a cancelled done event when reading the body throws an AbortError mid-stream", async () => {
    const reader = {
      read: () => Promise.reject(abortError("mid-stream abort")),
      cancel: () => Promise.resolve(),
    };
    const fakeResponse = {
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response;
    mockFetch(() => fakeResponse);
    const client = createOpenAIStreamingClient({ baseUrl: "https://x", apiKey: "k" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "done", stopReason: "cancelled" }]);
  });
});

// ─── Anthropic client ───────────────────────────────────────────────────────

describe("createAnthropicStreamingClient", () => {
  it("yields a single NOT_IMPLEMENTED error event", async () => {
    const client = createAnthropicStreamingClient({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
    });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toHaveLength(1);
    const event = events[0] as StreamErrorEvent;
    expect(event.type).toBe("error");
    expect(event.code).toBe("NOT_IMPLEMENTED");
    expect(event.message).toContain("not yet implemented");
  });
});

// ─── Proxy client ───────────────────────────────────────────────────────────

describe("createProxyStreamingClient", () => {
  it("forwards already-normalized delta and done events and stops at done", async () => {
    const { calls } = mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({ type: "delta", content: "a" }),
          JSON.stringify({ type: "delta", content: "b" }),
          JSON.stringify({ type: "done", stopReason: "stop" }),
          JSON.stringify({ type: "delta", content: "after-done-ignored" }),
        ]),
        { status: 200 },
      ),
    );
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(
      client.streamChat([{ role: "user", content: "hi" }], [], "sys", new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "delta", content: "a" },
      { type: "delta", content: "b" },
      { type: "done", stopReason: "stop" },
    ]);

    const call = calls[0]!;
    expect(call.url).toBe("https://proxy/chat");
    const sent = JSON.parse(call.init.body as string) as { model: string; systemPrompt: string };
    expect(sent.model).toBe("gpt-4o");
    expect(sent.systemPrompt).toBe("sys");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBeUndefined();
    expect(headers["X-Api-Base-URL"]).toBeUndefined();
  });

  it("forwards tool-call lifecycle events", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({ type: "tool_call_start", id: "t1", name: "doThing" }),
          JSON.stringify({ type: "tool_call_delta", id: "t1", args: "{}" }),
          JSON.stringify({ type: "tool_call_end", id: "t1" }),
          JSON.stringify({ type: "done", stopReason: "tool_calls" }),
        ]),
        { status: 200 },
      ),
    );
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "tool_call_start", id: "t1", name: "doThing" },
      { type: "tool_call_delta", id: "t1", args: "{}" },
      { type: "tool_call_end", id: "t1" },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("sends X-Api-Key and X-Api-Base-URL headers when configured", async () => {
    const { calls } = mockFetch(() =>
      streamingResponse(sseBody([JSON.stringify({ type: "done", stopReason: "stop" })]), {
        status: 200,
      }),
    );
    const client = createProxyStreamingClient({
      chatUrl: "https://proxy/chat",
      model: "gpt-5",
      apiKey: "secret",
      baseUrl: "https://local/v1",
    });
    await collect(client.streamChat([], [], "", new AbortController().signal));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("secret");
    expect(headers["X-Api-Base-URL"]).toBe("https://local/v1");
    const sent = JSON.parse(calls[0]!.init.body as string) as { model: string };
    expect(sent.model).toBe("gpt-5");
  });

  it("stops and forwards an upstream error event", async () => {
    mockFetch(() =>
      streamingResponse(
        sseBody([
          JSON.stringify({ type: "error", message: "upstream failed", code: "500" }),
          JSON.stringify({ type: "delta", content: "never" }),
        ]),
        { status: 200 },
      ),
    );
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "upstream failed", code: "500" }]);
  });

  it("skips unparseable lines and lines without a data prefix", async () => {
    mockFetch(() =>
      streamingResponse(
        [
          "data: {bad json\n\n",
          "event: ping\n\n",
          `data: ${JSON.stringify({ type: "delta", content: "good" })}\n\n`,
          `data: ${JSON.stringify({ type: "done", stopReason: "stop" })}\n\n`,
        ].join(""),
        { status: 200 },
      ),
    );
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([
      { type: "delta", content: "good" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("ends without a done event when the body simply closes", async () => {
    mockFetch(() =>
      streamingResponse(sseBody([JSON.stringify({ type: "delta", content: "lonely" })]), {
        status: 200,
      }),
    );
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "delta", content: "lonely" }]);
  });

  it("extracts a clean message from a flat { error } JSON body on non-ok", async () => {
    mockFetch(() =>
      streamingResponse(JSON.stringify({ error: "quota exceeded" }), { status: 402 }),
    );
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "quota exceeded", code: "402" }]);
  });

  it("extracts message from a nested { error: { message } } JSON body on non-ok", async () => {
    mockFetch(() =>
      streamingResponse(JSON.stringify({ error: { message: "bad request detail" } }), {
        status: 400,
      }),
    );
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "bad request detail", code: "400" }]);
  });

  it("uses the raw body when a non-ok body is not JSON", async () => {
    mockFetch(() => streamingResponse("plain text failure", { status: 500 }));
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "plain text failure", code: "500" }]);
  });

  it("uses the raw body when JSON error has no usable message field", async () => {
    mockFetch(() => streamingResponse(JSON.stringify({ error: { type: "x" } }), { status: 500 }));
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    const event = events[0] as StreamErrorEvent;
    expect(event.type).toBe("error");
    expect(event.message).toBe(JSON.stringify({ error: { type: "x" } }));
    expect(event.code).toBe("500");
  });

  it("falls back to statusText on a non-ok empty body", async () => {
    mockFetch(() => new Response("", { status: 502, statusText: "Bad Gateway" }));
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "Bad Gateway", code: "502" }]);
  });

  it("yields an error event when reading the non-ok body text throws", async () => {
    const failingText = {
      ok: false,
      status: 504,
      statusText: "Gateway Timeout",
      text: () => Promise.reject(new Error("read fail")),
    } as unknown as Response;
    mockFetch(() => failingText);
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "Gateway Timeout", code: "504" }]);
  });

  it("yields a network error event when fetch rejects with a non-abort error", async () => {
    mockFetch(() => Promise.reject(new Error("dns fail")));
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "Network error: dns fail" }]);
  });

  it("yields a cancelled done event when fetch rejects with an AbortError", async () => {
    mockFetch(() => Promise.reject(abortError("aborted")));
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "done", stopReason: "cancelled" }]);
  });

  it("yields an error event when the response has no body", async () => {
    const noBody = { ok: true, body: null } as unknown as Response;
    mockFetch(() => noBody);
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "No response body" }]);
  });

  it("yields a stream error event when reading the body throws mid-stream", async () => {
    const reader = {
      read: () => Promise.reject(new Error("proxy reader exploded")),
      cancel: () => Promise.resolve(),
    };
    const fakeResponse = {
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response;
    mockFetch(() => fakeResponse);
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "error", message: "Stream error: proxy reader exploded" }]);
  });

  it("yields a cancelled done event when reading the body throws an AbortError mid-stream", async () => {
    const reader = {
      read: () => Promise.reject(abortError("proxy abort")),
      cancel: () => Promise.resolve(),
    };
    const fakeResponse = {
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response;
    mockFetch(() => fakeResponse);
    const client = createProxyStreamingClient({ chatUrl: "https://proxy/chat" });
    const events = await collect(client.streamChat([], [], "", new AbortController().signal));
    expect(events).toEqual([{ type: "done", stopReason: "cancelled" }]);
  });
});
