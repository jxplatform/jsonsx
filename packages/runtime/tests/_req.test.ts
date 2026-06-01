import { GlobalRegistrator } from "@happy-dom/global-registrator";
try {
  GlobalRegistrator.register();
} catch {}

import { describe, test, expect, mock } from "bun:test";
import { reactive, isRef } from "@vue/reactivity";
import { resolvePrototype } from "../src/runtime";

const wait = () => new Promise((r) => setTimeout(r, 0));

describe("resolvePrototype", () => {
  test("Request: returns ref", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 1 }),
      }),
    ) as any;
    const state: Record<string, unknown> = reactive({});
    const result = await resolvePrototype(
      { $prototype: "Request", url: "/api/test" },
      state,
      "data",
    );
    expect(isRef(result)).toBe(true);
    state.data = result;
    await wait();
    expect(state.data).toEqual({ id: 1 });
  });
});
