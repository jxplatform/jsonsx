/**
 * Tests for src/services/ai-models.ts — the shared /models fetch: URL derivation from the
 * platform's chat URL, credential header forwarding, the module-wide cache + invalidation, and
 * error surfacing.
 */
import { installMockPlatform } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  ensureProxyProbe,
  fetchAvailableModels,
  getProxyDefaultModel,
  hasAiCredentials,
  invalidateModelCache,
  isManagedProxy,
  isProxyConfigured,
} from "../src/services/ai-models";

installMockPlatform();

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  Response.json({ models: [] }, { status: 200 });
const fetchCalls: { url: string; init?: RequestInit | undefined }[] = [];
(globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) => {
  fetchCalls.push({ init, url });
  return fetchImpl(url, init);
};

/** Let the probe's promise chain settle. */
async function flush(turns = 4) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

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

describe("proxy state flags", () => {
  test("captures configured/managed/defaultModel from the response", async () => {
    fetchImpl = async () =>
      Response.json(
        {
          models: [{ id: "@cf/meta/llama-4" }],
          configured: true,
          managed: true,
          defaultModel: "@cf/meta/llama-4",
        },
        { status: 200 },
      );
    await fetchAvailableModels();
    expect(isProxyConfigured()).toBe(true);
    expect(isManagedProxy()).toBe(true);
    expect(getProxyDefaultModel()).toBe("@cf/meta/llama-4");
  });

  test("defaults to unconfigured and resets on invalidation", async () => {
    fetchImpl = async () => Response.json({ models: [] }, { status: 200 });
    await fetchAvailableModels();
    expect(isProxyConfigured()).toBe(false);
    expect(isManagedProxy()).toBe(false);

    fetchImpl = async () => Response.json({ models: [], configured: true }, { status: 200 });
    await fetchAvailableModels({ force: true });
    expect(isProxyConfigured()).toBe(true);
    invalidateModelCache();
    expect(isProxyConfigured()).toBe(false);
    expect(getProxyDefaultModel()).toBe("");
  });
});

describe("hasAiCredentials", () => {
  test("is true for a stored key OR a backend that holds its own", async () => {
    expect(hasAiCredentials()).toBe(false);

    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-stored");
    expect(hasAiCredentials()).toBe(true);

    // Managed platforms (cloud Workers AI) unlock with no local key at all.
    globalThis.localStorage.clear();
    fetchImpl = async () =>
      Response.json({ models: [], configured: true, managed: true }, { status: 200 });
    await fetchAvailableModels({ force: true });
    expect(hasAiCredentials()).toBe(true);
  });
});

describe("ensureProxyProbe", () => {
  test("fetches once for concurrent callers and notifies every listener", async () => {
    fetchImpl = async () =>
      Response.json({ models: [], configured: false, managed: true }, { status: 200 });
    const seen: string[] = [];
    ensureProxyProbe(() => seen.push("a"));
    ensureProxyProbe(() => seen.push("b"));
    ensureProxyProbe(() => seen.push("a")); // Same host re-registering must not double-notify.
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(seen.toSorted()).toEqual(["a", "a", "b"]);
    expect(isManagedProxy()).toBe(true);
  });

  test("swallows probe failure, leaving the gate closed", async () => {
    fetchImpl = async () => new Response("nope", { status: 500 });
    let settled = false;
    ensureProxyProbe(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(true);
    expect(isManagedProxy()).toBe(false);
    expect(isProxyConfigured()).toBe(false);
  });

  test("invalidation re-arms the probe so managed state can be rediscovered", async () => {
    fetchImpl = async () =>
      Response.json({ models: [], configured: false, managed: true }, { status: 200 });
    ensureProxyProbe();
    await flush();
    expect(fetchCalls).toHaveLength(1);

    // Already settled: a repeat call is a no-op.
    ensureProxyProbe();
    await flush();
    expect(fetchCalls).toHaveLength(1);

    /* Saving/clearing BYOK credentials invalidates the cache, which clears the managed flag. If the
       probe stayed settled the gate would never learn managed mode again — the Connect Cloudflare
       option would vanish until a full page reload. */
    invalidateModelCache();
    expect(isManagedProxy()).toBe(false);
    ensureProxyProbe();
    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect(isManagedProxy()).toBe(true);
  });
});
