/**
 * VerifyProject tests — mock the compiler's buildSite and puppeteer (via browser-local.ts) so the
 * full pipeline (build → serve → screenshot → diff → report) runs without a real browser. Fake
 * pages fetch from the real serveDirectory server and return in-memory PNGs built with pngjs.
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

// -- Mock browser-local.ts (launchBrowser / closeBrowser) ---------------------------------------------

let launchedBrowser: Browser | null = null;
let launchCount = 0;
let closeCount = 0;

void mock.module("../src/browser-local.ts", () => ({
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
  fullPage: (boolean | undefined)[];
  closed: boolean;
}

/**
 * `emit` stands in for the page events puppeteer would fire. The diagnostics listeners are what
 * turn "this page scores 8%" into "this page 404'd on fifteen images", so a fake that cannot fire
 * them would leave the interesting half of the verifier untested.
 */
function makeFakePage(
  opts: {
    png?: Buffer;
    failGoto?: boolean;
    /** Events to fire during `goto`, in order. */
    events?: { event: string; payload: unknown }[];
    /** Omit `page.on` entirely — a stand-in page that only screenshots must still work. */
    noEvents?: boolean;
  } = {},
): {
  page: Page;
  state: FakePageState;
} {
  const state: FakePageState = { viewports: [], urls: [], fullPage: [], closed: false };
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const page = {
    ...(opts.noEvents
      ? {}
      : {
          on(event: string, handler: (payload: unknown) => void) {
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
            return this;
          },
        }),
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
      for (const { event, payload } of opts.events ?? []) {
        for (const handler of listeners.get(event) ?? []) {
          handler(payload);
        }
      }
    },
    screenshot(screenshotOpts?: { fullPage?: boolean }) {
      state.fullPage.push(screenshotOpts?.fullPage);
      return Promise.resolve(new Uint8Array(opts.png ?? RED_PNG));
    },
    close() {
      state.closed = true;
      return Promise.resolve();
    },
  } as unknown as Page;
  return { page, state };
}

/** A `console` message the way puppeteer hands one over. */
function consoleMessage(type: string, text: string) {
  return { text: () => text, type: () => type };
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
    expect(result.buildErrors).toEqual([]);
    expect(result.passed).toBe(true);
    // The whole scrollable page, not the first 900px of it.
    expect(indexPage.state.fullPage).toEqual([true]);

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
      colorTolerance: number;
      minFidelity: number;
      fullPage: boolean;
      passed: boolean;
    };
    expect(report.averageFidelity).toBe(100);
    expect(report.pages.length).toBe(2);
    expect(report.buildErrors).toEqual([]);
    expect(report.viewport).toEqual({ width: 640, height: 480 });
    /*
     * Named for what it is. `threshold` in the report read like the bar the run had to clear, and
     * it is pixelmatch's per-pixel colour tolerance — the confusion is issue #232 in one word.
     */
    expect(report.colorTolerance).toBe(0.1);
    expect(report.minFidelity).toBe(0);
    expect(report.fullPage).toBe(true);
    expect(report.passed).toBe(true);

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
    /*
     * A perfect diff and still not a pass. The build errors used to be logged here, written into
     * report.json, and dropped — `importSite` never saw them, so a project that did not compile
     * exited 0 like any other (issue #232).
     */
    expect(result.buildErrors).toEqual(["missing layout"]);
    expect(result.passed).toBe(false);
    // Default reportDir is <projectDir>/verify
    expect(result.reportDir).toBe(join(projectDir, "verify"));
    const report = JSON.parse(readFileSync(join(result.reportDir, "report.json"), "utf8")) as {
      buildErrors: string[];
    };
    expect(report.buildErrors).toEqual(["missing layout"]);
  });
});

/*
 * Issue #232, the other half: the verifier could see why a page rendered badly and threw it away.
 * The first real import 404'd on fifteen asset references and the report carried a percentage and
 * nothing else — a console-error or failed-request count would have pointed straight at the cause.
 */
describe("verifyProject - what the page said while it rendered", () => {
  it("records console errors and failed requests per page", async () => {
    const projectDir = makeProjectDir();
    buildSiteImpl = (dir) => {
      writeDist(dir, ["/"]);
      return Promise.resolve({ errors: [] });
    };

    const { page } = makeFakePage({
      events: [
        { event: "console", payload: consoleMessage("error", "Failed to load resource") },
        { event: "console", payload: consoleMessage("warning", "just a warning") },
        { event: "pageerror", payload: new Error("x is not defined") },
        // A page can throw a non-Error, and that is still a page that broke.
        { event: "pageerror", payload: "thrown string" },
        {
          event: "response",
          payload: { status: () => 404, url: () => "/assets/images/logo.webp" },
        },
        { event: "response", payload: { status: () => 200, url: () => "/index.html" } },
        { event: "requestfailed", payload: { url: () => "/assets/fonts/inter.woff2" } },
      ],
    });

    const progress: string[] = [];
    const result = await verifyProject({
      projectDir,
      pages: new Map([
        ["pages/index.json", { sourceUrl: "https://example.com/", screenshot: RED_PNG }],
      ]),
      onProgress: (msg) => progress.push(msg),
      browser: makeFakeBrowser([page]),
    });

    // A warning is not an error, and a 200 is not a miss.
    expect(result.pages[0]!.consoleErrors).toEqual([
      "Failed to load resource",
      "x is not defined",
      "thrown string",
    ]);
    expect(result.pages[0]!.failedRequests).toEqual([
      "404 /assets/images/logo.webp",
      "failed /assets/fonts/inter.woff2",
    ]);
    expect(progress.some((m) => m.includes("2 request(s) failed or 404"))).toBe(true);
    expect(progress.some((m) => m.includes("3 console error(s)"))).toBe(true);

    const report = JSON.parse(readFileSync(join(result.reportDir, "report.json"), "utf8")) as {
      pages: { failedRequests: string[] }[];
    };
    expect(report.pages[0]!.failedRequests).toHaveLength(2);
  });

  // A stand-in page that only screenshots is still a usable page; diagnostics are then empty.
  it("works against a page that fires no events at all", async () => {
    const projectDir = makeProjectDir();
    buildSiteImpl = (dir) => {
      writeDist(dir, ["/"]);
      return Promise.resolve({ errors: [] });
    };

    const { page } = makeFakePage({ noEvents: true });
    const result = await verifyProject({
      projectDir,
      pages: new Map([
        ["pages/index.json", { sourceUrl: "https://example.com/", screenshot: RED_PNG }],
      ]),
      browser: makeFakeBrowser([page]),
    });

    expect(result.pages[0]!.consoleErrors).toEqual([]);
    expect(result.pages[0]!.failedRequests).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe("verifyProject - the fidelity bar", () => {
  /**
   * The run that motivated the issue: 8.17% fidelity, exit 0, `Done! Open in Studio:`.
   * `minFidelity` is what makes it a gate; `threshold` never could be — that one is pixelmatch's
   * per-pixel colour tolerance and only moves the score.
   */
  async function runAt(minFidelity: number, png: Buffer) {
    const projectDir = makeProjectDir();
    buildSiteImpl = (dir) => {
      writeDist(dir, ["/"]);
      return Promise.resolve({ errors: [] });
    };
    const { page } = makeFakePage({ png });
    return verifyProject({
      projectDir,
      pages: new Map([
        ["pages/index.json", { sourceUrl: "https://example.com/", screenshot: RED_PNG }],
      ]),
      minFidelity,
      browser: makeFakeBrowser([page]),
    });
  }

  it("fails a run that scores under the bar", async () => {
    const result = await runAt(50, makePng(16, 16, [0, 0, 255, 255]));

    expect(result.averageFidelity).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("passes the same run when the bar is 0 — report only, which is the default", async () => {
    const result = await runAt(0, makePng(16, 16, [0, 0, 255, 255]));

    expect(result.averageFidelity).toBe(0);
    expect(result.passed).toBe(true);
  });

  it("passes a run that clears the bar", async () => {
    const result = await runAt(50, RED_PNG);

    expect(result.averageFidelity).toBe(100);
    expect(result.passed).toBe(true);
  });

  // An errored page is excluded from the average, so without this it could pass by omission.
  it("fails when a page could not be rendered at all, whatever the others scored", async () => {
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
        ["pages/about.json", { sourceUrl: "https://example.com/about", screenshot: RED_PNG }],
      ]),
      browser: makeFakeBrowser([good.page, bad.page]),
    });

    expect(result.averageFidelity).toBe(100);
    expect(result.passed).toBe(false);
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
