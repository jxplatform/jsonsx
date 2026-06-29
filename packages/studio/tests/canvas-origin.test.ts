import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { canvasBaseOrigin } from "../src/canvas/canvas-origin";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

interface PlatformGlobal {
  __jxPlatform?: { canvasUrl?: string } | undefined;
}
const g = globalThis as unknown as PlatformGlobal;

afterEach(() => {
  g.__jxPlatform = undefined;
});

describe("canvasBaseOrigin", () => {
  test("falls back to location.origin when no platform is registered", () => {
    g.__jxPlatform = undefined;
    expect(canvasBaseOrigin()).toBe(location.origin);
  });

  test("falls back to location.origin when the platform sets no canvasUrl", () => {
    g.__jxPlatform = {};
    expect(canvasBaseOrigin()).toBe(location.origin);
  });

  test("is IDENTITY for a relative canvasUrl (same-origin path resolves to location.origin)", () => {
    g.__jxPlatform = { canvasUrl: "/__studio__/canvas.html" };
    expect(canvasBaseOrigin()).toBe(location.origin);
  });

  test("returns the loopback origin for an absolute cross-origin canvasUrl", () => {
    g.__jxPlatform = { canvasUrl: "http://127.0.0.1:54321/__studio__/canvas.html?win=2" };
    expect(canvasBaseOrigin()).toBe("http://127.0.0.1:54321");
  });
});
