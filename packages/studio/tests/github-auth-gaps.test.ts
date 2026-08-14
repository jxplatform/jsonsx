/**
 * Gap coverage for src/github/github-auth.ts — the device-flow dialog template (user code,
 * verification link, cancel/close handlers) and the poll loop's cancelled / network-error branches,
 * which tests/github-auth.test.ts leaves uncovered by never rendering the dialog.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import { render as litRender } from "lit-html";
import type { NotifyCall } from "./notify-mock";

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

const notifications: NotifyCall[] = [];
void mock.module("../src/services/notify.js", () =>
  notifyModule((call) => notifications.push(call)),
);

const { authenticateGithub, MAX_POLL_FAILURES } = await import("../src/github/github-auth.js");

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

/**
 * Wait until a condition holds, polling on a short interval. Robust where a fixed `sleep` is not:
 * the poll loop schedules with setTimeout(0) for a 0s device interval, and under full-suite load
 * (or Windows' ~15ms timer granularity) that fires later than a fixed 10ms sleep, racing the
 * assert.
 */
const waitFor = async (cond: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met before timeout");
    }
    await sleep(5);
  }
};

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  for (const host of dialogHosts) {
    host.remove();
  }
  dialogHosts = [];
  fetchQueue = [];
  notifications.length = 0;
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
    // 0s interval: wait until the poll has fired and the token request is in flight (a fixed sleep
    // Races setTimeout(0) under load / Windows timer granularity).
    await waitFor(() => fetchCalls.length === 2);
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
    // It rests rather than persisting: the state is CORRECT — there is no token because the user
    // Declined to grant one — and a Problems row promises something still needs fixing.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.severity).toBe("warn");
    expect(notifications[0]!.options.detail).toBe("The authorization was declined on GitHub.");
  });

  test("expired_token says the code expired, and offers the same Retry", async () => {
    fetchQueue = [deviceResp(0), jsonResp({ error: "expired_token" })];
    expect(await authenticateGithub()).toBeNull();
    expect(notifications[0]!.options.detail).toBe("The device code expired before it was entered.");
    expect(notifications[0]!.options.action).toBe("git.signInToGithub");
  });

  test("an unrecognised error quotes back what GitHub actually said", async () => {
    fetchQueue = [deviceResp(0), jsonResp({ error: "unsupported_grant_type" })];
    expect(await authenticateGithub()).toBeNull();
    expect(notifications[0]!.options.detail).toContain("unsupported_grant_type");
  });

  test("an answer with no error field at all still reports rather than hanging", async () => {
    fetchQueue = [deviceResp(0), jsonResp({})];
    expect(await authenticateGithub()).toBeNull();
    expect(notifications[0]!.options.detail).toContain("an unrecognised response");
  });

  test("consecutive poll failures give up as a Problem instead of retrying forever", async () => {
    // The old loop's `catch {}` re-armed the timer with no budget: against a network that never
    // Answers, the dialog said "Waiting for authorization…" until the window closed.
    fetchQueue = [
      deviceResp(0),
      ...Array.from(
        { length: MAX_POLL_FAILURES },
        () => (() => Promise.reject(new TypeError("Failed to fetch"))) as FetchImpl,
      ),
    ];
    expect(await authenticateGithub()).toBeNull();
    expect(fetchCalls).toHaveLength(1 + MAX_POLL_FAILURES);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.severity).toBe("error");
    expect(notifications[0]!.message).toBe("Could not reach GitHub to sign in.");

    // And nothing was scheduled after it gave up.
    await sleep(20);
    expect(fetchCalls).toHaveLength(1 + MAX_POLL_FAILURES);
  });

  test("a failure that recovers resets the budget rather than accumulating", async () => {
    fetchQueue = [
      deviceResp(0),
      () => Promise.reject(new TypeError("Failed to fetch")),
      jsonResp({ error: "authorization_pending" }),
      () => Promise.reject(new TypeError("Failed to fetch")),
      jsonResp({ access_token: "ghp_recovered" }),
    ];
    expect(await authenticateGithub()).toBe("ghp_recovered");
    expect(notifications).toHaveLength(0);
  });
});
