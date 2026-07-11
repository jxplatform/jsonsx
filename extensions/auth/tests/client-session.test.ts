/**
 * Client-session.test.ts — the browser-safe client wrapper and the module session store, run
 * WITHOUT a DOM: `Session.resolve()` must return null outside browsers (SSG-safe), the client
 * factory must demand an explicit base URL, and the store must fetch/notify/clear through an
 * injected client.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { getAuthClient, resolveAuthBaseUrl, setAuthClient } from "../src/client";
import {
  clearSession,
  currentSession,
  fetchSession,
  inBrowser,
  resetSessionStore,
  Session,
  subscribeSession,
} from "../src/session";
import type { AuthClientResult, JxAuthClient } from "../src/client";
import type { SessionInfo } from "@jxsuite/connector/types";

/** A fake client whose getSession returns the given payloads in order. */
function fakeClient(payloads: unknown[]): JxAuthClient & { calls: number } {
  const fake = {
    calls: 0,
    getSession: (): Promise<AuthClientResult> => {
      fake.calls += 1;
      return Promise.resolve({ data: payloads.shift() ?? null });
    },
    signIn: {
      email: () => Promise.resolve({}),
      social: () => Promise.resolve({}),
    },
    signOut: () => Promise.resolve({}),
    signUp: { email: () => Promise.resolve({}) },
  };
  return fake;
}

afterEach(() => {
  setAuthClient(null);
  resetSessionStore();
});

describe("client wrapper", () => {
  test("resolveAuthBaseUrl needs an explicit base outside browsers", () => {
    expect(resolveAuthBaseUrl("http://x.test/_jx/auth")).toBe("http://x.test/_jx/auth");
    expect(() => resolveAuthBaseUrl()).toThrow(/baseUrl outside browsers/);
  });

  test("getAuthClient builds a real Better Auth client surface for an explicit base", () => {
    const client = getAuthClient("http://x.test/_jx/auth");
    expect(typeof client.signIn.email).toBe("function");
    expect(typeof client.signIn.social).toBe("function");
    expect(typeof client.signUp.email).toBe("function");
    expect(typeof client.signOut).toBe("function");
    expect(typeof client.getSession).toBe("function");
    // Same base → same instance; changed base → new instance.
    expect(getAuthClient("http://x.test/_jx/auth")).toBe(client);
    expect(getAuthClient("http://other.test/_jx/auth")).not.toBe(client);
  });

  test("an injected client wins regardless of base", () => {
    const fake = fakeClient([]);
    setAuthClient(fake);
    expect(getAuthClient()).toBe(fake);
    expect(getAuthClient("http://ignored.test")).toBe(fake);
  });
});

describe("session store", () => {
  test("fetchSession maps the payload, caches, and notifies subscribers", async () => {
    setAuthClient(fakeClient([{ user: { id: "u1", role: "admin" } }, null]));
    const seen: (SessionInfo | null)[] = [];
    const unsubscribe = subscribeSession((session) => seen.push(session));

    const first = await fetchSession();
    expect(first).toMatchObject({ role: "admin", userId: "u1" });
    expect(currentSession()).toEqual(first);

    const second = await fetchSession();
    expect(second).toBeNull();
    expect(seen).toEqual([first, null]);

    unsubscribe();
    await fetchSession();
    expect(seen).toHaveLength(2);
  });

  test("fetchSession fails closed (null) when the client throws", async () => {
    setAuthClient({
      ...fakeClient([]),
      getSession: () => Promise.reject(new Error("network down")),
    });
    expect(await fetchSession()).toBeNull();
    expect(currentSession()).toBeNull();
  });

  test("clearSession drops the value and notifies", () => {
    const seen: (SessionInfo | null)[] = [];
    subscribeSession((session) => seen.push(session));
    clearSession();
    expect(seen).toEqual([null]);
    expect(currentSession()).toBeNull();
  });
});

describe("Session state class", () => {
  test("resolve() is null outside browsers even with a live client (SSG-safe)", async () => {
    setAuthClient(fakeClient([{ user: { id: "u1" } }]));
    expect(inBrowser()).toBe(false);
    const session = new Session();
    expect(await session.resolve()).toBeNull();

    // Subscribe outside a browser registers the listener without fetching.
    const seen: (SessionInfo | null)[] = [];
    session.subscribe((value) => seen.push(value));
    clearSession();
    expect(seen).toEqual([null]);
  });

  test("keeps its config", () => {
    expect(new Session({ baseUrl: "http://x.test" }).config.baseUrl).toBe("http://x.test");
    expect(new Session().config).toEqual({});
  });
});
