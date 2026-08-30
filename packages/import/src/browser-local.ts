/**
 * Launching a real Chrome on this machine — the one module in the import that loads
 * `puppeteer-core` as a VALUE.
 *
 * It is separate from `capture.ts` for a bundling reason rather than a tidiness one.
 * `puppeteer-core` cannot run in workerd at all (it reaches for `child_process`, `net` and a binary
 * on disk), and a Worker bundler follows value imports transitively — so a single `import { launch
 * }` anywhere in `pipeline.ts`'s graph would pull the whole of it in and fail the deploy. Keeping
 * the launch here, and having every phase take a browser it was HANDED, is what lets Jx Cloud run
 * the same pipeline against a `@cloudflare/puppeteer` session.
 */

import { launch } from "puppeteer-core";
import type { Browser } from "puppeteer-core";

const DEFAULT_CHROME_PATHS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
];

function findChrome(executablePath?: string): string {
  if (executablePath) {
    return executablePath;
  }
  const env = process.env.CHROME_PATH;
  if (env) {
    return env;
  }

  for (const name of DEFAULT_CHROME_PATHS) {
    const path = Bun.which(name);
    if (path) {
      return path;
    }
  }
  throw new Error(
    "Could not find Chrome/Chromium. Set CHROME_PATH or install google-chrome-stable.",
  );
}

let _browser: Browser | null = null;

export interface LaunchOptions {
  /** Explicit browser binary. Wins over CHROME_PATH and PATH discovery. */
  executablePath?: string;
}

export async function launchBrowser(options?: LaunchOptions): Promise<Browser> {
  if (_browser?.connected) {
    return _browser;
  }
  _browser = await launch({
    executablePath: findChrome(options?.executablePath),
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser?.connected) {
    await _browser.close();
    _browser = null;
  }
}
