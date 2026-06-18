import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

if (globalThis.localStorage === undefined) {
  const store = new Map();
  globalThis.localStorage = {
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    removeItem: (k: string) => store.delete(k),
    setItem: (k: string, v: string) => store.set(k, v),
  } as any;
}

const STORAGE_KEY = "jx_github_token";

let mockFetchResponses: { ok?: boolean; json: unknown; status?: number }[] = [];
let mockFetchCalls: {
  url: string;
  opts: { body: string; headers: Record<string, string> };
}[] = [];
const originalFetch = globalThis.fetch;

/** @param {{ ok?: boolean; json: unknown; status?: number }[]} responses */
function setupFetch(responses: { ok?: boolean; json: unknown; status?: number }[]) {
  mockFetchResponses = [...responses];
  mockFetchCalls = [];
  // @ts-expect-error -- minimal fetch mock does not implement the full fetch type
  globalThis.fetch = async (url: any, opts: any) => {
    mockFetchCalls.push({ opts, url: String(url) });
    const next = mockFetchResponses.shift();
    if (!next) {
      throw new Error(`Unexpected fetch to ${url}`);
    }
    return {
      json: async () => next.json,
      ok: next.ok ?? true,
      status: next.status ?? 200,
    };
  };
}

void mock.module("../src/ui/layers.js", () => ({
  showConfirmDialog: async () => true,
  showDialog: (fn: any) =>
    new Promise((resolve) => {
      fn((val: any) => resolve(val));
    }),
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
    setupFetch([{ json: { error: "server_error" }, ok: false, status: 500 }]);
    // oxlint-disable-next-line typescript/await-thenable -- Bun's expect().rejects.toThrow() returns a real Promise at runtime but is typed `void`; the await must be kept to wait for the rejection.
    await expect(authenticateGithub()).rejects.toThrow("Failed to initiate GitHub device flow");
  });

  test("sends correct params to device/code endpoint", async () => {
    setupFetch([
      {
        json: {
          device_code: "dc_123",
          interval: 1,
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
        },
      },
      { json: { access_token: "ghp_new_token" } },
    ]);

    const promise = authenticateGithub();
    // Wait for initial fetch + poll interval (1s) + token fetch
    await new Promise((r) => {
      setTimeout(r, 1200);
    });
    const result = await promise;

    expect(mockFetchCalls[0]!.url).toBe("https://github.com/login/device/code");
    const body = JSON.parse(mockFetchCalls[0]!.opts.body);
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
          interval: 1,
          user_code: "WXYZ-9999",
          verification_uri: "https://github.com/login/device",
        },
      },
      { json: { error: "authorization_pending" } },
      { json: { access_token: "ghp_polled" } },
    ]);

    const promise = authenticateGithub();
    // 1st poll at 1s (authorization_pending), 2nd poll at 2s (success)
    await new Promise((r) => {
      setTimeout(r, 2200);
    });
    const result = await promise;

    expect(result).toBe("ghp_polled");
    expect(mockFetchCalls.length).toBe(3);

    const tokenCall = mockFetchCalls[1]!;
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
          interval: 1,
          user_code: "SLOW-DOWN",
          verification_uri: "https://github.com/login/device",
        },
      },
      { json: { error: "slow_down" } },
      { json: { access_token: "ghp_slow" } },
    ]);

    const promise = authenticateGithub();
    // 1st poll at 1s (slow_down), 2nd poll at 1+6=7s (interval+5)
    await new Promise((r) => {
      setTimeout(r, 7200);
    });
    const result = await promise;

    expect(result).toBe("ghp_slow");
    expect(mockFetchCalls.length).toBe(3);
  }, 10_000);

  test("resolves null on expired_token error", async () => {
    setupFetch([
      {
        json: {
          device_code: "dc_exp",
          interval: 1,
          user_code: "EXPIRED",
          verification_uri: "https://github.com/login/device",
        },
      },
      { json: { error: "expired_token" } },
    ]);

    const promise = authenticateGithub();
    await new Promise((r) => {
      setTimeout(r, 1200);
    });
    const result = await promise;
    expect(result).toBeNull();
  });
});
