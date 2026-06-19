/**
 * Gap coverage for src/github/github-auth.ts — the device-flow dialog template (user code,
 * verification link, cancel/close handlers) and the poll loop's cancelled / network-error branches,
 * which tests/github-auth.test.ts leaves uncovered by never rendering the dialog.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render as litRender } from "lit-html";

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

let dialogHosts: HTMLElement[] = [];

void mock.module("../src/ui/layers.js", () => ({
  showConfirmDialog: async () => true,
  showDialog: (templateFn: any) =>
    new Promise((resolve) => {
      const host = document.createElement("div");
      document.body.append(host);
      dialogHosts.push(host);
      litRender(
        templateFn((value: any) => {
          host.remove();
          resolve(value);
        }),
        host,
      );
    }),
}));

const { authenticateGithub } = await import("../src/github/github-auth.js");

// ─── Fetch stub with deferred responses ──────────────────────────────────────

type FetchImpl = (url: string, opts: any) => Promise<any>;
let fetchQueue: FetchImpl[] = [];
let fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;

function installFetch() {
  fetchCalls = [];
  // @ts-expect-error -- minimal fetch mock does not implement the full fetch type
  globalThis.fetch = async (url: any, opts: any) => {
    fetchCalls.push(String(url));
    const next = fetchQueue.shift();
    if (!next) {
      throw new Error(`Unexpected fetch to ${url}`);
    }
    return next(String(url), opts);
  };
}

const jsonResp =
  (json: unknown, ok = true): FetchImpl =>
  async () => ({ json: async () => json, ok, status: ok ? 200 : 500 });

/** Device-code response with a controllable poll interval (seconds). */
const deviceResp = (interval: number) =>
  jsonResp({
    device_code: "dc_gaps",
    interval,
    user_code: "GAPS-1234",
    verification_uri: "https://github.com/login/device",
  });

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  for (const host of dialogHosts) {
    host.remove();
  }
  dialogHosts = [];
  fetchQueue = [];
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("authenticateGithub dialog", () => {
  test("renders the user code and verification link, cancel stops polling", async () => {
    // Interval of 1s: the first poll never fires before we cancel.
    fetchQueue = [deviceResp(1)];
    const promise = authenticateGithub();
    await sleep(5);

    const host = dialogHosts.at(-1)!;
    expect(host).toBeTruthy();
    expect(host.textContent).toContain("GAPS-1234");
    expect(host.textContent).toContain("Waiting for authorization");
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/login/device");
    expect(link.textContent).toContain("https://github.com/login/device");

    host.querySelector("sp-dialog-wrapper")!.dispatchEvent(new Event("cancel"));
    expect(await promise).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // The pending poll timer was cleared — only the device-code request ever fired.
    await sleep(20);
    expect(fetchCalls).toEqual(["https://github.com/login/device/code"]);
  });

  test("close dismisses the dialog and resolves null", async () => {
    fetchQueue = [deviceResp(1)];
    const promise = authenticateGithub();
    await sleep(5);

    dialogHosts.at(-1)!.querySelector("sp-dialog-wrapper")!.dispatchEvent(new Event("close"));
    expect(await promise).toBeNull();
    await sleep(20);
    expect(fetchCalls.length).toBe(1);
  });

  test("cancel during an in-flight poll stops the loop after the response lands", async () => {
    let resolveToken: ((value: any) => void) | undefined;
    fetchQueue = [
      deviceResp(0),
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    ];
    const promise = authenticateGithub();
    await sleep(10); // 0s interval: poll fired, token request now in flight
    expect(fetchCalls.length).toBe(2);

    dialogHosts.at(-1)!.querySelector("sp-dialog-wrapper")!.dispatchEvent(new Event("cancel"));
    expect(await promise).toBeNull();

    // The pending poll completes with authorization_pending and schedules another poll,
    // Which must early-return because the flow was cancelled.
    resolveToken!({
      json: async () => ({ error: "authorization_pending" }),
      ok: true,
      status: 200,
    });
    await sleep(20);
    expect(fetchCalls.length).toBe(2);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("network error during polling retries and then succeeds", async () => {
    fetchQueue = [
      deviceResp(0),
      () => Promise.reject(new Error("offline")),
      jsonResp({ access_token: "ghp_retry_token" }),
    ];
    const result = await authenticateGithub();
    expect(result).toBe("ghp_retry_token");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("ghp_retry_token");
    expect(fetchCalls).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
      "https://github.com/login/oauth/access_token",
    ]);
    // The dialog was torn down once the token arrived.
    expect(dialogHosts.at(-1)!.isConnected).toBe(false);
  });

  test("access_denied resolves null and closes the dialog", async () => {
    fetchQueue = [deviceResp(0), jsonResp({ error: "access_denied" })];
    const result = await authenticateGithub();
    expect(result).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(dialogHosts.at(-1)!.isConnected).toBe(false);
  });
});
