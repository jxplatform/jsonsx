/**
 * `setSkipAutoRequests` — the edit-mode gate on automatic `$prototype: "Request"` fetches, sibling
 * of `setSkipServerFunctions`. Studio's `buildScope` re-resolves every `state` entry on each full
 * canvas render, so without this an authoring action that escalates to a full render issued an HTTP
 * request every time.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { isRef, reactive } from "@vue/reactivity";
import { resolvePrototype, setSkipAutoRequests } from "../src/runtime";

try {
  GlobalRegistrator.register();
} catch {}

const wait = () =>
  new Promise((r) => {
    setTimeout(r, 0);
  });

function stubFetch() {
  const fetchMock = mock(() =>
    Promise.resolve({
      json: () => Promise.resolve({ id: 1 }),
      ok: true,
    }),
  );
  global.fetch = fetchMock as never;
  return fetchMock;
}

afterEach(() => {
  setSkipAutoRequests(false);
});

describe("setSkipAutoRequests", () => {
  test("suppresses the fetch for an automatic request, still returning a ref", async () => {
    const fetchMock = stubFetch();
    setSkipAutoRequests(true);
    const state: Record<string, unknown> = reactive({});
    const result = await resolvePrototype(
      { $prototype: "Request", url: "/api/test" },
      state,
      "data",
    );

    // The scope shape is unchanged — the ref simply stays at its pre-fetch value, which is exactly
    // What bindings observe before any real fetch resolves.
    expect(isRef(result)).toBe(true);
    state.data = result;
    await wait();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.data).toBeNull();
  });

  test("re-resolving many times issues no requests while gated", async () => {
    const fetchMock = stubFetch();
    setSkipAutoRequests(true);
    const state: Record<string, unknown> = reactive({});
    for (let i = 0; i < 5; i++) {
      await resolvePrototype({ $prototype: "Request", url: "/api/test" }, state, "data");
    }
    await wait();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fetches again once the gate is lifted (preview mode)", async () => {
    const fetchMock = stubFetch();
    setSkipAutoRequests(false);
    const state: Record<string, unknown> = reactive({});
    const result = await resolvePrototype(
      { $prototype: "Request", url: "/api/test" },
      state,
      "data",
    );
    state.data = result;
    await wait();
    expect(fetchMock).toHaveBeenCalled();
    expect(state.data).toEqual({ id: 1 });
  });

  test("leaves manual requests alone — they never auto-fetch in either mode", async () => {
    const fetchMock = stubFetch();
    setSkipAutoRequests(true);
    const state: Record<string, unknown> = reactive({});
    const gated = await resolvePrototype(
      { $prototype: "Request", manual: true, url: "/api/test" },
      state,
      "data",
    );
    setSkipAutoRequests(false);
    const ungated = await resolvePrototype(
      { $prototype: "Request", manual: true, url: "/api/test" },
      state,
      "data",
    );
    await wait();
    expect(isRef(gated)).toBe(true);
    expect(isRef(ungated)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
