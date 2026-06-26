import { describe, expect, test } from "bun:test";
import { CANVAS_MODES, isCanvasMode } from "../src/canvas/iframe-protocol";

describe("isCanvasMode", () => {
  test("accepts every declared canvas mode", () => {
    for (const mode of CANVAS_MODES) {
      expect(isCanvasMode(mode)).toBe(true);
    }
  });

  test("rejects unknown strings and non-strings", () => {
    expect(isCanvasMode("live")).toBe(false);
    expect(isCanvasMode("")).toBe(false);
    expect(isCanvasMode(null)).toBe(false);
    expect(isCanvasMode(3)).toBe(false);
    expect(isCanvasMode({})).toBe(false);
  });
});
