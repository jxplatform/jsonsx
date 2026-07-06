import { launch } from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";

export interface CaptureResult {
  url: string;
  title: string;
  bodyHtml: string;
  /** Discovered same-origin links for the crawler (Phase 3). */
  links: string[];
  /** The puppeteer Page, kept open for style capture (Phase 1). Caller must close. */
  page: Page;
}

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

export interface CaptureOptions {
  /** Scroll to bottom before capture to trigger lazy-loaded content (default: true). */
  scrollToBottom?: boolean;
}

/**
 * Scroll the page to the bottom in steps to trigger lazy-loaded images and intersection-observer
 * content, then scroll back to top. Settles between steps to let content render.
 */
async function scrollToRevealAll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const delay = (ms: number) =>
      new Promise<void>((r) => {
        setTimeout(r, ms);
      });
    const scrollHeight = () => document.body.scrollHeight;
    const viewportHeight = window.innerHeight;
    let lastHeight = 0;
    let currentPosition = 0;

    // Scroll down in viewport-sized steps
    while (currentPosition < scrollHeight()) {
      currentPosition += viewportHeight;
      window.scrollTo(0, currentPosition);
      await delay(100);

      // If the page grew (infinite scroll), keep going but cap at 20 iterations
      if (scrollHeight() > lastHeight) {
        lastHeight = scrollHeight();
      }
      if (currentPosition > viewportHeight * 20) {
        break;
      }
    }

    // Settle for lazy images that load on scroll
    await delay(300);

    // Scroll back to top for the reference screenshot
    window.scrollTo(0, 0);
    await delay(100);
  });
}

/**
 * Capture a page's DOM. Returns the page object still open — the caller is responsible for closing
 * it (after style capture in Phase 1, or immediately).
 */
export async function capturePage(
  url: string,
  browser?: Browser,
  options?: CaptureOptions,
): Promise<CaptureResult> {
  const { scrollToBottom = true } = options ?? {};
  const br = browser ?? (await launchBrowser());
  const page: Page = await br.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });

  // R1: Scroll to bottom to trigger lazy-loaded content before capture
  if (scrollToBottom) {
    await scrollToRevealAll(page);
  }

  const result = await page.evaluate(() => {
    // Strip scripts and noscript before capture
    for (const el of document.querySelectorAll("script, noscript")) {
      el.remove();
    }

    const links: string[] = [];
    const { origin } = location;
    for (const a of document.querySelectorAll("a[href]")) {
      try {
        const { href } = new URL((a as HTMLAnchorElement).href, location.href);
        if (href.startsWith(origin) && !href.includes("#")) {
          links.push(href);
        }
      } catch {
        // Skip invalid URLs
      }
    }

    return {
      title: document.title,
      bodyHtml: document.body.innerHTML,
      links: [...new Set(links)],
    };
  });

  return { url, ...result, page };
}
