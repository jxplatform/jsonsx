/**
 * Browser launch for the screenshot runner. Uses puppeteer-core against a system Chromium/Chrome
 * (no bundled browser download — required on NixOS, and ubuntu CI ships Chrome preinstalled).
 * Resolution mirrors packages/desktop/src/chromium/index.ts findChromium().
 */

import { launch } from "puppeteer-core";
import type { Browser, BrowserContext, Page } from "puppeteer-core";

export function findChromium(): string | null {
  const candidates = [
    process.env.CHROMIUM_BIN,
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    const found = Bun.which(bin);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Chromium flags that make one machine's rasterization match the next one's. Every entry here is a
 * SOURCE OF PIXELS, not a convenience: the color profile, the scrollbar chrome, the glyph
 * rasterizer and the UI language each change bytes, and a capture that leaves any of them to the
 * host is a capture that drifts when the host changes.
 */
export const DETERMINISM_ARGS = [
  "--force-color-profile=srgb",
  "--hide-scrollbars",
  // Glyph rasterization: no hinting variance, no subpixel (RGB) anti-aliasing. Both differ by host
  // Font stack and by GPU, and both land in the PNG.
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--disable-gpu",
  // The UI language reaches the page: `Intl` defaults, `lang`-sensitive CSS, and form-control
  // Chrome (date pickers, file inputs) are all rendered in it.
  "--lang=en-US",
];

/**
 * Environment the browser process runs under. The page reads the clock through the browser, so the
 * timezone is a rendering input wherever a date is formatted; `LANG` picks fontconfig's and ICU's
 * defaults the same way.
 */
export const DETERMINISM_ENV: Record<string, string> = {
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
};

export async function launchBrowser(opts: { headed?: boolean } = {}): Promise<Browser> {
  const executablePath = findChromium();
  if (!executablePath) {
    throw new Error(
      "No chromium/chrome binary found. Install chromium or set CHROMIUM_BIN to a browser path.",
    );
  }
  const args = [...DETERMINISM_ARGS];
  if (process.env.CI) {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }
  return launch({
    args,
    defaultViewport: null,
    env: { ...process.env, ...DETERMINISM_ENV },
    executablePath,
    headless: !opts.headed,
  });
}

/**
 * One shot, one browser context. A context owns its own cookie jar, storage AND HTTP cache, so
 * without this every shot after the first photographs a warm cache — and "warm" is not a state the
 * runner controls: it depends on which shots ran before, which is why the same shot captured first
 * and captured tenth produced two different pictures (the site's webfonts had not swapped in yet on
 * the cold one). A fresh context makes every shot cold, i.e. all of them equal, and the capture
 * then waits for the loads it just guaranteed will happen.
 */
export async function newShotContext(
  browser: Browser,
): Promise<{ context: BrowserContext; dispose: () => Promise<void>; page: Page }> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  return {
    context,
    dispose: async () => {
      await context.close();
    },
    page,
  };
}
