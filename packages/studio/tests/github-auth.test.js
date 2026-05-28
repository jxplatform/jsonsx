import "./with-dom.js";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map();
  globalThis.localStorage = /** @type {any} */ ({
    getItem: (/** @type {string} */ k) => store.get(k) ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => store.set(k, v),
    removeItem: (/** @type {string} */ k) => store.delete(k),
    clear: () => store.clear(),
  });
}

const STORAGE_KEY = "jx_github_token";

/** @type {{ ok?: boolean; json: unknown; status?: number }[]} */
let mockFetchResponses = [];
/** @type {{ url: string; opts: any }[]} */
let mockFetchCalls = [];
const originalFetch = globalThis.fetch;

/** @param {{ ok?: boolean; json: unknown; status?: number }[]} responses */
function setupFetch(responses) {
  mockFetchResponses = [...responses];
  mockFetchCalls = [];
  // @ts-ignore
  globalThis.fetch = async (/** @type {any} */ url, /** @type {any} */ opts) => {
    mockFetchCalls.push({ url: String(url), opts });
    const next = mockFetchResponses.shift();
    if (!next) throw new Error(`Unexpected fetch to ${url}`);
    return {
      ok: next.ok ?? true,
      json: async () => next.json,
      status: next.status ?? 200,
    };
  };
}

let _dialogDoneFn = null;

mock.module("../src/ui/layers.js", () => ({
  showDialog: (/** @type {any} */ fn) => {
    return new Promise((resolve) => {
      _dialogDoneFn = resolve;
      fn((/** @type {any} */ val) => resolve(val));
    });
  },
  showConfirmDialog: async () => true,
}));

const { getGithubToken, clearGithubToken, authenticateGithub } =
  await import("../src/github/github-auth.js");

describe("getGithubToken", () => {
  beforeEach(() => localStorage.removeItem(STORAGE_KEY));

  test("returns null when no token stored", () => {
    expect(getGithubToken()).toBeNull();
  });

  test("returns stored token", () => {
    localStorage.setItem(STORAGE_KEY, "ghp_abc123");
    expect(getGithubToken()).toBe("ghp_abc123");
  });
});

describe("clearGithubToken", () => {
  test("removes the stored token", () => {
    localStorage.setItem(STORAGE_KEY, "ghp_abc123");
    clearGithubToken();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("authenticateGithub", () => {
  beforeEach(() => localStorage.removeItem(STORAGE_KEY));
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns existing token if already stored", async () => {
    localStorage.setItem(STORAGE_KEY, "ghp_existing");
    const result = await authenticateGithub();
    expect(result).toBe("ghp_existing");
  });

  test("throws when device code request fails", async () => {
    setupFetch([{ ok: false, status: 500, json: { error: "server_error" } }]);
    await expect(authenticateGithub()).rejects.toThrow("Failed to initiate GitHub device flow");
  });

  test("sends correct params to device/code endpoint", async () => {
    setupFetch([
      {
        json: {
          device_code: "dc_123",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
        },
      },
      { json: { access_token: "ghp_new_token" } },
    ]);

    const promise = authenticateGithub();
    // Wait for initial fetch + poll interval (1s) + token fetch
    await new Promise((r) => setTimeout(r, 1200));
    const result = await promise;

    expect(mockFetchCalls[0].url).toBe("https://github.com/login/device/code");
    const body = JSON.parse(mockFetchCalls[0].opts.body);
    expect(body.client_id).toBe("Ov23liYVlMFpgjOEPXJH");
    expect(body.scope).toBe("repo");
    expect(result).toBe("ghp_new_token");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("ghp_new_token");
  });

  test("polls token endpoint with correct grant_type", async () => {
    setupFetch([
      {
        json: {
          device_code: "dc_456",
          user_code: "WXYZ-9999",
          verification_uri: "https://github.com/login/device",
          interval: 1,
        },
      },
      { json: { error: "authorization_pending" } },
      { json: { access_token: "ghp_polled" } },
    ]);

    const promise = authenticateGithub();
    // 1st poll at 1s (authorization_pending), 2nd poll at 2s (success)
    await new Promise((r) => setTimeout(r, 2200));
    const result = await promise;

    expect(result).toBe("ghp_polled");
    expect(mockFetchCalls.length).toBe(3);

    const tokenCall = mockFetchCalls[1];
    expect(tokenCall.url).toBe("https://github.com/login/oauth/access_token");
    const tokenBody = JSON.parse(tokenCall.opts.body);
    expect(tokenBody.device_code).toBe("dc_456");
    expect(tokenBody.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(tokenBody.client_id).toBe("Ov23liYVlMFpgjOEPXJH");
  });

  test("handles slow_down by increasing interval", async () => {
    setupFetch([
      {
        json: {
          device_code: "dc_789",
          user_code: "SLOW-DOWN",
          verification_uri: "https://github.com/login/device",
          interval: 1,
        },
      },
      { json: { error: "slow_down" } },
      { json: { access_token: "ghp_slow" } },
    ]);

    const promise = authenticateGithub();
    // 1st poll at 1s (slow_down), 2nd poll at 1+6=7s (interval+5)
    await new Promise((r) => setTimeout(r, 7200));
    const result = await promise;

    expect(result).toBe("ghp_slow");
    expect(mockFetchCalls.length).toBe(3);
  }, 10000);

  test("resolves null on expired_token error", async () => {
    setupFetch([
      {
        json: {
          device_code: "dc_exp",
          user_code: "EXPIRED",
          verification_uri: "https://github.com/login/device",
          interval: 1,
        },
      },
      { json: { error: "expired_token" } },
    ]);

    const promise = authenticateGithub();
    await new Promise((r) => setTimeout(r, 1200));
    const result = await promise;
    expect(result).toBeNull();
  });
});
