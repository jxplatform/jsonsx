/** Platform abstraction layer (C7): register/get/has lifecycle in src/platform.ts. */
import "./with-dom.js";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { getPlatform, hasPlatform, registerPlatform } from "../src/platform";
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
    expect(getPlatform()).toBe(fake);
    expect(g.__jxPlatform).toBe(fake);
  });

  test("re-registering replaces the previous platform", () => {
    const first = { id: "first" } as unknown as StudioPlatform;
    const second = { id: "second" } as unknown as StudioPlatform;
    registerPlatform(first);
    registerPlatform(second);
    expect(getPlatform()).toBe(second);
  });
});
