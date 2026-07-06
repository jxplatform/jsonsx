/**
 * Browser plumbing in capture.ts: Chrome discovery precedence, the browser singleton, and
 * capturePage. puppeteer-core is mocked; the in-page callbacks passed to page.evaluate execute
 * in-process against a happy-dom document so their DOM logic is really exercised.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";

interface FakeBrowser {
  connected: boolean;
  close: ReturnType<typeof mock>;
  newPage: ReturnType<typeof mock>;
}

let launchedWith: { executablePath: string } | null = null;
let currentBrowser: FakeBrowser;

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

function makeFakePage() {
  return {
    setViewport: mock(() => Promise.resolve()),
    goto: mock(() => Promise.resolve()),
    evaluate: mock((fn: (...a: unknown[]) => unknown, ...args: unknown[]) =>
      Promise.resolve(fn(...args)),
    ),
    close: mock(() => Promise.resolve()),
  };
}

const launch = mock((opts: { executablePath: string }) => {
  launchedWith = opts;
  currentBrowser = {
    connected: true,
    close: mock(() => {
      currentBrowser.connected = false;
      return Promise.resolve();
    }),
    newPage: mock(() => Promise.resolve(makeFakePage())),
  };
  return Promise.resolve(currentBrowser);
});
void mock.module("puppeteer-core", () => ({ launch }));

const { launchBrowser, closeBrowser, capturePage } = await import("../src/capture.ts");

const originalChromePath = process.env.CHROME_PATH;

beforeEach(() => {
  launch.mockClear();
  launchedWith = null;
  delete process.env.CHROME_PATH;
});

afterEach(async () => {
  await closeBrowser();
  if (originalChromePath === undefined) {
    delete process.env.CHROME_PATH;
  } else {
    process.env.CHROME_PATH = originalChromePath;
  }
});

describe("launchBrowser — Chrome discovery", () => {
  test("an explicit executablePath wins over everything", async () => {
    process.env.CHROME_PATH = "/env/chrome";
    await launchBrowser({ executablePath: "/explicit/chromium" });
    expect(launchedWith?.executablePath).toBe("/explicit/chromium");
  });

  test("CHROME_PATH wins over PATH discovery", async () => {
    process.env.CHROME_PATH = "/env/chrome";
    await launchBrowser();
    expect(launchedWith?.executablePath).toBe("/env/chrome");
  });

  test("falls back to which-discovery of chrome/chromium binaries", async () => {
    const which = spyOn(Bun, "which").mockImplementation((name: string) =>
      name === "chromium" ? "/usr/bin/chromium" : null,
    );
    try {
      await launchBrowser();
      expect(launchedWith?.executablePath).toBe("/usr/bin/chromium");
    } finally {
      which.mockRestore();
    }
  });

  test("throws when no browser can be found", async () => {
    const which = spyOn(Bun, "which").mockImplementation(() => null);
    try {
      // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
      await expect(launchBrowser()).rejects.toThrow("Could not find Chrome/Chromium");
    } finally {
      which.mockRestore();
    }
  });

  test("reuses the connected browser singleton", async () => {
    const first = await launchBrowser({ executablePath: "/a" });
    const second = await launchBrowser({ executablePath: "/b" });
    expect(second).toBe(first);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  test("closeBrowser disconnects and allows a fresh launch", async () => {
    const first = await launchBrowser({ executablePath: "/a" });
    await closeBrowser();
    expect((first as unknown as FakeBrowser).close).toHaveBeenCalled();
    await launchBrowser({ executablePath: "/b" });
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

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

    const browser = await launchBrowser({ executablePath: "/a" });
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

    const browser = await launchBrowser({ executablePath: "/a" });
    const page = await capturePage("https://site.example/page", browser);
    // The scroll pass ends by returning to the top.
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(page.title).toBeDefined();
  });

  test("launches its own browser when none is passed", async () => {
    makeDom("<p>standalone</p>");
    process.env.CHROME_PATH = "/env/chrome";
    const result = await capturePage("https://site.example/page", undefined, {
      scrollToBottom: false,
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result.bodyHtml).toContain("standalone");
  });
});
