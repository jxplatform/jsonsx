/**
 * Phase 7 (view-side gate-on): the desktop platform's data-URL MutationObserver + views://
 * fetch-shim switch REWRITE TARGET when platform.canvasUrl is an absolute loopback origin. A
 * relative panel asset is rewritten to an absolute loopback URL (fetch-free, a cross-origin image
 * load), and the views:// read-shim steps aside so the canvas doc + assets are served natively over
 * http.
 *
 * This file owns a SINGLE platform (one observer, one window.fetch wrap) so there is no
 * cross-observer interference — platform.test.ts already covers the gate-off (data-URL) path with
 * its own fixture.
 */

import { describe, expect, mock, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

interface Call {
  method: string;
  args: unknown[];
}

const calls: Call[] = [];
const impls = new Map<string, (...args: unknown[]) => unknown>();

const requestProxy = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
  get(_target, prop: string) {
    return (...args: unknown[]) => {
      calls.push({ args, method: prop });
      const impl = impls.get(prop);
      if (impl) {
        return (async () => impl(...args))();
      }
      return Promise.resolve({ method: prop, ok: true });
    };
  },
});

const rpcObject = { request: requestProxy };

void mock.module("electrobun/view", () => ({
  Electroview: class {
    static defineRPC() {
      return rpcObject;
    }
  },
}));

function callsFor(method: string): Call[] {
  return calls.filter((c) => c.method === method);
}

async function flush(ms = 25): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Stub window.fetch BEFORE the platform wraps it, so passthrough (shim step-aside) is observable.
const passthroughFetch = mock(async () => new Response("passthrough-body", { status: 299 }));
(window as unknown as Record<string, unknown>).fetch = passthroughFetch;

const { createDesktopPlatform } = await import("../src/platform");

const LOOPBACK = "http://127.0.0.1:51999";
const platform = createDesktopPlatform();
// Set BEFORE the synchronous mutation batch below so the observer sees loopback as active.
platform.canvasUrl = `${LOOPBACK}/__studio__/canvas.html`;

const lbImg = document.createElement("img");
lbImg.setAttribute("src", "./assets/hero.png");
const lbBg = document.createElement("div");
lbBg.setAttribute("style", "background-image: url('media/tile.png')");
document.body.append(lbImg, lbBg);

describe("loopback rewrite target (gate-on)", () => {
  test("rewrites a relative img src to an absolute loopback URL (no data: fetch)", async () => {
    await flush();
    expect(lbImg.getAttribute("src")).toBe(`${LOOPBACK}/assets/hero.png`);
    // No readFileAsDataUrl round-trip on the loopback path.
    expect(callsFor("readFileAsDataUrl")).toHaveLength(0);
  });

  test("rewrites a background-image url() to the loopback origin", async () => {
    await flush();
    // Happy-dom round-trips backgroundImage with quotes; assert on the loopback URL substring.
    expect(lbBg.style.backgroundImage).toContain(`${LOOPBACK}/media/tile.png`);
    expect(lbBg.style.backgroundImage.startsWith("url(")).toBe(true);
  });

  test("the views:// fetch-shim steps aside on loopback (passes through to native fetch)", async () => {
    const res = await (window.fetch as typeof fetch)("views://studio/index.html");
    expect(res.status).toBe(299);
    expect(await res.text()).toBe("passthrough-body");
    // No readFile shim call on the loopback path.
    expect(callsFor("readFile")).toHaveLength(0);
  });

  test("a non-http canvasUrl yields no loopback origin → the views:// read-shim stays active", async () => {
    // Defensive: a relative/custom-scheme canvasUrl must NOT be treated as a loopback origin, so the
    // Views:// read-shim stays installed (loopbackOrigin() returns null on a non-http protocol).
    platform.canvasUrl = "views://studio/packages/studio/canvas.html";
    impls.set("readFile", () => "<html>shim</html>");
    const res = await (window.fetch as typeof fetch)("views://studio/index.html");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>shim</html>");
    expect(callsFor("readFile").length).toBeGreaterThan(0);
    impls.delete("readFile");
    platform.canvasUrl = `${LOOPBACK}/__studio__/canvas.html`;
  });
});
