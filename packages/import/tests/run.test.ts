/**
 * The importSite orchestrator: option validation, phase sequencing, progress events, warnings,
 * abort handling, and the single-page vs crawl branches. All browser/FS-touching phase modules are
 * mocked; the pure transforms (convertToJx, style-diff, apply-styles, layout-detect) run for real.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JxElement } from "@jxsuite/schema/types";
import type { CapturedStyle } from "../src/style-capture.ts";

const pageClose = mock(() => Promise.resolve());
const fakeBrowser = { fake: true };

const launchBrowser = mock((_opts?: Record<string, unknown>) => Promise.resolve(fakeBrowser));
const closeBrowser = mock(() => Promise.resolve());
const capturePage = mock((_url: string, _browser?: unknown, _opts?: Record<string, unknown>) =>
  Promise.resolve({
    url: "https://site.example/",
    title: "Example Site",
    bodyHtml: "<div><h1>Hello</h1><p>World</p></div>",
    links: ["https://site.example/about"],
    page: { close: pageClose },
  }),
);
void mock.module("../src/capture.ts", () => ({ launchBrowser, closeBrowser, capturePage }));

const captureStyles = mock(() =>
  Promise.resolve({
    elements: [] as CapturedStyle[],
    uaDefaults: {} as Record<string, Record<string, string>>,
    mediaQueries: [] as string[],
    customProperties: {} as Record<string, string>,
    documentStyles: { "background-color": "rgb(1, 2, 3)" } as Record<string, string>,
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
    assets: [{ url: "https://site.example/hero.jpg", kind: "image" }],
    inlineSvgCount: 0,
    stylesheets: [{ href: "inline", cssText: "", fontFaceRules: ["@font-face { }"] }],
  }),
);
void mock.module("../src/asset-collect.ts", () => ({ collectAssets }));

const downloadAssets = mock(() =>
  Promise.resolve({
    rewriteMap: new Map([
      ["https://site.example/hero.jpg", "/assets/images/hero.jpg"],
      ["https://site.example/font.woff2", "/assets/fonts/font.woff2"],
    ]),
    failed: ["https://site.example/broken.png"],
    skipped: [] as string[],
    totalBytes: 2048,
  }),
);
void mock.module("../src/asset-download.ts", () => ({ downloadAssets }));

const emitMultiPageProject = mock((_opts: Record<string, unknown>) =>
  Promise.resolve({ files: ["project.json", "a", "b"] }),
);
void mock.module("../src/emit.ts", () => ({ emitMultiPageProject }));

const componentize = mock(() => ({
  components: new Map([["component-div-0", { tagName: "component-div-0" }]]),
  rewrittenPages: new Map<string, JxElement>(),
}));
void mock.module("../src/componentize.ts", () => ({ componentize }));

const aiComponentize = mock(
  (_heuristic: unknown, _opts: Record<string, unknown>, onProgress?: (msg: string) => void) => {
    onProgress?.("Renamed component-div-0 → hero-banner");
    return Promise.resolve({
      components: new Map([["hero-banner", { tagName: "hero-banner" }]]),
      rewrittenPages: new Map<string, JxElement>(),
    });
  },
);
void mock.module("../src/ai-componentize.ts", () => ({ aiComponentize }));

const captureReferenceScreenshot = mock(() => Promise.resolve(Buffer.from("png")));
const verifyProject = mock((_opts: Record<string, unknown>) => {
  (_opts.onProgress as ((msg: string) => void) | undefined)?.("Building site...");
  return Promise.resolve({
    pages: [
      {
        route: "pages/index.json",
        sourceUrl: "https://site.example/",
        fidelity: 97.5,
        mismatchedPixels: 10,
        totalPixels: 400,
        diffImagePath: "d",
        originalScreenshotPath: "o",
        renderedScreenshotPath: "r",
      },
    ],
    averageFidelity: 97.5,
    reportDir: "/tmp/report",
  });
});
void mock.module("../src/verify.ts", () => ({ captureReferenceScreenshot, verifyProject }));

const page = (title: string, extra?: JxElement[]): JxElement => ({
  tagName: "div",
  children: [
    { tagName: "header", children: ["Shared header"] },
    { tagName: "main", children: [title, ...(extra ?? [])] },
    { tagName: "footer", children: ["Shared footer"] },
  ],
});

const crawlSite = mock((_opts: Record<string, unknown>) => {
  (_opts.onProgress as ((msg: string) => void) | undefined)?.("  [1/10] Capturing...");
  return Promise.resolve({
    pages: [
      {
        url: "https://site.example/",
        route: "pages/index.json",
        title: "Home",
        jx: { document: page("Home"), nodeCount: 4, collectedStyles: [] },
        depth: 0,
        links: [],
      },
      {
        url: "https://site.example/about",
        route: "pages/about.json",
        title: "About",
        jx: { document: page("About"), nodeCount: 4, collectedStyles: [] },
        depth: 1,
        links: [],
        screenshot: Buffer.from("png"),
      },
    ],
    breakpoints: { "--sm": "(max-width: 640px)" } as Record<string, string> | undefined,
    skippedByRobots: ["https://site.example/admin"],
    skippedByNodeCap: ["https://site.example/huge"],
    fontFaceRules: [] as string[],
    fontRewriteMap: new Map<string, string>(),
    styleTokens: undefined,
  });
});
void mock.module("../src/crawl.ts", () => ({ crawlSite }));

const { importSite } = await import("../src/run.ts");

interface ProgressEvent {
  phase: string;
  message: string;
}

function freshOutDir(): string {
  const base = mkdtempSync(join(tmpdir(), "jx-run-test-"));
  return join(base, "out");
}

beforeEach(() => {
  for (const m of [
    launchBrowser,
    closeBrowser,
    capturePage,
    captureStyles,
    extractMedia,
    collectAssets,
    downloadAssets,
    emitMultiPageProject,
    componentize,
    aiComponentize,
    captureReferenceScreenshot,
    verifyProject,
    crawlSite,
    pageClose,
  ]) {
    m.mockClear();
  }
});

describe("importSite — validation", () => {
  test("rejects a non-http(s) URL", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(importSite({ url: "ftp://x", outDir: freshOutDir() })).rejects.toThrow(
      "URL must start with http:// or https://",
    );
  });

  test("rejects a relative outDir", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(importSite({ url: "https://x.example", outDir: "relative/dir" })).rejects.toThrow(
      "absolute path",
    );
  });

  test("rejects a non-empty outDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-run-nonempty-"));
    writeFileSync(join(dir, "existing.txt"), "x");
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(importSite({ url: "https://x.example", outDir: dir })).rejects.toThrow(
      "is not empty",
    );
  });
});

describe("importSite — single-page mode", () => {
  test("runs capture → styles → assets → emit and reports progress", async () => {
    const events: ProgressEvent[] = [];
    const outDir = freshOutDir();
    const result = await importSite({ url: "https://site.example/", outDir, maxDepth: 0 }, (e) => {
      events.push(e);
    });

    const phases = events.map((e) => e.phase);
    for (const phase of ["launch", "capture", "styles", "assets", "emit", "done"]) {
      expect(phases).toContain(phase);
    }
    expect(result.outDir).toBe(outDir);
    expect(result.pages).toEqual([
      { route: "pages/index.json", title: "Example Site", nodeCount: expect.any(Number) },
    ]);
    expect(result.fileCount).toBe(3);
    expect(result.verify).toBeNull();
    // Failed asset downloads surface as warnings.
    expect(result.warnings.some((w) => w.includes("failed to download"))).toBe(true);
    expect(pageClose).toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalled();
    // No @media queries in the mock → extractMedia is never consulted.
    expect(extractMedia).not.toHaveBeenCalled();
  });

  test("threads the chrome path into launchBrowser", async () => {
    await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      maxDepth: 0,
      chromePath: "/opt/chromium/bin/chromium",
    });
    expect(launchBrowser).toHaveBeenCalledWith({
      executablePath: "/opt/chromium/bin/chromium",
    });
  });

  test("skips styles and assets when disabled", async () => {
    const events: ProgressEvent[] = [];
    await importSite(
      {
        url: "https://site.example/",
        outDir: freshOutDir(),
        maxDepth: 0,
        styles: false,
        assets: false,
      },
      (e) => events.push(e),
    );
    expect(captureStyles).not.toHaveBeenCalled();
    expect(collectAssets).not.toHaveBeenCalled();
    const phases = new Set(events.map((e) => e.phase));
    expect(phases.has("styles")).toBe(false);
    expect(phases.has("assets")).toBe(false);
  });

  test("extracts breakpoints when the page has media queries", async () => {
    captureStyles.mockResolvedValueOnce({
      elements: [],
      uaDefaults: {},
      mediaQueries: ["(max-width: 768px)"],
      customProperties: { "--brand": "rgb(1, 2, 3)" },
      documentStyles: {},
    });
    await importSite({ url: "https://site.example/", outDir: freshOutDir(), maxDepth: 0 });
    expect(extractMedia).toHaveBeenCalled();
    const emitOpts = emitMultiPageProject.mock.calls[0]?.[0] as {
      breakpoints?: Record<string, string>;
    };
    expect(emitOpts.breakpoints).toEqual({ "--md": "(max-width: 768px)" });
  });

  test("reports sub-kilobyte download sizes and skipped tracking URLs", async () => {
    downloadAssets.mockResolvedValueOnce({
      rewriteMap: new Map([["https://site.example/hero.jpg", "/assets/images/hero.jpg"]]),
      failed: [],
      skipped: ["https://site.example/analytics.js"],
      totalBytes: 512,
    });
    const events: ProgressEvent[] = [];
    await importSite({ url: "https://site.example/", outDir: freshOutDir(), maxDepth: 0 }, (e) => {
      events.push(e);
    });
    const messages = events.map((e) => e.message);
    expect(messages.some((m) => m.includes("512 B"))).toBe(true);
    expect(messages.some((m) => m.includes("Skipped 1 tracking/analytics URLs"))).toBe(true);
  });

  test("reports megabyte-range download sizes", async () => {
    downloadAssets.mockResolvedValueOnce({
      rewriteMap: new Map([["https://site.example/hero.jpg", "/assets/images/hero.jpg"]]),
      failed: [],
      skipped: [],
      totalBytes: 3 * 1024 * 1024,
    });
    const events: ProgressEvent[] = [];
    await importSite({ url: "https://site.example/", outDir: freshOutDir(), maxDepth: 0 }, (e) => {
      events.push(e);
    });
    expect(events.some((e) => e.message.includes("3.0 MB"))).toBe(true);
  });

  test("extracts design tokens when custom properties match computed values", async () => {
    captureStyles.mockResolvedValueOnce({
      elements: [{ path: [0], tagName: "h1", styles: { color: "rgb(4, 5, 6)" } }],
      uaDefaults: {},
      mediaQueries: [],
      customProperties: { "--ink": "rgb(4, 5, 6)" },
      documentStyles: {},
    });
    const events: ProgressEvent[] = [];
    await importSite({ url: "https://site.example/", outDir: freshOutDir(), maxDepth: 0 }, (e) => {
      events.push(e);
    });
    expect(events.some((e) => e.message.includes("design tokens"))).toBe(true);
    const emitOpts = emitMultiPageProject.mock.calls[0]?.[0] as {
      styleTokens?: Record<string, string>;
    };
    expect(emitOpts.styleTokens).toEqual({ "--ink": "rgb(4, 5, 6)" });
  });

  test("reports when media queries yield no breakpoint deltas", async () => {
    captureStyles.mockResolvedValueOnce({
      elements: [],
      uaDefaults: {},
      mediaQueries: ["(max-width: 500px)"],
      customProperties: {},
      documentStyles: {},
    });
    extractMedia.mockResolvedValueOnce({ breakpoints: {}, deltas: {} });
    const events: ProgressEvent[] = [];
    await importSite({ url: "https://site.example/", outDir: freshOutDir(), maxDepth: 0 }, (e) => {
      events.push(e);
    });
    expect(events.some((e) => e.message.includes("No responsive breakpoints"))).toBe(true);
    const emitOpts = emitMultiPageProject.mock.calls[0]?.[0] as {
      breakpoints?: Record<string, string>;
    };
    expect(emitOpts.breakpoints).toBeUndefined();
  });

  test("warns on pages above the node cap", async () => {
    const result = await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      maxDepth: 0,
      maxNodesPerPage: 1,
    });
    expect(result.warnings.some((w) => w.includes("Large page"))).toBe(true);
  });

  test("runs the AI componentize pass and forwards the refined components to emit", async () => {
    await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      maxDepth: 0,
      ai: { apiKey: "sk-test", baseUrl: "http://llm.local/v1", model: "test-model" },
    });
    expect(componentize).toHaveBeenCalled();
    expect(aiComponentize).toHaveBeenCalled();
    const aiOpts = aiComponentize.mock.calls[0]?.[1] as {
      apiKey: string;
      baseUrl?: string;
      model?: string;
    };
    expect(aiOpts).toEqual({
      apiKey: "sk-test",
      baseUrl: "http://llm.local/v1",
      model: "test-model",
    });
    const emitOpts = emitMultiPageProject.mock.calls[0]?.[0] as {
      componentizeOptions: unknown;
      precomputedComponents?: { components: Map<string, unknown> };
    };
    expect(emitOpts.componentizeOptions).toBe(false);
    expect(emitOpts.precomputedComponents?.components.has("hero-banner")).toBe(true);
  });

  test("skips the AI pass when the heuristic finds no components", async () => {
    componentize.mockReturnValueOnce({
      components: new Map<string, { tagName: string }>(),
      rewrittenPages: new Map<string, JxElement>(),
    });
    await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      maxDepth: 0,
      ai: { apiKey: "sk-test" },
    });
    expect(componentize).toHaveBeenCalled();
    expect(aiComponentize).not.toHaveBeenCalled();
    // Emit falls back to its own heuristic pass: no precomputed components handed over.
    const emitOpts = emitMultiPageProject.mock.calls[0]?.[0] as {
      componentizeOptions: unknown;
      precomputedComponents?: unknown;
    };
    expect(emitOpts.precomputedComponents).toBeUndefined();
    expect(emitOpts.componentizeOptions).toEqual({});
  });

  test("skips the AI pass when componentization is disabled", async () => {
    await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      maxDepth: 0,
      componentize: false,
      ai: { apiKey: "sk-test" },
    });
    expect(componentize).not.toHaveBeenCalled();
    expect(aiComponentize).not.toHaveBeenCalled();
  });

  test("verify captures a reference screenshot and reports fidelity", async () => {
    const result = await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      maxDepth: 0,
      verify: { threshold: 0.2 },
    });
    expect(captureReferenceScreenshot).toHaveBeenCalled();
    const verifyOpts = verifyProject.mock.calls[0]?.[0] as { threshold: number; browser?: unknown };
    expect(verifyOpts.threshold).toBe(0.2);
    expect(verifyOpts.browser).toBe(fakeBrowser);
    /* Per page, not just the average: "average fidelity 97.5%" is a fact nobody can act on, and
       "the pricing page renders at 61%" is a decision. */
    expect(result.verify).toEqual({
      averageFidelity: 97.5,
      pages: [{ fidelity: 97.5, route: "pages/index.json" }],
      reportDir: "/tmp/report",
    });
  });

  test("a page the verifier could not render carries its reason", async () => {
    // A page at 0% because it failed to build is a different finding from one that rendered badly.
    verifyProject.mockImplementationOnce(() =>
      Promise.resolve({
        averageFidelity: 0,
        pages: [
          {
            diffImagePath: "d",
            error: "Navigation failed",
            fidelity: 0,
            mismatchedPixels: 0,
            originalScreenshotPath: "o",
            renderedScreenshotPath: "r",
            route: "pages/about.json",
            sourceUrl: "https://site.example/about",
            totalPixels: 0,
          },
        ],
        reportDir: "/tmp/report",
      }),
    );
    const result = await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      maxDepth: 0,
      verify: {},
    });
    expect(result.verify!.pages).toEqual([
      { error: "Navigation failed", fidelity: 0, route: "pages/about.json" },
    ]);
  });

  test("an aborted signal stops the pipeline and still closes the browser", async () => {
    const controller = new AbortController();
    controller.abort();
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(
      importSite({
        url: "https://site.example/",
        outDir: freshOutDir(),
        maxDepth: 0,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Import aborted");
    expect(capturePage).not.toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalled();
  });

  test("emit failures propagate and still close the browser", async () => {
    emitMultiPageProject.mockRejectedValueOnce(new Error("disk full"));
    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(
      importSite({ url: "https://site.example/", outDir: freshOutDir(), maxDepth: 0 }),
    ).rejects.toThrow("disk full");
    expect(closeBrowser).toHaveBeenCalled();
  });
});

describe("importSite — crawl mode", () => {
  test("maps options onto crawlSite and aggregates the result", async () => {
    const events: ProgressEvent[] = [];
    const outDir = freshOutDir();
    const result = await importSite(
      {
        url: "https://site.example/",
        outDir,
        maxDepth: 2,
        maxPages: 10,
        styles: false,
        assets: false,
        scroll: false,
        respectRobots: false,
      },
      (e) => events.push(e),
    );

    const crawlOpts = crawlSite.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(crawlOpts.maxDepth).toBe(2);
    expect(crawlOpts.maxPages).toBe(10);
    expect(crawlOpts.skipStyles).toBe(true);
    expect(crawlOpts.skipAssets).toBe(true);
    expect(crawlOpts.noScroll).toBe(true);
    expect(crawlOpts.respectRobots).toBe(false);
    expect(crawlOpts.captureScreenshots).toBe(false);

    // Two structurally-identical header/footer pages → a shared layout is detected and emitted.
    const emitOpts = emitMultiPageProject.mock.calls[0]?.[0] as { layout?: JxElement };
    expect(emitOpts.layout).toBeDefined();
    const phases = new Set(events.map((e) => e.phase));
    expect(phases.has("layout")).toBe(true);

    expect(result.pages).toEqual([
      { route: "pages/index.json", title: "Home", nodeCount: 4 },
      { route: "pages/about.json", title: "About", nodeCount: 4 },
    ]);
    // Node-cap skips surface as warnings.
    expect(result.warnings.some((w) => w.includes("node cap"))).toBe(true);
    expect(closeBrowser).toHaveBeenCalled();
  });

  test("verify uses the screenshots captured during the crawl", async () => {
    const result = await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      verify: {},
    });
    const verifyOpts = verifyProject.mock.calls[0]?.[0] as {
      pages: Map<string, unknown>;
      threshold: number;
    };
    // Only the page that has a screenshot participates.
    expect([...verifyOpts.pages.keys()]).toEqual(["pages/about.json"]);
    expect(verifyOpts.threshold).toBe(0.15);
    expect(result.verify?.averageFidelity).toBe(97.5);
  });

  test("skips verify when the crawl produced no screenshots", async () => {
    crawlSite.mockResolvedValueOnce({
      pages: [
        {
          url: "https://site.example/",
          route: "pages/index.json",
          title: "Home",
          jx: { document: page("Home"), nodeCount: 4, collectedStyles: [] },
          depth: 0,
          links: [],
        },
      ],
      breakpoints: undefined,
      skippedByRobots: [],
      skippedByNodeCap: [],
      fontFaceRules: [],
      fontRewriteMap: new Map(),
      styleTokens: undefined,
    });
    const result = await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      verify: {},
    });
    expect(verifyProject).not.toHaveBeenCalled();
    expect(result.verify).toBeNull();
  });
});
