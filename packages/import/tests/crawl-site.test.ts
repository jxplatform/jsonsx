/**
 * The crawlSite BFS: robots.txt handling, per-page capture/style/asset phases (capture and the
 * browser-facing style/asset modules mocked; the pure transforms real), link enqueueing, node-cap
 * skips, cross-page merging, failure resilience, and abort. Complements crawl.test.ts, which covers
 * the pure URL helpers.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedStyle } from "../src/style-capture.ts";

type FakeSite = Record<string, { title: string; bodyHtml: string; links: string[] }>;

let site: FakeSite = {};
const pageScreenshot = mock((_opts?: { fullPage?: boolean; type?: string }) =>
  Promise.resolve(new Uint8Array([1, 2, 3])),
);

const capturePage = mock((url: string) => {
  const entry = site[url];
  if (!entry) {
    return Promise.reject(new Error(`no route for ${url}`));
  }
  return Promise.resolve({
    url,
    title: entry.title,
    bodyHtml: entry.bodyHtml,
    links: entry.links,
    page: {
      close: mock(() => Promise.resolve()),
      screenshot: pageScreenshot,
    },
  });
});
const launchBrowser = mock(() => Promise.resolve({ fake: true }));
const closeBrowser = mock(() => Promise.resolve());
void mock.module("../src/capture.ts", () => ({ capturePage, launchBrowser, closeBrowser }));

const captureStyles = mock(() =>
  Promise.resolve({
    elements: [] as CapturedStyle[],
    uaDefaults: {} as Record<string, Record<string, string>>,
    mediaQueries: ["(max-width: 768px)"],
    customProperties: {} as Record<string, string>,
    documentStyles: { "background-color": "rgb(9, 9, 9)" } as Record<string, string>,
  }),
);
void mock.module("../src/style-capture.ts", () => ({ captureStyles }));

const extractMedia = mock(() =>
  Promise.resolve({
    breakpoints: { "--md": "(max-width: 768px)" } as Record<string, string>,
    deltas: {},
  }),
);
void mock.module("../src/media-extract.ts", () => ({ extractMedia }));

const collectAssets = mock(() =>
  Promise.resolve({
    assets: [{ url: "https://crawl.example/logo.png", kind: "image" }],
    inlineSvgCount: 0,
    stylesheets: [
      { href: "inline", cssText: "", fontFaceRules: ["@font-face { font-family: X }"] },
    ],
  }),
);
void mock.module("../src/asset-collect.ts", () => ({ collectAssets }));

const downloadAssets = mock(() =>
  Promise.resolve({
    rewriteMap: new Map([
      ["https://crawl.example/logo.png", "/assets/images/logo.png"],
      ["https://crawl.example/font.woff2", "/assets/fonts/font.woff2"],
    ]),
    failed: [],
    skipped: [],
    totalBytes: 100,
  }),
);
void mock.module("../src/asset-download.ts", () => ({ downloadAssets }));

const { crawlSite, fetchRobotsTxt } = await import("../src/crawl.ts");

const realFetch = globalThis.fetch;
let robotsBody: string | null = "";

beforeEach(() => {
  capturePage.mockClear();
  captureStyles.mockClear();
  collectAssets.mockClear();
  downloadAssets.mockClear();
  robotsBody = "";
  globalThis.fetch = mock((input: string | URL | Request) => {
    if (String(input).endsWith("/robots.txt")) {
      if (robotsBody === null) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve(new Response(robotsBody, { status: 200 }));
    }
    return realFetch(input as string);
  }) as unknown as typeof fetch;
});

function outDir(): string {
  return mkdtempSync(join(tmpdir(), "jx-crawl-test-"));
}

const HOME = "https://crawl.example/";

function seedSite() {
  site = {
    [HOME]: {
      title: "Home",
      bodyHtml: "<div><h1>Home</h1></div>",
      links: [
        "https://crawl.example/about",
        "https://crawl.example/about", // Duplicate — deduped by normalizeUrl
        "https://crawl.example/admin/panel",
        "https://other.example/away", // Cross-origin — never enqueued
      ],
    },
    "https://crawl.example/about": {
      title: "About",
      bodyHtml: "<div><h2>About</h2></div>",
      links: ["https://crawl.example/deep"],
    },
    "https://crawl.example/deep": {
      title: "Deep",
      bodyHtml: "<div><h3>Deep</h3></div>",
      links: [],
    },
  };
}

describe("fetchRobotsTxt", () => {
  test("collects wildcard-agent disallow prefixes", async () => {
    robotsBody = `# comment
User-agent: googlebot
Disallow: /google-only
User-agent: *
Disallow: /admin
Disallow:
`;
    const disallowed = await fetchRobotsTxt("https://crawl.example");
    expect(disallowed).toEqual(new Set(["/admin"]));
  });

  test("allows everything when robots.txt is unreachable", async () => {
    robotsBody = null;
    const disallowed = await fetchRobotsTxt("https://crawl.example");
    expect(disallowed.size).toBe(0);
  });

  test("allows everything on a non-ok robots.txt response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("gone", { status: 404 })),
    ) as unknown as typeof fetch;
    const disallowed = await fetchRobotsTxt("https://crawl.example");
    expect(disallowed.size).toBe(0);
  });
});

describe("crawlSite", () => {
  test("BFS-crawls same-origin links, respecting robots.txt and depth", async () => {
    seedSite();
    robotsBody = "User-agent: *\nDisallow: /admin";
    const messages: string[] = [];
    const result = await crawlSite({
      url: HOME,
      outDir: outDir(),
      maxDepth: 1,
      maxPages: 10,
      maxNodesPerPage: 5000,
      skipStyles: false,
      skipAssets: false,
      respectRobots: true,
      onProgress: (m) => messages.push(m),
    });

    // Home + about; /deep is beyond depth 1; /admin blocked by robots; other.example skipped.
    expect(result.pages.map((p) => p.route)).toEqual(["pages/index.json", "pages/about.json"]);
    expect(result.skippedByRobots).toEqual(["https://crawl.example/admin/panel"]);

    // Styles: breakpoints + document styles + tokens merged across pages.
    expect(result.breakpoints).toEqual({ "--md": "(max-width: 768px)" });
    expect(result.pages[0]?.jx.document.style?.backgroundColor).toBe("rgb(9, 9, 9)");

    // Assets: font-face rules deduped across pages, font rewrites collected.
    expect(result.fontFaceRules).toEqual(["@font-face { font-family: X }"]);
    expect(result.fontRewriteMap.get("https://crawl.example/font.woff2")).toBe(
      "/assets/fonts/font.woff2",
    );
    expect(messages.some((m) => m.includes("robots.txt"))).toBe(true);
  });

  test("skips styles/assets for pages above the node cap and keeps crawling", async () => {
    seedSite();
    const result = await crawlSite({
      url: HOME,
      outDir: outDir(),
      maxDepth: 1,
      maxPages: 10,
      maxNodesPerPage: 1,
      skipStyles: false,
      skipAssets: false,
      respectRobots: false,
      captureScreenshots: true,
      onProgress: () => {},
    });
    expect(result.skippedByNodeCap.length).toBeGreaterThan(0);
    expect(captureStyles).not.toHaveBeenCalled();
    expect(collectAssets).not.toHaveBeenCalled();
    // Screenshots still captured for capped pages.
    expect(result.pages[0]?.screenshot).toBeInstanceOf(Buffer);
    /*
     * Whole page by default, because the verifier renders the clone the same way. A viewport
     * reference diffed against a full-page render is compared by padding the shorter image, so the
     * two would disagree over everything below the fold before a single style was compared.
     */
    expect(pageScreenshot.mock.calls.at(-1)?.[0]).toEqual({ fullPage: true, type: "png" });
  });

  test("honours a viewport-only reference when asked for one", async () => {
    seedSite();
    await crawlSite({
      url: HOME,
      outDir: outDir(),
      maxDepth: 0,
      maxPages: 10,
      maxNodesPerPage: 5000,
      skipStyles: true,
      skipAssets: true,
      respectRobots: false,
      captureScreenshots: true,
      fullPageScreenshots: false,
      onProgress: () => {},
    });

    expect(pageScreenshot.mock.calls.at(-1)?.[0]).toEqual({ fullPage: false, type: "png" });
  });

  test("survives capture and style failures with warnings", async () => {
    seedSite();
    delete site["https://crawl.example/about"]; // CapturePage will reject for this URL
    captureStyles.mockRejectedValueOnce(new Error("style boom"));
    const messages: string[] = [];
    const result = await crawlSite({
      url: HOME,
      outDir: outDir(),
      maxDepth: 1,
      maxPages: 10,
      maxNodesPerPage: 5000,
      skipStyles: false,
      skipAssets: true,
      respectRobots: false,
      onProgress: (m) => messages.push(m),
    });
    expect(result.pages.map((p) => p.title)).toEqual(["Home"]);
    expect(messages.some((m) => m.includes("Style capture failed"))).toBe(true);
    expect(messages.some((m) => m.includes("Failed to capture"))).toBe(true);
  });

  test("stops at maxPages", async () => {
    seedSite();
    const result = await crawlSite({
      url: HOME,
      outDir: outDir(),
      maxDepth: 3,
      maxPages: 2,
      maxNodesPerPage: 5000,
      skipStyles: true,
      skipAssets: true,
      respectRobots: false,
      onProgress: () => {},
    });
    expect(result.pages).toHaveLength(2);
  });

  test("merges style tokens when custom properties match computed values", async () => {
    seedSite();
    captureStyles.mockResolvedValueOnce({
      elements: [{ path: [0], tagName: "h1", styles: { color: "rgb(1, 2, 3)" } }],
      uaDefaults: {},
      mediaQueries: [],
      customProperties: { "--brand": "rgb(1, 2, 3)" },
      documentStyles: {},
    });
    const result = await crawlSite({
      url: HOME,
      outDir: outDir(),
      maxDepth: 0,
      maxPages: 1,
      maxNodesPerPage: 5000,
      skipStyles: false,
      skipAssets: true,
      respectRobots: false,
      onProgress: () => {},
    });
    expect(result.styleTokens).toEqual({ "--brand": "rgb(1, 2, 3)" });
    // No @media queries on this page → no breakpoints merged.
    expect(result.breakpoints).toBeUndefined();
  });

  test("media queries without breakpoint deltas leave the merged set empty", async () => {
    seedSite();
    extractMedia.mockResolvedValueOnce({ breakpoints: {}, deltas: {} });
    const result = await crawlSite({
      url: HOME,
      outDir: outDir(),
      maxDepth: 0,
      maxPages: 1,
      maxNodesPerPage: 5000,
      skipStyles: false,
      skipAssets: true,
      respectRobots: false,
      onProgress: () => {},
    });
    expect(extractMedia).toHaveBeenCalled();
    expect(result.breakpoints).toBeUndefined();
  });

  test("survives asset-collection failures with a warning", async () => {
    seedSite();
    collectAssets.mockRejectedValueOnce(new Error("collect boom"));
    const messages: string[] = [];
    const result = await crawlSite({
      url: HOME,
      outDir: outDir(),
      maxDepth: 0,
      maxPages: 1,
      maxNodesPerPage: 5000,
      skipStyles: true,
      skipAssets: false,
      respectRobots: false,
      onProgress: (m) => messages.push(m),
    });
    expect(result.pages).toHaveLength(1);
    expect(messages.some((m) => m.includes("Asset collection failed"))).toBe(true);
  });

  test("throws when the signal aborts mid-crawl", async () => {
    seedSite();
    const controller = new AbortController();
    let captured = 0;
    capturePage.mockImplementation((url: string) => {
      captured += 1;
      if (captured >= 1) {
        controller.abort();
      }
      const entry = site[url]!;
      return Promise.resolve({
        url,
        title: entry.title,
        bodyHtml: entry.bodyHtml,
        links: entry.links,
        page: { close: mock(() => Promise.resolve()), screenshot: pageScreenshot },
      });
    });
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(
      crawlSite({
        url: HOME,
        outDir: outDir(),
        maxDepth: 2,
        maxPages: 10,
        maxNodesPerPage: 5000,
        skipStyles: true,
        skipAssets: true,
        respectRobots: false,
        onProgress: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow("Import aborted");
  });
});
