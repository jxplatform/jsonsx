import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { canvasBaseOrigin, documentBase, loopbackAssetSrc } from "../src/canvas/canvas-origin";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

interface PlatformGlobal {
  __jxPlatform?: { canvasUrl?: string; documentBaseUrl?: string } | undefined;
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

/**
 * Where the canvas fetches project files from.
 *
 * The renderer resolves a component `$ref` with `fetch(url).then(r => r.json())` from inside the
 * iframe, so a project file has to exist at a URL — `readFile` is not reachable from there. Hosts
 * that serve the tree from their web root need no declaration; a host whose `projectRoot` is an
 * identifier rather than a path must make one, or every `$ref` addresses nothing.
 */
describe("documentBase", () => {
  test("defaults to the canvas origin plus the project root", () => {
    g.__jxPlatform = {};
    expect(documentBase("examples/site-demo")).toBe(`${location.origin}/examples/site-demo/`);
  });

  test("omits the root segment when there is no root", () => {
    g.__jxPlatform = {};
    expect(documentBase("")).toBe(`${location.origin}/`);
    expect(documentBase()).toBe(`${location.origin}/`);
  });

  test("a declared base wins, and the project root is NOT appended to it", () => {
    /* The declared base already addresses one project — Jx Cloud's is
       /api/v1/p/:owner/:repo/:branch/studio/raw/ — so appending the root key on top of it would
       address a directory named "owner/repo@branch" inside that project. */
    g.__jxPlatform = { documentBaseUrl: "/api/v1/p/acme/site/main/studio/raw/" };
    expect(documentBase("acme/site@main")).toBe("/api/v1/p/acme/site/main/studio/raw/");
  });

  test("a declared base missing its trailing slash still composes", () => {
    // `new URL("pages/index.json", ".../raw")` would drop the last segment; the slash is load-bearing.
    g.__jxPlatform = { documentBaseUrl: "/api/v1/p/acme/site/main/studio/raw" };
    expect(new URL("pages/index.json", `http://x${documentBase("")}`).pathname).toBe(
      "/api/v1/p/acme/site/main/studio/raw/pages/index.json",
    );
  });

  test("an unregistered platform does not throw — gates render before registration", () => {
    g.__jxPlatform = undefined;
    expect(documentBase("root")).toBe(`${location.origin}/root/`);
  });
});
