/**
 * Page capture, and the browser surface the whole import is written against.
 *
 * That surface is declared STRUCTURALLY here rather than imported from `puppeteer-core`, and the
 * reason is bundling, not taste: `puppeteer-core` is unloadable in workerd, and a Worker bundler
 * follows value imports transitively, so a single one anywhere in `pipeline.ts`'s graph would fail
 * the deploy. Naming only `newPage` — and, on a page, the five calls the phases actually make —
 * lets the same code drive a local Chrome (`browser-local.ts`) or a `@cloudflare/puppeteer`
 * session, both of which provide exactly this and more.
 */

/**
 * What `evaluate` hands the in-page function.
 *
 * A homomorphic mapped type rather than plain `Params`, because puppeteer's own `evaluate` declares
 * its parameters through one (it unwraps `JSHandle`s there). Two generic signatures only relate
 * when they are shaped alike, and with a bare tuple puppeteer's `Page` stops being assignable to
 * `ImportPage` — which is the one thing this interface has to be true of.
 */
export type PageArgs<Params extends unknown[]> = { [K in keyof Params]: Params[K] };

export interface ImportPage {
  goto: (
    url: string,
    options?: {
      waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
      timeout?: number;
    },
  ) => Promise<unknown>;
  setViewport: (viewport: { width: number; height: number }) => Promise<unknown>;
  evaluate: <Params extends unknown[], R>(
    fn: (...params: PageArgs<Params>) => R,
    ...args: Params
  ) => Promise<Awaited<R>>;
  screenshot: (options?: { fullPage?: boolean; type?: "png" }) => Promise<Uint8Array>;
  close: () => Promise<unknown>;
}

export interface ImportBrowser {
  newPage: () => Promise<ImportPage>;
}

export interface CaptureResult {
  url: string;
  title: string;
  bodyHtml: string;
  /** Discovered same-origin links for the crawler (Phase 3). */
  links: string[];
  /** The page, kept open for style capture (Phase 1). Caller must close. */
  page: ImportPage;
}

export interface CaptureOptions {
  /** Scroll to bottom before capture to trigger lazy-loaded content (default: true). */
  scrollToBottom?: boolean;
}

/**
 * Scroll the page to the bottom in steps to trigger lazy-loaded images and intersection-observer
 * content, then scroll back to top. Settles between steps to let content render.
 */
async function scrollToRevealAll(page: ImportPage): Promise<void> {
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
 *
 * The browser is a parameter and has no default. It used to fall back to launching a local Chrome,
 * and that fallback was the value import of `puppeteer-core` that kept this module — and everything
 * that reaches it — out of a Worker.
 */
export async function capturePage(
  url: string,
  browser: ImportBrowser,
  options?: CaptureOptions,
): Promise<CaptureResult> {
  const { scrollToBottom = true } = options ?? {};
  const page = await browser.newPage();
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
