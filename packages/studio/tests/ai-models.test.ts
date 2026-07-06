/**
 * Tests for src/services/ai-models.ts — the shared /models fetch: URL derivation from the
 * platform's chat URL, credential header forwarding, the module-wide cache + invalidation, and
 * error surfacing.
 */
import { installMockPlatform } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { fetchAvailableModels, invalidateModelCache } from "../src/services/ai-models";

installMockPlatform();

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  Response.json({ models: [] }, { status: 200 });
const fetchCalls: { url: string; init?: RequestInit | undefined }[] = [];
(globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) => {
  fetchCalls.push({ init, url });
  return fetchImpl(url, init);
};

beforeEach(() => {
  globalThis.localStorage.clear();
  invalidateModelCache();
  fetchCalls.length = 0;
  fetchImpl = async () =>
    Response.json({ models: [{ id: "gpt-4o" }, { id: "x", name: "Model X" }] }, { status: 200 });
});

describe("fetchAvailableModels", () => {
  test("derives /models from the chat URL and maps ids/names", async () => {
    const models = await fetchAvailableModels();
    expect(fetchCalls.at(-1)!.url).toBe("/__mock/ai/models");
    expect(models).toEqual([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "x", name: "Model X" },
    ]);
  });

  test("forwards stored credentials as headers, omitting empty ones", async () => {
    await fetchAvailableModels();
    let headers = fetchCalls.at(-1)!.init!.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBeUndefined();
    expect(headers["X-Api-Base-URL"]).toBeUndefined();

    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-stored");
    globalThis.localStorage.setItem("jx.ai.baseUrl", "http://localhost:11434/v1");
    await fetchAvailableModels({ force: true });
    headers = fetchCalls.at(-1)!.init!.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-stored");
    expect(headers["X-Api-Base-URL"]).toBe("http://localhost:11434/v1");
  });

  test("explicit overrides win over stored credentials", async () => {
    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-stored");
    await fetchAvailableModels({ apiKey: "sk-draft", baseUrl: "http://draft/v1" });
    const headers = fetchCalls.at(-1)!.init!.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-draft");
    expect(headers["X-Api-Base-URL"]).toBe("http://draft/v1");
  });

  test("caches until invalidated; force bypasses the cache", async () => {
    await fetchAvailableModels();
    await fetchAvailableModels();
    expect(fetchCalls).toHaveLength(1);

    await fetchAvailableModels({ force: true });
    expect(fetchCalls).toHaveLength(2);

    invalidateModelCache();
    await fetchAvailableModels();
    expect(fetchCalls).toHaveLength(3);
  });

  test("throws on a failed response and does not cache the failure", async () => {
    fetchImpl = async () => new Response("nope", { status: 500 });
    expect(fetchAvailableModels()).rejects.toThrow("HTTP 500");

    fetchImpl = async () => Response.json({ models: [{ id: "ok" }] }, { status: 200 });
    const models = await fetchAvailableModels();
    expect(models).toEqual([{ id: "ok", name: "ok" }]);
  });

  test("tolerates a payload without a models array", async () => {
    fetchImpl = async () => Response.json({}, { status: 200 });
    expect(await fetchAvailableModels()).toEqual([]);
  });
});
