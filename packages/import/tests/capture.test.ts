/**
 * CapturePage against a fake browser — no puppeteer at all, which is the property the module was
 * split for. The in-page callbacks passed to page.evaluate execute in-process against a happy-dom
 * document, so their DOM logic is really exercised.
 */
import { describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { capturePage } from "../src/capture.ts";
import type { ImportBrowser } from "../src/capture.ts";

function makeDom(html: string): Window {
  const win = new Window({ url: "https://site.example/page" });
  win.document.body.innerHTML = html;
  Object.assign(globalThis, {
    document: win.document,
    window: win,
    location: win.location,
  });
  return win;
}

/** A browser that is only the surface `ImportPage` declares — the point of the structural type. */
function fakeBrowser(): ImportBrowser {
  return {
    newPage: () =>
      Promise.resolve({
        setViewport: mock(() => Promise.resolve()),
        goto: mock(() => Promise.resolve()),
        evaluate: mock((fn: (...a: never[]) => unknown, ...args: never[]) =>
          Promise.resolve(fn(...args)),
        ),
        screenshot: mock(() => Promise.resolve(new Uint8Array([1]))),
        close: mock(() => Promise.resolve()),
      }),
  } as unknown as ImportBrowser;
}

describe("capturePage", () => {
  test("strips scripts and collects same-origin links from the live DOM", async () => {
    makeDom(`
      <script>evil()</script>
      <noscript>fallback</noscript>
      <h1>Title</h1>
      <a href="/about">About</a>
      <a href="/about">Duplicate</a>
      <a href="https://site.example/contact">Contact</a>
      <a href="https://other.example/away">External</a>
      <a href="/anchored#section">Anchored</a>
    `);
    globalThis.document.title = "Captured Page";

    const browser = fakeBrowser();
    const result = await capturePage("https://site.example/page", browser, {
      scrollToBottom: false,
    });

    expect(result.title).toBe("Captured Page");
    expect(result.bodyHtml).toContain("<h1>Title</h1>");
    expect(result.bodyHtml).not.toContain("script");
    // Same-origin, deduped, hash links excluded, external origins excluded.
    expect(result.links).toEqual(["https://site.example/about", "https://site.example/contact"]);
    expect(result.url).toBe("https://site.example/page");
  });

  test("scrolls to reveal lazy content when enabled", async () => {
    const win = makeDom("<div>tall content</div>");
    const scrollTo = mock(() => {});
    (win as unknown as { scrollTo: unknown }).scrollTo = scrollTo;

    const browser = fakeBrowser();
    const page = await capturePage("https://site.example/page", browser);
    // The scroll pass ends by returning to the top.
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(page.title).toBeDefined();
  });

  test("the scroll pass steps through a tall page and caps runaway growth", async () => {
    const win = makeDom("<div>tall content</div>");
    const scrollTo = mock(() => {});
    (win as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    // 22 viewports tall: the step loop must give up at the 20-viewport cap, not scroll forever.
    Object.defineProperty(win, "innerHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(win.document.body, "scrollHeight", {
      configurable: true,
      get: () => 2200,
    });

    // Collapse the in-page settle delays so the capped loop runs instantly.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((cb: () => void) =>
      realSetTimeout(cb, 0)) as unknown as typeof setTimeout;
    try {
      await capturePage("https://site.example/page", fakeBrowser());
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // 21 downward steps (the 21st crosses the cap and breaks) plus the return to top.
    expect(scrollTo).toHaveBeenCalledTimes(22);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
  });
});
