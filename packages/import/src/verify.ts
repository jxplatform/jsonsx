/**
 * Verify — render each emitted page in the Jx runtime, screenshot-diff vs the captured original,
 * and report a per-page fidelity score.
 *
 * Uses the compiler's `buildSite` to produce static HTML, serves it locally via Bun, then
 * screenshots both original and rendered pages with puppeteer for pixel comparison.
 */

import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import type { Browser, Page } from "puppeteer-core";
import { launchBrowser, closeBrowser } from "./capture.ts";
import { diffScreenshots } from "./screenshot-diff.ts";

export interface VerifyOptions {
  /** The emitted Jx project directory (contains project.json). */
  projectDir: string;
  /** Map of route path → original source URL for each page. */
  pageUrls: Map<string, string>;
  /** Viewport width (default: 1440). */
  viewportWidth?: number;
  /** Viewport height (default: 900). */
  viewportHeight?: number;
  /** Where to write diff images and the report (default: <projectDir>/verify/). */
  reportDir?: string;
  /** Pixelmatch threshold (default: 0.15). */
  threshold?: number;
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
  error?: string;
}

export interface VerifyResult {
  pages: PageVerifyResult[];
  /** Average fidelity across all pages. */
  averageFidelity: number;
  reportDir: string;
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

async function screenshotPage(
  page: Page,
  url: string,
  width: number,
  height: number,
): Promise<Buffer> {
  await page.setViewport({ width, height });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });
  // Wait a bit for any late paints
  await new Promise<void>((r) => {
    setTimeout(r, 500);
  });
  const screenshot = await page.screenshot({ type: "png", fullPage: false });
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
        const contentType = filePath.endsWith(".html")
          ? "text/html"
          : filePath.endsWith(".css")
            ? "text/css"
            : filePath.endsWith(".js")
              ? "application/javascript"
              : "application/octet-stream";
        return new Response(file, { headers: { "Content-Type": contentType } });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return { server, baseUrl: `http://localhost:${server.port}` };
}

/**
 * Verify a cloned Jx project against its original source URLs.
 *
 * 1. Build the project to static HTML via the Jx compiler
 * 2. Serve the built output locally
 * 3. For each page: screenshot original URL + screenshot local rendered page
 * 4. Pixel-diff and report fidelity
 */
export async function verifyProject(opts: VerifyOptions): Promise<VerifyResult> {
  const {
    projectDir,
    pageUrls,
    viewportWidth = 1440,
    viewportHeight = 900,
    threshold = 0.15,
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
      pages: [...pageUrls.entries()].map(([route, sourceUrl]) => ({
        route,
        sourceUrl,
        fidelity: 0,
        mismatchedPixels: 0,
        totalPixels: 0,
        diffImagePath: "",
        originalScreenshotPath: "",
        renderedScreenshotPath: "",
        error: `Build failed: ${err.message}`,
      })),
      averageFidelity: 0,
      reportDir,
    };
  }

  // Step 2: Serve the built output
  onProgress("Starting local server for rendered pages...");
  const { server, baseUrl } = serveDirectory(distDir);

  const browser = opts.browser ?? (await launchBrowser());
  const results: PageVerifyResult[] = [];

  try {
    // Step 3: Screenshot and diff each page
    for (const [route, sourceUrl] of pageUrls) {
      const urlPath = routeToUrlPath(route);
      const safeName = urlPath === "/" ? "index" : urlPath.slice(1).replaceAll("/", "-");

      onProgress(`  Verifying ${route} (${sourceUrl})...`);

      try {
        // Screenshot original
        onProgress(`    Screenshotting original: ${sourceUrl}`);
        const origPage = await browser.newPage();
        const originalPng = await screenshotPage(
          origPage,
          sourceUrl,
          viewportWidth,
          viewportHeight,
        );
        await origPage.close();

        // Screenshot rendered
        const renderedUrl = `${baseUrl}${urlPath}`;
        onProgress(`    Screenshotting rendered: ${renderedUrl}`);
        const renderedPage = await browser.newPage();
        const renderedPng = await screenshotPage(
          renderedPage,
          renderedUrl,
          viewportWidth,
          viewportHeight,
        );
        await renderedPage.close();

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
          sourceUrl,
          fidelity: diff.fidelity,
          mismatchedPixels: diff.mismatchedPixels,
          totalPixels: diff.totalPixels,
          diffImagePath: diffPath,
          originalScreenshotPath: origPath,
          renderedScreenshotPath: renderedPath,
        });
      } catch (error) {
        const err = error as Error;
        onProgress(`    Error: ${err.message}`);
        results.push({
          route,
          sourceUrl,
          fidelity: 0,
          mismatchedPixels: 0,
          totalPixels: 0,
          diffImagePath: "",
          originalScreenshotPath: "",
          renderedScreenshotPath: "",
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

    const report = {
      timestamp: new Date().toISOString(),
      projectDir,
      viewport: { width: viewportWidth, height: viewportHeight },
      threshold,
      averageFidelity,
      pages: results,
      buildErrors: buildErrors ?? [],
    };
    writeFileSync(join(reportDir, "report.json"), JSON.stringify(report, null, 2));

    return { pages: results, averageFidelity, reportDir };
  } finally {
    server.stop();
    if (!opts.browser) {
      await closeBrowser();
    }
  }
}
