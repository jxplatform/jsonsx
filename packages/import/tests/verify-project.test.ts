/**
 * VerifyProject tests — mock the compiler's buildSite and puppeteer (via capture.ts) so the full
 * pipeline (build → serve → screenshot → diff → report) runs without a real browser. Fake pages
 * fetch from the real serveDirectory server and return in-memory PNGs built with pngjs.
 */

import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Browser, Page } from "puppeteer-core";

function makePng(width: number, height: number, fill: [number, number, number, number]): Buffer {
  const img = new PNG({ width, height });
  const [r, g, b, a] = fill;
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = a;
  }
  return PNG.sync.write(img);
}

const RED_PNG = makePng(16, 16, [255, 0, 0, 255]);

// -- Mock buildSite (swappable per test) --------------------------------------------------------

interface BuildSiteResult {
  errors: string[];
}
let buildSiteImpl: (dir: string) => Promise<BuildSiteResult> = () =>
  Promise.resolve({ errors: [] });

void mock.module("@jxsuite/compiler/site", () => ({
  buildSite: (dir: string) => buildSiteImpl(dir),
}));

// -- Mock capture.ts (launchBrowser / closeBrowser) ---------------------------------------------

let launchedBrowser: Browser | null = null;
let launchCount = 0;
let closeCount = 0;

void mock.module("../src/capture.ts", () => ({
  launchBrowser: () => {
    launchCount += 1;
    if (!launchedBrowser) {
      throw new Error("no fake browser configured");
    }
    return Promise.resolve(launchedBrowser);
  },
  closeBrowser: () => {
    closeCount += 1;
    return Promise.resolve();
  },
}));

const { verifyProject, captureReferenceScreenshot } = await import("../src/verify.ts");

// -- Fake puppeteer pages / browser -------------------------------------------------------------

interface FakePageState {
  viewports: { width: number; height: number }[];
  urls: string[];
  closed: boolean;
}

function makeFakePage(opts: { png?: Buffer; failGoto?: boolean } = {}): {
  page: Page;
  state: FakePageState;
} {
  const state: FakePageState = { viewports: [], urls: [], closed: false };
  const page = {
    setViewport(vp: { width: number; height: number }) {
      state.viewports.push(vp);
      return Promise.resolve();
    },
    async goto(url: string) {
      if (opts.failGoto) {
        throw new Error("goto failed");
      }
      // Exercise the real serveDirectory server the way a browser would
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      state.urls.push(url);
    },
    screenshot() {
      return Promise.resolve(new Uint8Array(opts.png ?? RED_PNG));
    },
    close() {
      state.closed = true;
      return Promise.resolve();
    },
  } as unknown as Page;
  return { page, state };
}

function makeFakeBrowser(pages: Page[]): Browser {
  let i = 0;
  return {
    newPage() {
      const page = pages[i];
      i += 1;
      if (!page) {
        throw new Error("no more fake pages");
      }
      return Promise.resolve(page);
    },
  } as unknown as Browser;
}

function makeProjectDir(): string {
  return mkdtempSync("/tmp/jx-import-verify-project-");
}

/** BuildSite stand-in that writes a minimal static site into <dir>/dist. */
function writeDist(dir: string, routes: string[]): void {
  for (const route of routes) {
    const target =
      route === "/" ? join(dir, "dist", "index.html") : join(dir, "dist", route, "index.html");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, `<html><body>${route}</body></html>`);
  }
}

// -- Tests ---------------------------------------------------------------------------------------

describe("verifyProject - success path", () => {
  it("builds, serves, screenshots, diffs, and writes a report", async () => {
    const projectDir = makeProjectDir();
    const reportDir = join(projectDir, "custom-report");
    buildSiteImpl = (dir) => {
      writeDist(dir, ["/", "about"]);
      return Promise.resolve({ errors: [] });
    };

    // Reference screenshot for "about" comes from a file on disk (path branch)
    const refPath = join(projectDir, "about-ref.png");
    writeFileSync(refPath, RED_PNG);

    const indexPage = makeFakePage();
    const aboutPage = makeFakePage();
    const browser = makeFakeBrowser([indexPage.page, aboutPage.page]);

    const progress: string[] = [];
    const result = await verifyProject({
      projectDir,
      pages: new Map([
        ["pages/index.json", { sourceUrl: "https://example.com/", screenshot: RED_PNG }],
        ["pages/about.json", { sourceUrl: "https://example.com/about", screenshot: refPath }],
      ]),
      reportDir,
      viewportWidth: 640,
      viewportHeight: 480,
      threshold: 0.1,
      onProgress: (msg) => progress.push(msg),
      browser,
    });

    expect(result.reportDir).toBe(reportDir);
    expect(result.pages.length).toBe(2);
    expect(result.pages[0]!.route).toBe("pages/index.json");
    expect(result.pages[0]!.fidelity).toBe(100);
    expect(result.pages[0]!.error).toBeUndefined();
    expect(result.pages[1]!.fidelity).toBe(100);
    expect(result.averageFidelity).toBe(100);

    // Fake pages hit the real local server at the mapped URL paths
    expect(indexPage.state.urls[0]).toMatch(/^http:\/\/localhost:\d+\/$/);
    expect(aboutPage.state.urls[0]).toMatch(/^http:\/\/localhost:\d+\/about$/);
    expect(indexPage.state.viewports[0]).toEqual({ width: 640, height: 480 });
    expect(indexPage.state.closed).toBe(true);
    expect(aboutPage.state.closed).toBe(true);

    // Artifacts on disk
    for (const name of [
      "index-original.png",
      "index-rendered.png",
      "index-diff.png",
      "about-original.png",
      "about-rendered.png",
      "about-diff.png",
      "report.json",
    ]) {
      expect(existsSync(join(reportDir, name))).toBe(true);
    }
    const report = JSON.parse(readFileSync(join(reportDir, "report.json"), "utf8")) as {
      averageFidelity: number;
      pages: unknown[];
      buildErrors: string[];
      viewport: { width: number; height: number };
    };
    expect(report.averageFidelity).toBe(100);
    expect(report.pages.length).toBe(2);
    expect(report.buildErrors).toEqual([]);
    expect(report.viewport).toEqual({ width: 640, height: 480 });

    expect(progress.some((m) => m.includes("Building project"))).toBe(true);
    expect(progress.some((m) => m.includes("Verifying pages/index.json"))).toBe(true);
    expect(progress.some((m) => m.includes("Fidelity: 100%"))).toBe(true);

    // A caller-provided browser must not be closed by verifyProject
    expect(closeCount).toBe(0);
  });

  it("reports build errors via onProgress and in report.json", async () => {
    const projectDir = makeProjectDir();
    buildSiteImpl = (dir) => {
      writeDist(dir, ["/"]);
      return Promise.resolve({ errors: ["missing layout"] });
    };

    const { page } = makeFakePage();
    const progress: string[] = [];
    const result = await verifyProject({
      projectDir,
      pages: new Map([
        ["pages/index.json", { sourceUrl: "https://example.com/", screenshot: RED_PNG }],
      ]),
      onProgress: (msg) => progress.push(msg),
      browser: makeFakeBrowser([page]),
    });

    expect(progress.some((m) => m.includes("Build completed with 1 error(s)"))).toBe(true);
    expect(result.averageFidelity).toBe(100);
    // Default reportDir is <projectDir>/verify
    expect(result.reportDir).toBe(join(projectDir, "verify"));
    const report = JSON.parse(readFileSync(join(result.reportDir, "report.json"), "utf8")) as {
      buildErrors: string[];
    };
    expect(report.buildErrors).toEqual(["missing layout"]);
  });
});

describe("verifyProject - failure paths", () => {
  it("returns per-page build-failure results when buildSite throws", async () => {
    const projectDir = makeProjectDir();
    buildSiteImpl = () => Promise.reject(new Error("boom"));

    const result = await verifyProject({
      projectDir,
      pages: new Map([
        ["pages/index.json", { sourceUrl: "https://example.com/", screenshot: RED_PNG }],
        ["pages/about.json", { sourceUrl: "https://example.com/about", screenshot: RED_PNG }],
      ]),
    });

    expect(result.averageFidelity).toBe(0);
    expect(result.pages.length).toBe(2);
    expect(result.pages[0]!.error).toBe("Build failed: boom");
    expect(result.pages[1]!.error).toBe("Build failed: boom");
    expect(result.pages[1]!.sourceUrl).toBe("https://example.com/about");
  });

  it("records a per-page error and keeps going when one page fails", async () => {
    const projectDir = makeProjectDir();
    buildSiteImpl = (dir) => {
      writeDist(dir, ["/"]);
      return Promise.resolve({ errors: [] });
    };

    const good = makeFakePage();
    const bad = makeFakePage({ failGoto: true });
    const result = await verifyProject({
      projectDir,
      pages: new Map([
        ["pages/index.json", { sourceUrl: "https://example.com/", screenshot: RED_PNG }],
        ["pages/broken.json", { sourceUrl: "https://example.com/broken", screenshot: RED_PNG }],
      ]),
      onProgress: () => {},
      browser: makeFakeBrowser([good.page, bad.page]),
    });

    expect(result.pages[0]!.fidelity).toBe(100);
    expect(result.pages[1]!.error).toBe("goto failed");
    expect(result.pages[1]!.fidelity).toBe(0);
    expect(result.pages[1]!.diffImagePath).toBe("");
    // Only successful pages count toward the average
    expect(result.averageFidelity).toBe(100);
  });

  it("launches and closes its own browser and averages 0 when every page fails", async () => {
    const projectDir = makeProjectDir();
    buildSiteImpl = (dir) => {
      writeDist(dir, ["/"]);
      return Promise.resolve({ errors: [] });
    };

    const bad = makeFakePage({ failGoto: true });
    launchedBrowser = makeFakeBrowser([bad.page]);
    const launchesBefore = launchCount;
    const closesBefore = closeCount;

    const result = await verifyProject({
      projectDir,
      pages: new Map([
        ["pages/index.json", { sourceUrl: "https://example.com/", screenshot: RED_PNG }],
      ]),
    });

    expect(result.pages[0]!.error).toBe("goto failed");
    expect(result.averageFidelity).toBe(0);
    expect(launchCount).toBe(launchesBefore + 1);
    expect(closeCount).toBe(closesBefore + 1);
  });
});

describe("captureReferenceScreenshot", () => {
  it("sets the default viewport and returns a PNG buffer", async () => {
    const { page, state } = makeFakePage();
    const buf = await captureReferenceScreenshot(page);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(RED_PNG)).toBe(true);
    expect(state.viewports[0]).toEqual({ width: 1440, height: 900 });
  });

  it("honors explicit dimensions", async () => {
    const { page, state } = makeFakePage();
    await captureReferenceScreenshot(page, 800, 600);
    expect(state.viewports[0]).toEqual({ width: 800, height: 600 });
  });
});
