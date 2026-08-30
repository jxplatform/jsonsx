/**
 * What `importSite` hands the pipeline, pinned.
 *
 * The local import's defaults used to live inside the orchestrator that also did the work, so
 * "unchanged behavior" was whatever the phases happened to see. Now the wrapper forwards options
 * across a module boundary, and the two ways that goes silently wrong are a default restated here
 * (which then drifts from the pipeline's own) and an option dropped in the hand-off. Both are
 * regressions no other suite would notice, so this asserts the exact hand-off — including the
 * `gpt-4o-mini` model default, which moved OUT of `ai-componentize.ts` and has to still be applied
 * on the CLI and OSS-server path.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launchBrowser = mock((_opts?: Record<string, unknown>) => Promise.resolve({ fake: true }));
const closeBrowser = mock(() => Promise.resolve());
void mock.module("../src/browser-local.ts", () => ({ launchBrowser, closeBrowser }));

const runImportPipeline = mock((_opts: Record<string, unknown>) =>
  Promise.resolve({
    pages: [{ route: "pages/index.json", title: "T", nodeCount: 3 }],
    files: ["project.json", "pages/index.json", "layouts/base.json"],
    projectJson: '{ "name": "T" }\n',
    references: new Map(),
    warnings: ["something odd"],
  }),
);
void mock.module("../src/pipeline.ts", () => ({ runImportPipeline }));

const { importSite } = await import("../src/run.ts");

function freshOutDir(): string {
  const base = mkdtempSync(join(tmpdir(), "jx-run-defaults-"));
  return join(base, "out");
}

function lastOptions(): Record<string, unknown> {
  return runImportPipeline.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  runImportPipeline.mockClear();
  launchBrowser.mockClear();
  closeBrowser.mockClear();
});

describe("importSite — the local defaults", () => {
  test("forwards only what the caller gave, so every default stays in the pipeline", async () => {
    const outDir = freshOutDir();
    await importSite({ url: "https://site.example/", outDir });

    const opts = lastOptions();
    expect(opts.url).toBe("https://site.example/");
    expect(opts.maxDepth).toBe(2);
    expect(opts.ai).toBe(false);
    expect(opts.referenceScreenshots).toBe(false);
    /* Absent, not `undefined`. Restating `maxPages = 25` here is how the CLI and the cloud drift
       apart, and under exactOptionalPropertyTypes an explicit undefined is a different value. */
    for (const key of [
      "maxPages",
      "maxNodesPerPage",
      "breakpoints",
      "styles",
      "assets",
      "scroll",
      "respectRobots",
      "componentize",
      "signal",
    ]) {
      expect(Object.hasOwn(opts, key)).toBe(false);
    }
    // OutDir, verify and chromePath are the wrapper's own; the pipeline must never see them.
    expect(Object.hasOwn(opts, "outDir")).toBe(false);
    expect(Object.hasOwn(opts, "verify")).toBe(false);
    expect(Object.hasOwn(opts, "chromePath")).toBe(false);
  });

  test("forwards every option the caller did give, verbatim", async () => {
    const controller = new AbortController();
    await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      maxDepth: 1,
      maxPages: 7,
      maxNodesPerPage: 900,
      breakpoints: { mode: "explicit", rounding: "up", widths: [768] },
      styles: false,
      assets: false,
      scroll: false,
      respectRobots: false,
      componentize: { minInstances: 3, minDepth: 4 },
      signal: controller.signal,
    });

    const opts = lastOptions();
    expect(opts.maxPages).toBe(7);
    expect(opts.maxNodesPerPage).toBe(900);
    expect(opts.breakpoints).toEqual({ mode: "explicit", rounding: "up", widths: [768] });
    expect(opts.styles).toBe(false);
    expect(opts.assets).toBe(false);
    expect(opts.scroll).toBe(false);
    expect(opts.respectRobots).toBe(false);
    expect(opts.componentize).toEqual({ minInstances: 3, minDepth: 4 });
    expect(opts.signal).toBe(controller.signal);
  });

  test("names gpt-4o-mini when the caller did not, and never overrides one that was named", async () => {
    await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      ai: { apiKey: "sk-local" },
    });
    expect(lastOptions().ai).toEqual({ apiKey: "sk-local", model: "gpt-4o-mini" });

    await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      ai: { apiKey: "sk-local", baseUrl: "http://llm.local/v1", model: "@cf/meta/llama-3.1-8b" },
    });
    expect(lastOptions().ai).toEqual({
      apiKey: "sk-local",
      baseUrl: "http://llm.local/v1",
      model: "@cf/meta/llama-3.1-8b",
    });
  });

  test("asks for reference screenshots only when verify is on, framed the way verify renders", async () => {
    await importSite({ url: "https://site.example/", outDir: freshOutDir(), verify: {} });
    expect(lastOptions().referenceScreenshots).toEqual({ fullPage: true });

    await importSite({
      url: "https://site.example/",
      outDir: freshOutDir(),
      verify: { fullPage: false },
    });
    expect(lastOptions().referenceScreenshots).toEqual({ fullPage: false });
  });

  test("writes the seed through the real filesystem before the browser launches", async () => {
    const outDir = freshOutDir();
    const events: { phase: string; message: string; root?: string }[] = [];
    await importSite({ url: "https://www.site.example/", outDir }, (e) => events.push(e));

    expect(events[0]).toEqual({
      message: `Created ${outDir}`,
      phase: "seed",
      root: outDir,
    });
    expect(await Bun.file(join(outDir, "project.json")).json()).toEqual({
      name: "site.example",
      imports: {},
      images: { optimize: false },
    });
    expect(launchBrowser).toHaveBeenCalledWith({});
    expect(closeBrowser).toHaveBeenCalled();
  });

  test("the sink it hands over is rooted at outDir", async () => {
    const outDir = freshOutDir();
    await importSite({ url: "https://site.example/", outDir });

    const io = lastOptions().io as { write: (p: string, d: string) => Promise<void> };
    await io.write("pages/deep/x.json", '{"ok":true}');
    expect(await Bun.file(join(outDir, "pages", "deep", "x.json")).json()).toEqual({ ok: true });
  });

  test("the pipeline's warnings and file count reach the caller unchanged", async () => {
    const result = await importSite({ url: "https://site.example/", outDir: freshOutDir() });
    expect(result.warnings).toEqual(["something odd"]);
    expect(result.fileCount).toBe(3);
    expect(result.pages).toEqual([{ route: "pages/index.json", title: "T", nodeCount: 3 }]);
    expect(result.verify).toBeNull();
  });
});
