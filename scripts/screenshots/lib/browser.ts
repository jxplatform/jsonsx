/**
 * Browser launch for the screenshot runner. Uses puppeteer-core against a system Chromium/Chrome
 * (no bundled browser download — required on NixOS, and ubuntu CI ships Chrome preinstalled).
 * Resolution mirrors packages/desktop/src/chromium/index.ts findChromium().
 */

import { launch } from "puppeteer-core";
import type { Browser } from "puppeteer-core";

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

export async function launchBrowser(opts: { headed?: boolean } = {}): Promise<Browser> {
  const executablePath = findChromium();
  if (!executablePath) {
    throw new Error(
      "No chromium/chrome binary found. Install chromium or set CHROMIUM_BIN to a browser path.",
    );
  }
  const args = [
    // Deterministic rendering: fixed color profile, no scrollbars, no font hinting variance
    "--force-color-profile=srgb",
    "--hide-scrollbars",
    "--font-render-hinting=none",
    "--disable-gpu",
    "--disable-lcd-text",
  ];
  if (process.env.CI) {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }
  return launch({
    args,
    defaultViewport: null,
    executablePath,
    headless: !opts.headed,
  });
}
