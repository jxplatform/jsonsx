import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { canvasBaseOrigin, loopbackAssetSrc } from "../src/canvas/canvas-origin";

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

describe("loopbackAssetSrc", () => {
  test("returns the input path unchanged when no platform / no canvasUrl is registered", () => {
    g.__jxPlatform = undefined;
    expect(loopbackAssetSrc("/public/logo.png")).toBe("/public/logo.png");
  });

  test("returns the input unchanged for a same-origin relative canvasUrl (guard: origin === location.origin)", () => {
    g.__jxPlatform = { canvasUrl: "/__studio__/canvas.html" };
    expect(loopbackAssetSrc("/public/logo.png")).toBe("/public/logo.png");
  });

  test("rewrites to the loopback origin for an absolute cross-origin canvasUrl (leading / normalized)", () => {
    g.__jxPlatform = { canvasUrl: "http://127.0.0.1:54321/__studio__/canvas.html" };
    expect(loopbackAssetSrc("/public/logo.png")).toBe("http://127.0.0.1:54321/public/logo.png");
  });

  test("normalizes a leading './' and a bare relative path to a single slash", () => {
    g.__jxPlatform = { canvasUrl: "http://127.0.0.1:54321/__studio__/canvas.html" };
    expect(loopbackAssetSrc("./public/logo.png")).toBe("http://127.0.0.1:54321/public/logo.png");
    expect(loopbackAssetSrc("logo.png")).toBe("http://127.0.0.1:54321/logo.png");
  });

  test("leaves already-absolute data/blob/http/views urls untouched even when a loopback origin is set", () => {
    g.__jxPlatform = { canvasUrl: "http://127.0.0.1:54321/__studio__/canvas.html" };
    expect(loopbackAssetSrc("data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
    expect(loopbackAssetSrc("blob:http://x/abc")).toBe("blob:http://x/abc");
    expect(loopbackAssetSrc("http://example.com/pic.png")).toBe("http://example.com/pic.png");
    expect(loopbackAssetSrc("views://studio/pic.png")).toBe("views://studio/pic.png");
  });
});
