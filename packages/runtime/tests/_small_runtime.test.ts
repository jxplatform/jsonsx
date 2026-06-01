import { GlobalRegistrator } from "@happy-dom/global-registrator";
try {
  GlobalRegistrator.register();
} catch {}

import { describe, test, expect } from "bun:test";
import { reactive, ref } from "@vue/reactivity";
import { resolvePrototype, isSignal, Jx } from "../src/runtime";

describe("isSignal", () => {
  test("true for ref", () => expect(isSignal(ref(0))).toBe(true));
});

describe("resolvePrototype", () => {
  test("Set: default empty", async () => {
    const state: Record<string, unknown> = reactive({});
    const result = await resolvePrototype({ $prototype: "Set" }, state, "s");
    state.s = result;
    expect(state.s).toBeInstanceOf(Set);
  });
});

describe("Jx", () => {
  test("mounts object doc into target", async () => {
    const target = document.createElement("div");
    await Jx({ tagName: "span", textContent: "mounted" }, target);
    expect(target.children[0].tagName.toLowerCase()).toBe("span");
  });

  test("defaults target to document.body", async () => {
    const before = document.body.children.length;
    await Jx({ tagName: "div" });
    expect(document.body.children.length).toBe(before + 1);
  });
});
