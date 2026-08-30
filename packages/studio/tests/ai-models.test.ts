/**
 * Tests for src/services/ai-models.ts — the shared /models fetch: URL derivation from the
 * platform's chat URL, credential header forwarding, the module-wide cache + invalidation, and
 * error surfacing.
 */
import { clearSeededSettings, installMockPlatform, seedSettings } from "./harness";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  ensureProxyProbe,
  fetchAvailableModels,
  getProxyDefaultModel,
  hasAiCredentials,
  aiConnection,
  cachedModels,
  installProbeRefresh,
  modelContextWindow,
  modelToolSupport,
  PROBE_STALE_MS,
  refreshStaleProbe,
  resetModelCache,
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
  localStorage.clear();
  clearSeededSettings();
  resetModelCache();
  fetchCalls.length = 0;
  fetchImpl = async () =>
    Response.json({ models: [{ id: "gpt-4o" }, { id: "x", name: "Model X" }] }, { status: 200 });
});

afterEach(() => {
  setSystemTime();
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

    seedSettings({ "jx.ai.openaiKey": "sk-stored", "jx.ai.baseUrl": "http://localhost:11434/v1" });
    await fetchAvailableModels({ force: true });
    headers = fetchCalls.at(-1)!.init!.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-stored");
    expect(headers["X-Api-Base-URL"]).toBe("http://localhost:11434/v1");
  });

  test("explicit credentials win over stored ones", async () => {
    seedSettings({ "jx.ai.openaiKey": "sk-stored" });
    await fetchAvailableModels({
      credentials: { apiKey: "sk-draft", baseUrl: "http://draft/v1" },
    });
    const headers = fetchCalls.at(-1)!.init!.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-draft");
    expect(headers["X-Api-Base-URL"]).toBe("http://draft/v1");
  });

  /**
   * The cache used to be unkeyed, and two callers with different credentials wrote to it: the
   * credentials form fetches with the drafts being edited, the capability probe with what is
   * stored. Whichever landed last won, so the chat composer's picker could list one provider's
   * catalogue while another was configured — which is what a user saw after setting a provider up.
   */
  test("a list fetched under one credential pair is not served for another", async () => {
    const draft = { apiKey: "sk-draft", baseUrl: "http://draft/v1" };
    const other = { apiKey: "sk-other", baseUrl: "http://other/v1" };
    await fetchAvailableModels({ credentials: draft });
    expect(fetchCalls).toHaveLength(1);

    // Same credentials: served from the cache.
    await fetchAvailableModels({ credentials: draft });
    expect(fetchCalls).toHaveLength(1);
    expect(cachedModels(draft)).not.toBeNull();

    // Different credentials: a miss, not the other provider's list.
    expect(cachedModels(other)).toBeNull();
    await fetchAvailableModels({ credentials: other });
    expect(fetchCalls).toHaveLength(2);
    expect(cachedModels(draft)).toBeNull();
  });

  test("changing the stored credentials drops the cache", async () => {
    await fetchAvailableModels();
    expect(cachedModels(aiConnection())).not.toBeNull();
    seedSettings({ "jx.ai.openaiKey": "sk-new" });
    expect(cachedModels(aiConnection())).toBeNull();
  });

  test("caches until invalidated; force bypasses the cache", async () => {
    await fetchAvailableModels();
    await fetchAvailableModels();
    expect(fetchCalls).toHaveLength(1);

    await fetchAvailableModels({ force: true });
    expect(fetchCalls).toHaveLength(2);

    resetModelCache();
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
    resetModelCache();
    expect(isProxyConfigured()).toBe(false);
    expect(getProxyDefaultModel()).toBe("");
  });
});

describe("hasAiCredentials", () => {
  test("is true for a stored key OR a backend that holds its own", async () => {
    expect(hasAiCredentials()).toBe(false);

    seedSettings({ "jx.ai.openaiKey": "sk-stored" });
    expect(hasAiCredentials()).toBe(true);

    // Managed platforms (cloud Workers AI) unlock with no local key at all.
    localStorage.clear();
    clearSeededSettings();
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
    resetModelCache();
    expect(isManagedProxy()).toBe(false);
    ensureProxyProbe();
    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect(isManagedProxy()).toBe(true);
  });
});

describe("model capabilities", () => {
  /* The backend has reported toolSupport all along and the ingest mapped {id, name} only, so a
     Workers AI model that cannot call tools was indistinguishable from one that can. */
  test("ingest keeps toolSupport and contextWindow, omitting what the backend did not send", async () => {
    fetchImpl = async () =>
      Response.json(
        {
          models: [
            { id: "@cf/meta/llama-4", contextWindow: 128_000, toolSupport: true },
            { id: "@cf/tiny/chat", contextWindow: 4096, toolSupport: false },
            { id: "gpt-4o", name: "GPT-4o" },
          ],
        },
        { status: 200 },
      );
    const models = await fetchAvailableModels();

    expect(models[0]).toEqual({
      contextWindow: 128_000,
      id: "@cf/meta/llama-4",
      name: "@cf/meta/llama-4",
      toolSupport: true,
    });
    expect(models[1]!.toolSupport).toBe(false);
    // Silence stays silence: a BYOK provider reports neither, and neither key is invented.
    expect(models[2]).toEqual({ id: "gpt-4o", name: "GPT-4o" });
    expect("toolSupport" in models[2]!).toBe(false);
    expect("contextWindow" in models[2]!).toBe(false);
  });

  test("modelToolSupport and modelContextWindow read the cache, and undefined is not false", async () => {
    fetchImpl = async () =>
      Response.json(
        {
          models: [
            { id: "@cf/tiny/chat", contextWindow: 4096, toolSupport: false },
            { id: "gpt-4o" },
          ],
        },
        { status: 200 },
      );
    await fetchAvailableModels();

    expect(modelToolSupport("@cf/tiny/chat")).toBe(false);
    expect(modelContextWindow("@cf/tiny/chat")).toBe(4096);
    // The backend said nothing about gpt-4o, and nothing is not "no tools".
    expect(modelToolSupport("gpt-4o")).toBeUndefined();
    expect(modelContextWindow("gpt-4o")).toBeUndefined();
    // A model the catalogue never listed at all.
    expect(modelToolSupport("my-custom-model")).toBeUndefined();

    resetModelCache();
    expect(modelToolSupport("@cf/tiny/chat")).toBeUndefined();
  });

  test("a capability is readable whichever credentials keyed the list", async () => {
    /* The keyed reader exists because SHOWING one provider's catalogue under another's key is a lie
       about what is available. "What did the backend say about this id" is not that question. */
    const draft = { apiKey: "sk-draft", baseUrl: "http://draft/v1" };
    fetchImpl = async () =>
      Response.json({ models: [{ id: "@cf/tiny/chat", toolSupport: false }] }, { status: 200 });
    await fetchAvailableModels({ credentials: draft });

    expect(cachedModels(aiConnection())).toBeNull();
    expect(modelToolSupport("@cf/tiny/chat")).toBe(false);
  });
});

describe("probe staleness", () => {
  /** Settle a managed probe and report how many fetches that took. */
  async function settleManagedProbe() {
    fetchImpl = async () =>
      Response.json({ models: [], configured: true, managed: true }, { status: 200 });
    ensureProxyProbe();
    await flush();
    return fetchCalls.length;
  }

  /** Move the clock past the staleness window without waiting ten real minutes. */
  function age(ms: number) {
    setSystemTime(new Date(Date.now() + ms));
  }

  test("a stale probe re-runs on window focus", async () => {
    /* The probe is one-shot and only the settings subscription re-arms it — which never fires for a
       HOSTED grant, because nothing about it is stored in this browser. A grant that lapsed
       mid-session therefore left every gate showing the reading it took at boot. */
    setSystemTime(new Date("2026-08-29T12:00:00Z"));
    expect(await settleManagedProbe()).toBe(1);

    age(PROBE_STALE_MS + 1);
    window.dispatchEvent(new Event("focus"));
    await flush();

    expect(fetchCalls).toHaveLength(2);
    expect(isManagedProxy()).toBe(true);
  });

  test("a fresh probe is left alone on focus", async () => {
    setSystemTime(new Date("2026-08-29T12:00:00Z"));
    expect(await settleManagedProbe()).toBe(1);

    age(PROBE_STALE_MS - 1000);
    window.dispatchEvent(new Event("focus"));
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(refreshStaleProbe()).toBe(false);
  });

  test("an unmanaged backend is never re-probed on focus, however old the reading", async () => {
    // A BYOK reading changes only when the stored key does, and the settings subscription owns that.
    setSystemTime(new Date("2026-08-29T12:00:00Z"));
    fetchImpl = async () => Response.json({ models: [], configured: true }, { status: 200 });
    ensureProxyProbe();
    await flush();
    expect(fetchCalls).toHaveLength(1);

    age(PROBE_STALE_MS * 10);
    expect(refreshStaleProbe()).toBe(false);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchCalls).toHaveLength(1);
  });

  test("a probe that never settled is not treated as stale", async () => {
    setSystemTime(new Date("2026-08-29T12:00:00Z"));
    resetModelCache();
    age(PROBE_STALE_MS * 10);
    expect(refreshStaleProbe()).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  test("installProbeRefresh is idempotent and a no-op with no window", async () => {
    /* The module installs its own listener at evaluation; a second call must not double-register,
       and a bare-`bun` runner with no DOM must still be able to import this module. */
    setSystemTime(new Date("2026-08-29T12:00:00Z"));
    installProbeRefresh();
    expect(await settleManagedProbe()).toBe(1);
    age(PROBE_STALE_MS + 1);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchCalls).toHaveLength(2); // One re-probe, not two.

    const realWindow = globalThis.window;
    try {
      (globalThis as Record<string, unknown>).window = undefined;
      expect(() => installProbeRefresh()).not.toThrow();
    } finally {
      (globalThis as Record<string, unknown>).window = realWindow;
    }
  });
});
