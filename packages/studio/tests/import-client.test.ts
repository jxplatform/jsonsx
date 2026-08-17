/**
 * The shared NDJSON import client: request shaping (headers/body), line parsing across chunk
 * boundaries, heartbeat tolerance, and terminal done/error handling.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { streamImport } from "../src/services/import-client";
import type { ImportProgressEvent, ImportSiteOptions } from "../src/types";

const OPTS: ImportSiteOptions = {
  url: "https://clone.example/",
  name: "Clone",
  directory: "clone",
  depth: 1,
  maxPages: 20,
  aiComponents: true,
  apiKey: "sk-test",
  baseUrl: "http://llm.local/v1",
  model: "test-model",
};

function ndjsonResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const fetchMock = mock(impl);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("streamImport", () => {
  test("posts the request with credential headers and resolves the done line", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(
        ndjsonResponse([
          '{"type":"progress","phase":"capture","message":"Capturing...","current":1,"total":5}\n',
          '{"type":"heartbeat"}\n',
          '{"type":"done","root":"/projects/clone","config":{"name":"Clone"}}\n',
        ]),
      ),
    );

    const events: ImportProgressEvent[] = [];
    const result = await streamImport("/__studio/import-site", OPTS, (e) => events.push(e));

    expect(result).toEqual({ root: "/projects/clone", config: { name: "Clone" } });
    // Heartbeats are swallowed; progress is forwarded with counts.
    expect(events).toEqual([{ phase: "capture", message: "Capturing...", current: 1, total: 5 }]);

    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("/__studio/import-site");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-test");
    expect(headers["X-Api-Base-URL"]).toBe("http://llm.local/v1");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      url: "https://clone.example/",
      directory: "clone",
      depth: 1,
      maxPages: 20,
      aiComponents: true,
      aiModel: "test-model",
    });
  });

  test("omits credential headers when no key is set", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(ndjsonResponse(['{"type":"done","root":"/p","config":{}}\n'])),
    );
    const bare: ImportSiteOptions = {
      url: "https://x.example",
      name: "X",
      directory: "x",
      depth: 0,
      maxPages: 1,
      aiComponents: false,
    };
    await streamImport("/e", bare, () => {});
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBeUndefined();
    expect(headers["X-Api-Base-URL"]).toBeUndefined();
  });

  test("reassembles lines split across chunks", async () => {
    stubFetch(() =>
      Promise.resolve(
        ndjsonResponse([
          '{"type":"progress","phase":"sty',
          'les","message":"Diffing..."}\n{"type":"done","ro',
          'ot":"/p","config":{"name":"Split"}}\n',
        ]),
      ),
    );
    const events: ImportProgressEvent[] = [];
    const result = await streamImport("/e", OPTS, (e) => events.push(e));
    expect(events).toEqual([{ phase: "styles", message: "Diffing..." }]);
    expect(result.config).toEqual({ name: "Split" } as never);
  });

  /*
   * Tolerating a garbled line is right; hiding it is not. Before the counter, an import that
   * dropped half its progress lines finished looking clean and the user never learned which pages
   * were skipped.
   */
  test("counts unreadable lines and reports them once at the end", async () => {
    stubFetch(() =>
      Promise.resolve(
        ndjsonResponse([
          '{"type":"progress","phase":"crawl","message":"Fetching..."}\n',
          "{not json at all\n",
          "}{\n",
          '{"type":"done","root":"/p","config":{"name":"Partial"}}\n',
        ]),
      ),
    );
    const events: ImportProgressEvent[] = [];
    await streamImport("/e", OPTS, (e) => events.push(e));
    expect(events).toEqual([
      { phase: "crawl", message: "Fetching..." },
      {
        phase: "warning",
        message:
          "2 progress lines could not be read and were skipped — the import may be missing steps.",
      },
    ]);
  });

  test("a clean stream reports no warning", async () => {
    stubFetch(() =>
      Promise.resolve(
        ndjsonResponse([
          '{"type":"heartbeat"}\n',
          '{"type":"done","root":"/p","config":{"name":"Clean"}}\n',
        ]),
      ),
    );
    const events: ImportProgressEvent[] = [];
    await streamImport("/e", OPTS, (e) => events.push(e));
    expect(events).toEqual([]);
  });

  test("one unreadable line is reported in the singular", async () => {
    stubFetch(() =>
      Promise.resolve(
        ndjsonResponse(["oops\n", '{"type":"done","root":"/p","config":{"name":"One"}}\n']),
      ),
    );
    const events: ImportProgressEvent[] = [];
    await streamImport("/e", OPTS, (e) => events.push(e));
    expect(events[0]?.message).toBe(
      "1 progress line could not be read and was skipped — the import may be missing steps.",
    );
  });

  test("rejects on a terminal error line", async () => {
    stubFetch(() =>
      Promise.resolve(
        ndjsonResponse([
          '{"type":"progress","phase":"launch","message":"Launching browser..."}\n',
          '{"type":"error","error":"Chrome not found"}\n',
        ]),
      ),
    );
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(streamImport("/e", OPTS, () => {})).rejects.toThrow("Chrome not found");
  });

  test("rejects on a non-OK response with the JSON error body", async () => {
    stubFetch(() =>
      Promise.resolve(Response.json({ error: "url and directory are required" }, { status: 400 })),
    );
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(streamImport("/e", OPTS, () => {})).rejects.toThrow(
      "url and directory are required",
    );
  });

  test("rejects when the stream ends without a done line", async () => {
    stubFetch(() =>
      Promise.resolve(
        ndjsonResponse(['{"type":"progress","phase":"capture","message":"Capturing..."}\n']),
      ),
    );
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(streamImport("/e", OPTS, () => {})).rejects.toThrow(
      "Import stream ended without a result",
    );
  });

  test("forwards the abort signal to fetch", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(ndjsonResponse(['{"type":"done","root":"/p","config":{}}\n'])),
    );
    const controller = new AbortController();
    await streamImport("/e", OPTS, () => {}, controller.signal);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
  });
});
