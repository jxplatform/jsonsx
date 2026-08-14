/** Platform abstraction layer (C7): register/get/has lifecycle and call counting in src/platform.ts. */
import "./with-dom.js";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { getPlatform, hasPlatform, platformInFlight, registerPlatform } from "../src/platform";
import type { StudioPlatform } from "../src/types";

const g = globalThis as unknown as { __jxPlatform?: StudioPlatform };
const original = g.__jxPlatform;

beforeEach(() => {
  delete g.__jxPlatform;
});

afterAll(() => {
  if (original) {
    g.__jxPlatform = original;
  } else {
    delete g.__jxPlatform;
  }
});

describe("platform registry", () => {
  test("hasPlatform is false before registration", () => {
    expect(hasPlatform()).toBe(false);
  });

  test("getPlatform throws a descriptive error when nothing is registered", () => {
    expect(() => getPlatform()).toThrow(
      "No platform registered. Call registerPlatform() before starting Studio.",
    );
  });

  test("registerPlatform makes the platform available globally", () => {
    const fake = { id: "test-platform" } as unknown as StudioPlatform;
    registerPlatform(fake);
    expect(hasPlatform()).toBe(true);
    // The raw adapter is what is stored; callers get the counting proxy over it, so identity is
    // Deliberately NOT preserved — every value read through it is.
    expect(g.__jxPlatform).toBe(fake);
    expect((getPlatform() as unknown as { id: string }).id).toBe("test-platform");
  });

  test("re-registering replaces the previous platform", () => {
    const first = { id: "first" } as unknown as StudioPlatform;
    const second = { id: "second" } as unknown as StudioPlatform;
    registerPlatform(first);
    expect((getPlatform() as unknown as { id: string }).id).toBe("first");
    registerPlatform(second);
    expect((getPlatform() as unknown as { id: string }).id).toBe("second");
  });

  test("an adapter registered directly on the global is still counted", async () => {
    // Desktop pre-registers on `window.__jxPlatform` without calling the registrar, which is why
    // The proxy is applied at the READ point rather than at registration.
    g.__jxPlatform = { readFile: () => Promise.resolve("x") } as unknown as StudioPlatform;
    const platform = getPlatform() as unknown as { readFile: () => Promise<string> };
    const call = platform.readFile();
    expect(platformInFlight()).toEqual(["readFile"]);
    await call;
    expect(platformInFlight()).toEqual([]);
  });
});

describe("call counting", () => {
  function makePlatform(): {
    platform: StudioPlatform;
    settle: (method: string, ok: boolean) => void;
  } {
    const resolvers = new Map<string, (ok: boolean) => void>();
    const pending = (method: string) => () =>
      new Promise<string>((resolve, reject) => {
        resolvers.set(method, (ok) => {
          if (ok) {
            resolve("ok");
          } else {
            reject(new Error("boom"));
          }
        });
      });
    return {
      platform: {
        gitStatus: pending("gitStatus"),
        readFile: pending("readFile"),
        // Synchronous members are passed through — they cannot be outstanding.
        rootPath: "/tmp/project",
        version: () => "1.2.3",
      } as unknown as StudioPlatform,
      settle: (method, ok) => resolvers.get(method)?.(ok),
    };
  }

  test("counts each unsettled call, one entry per call, named by its method", async () => {
    const { platform, settle } = makePlatform();
    registerPlatform(platform);
    const api = getPlatform() as unknown as {
      gitStatus: () => Promise<string>;
      readFile: () => Promise<string>;
    };
    const first = api.gitStatus();
    expect(platformInFlight()).toEqual(["gitStatus"]);
    const second = api.readFile();
    expect(platformInFlight().toSorted()).toEqual(["gitStatus", "readFile"]);
    settle("gitStatus", true);
    settle("readFile", true);
    await Promise.all([first, second]);
    expect(platformInFlight()).toEqual([]);
  });

  test("a REJECTED call is a call that finished — the counter must not wedge", async () => {
    const { platform, settle } = makePlatform();
    registerPlatform(platform);
    const api = getPlatform() as unknown as { gitStatus: () => Promise<string> };
    const call = api.gitStatus();
    expect(platformInFlight()).toEqual(["gitStatus"]);
    settle("gitStatus", false);
    const failure = (await call.catch((error: unknown) => error)) as Error;
    expect(failure.message).toBe("boom");
    expect(platformInFlight()).toEqual([]);
  });

  test("two concurrent calls to one method are two reasons to wait", async () => {
    const resolvers: ((value: string) => void)[] = [];
    registerPlatform({
      gitStatus: () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    } as unknown as StudioPlatform);
    const api = getPlatform() as unknown as { gitStatus: () => Promise<string> };
    const calls = [api.gitStatus(), api.gitStatus()];
    expect(platformInFlight()).toEqual(["gitStatus", "gitStatus"]);
    for (const resolve of resolvers) {
      resolve("ok");
    }
    await Promise.all(calls);
    expect(platformInFlight()).toEqual([]);
  });

  test("synchronous members and plain values pass through untouched", () => {
    const { platform } = makePlatform();
    registerPlatform(platform);
    const api = getPlatform() as unknown as { rootPath: string; version: () => string };
    expect(api.rootPath).toBe("/tmp/project");
    expect(api.version()).toBe("1.2.3");
    expect(platformInFlight()).toEqual([]);
  });

  test("a method REPLACED on the adapter is re-wrapped, not answered by the old one", async () => {
    // Capabilities get installed lazily (a desktop shell adding `cfConnect` once its OAuth broker
    // Is up), so a wrapper memoised by name alone would keep calling the implementation that was
    // There at first read — the call would land nowhere and the counter would never see it.
    const platform = { probe: () => Promise.resolve("first") } as unknown as StudioPlatform;
    registerPlatform(platform);
    const api = getPlatform() as unknown as { probe: () => Promise<string> };
    expect(await api.probe()).toBe("first");
    (platform as unknown as { probe: () => Promise<string> }).probe = () =>
      Promise.resolve("second");
    expect(await api.probe()).toBe("second");
    expect(platformInFlight()).toEqual([]);
  });

  test("a wrapper is memoised, so capability checks and cached references stay stable", () => {
    const { platform } = makePlatform();
    registerPlatform(platform);
    const api = getPlatform();
    expect(api.gitStatus).toBe(api.gitStatus);
    expect(typeof api.gitStatus).toBe("function");
    expect((api as unknown as { gitClone?: unknown }).gitClone).toBeUndefined();
    // The same read through a second getPlatform() call is the same proxy, not a fresh one.
    expect(getPlatform()).toBe(api);
  });
});
