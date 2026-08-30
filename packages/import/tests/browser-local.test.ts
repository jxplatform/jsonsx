/**
 * Chrome discovery and the browser singleton in browser-local.ts — the one module that loads
 * puppeteer-core as a value. puppeteer-core is mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

interface FakeBrowser {
  connected: boolean;
  close: ReturnType<typeof mock>;
  newPage: ReturnType<typeof mock>;
}

let launchedWith: { executablePath: string } | null = null;
let currentBrowser: FakeBrowser;

const launch = mock((opts: { executablePath: string }) => {
  launchedWith = opts;
  currentBrowser = {
    connected: true,
    close: mock(() => {
      currentBrowser.connected = false;
      return Promise.resolve();
    }),
    newPage: mock(() => Promise.resolve({})),
  };
  return Promise.resolve(currentBrowser);
});
void mock.module("puppeteer-core", () => ({ launch }));

const { launchBrowser, closeBrowser } = await import("../src/browser-local.ts");

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
