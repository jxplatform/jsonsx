/**
 * Verify — render each emitted page in the Jx runtime, screenshot-diff vs the captured original,
 * and report a per-page fidelity score.
 *
 * Uses the compiler's `buildSite` to produce static HTML, serves it locally via Bun, then
 * screenshots the rendered pages with puppeteer and diffs against reference screenshots captured
 * during import.
 */

import { extname, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { Browser, Page } from "puppeteer-core";
import { launchBrowser, closeBrowser } from "./browser-local.ts";
import { diffScreenshots } from "./screenshot-diff.ts";

export interface PageRef {
  sourceUrl: string;
  /** Pre-captured reference screenshot (PNG buffer or path to a .png file on disk). */
  screenshot: Buffer | string;
}

export interface VerifyOptions {
  /** The emitted Jx project directory (contains project.json). */
  projectDir: string;
  /** Map of route path (e.g. "pages/index.json") → page reference data. */
  pages: Map<string, PageRef>;
  /** Viewport width (default: 1440). */
  viewportWidth?: number;
  /** Viewport height (default: 900). */
  viewportHeight?: number;
  /** Where to write diff images and the report (default: <projectDir>/verify/). */
  reportDir?: string;
  /**
   * Pixelmatch's per-pixel COLOUR tolerance, 0..1 (default 0.15).
   *
   * It decides when two pixels count as the same colour, so it moves the score; it is not a
   * pass/fail bar. `minFidelity` is the bar. Calling this one a "threshold" is what let a run
   * scoring 8% exit 0 (issue #232).
   */
  threshold?: number;
  /**
   * The average fidelity, 0..100, below which the run is a failure (default 0 — report only).
   *
   * Reported as `passed`; the caller decides what to do with it. `jx-import` exits non-zero.
   */
  minFidelity?: number;
  /**
   * Compare the whole scrollable page rather than the viewport (default true).
   *
   * It used to be the first 900px, which on a long marketing page is a small fraction of what was
   * imported — most of the clone was never looked at.
   */
  fullPage?: boolean;
  /** Progress callback. */
  onProgress?: (msg: string) => void;
  /** Existing browser instance to reuse. */
  browser?: Browser;
}

export interface PageVerifyResult {
  route: string;
  sourceUrl: string;
  fidelity: number;
  mismatchedPixels: number;
  totalPixels: number;
  diffImagePath: string;
  originalScreenshotPath: string;
  renderedScreenshotPath: string;
  /**
   * Console errors and uncaught exceptions the rendered page produced.
   *
   * A fidelity number says the clone looks wrong; these say why. The first import measured 404'd on
   * 15 asset references and the verify pass reported a percentage and nothing else.
   */
  consoleErrors: string[];
  /** Requests the rendered page made that failed or answered 4xx/5xx, as "<status> <url>". */
  failedRequests: string[];
  error?: string;
}

export interface VerifyResult {
  pages: PageVerifyResult[];
  /** Average fidelity across all pages. */
  averageFidelity: number;
  reportDir: string;
  /**
   * Errors the compiler reported while building the project.
   *
   * Previously logged, written into report.json, and then dropped — `verifyProject` carried on and
   * `importSite` never saw them, so a project that did not build still exited 0.
   */
  buildErrors: string[];
  /**
   * Whether this run met its bar: it built cleanly, every page rendered, and the average fidelity
   * reached `minFidelity`. The single fact a caller needs to gate on.
   */
  passed: boolean;
}

/**
 * Map a source page route (e.g. "pages/about.json") to the URL path the built site serves.
 * "pages/index.json" → "/", "pages/about.json" → "/about", "pages/blog/post-1.json" →
 * "/blog/post-1"
 */
export function routeToUrlPath(route: string): string {
  let path = route
    .replace(/^pages\//, "/")
    .replace(/\.json$/, "")
    .replace(/\/index$/, "/");
  if (path !== "/" && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  return path;
}

/** What the rendered page said about itself while it loaded. */
interface PageDiagnostics {
  consoleErrors: string[];
  failedRequests: string[];
}

/**
 * Listen for the two things a fidelity percentage cannot tell you: what the page logged, and what
 * it asked for and did not get.
 *
 * Attached before `goto`, because a 404 on an asset referenced in the HTML happens during the
 * navigation. Registration is optional — a stand-in page that only screenshots is still usable, and
 * diagnostics are then simply empty rather than a crash.
 */
function watchPage(page: Page): PageDiagnostics {
  const diagnostics: PageDiagnostics = { consoleErrors: [], failedRequests: [] };
  if (typeof (page as Partial<Page>).on !== "function") {
    return diagnostics;
  }
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      diagnostics.consoleErrors.push(msg.text());
    }
  });
  // `pageerror` carries `Error | unknown`: a page can reject with anything at all, and a thrown
  // String is still a page that broke.
  page.on("pageerror", (error) => {
    diagnostics.consoleErrors.push(error instanceof Error ? error.message : String(error));
  });
  page.on("requestfailed", (request) => {
    diagnostics.failedRequests.push(`failed ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });
  return diagnostics;
}

async function screenshotPage(
  page: Page,
  url: string,
  width: number,
  height: number,
  fullPage: boolean,
): Promise<Buffer> {
  await page.setViewport({ width, height });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });
  await new Promise<void>((r) => {
    setTimeout(r, 500);
  });
  const screenshot = await page.screenshot({ fullPage, type: "png" });
  return Buffer.from(screenshot);
}

/**
 * Take a reference screenshot of a live page via puppeteer. Called during import so the screenshot
 * is captured at the same time as the DOM.
 */
export async function captureReferenceScreenshot(
  page: Page,
  width = 1440,
  height = 900,
  fullPage = true,
): Promise<Buffer> {
  await page.setViewport({ width, height });
  const screenshot = await page.screenshot({ fullPage, type: "png" });
  return Buffer.from(screenshot);
}

/** Build the Jx project to static HTML using the compiler. */
async function buildProject(projectDir: string): Promise<{ distDir: string; errors: string[] }> {
  const { buildSite } = await import("@jxsuite/compiler/site");
  const distDir = join(projectDir, "dist");
  const result = await buildSite(projectDir, { clean: true, verbose: false });
  return { distDir, errors: result.errors };
}

/**
 * What the verify server declares for each extension it can serve.
 *
 * `.html`, `.css` and `.js` were the whole map, so every SVG, PNG, WOFF2 and JSON went out as
 * `application/octet-stream`. A browser will not render an `<img src>` served as a binary blob and
 * will not use a font it was handed as one, which cost the clone fidelity points that were not the
 * importer's fault at all (issue #232).
 */
const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

/**
 * Serve a directory over HTTP using Bun's built-in server. Returns the server instance and the base
 * URL.
 */
export function serveDirectory(dir: string): {
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
} {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      let { pathname } = new URL(req.url);
      if (pathname === "/") {
        pathname = "/index.html";
      } else if (!pathname.includes(".")) {
        pathname = `${pathname}/index.html`;
      }

      const filePath = join(dir, pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const contentType =
          CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
        return new Response(file, { headers: { "Content-Type": contentType } });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return { server, baseUrl: `http://localhost:${server.port}` };
}

function resolveScreenshot(ref: Buffer | string): Buffer {
  if (Buffer.isBuffer(ref)) {
    return ref;
  }
  return readFileSync(ref);
}

/**
 * Verify a cloned Jx project against reference screenshots captured during import.
 *
 * 1. Build the project to static HTML via the Jx compiler
 * 2. Serve the built output locally
 * 3. For each page: screenshot the rendered page, diff against the reference screenshot
 * 4. Report per-page fidelity
 */
export async function verifyProject(opts: VerifyOptions): Promise<VerifyResult> {
  const {
    projectDir,
    pages,
    viewportWidth = 1440,
    viewportHeight = 900,
    threshold = 0.15,
    minFidelity = 0,
    fullPage = true,
    onProgress = () => {},
  } = opts;

  const reportDir = opts.reportDir ?? join(projectDir, "verify");
  mkdirSync(reportDir, { recursive: true });

  // Step 1: Build the project
  onProgress("Building project to static HTML...");
  let distDir: string;
  let buildErrors: string[];
  try {
    const buildResult = await buildProject(projectDir);
    ({ distDir } = buildResult);
    buildErrors = buildResult.errors;
    if (buildErrors.length > 0) {
      onProgress(`  Build completed with ${buildErrors.length} error(s)`);
    }
  } catch (error) {
    const err = error as Error;
    return {
      pages: [...pages.entries()].map(([route, ref]) => ({
        route,
        sourceUrl: ref.sourceUrl,
        fidelity: 0,
        mismatchedPixels: 0,
        totalPixels: 0,
        diffImagePath: "",
        originalScreenshotPath: "",
        renderedScreenshotPath: "",
        consoleErrors: [],
        failedRequests: [],
        error: `Build failed: ${err.message}`,
      })),
      averageFidelity: 0,
      reportDir,
      buildErrors: [`Build failed: ${err.message}`],
      passed: false,
    };
  }

  // Step 2: Serve the built output
  onProgress("Starting local server for rendered pages...");
  const { server, baseUrl } = serveDirectory(distDir);

  const browser = opts.browser ?? (await launchBrowser());
  const results: PageVerifyResult[] = [];

  try {
    // Step 3: Screenshot rendered pages and diff against references
    for (const [route, ref] of pages) {
      const urlPath = routeToUrlPath(route);
      const safeName = urlPath === "/" ? "index" : urlPath.slice(1).replaceAll("/", "-");

      onProgress(`  Verifying ${route}...`);

      try {
        const originalPng = resolveScreenshot(ref.screenshot);

        // Screenshot rendered
        const renderedUrl = `${baseUrl}${urlPath}`;
        onProgress(`    Screenshotting rendered: ${renderedUrl}`);
        const renderedPage = await browser.newPage();
        // Listeners go on before the navigation — a 404 on an asset named in the HTML happens
        // During it, and that is exactly the class of failure the score alone cannot explain.
        const diagnostics = watchPage(renderedPage);
        const renderedPng = await screenshotPage(
          renderedPage,
          renderedUrl,
          viewportWidth,
          viewportHeight,
          fullPage,
        );
        await renderedPage.close();
        if (diagnostics.failedRequests.length > 0) {
          onProgress(`    ${diagnostics.failedRequests.length} request(s) failed or 404'd`);
        }
        if (diagnostics.consoleErrors.length > 0) {
          onProgress(`    ${diagnostics.consoleErrors.length} console error(s)`);
        }

        // Diff
        onProgress("    Computing pixel diff...");
        const diff = diffScreenshots(originalPng, renderedPng, { threshold });

        // Write artifacts
        const origPath = join(reportDir, `${safeName}-original.png`);
        const renderedPath = join(reportDir, `${safeName}-rendered.png`);
        const diffPath = join(reportDir, `${safeName}-diff.png`);

        writeFileSync(origPath, originalPng);
        writeFileSync(renderedPath, renderedPng);
        writeFileSync(diffPath, diff.diffPng);

        onProgress(`    Fidelity: ${diff.fidelity}% (${diff.mismatchedPixels} mismatched pixels)`);

        results.push({
          route,
          sourceUrl: ref.sourceUrl,
          fidelity: diff.fidelity,
          mismatchedPixels: diff.mismatchedPixels,
          totalPixels: diff.totalPixels,
          diffImagePath: diffPath,
          originalScreenshotPath: origPath,
          renderedScreenshotPath: renderedPath,
          consoleErrors: diagnostics.consoleErrors,
          failedRequests: diagnostics.failedRequests,
        });
      } catch (error) {
        const err = error as Error;
        onProgress(`    Error: ${err.message}`);
        results.push({
          route,
          sourceUrl: ref.sourceUrl,
          fidelity: 0,
          mismatchedPixels: 0,
          totalPixels: 0,
          diffImagePath: "",
          originalScreenshotPath: "",
          renderedScreenshotPath: "",
          consoleErrors: [],
          failedRequests: [],
          error: err.message,
        });
      }
    }

    // Step 4: Write summary report
    const successfulPages = results.filter((r) => !r.error);
    const averageFidelity =
      successfulPages.length > 0
        ? Math.round(
            (successfulPages.reduce((sum, r) => sum + r.fidelity, 0) / successfulPages.length) *
              100,
          ) / 100
        : 0;

    /*
     * A run passes only if all three hold. Any one of them alone can be silently wrong: a project
     * that did not build still renders SOMETHING, a page that failed to screenshot is excluded
     * from the average rather than dragging it down, and a page that rendered can still be a
     * different site. Previously none of them could fail the run — an 8%-fidelity clone printed
     * `Done!` and exited 0, which is worse than failing because it is only visible to somebody who
     * opens the result and looks at it (issue #232).
     */
    const errored = results.filter((r) => r.error);
    const passed =
      (buildErrors ?? []).length === 0 && errored.length === 0 && averageFidelity >= minFidelity;

    const report = {
      timestamp: new Date().toISOString(),
      projectDir,
      viewport: { width: viewportWidth, height: viewportHeight },
      fullPage,
      /** Pixelmatch's per-pixel colour tolerance — see `VerifyOptions.threshold`. */
      colorTolerance: threshold,
      minFidelity,
      averageFidelity,
      passed,
      pages: results,
      buildErrors: buildErrors ?? [],
    };
    writeFileSync(join(reportDir, "report.json"), JSON.stringify(report, null, 2));

    return {
      pages: results,
      averageFidelity,
      reportDir,
      buildErrors: buildErrors ?? [],
      passed,
    };
  } finally {
    void server.stop();
    if (!opts.browser) {
      await closeBrowser();
    }
  }
}
