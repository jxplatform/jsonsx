/**
 * The /__studio/import-site endpoint: request validation, NDJSON progress streaming, LLM-key
 * threading from headers, the missing-key warning path, destination gating, and error reporting.
 * The @jxsuite/import pipeline is mocked — no browser or network is touched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface CapturedImportCall {
  options: Record<string, unknown>;
  onProgress: ((e: Record<string, unknown>) => void) | undefined;
}

let importCalls: CapturedImportCall[] = [];
let importBehavior: (call: CapturedImportCall) => Promise<Record<string, unknown>>;

const importSite = mock(
  (options: Record<string, unknown>, onProgress?: (e: Record<string, unknown>) => void) => {
    const call: CapturedImportCall = { options, onProgress };
    importCalls.push(call);
    return importBehavior(call);
  },
);
void mock.module("@jxsuite/import/run", () => ({ importSite }));

const { handleImportApi } = await import("../src/import-api.ts");

const ROOT = resolve(tmpdir(), `jx-import-api-test-${Date.now()}`);

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  const url = new URL("http://localhost/__studio/import-site");
  const req = new Request(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  return { req, url };
}

const apiOptions = {
  resolveDest: (dir: string) => {
    if (dir.startsWith("..")) {
      throw new Error("Path outside project root");
    }
    return resolve(ROOT, dir);
  },
  toRoot: (dest: string) => `root:${dest}`,
};

async function waitUntil(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (cond()) {
      return;
    }
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  }
}

async function readLines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  importCalls = [];
  importSite.mockClear();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  rmSync(ROOT, { force: true, recursive: true });
  // Default behavior: two progress events, then a successful result with a real project.json.
  importBehavior = (call) => {
    const outDir = call.options.outDir as string;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "project.json"), JSON.stringify({ name: "Imported Site" }));
    call.onProgress?.({ phase: "capture", message: "Capturing page..." });
    call.onProgress?.({ phase: "emit", message: "Wrote 3 files", current: 3, total: 3 });
    return Promise.resolve({ outDir, pages: [], fileCount: 3, verify: null, warnings: [] });
  };
});

describe("routing and validation", () => {
  test("returns null for non-matching routes", async () => {
    const url = new URL("http://localhost/__studio/other");
    const res = await handleImportApi(new Request(url, { method: "POST" }), url, apiOptions);
    expect(res).toBeNull();
    const getUrl = new URL("http://localhost/__studio/import-site");
    const getRes = await handleImportApi(
      new Request(getUrl, { method: "GET" }),
      getUrl,
      apiOptions,
    );
    expect(getRes).toBeNull();
  });

  test("rejects a missing url or directory", async () => {
    const { req, url } = makeRequest({ url: "https://x.example" });
    const res = await handleImportApi(req, url, apiOptions);
    expect(res?.status).toBe(400);
  });

  test("rejects a non-http(s) url", async () => {
    const { req, url } = makeRequest({ directory: "site", url: "file:///etc/passwd" });
    const res = await handleImportApi(req, url, apiOptions);
    expect(res?.status).toBe(400);
  });

  test("rejects an invalid JSON body", async () => {
    const reqUrl = new URL("http://localhost/__studio/import-site");
    const req = new Request(reqUrl, { body: "{nope", method: "POST" });
    const res = await handleImportApi(req, reqUrl, apiOptions);
    expect(res?.status).toBe(400);
  });

  test("rejects destinations the host disallows", async () => {
    const { req, url } = makeRequest({ directory: "../escape", url: "https://x.example" });
    const res = await handleImportApi(req, url, apiOptions);
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toContain("outside");
    expect(importSite).not.toHaveBeenCalled();
  });
});

describe("streaming", () => {
  test("streams progress lines and a terminal done line with root and config", async () => {
    const { req, url } = makeRequest({
      directory: "imported",
      url: "https://x.example",
      depth: 2,
      maxPages: 9,
    });
    const res = await handleImportApi(req, url, apiOptions);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("application/x-ndjson");

    const lines = await readLines(res!);
    expect(lines[0]).toEqual({ type: "progress", phase: "capture", message: "Capturing page..." });
    expect(lines[1]).toEqual({
      type: "progress",
      phase: "emit",
      message: "Wrote 3 files",
      current: 3,
      total: 3,
    });
    const done = lines.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.root).toBe(`root:${resolve(ROOT, "imported")}`);
    expect(done.config).toEqual({ name: "Imported Site" });

    const opts = importCalls[0]!.options;
    expect(opts.url).toBe("https://x.example");
    expect(opts.outDir).toBe(resolve(ROOT, "imported"));
    expect(opts.maxDepth).toBe(2);
    expect(opts.maxPages).toBe(9);
    expect(opts.ai).toBe(false);
  });

  test("clamps depth and maxPages to sane bounds", async () => {
    const { req, url } = makeRequest({
      directory: "clamped",
      url: "https://x.example",
      depth: 99,
      maxPages: 9999,
    });
    const res = await handleImportApi(req, url, apiOptions);
    await res?.text();
    const opts = importCalls[0]!.options;
    expect(opts.maxDepth).toBe(5);
    expect(opts.maxPages).toBe(100);
  });

  test("threads the header API key, base URL, and model into the ai options", async () => {
    const { req, url } = makeRequest(
      {
        directory: "with-ai",
        url: "https://x.example",
        aiComponents: true,
        aiModel: "test-model",
      },
      { "X-Api-Key": "sk-header", "X-Api-Base-URL": "http://llm.local/v1" },
    );
    const res = await handleImportApi(req, url, apiOptions);
    await res?.text();
    expect(importCalls[0]!.options.ai).toEqual({
      apiKey: "sk-header",
      baseUrl: "http://llm.local/v1",
      model: "test-model",
    });
  });

  test("accepts an Authorization: Bearer token as the API key", async () => {
    const { req, url } = makeRequest(
      { directory: "bearer-ai", url: "https://x.example", aiComponents: true },
      { Authorization: "Bearer sk-bearer" },
    );
    const res = await handleImportApi(req, url, apiOptions);
    await res?.text();
    const ai = importCalls[0]!.options.ai as { apiKey: string };
    expect(ai.apiKey).toBe("sk-bearer");
  });

  test("falls back to the OPENAI_API_KEY env var", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    const { req, url } = makeRequest({
      directory: "env-ai",
      url: "https://x.example",
      aiComponents: true,
    });
    const res = await handleImportApi(req, url, apiOptions);
    await res?.text();
    const ai = importCalls[0]!.options.ai as { apiKey: string };
    expect(ai.apiKey).toBe("sk-env");
  });

  test("warns and skips the AI pass when no key resolves", async () => {
    const { req, url } = makeRequest({
      directory: "no-key",
      url: "https://x.example",
      aiComponents: true,
    });
    const res = await handleImportApi(req, url, apiOptions);
    const lines = await readLines(res!);
    expect(lines.some((l) => String(l.message).includes("no API key"))).toBe(true);
    expect(importCalls[0]!.options.ai).toBe(false);
    expect(lines.at(-1)!.type).toBe("done");
  });

  test("reports pipeline failures as a terminal error line", async () => {
    importBehavior = () => Promise.reject(new Error("Chrome not found"));
    const { req, url } = makeRequest({ directory: "boom", url: "https://x.example" });
    const res = await handleImportApi(req, url, apiOptions);
    expect(res?.status).toBe(200);
    const lines = await readLines(res!);
    expect(lines.at(-1)).toEqual({ type: "error", error: "Chrome not found" });
  });

  test("stops writing once the client cancels the stream", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let finished = false;
    importBehavior = async (call) => {
      const outDir = call.options.outDir as string;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "project.json"), "{}");
      call.onProgress?.({ phase: "capture", message: "first" });
      await gate;
      // The first post-cancel write trips the enqueue failure and marks the stream closed;
      // The second returns early on the closed flag. Neither may throw into the pipeline.
      call.onProgress?.({ phase: "late", message: "after-cancel" });
      call.onProgress?.({ phase: "late", message: "after-close" });
      finished = true;
      return { fileCount: 0, outDir, pages: [], verify: null, warnings: [] };
    };

    const { req, url } = makeRequest({ directory: "cancelled", url: "https://x.example" });
    const res = await handleImportApi(req, url, apiOptions);
    const reader = res!.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("first");
    await reader.cancel();
    release!();

    await waitUntil(() => finished);
    expect(finished).toBe(true);
  });

  test("emits heartbeat lines while a phase is silent", async () => {
    const realSetInterval = globalThis.setInterval;
    let heartbeat: (() => void) | undefined;
    globalThis.setInterval = ((cb: () => void, ms?: number) => {
      const timer = realSetInterval(() => {}, ms);
      if (ms === 15_000) {
        heartbeat = cb;
      }
      return timer;
    }) as unknown as typeof setInterval;
    try {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      importBehavior = async (call) => {
        const outDir = call.options.outDir as string;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "project.json"), "{}");
        await gate;
        return { fileCount: 0, outDir, pages: [], verify: null, warnings: [] };
      };

      const { req, url } = makeRequest({ directory: "silent", url: "https://x.example" });
      const res = await handleImportApi(req, url, apiOptions);
      await waitUntil(() => heartbeat !== undefined);
      heartbeat!();
      release!();
      const lines = await readLines(res!);
      expect(lines[0]).toEqual({ type: "heartbeat" });
      expect(lines.at(-1)!.type).toBe("done");
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test("forwards the request abort signal into the pipeline", async () => {
    let seenSignal: AbortSignal | undefined;
    importBehavior = (call) => {
      seenSignal = call.options.signal as AbortSignal;
      return Promise.resolve({
        outDir: call.options.outDir as string,
        pages: [],
        fileCount: 0,
        verify: null,
        warnings: [],
      });
    };
    // Provide a project.json so the done line can still be written.
    const dest = resolve(ROOT, "signal");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "project.json"), "{}");

    const { req, url } = makeRequest({ directory: "signal", url: "https://x.example" });
    const res = await handleImportApi(req, url, apiOptions);
    await res?.text();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("the verify pass and the run summary", () => {
  test("verify is off unless asked for", async () => {
    const { req, url } = makeRequest({ directory: "site", url: "https://x.example" });
    await readLines((await handleImportApi(req, url, apiOptions))!);
    expect(importCalls[0]!.options.verify).toBe(false);
  });

  test("verify is forwarded with a clamped threshold", async () => {
    const { req, url } = makeRequest({
      directory: "site",
      url: "https://x.example",
      verify: true,
      verifyThreshold: 0.3,
    });
    await readLines((await handleImportApi(req, url, apiOptions))!);
    expect(importCalls[0]!.options.verify).toEqual({ threshold: 0.3 });

    for (const [sent, expected] of [
      [5, 1],
      [-2, 0.01],
      ["nonsense", 0.15],
      [undefined, 0.15],
    ] as const) {
      importCalls = [];
      const next = makeRequest({
        directory: "site",
        url: "https://x.example",
        verify: true,
        ...(sent === undefined ? {} : { verifyThreshold: sent }),
      });
      await readLines((await handleImportApi(next.req, next.url, apiOptions))!);
      expect(importCalls[0]!.options.verify).toEqual({ threshold: expected });
    }
  });

  test("the done line carries what the run found", async () => {
    /* The pipeline computed the page list, the file count, the warnings and the fidelity scores,
       and this endpoint used to discard every one of them: the caller learned that an import had
       happened and nothing about what it found. */
    importBehavior = (call) => {
      const outDir = call.options.outDir as string;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "project.json"), JSON.stringify({ name: "Imported Site" }));
      return Promise.resolve({
        fileCount: 14,
        outDir,
        pages: [{ nodeCount: 120, route: "pages/index.json", title: "Home" }],
        verify: {
          averageFidelity: 84,
          pages: [{ fidelity: 61, route: "pages/pricing.json" }],
          reportDir: `${outDir}/verify`,
        },
        warnings: ["3 assets failed to download"],
      });
    };

    const { req, url } = makeRequest({
      directory: "site",
      url: "https://x.example",
      verify: true,
    });
    const lines = await readLines((await handleImportApi(req, url, apiOptions))!);
    const done = lines.at(-1)!;

    expect(done.type).toBe("done");
    expect(done.result).toMatchObject({
      fileCount: 14,
      pages: [{ nodeCount: 120, route: "pages/index.json", title: "Home" }],
      warnings: ["3 assets failed to download"],
    });
    expect((done.result as { verify: { averageFidelity: number } }).verify.averageFidelity).toBe(
      84,
    );
  });

  test("a run with no verify pass omits the key rather than sending null", async () => {
    const { req, url } = makeRequest({ directory: "site", url: "https://x.example" });
    const lines = await readLines((await handleImportApi(req, url, apiOptions))!);
    const result = lines.at(-1)!.result as Record<string, unknown>;
    expect(result).toMatchObject({ fileCount: 3, pages: [], warnings: [] });
    expect(result).not.toHaveProperty("verify");
  });
});
