/**
 * Coverage-gap tests for small service/util modules:
 *
 * - Cf-settings read() degradation when localStorage access throws
 * - Jx-validate no-op degradation when ajv fails to load/compile
 * - Render-critic "is not a function" / "is not a constructor" error translation
 * - Preview-format fallback when JSON.stringify throws
 */
import "./with-dom.js";
import { describe, expect, mock, test } from "bun:test";

// Jx-validate treats ajv as an optional peer dependency: this file exercises the degraded
// Path where the compile step throws, so the mock must land before the module loads.
void mock.module("ajv/dist/2020.js", () => ({
  default: class FailingAjv {
    constructor() {
      throw new Error("ajv unavailable in this environment");
    }
  },
}));

const { validateDoc, validateDocOrNull } = await import("../src/services/jx-validate");
const { renderCheck } = await import("../src/services/render-critic");
const { formatPreviewValue } = await import("../src/utils/preview-format");
const { getCfAccountId, getCfToken } = await import("../src/services/cf-settings");

describe("cf-settings storage failure", () => {
  test("read degrades to empty string when localStorage access throws", () => {
    // Happy-dom's Storage is a proxy (assigning .getItem would just store an item), so swap
    // The whole global for one that throws on access — the private-mode failure shape.
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage denied");
      },
    });
    try {
      expect(getCfToken()).toBe("");
      expect(getCfAccountId()).toBe("");
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      }
    }
  });
});

describe("jx-validate without ajv", () => {
  test("validateDoc degrades to no findings when the validator fails to compile", async () => {
    expect(await validateDoc({ tagName: "div" })).toEqual([]);
    // A second call reuses the settled loading promise (still degraded).
    expect(await validateDoc({ not: "a document" })).toEqual([]);
  });
});

/**
 * The three-state answer exists for exactly this environment.
 *
 * `validateDoc` degrades to "no errors" when ajv cannot load, which is indistinguishable from a
 * valid document — fine where validation decorates an editor, wrong where it gates a destructive
 * step. `format/convert-file.ts` reads the `null` and says the result could not be checked, rather
 * than claiming it is valid.
 */
describe("validateDocOrNull under a broken ajv", () => {
  test("answers null, where validateDoc answers no errors", async () => {
    expect(await validateDoc({ tagName: "div" })).toEqual([]);
    expect(await validateDocOrNull({ tagName: "div" })).toBeNull();
  });
});

describe("render-critic error translation branches", () => {
  test('"is not a function" errors get the handler-oriented fix hint', async () => {
    const doc = {
      children: [{ children: ["${state.count()}"], tagName: "span" }],
      state: { count: 5 },
      tagName: "div",
    };
    const result = await renderCheck(doc as never);
    expect(result.ok).toBe(false);
    const { error } = result as { error: string; ok: false };
    expect(error).toContain("is not a function");
    expect(error).toContain('$prototype: "Function"');
  });

  test('"is not a constructor" errors get the prototype-oriented fix hint', async () => {
    const doc = {
      children: [{ children: ["${new state.count()}"], tagName: "span" }],
      state: { count: 5 },
      tagName: "div",
    };
    const result = await renderCheck(doc as never);
    expect(result.ok).toBe(false);
    const { error } = result as { error: string; ok: false };
    expect(error).toContain("is not a constructor");
    expect(error).toContain("$export");
  });
});

describe("preview-format stringify failure", () => {
  test("falls back to String() when JSON.stringify throws", () => {
    expect(formatPreviewValue(7n)).toBe("7");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatPreviewValue(circular)).toBe("[object Object]");
  });
});
