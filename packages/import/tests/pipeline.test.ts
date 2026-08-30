/**
 * `runImportPipeline` driven by a FAKE browser and an in-memory sink — no puppeteer, no filesystem.
 *
 * That is the property the refactor exists for, so it is asserted rather than described: the
 * pipeline, the emitter and every transform are the real ones, and only the browser and the write
 * destination are supplied — which is exactly what a Cloudflare Worker supplies. The in-page
 * callbacks run in-process against a happy-dom document, so `capturePage`'s DOM logic is really
 * exercised on the way through. Only the LLM call is doubled, and only where the test is about what
 * the pipeline ASKS it for.
 *
 * The last test is the bundling guard the whole split was for: it walks pipeline.ts's transitive
 * import graph and fails on a VALUE import of puppeteer-core anywhere in it.
 */
import { describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runImportPipeline } from "../src/pipeline.ts";
import type { ImportBrowser } from "../src/capture.ts";
import { memoryIo } from "./memory-io.ts";

/** A browser that is only `newPage`, and pages that are only the five calls the phases make. */
function fakeBrowser(pages: Record<string, { title: string; html: string }>): {
  browser: ImportBrowser;
  closed: () => number;
  shots: () => number;
} {
  let closed = 0;
  let shots = 0;
  const browser: ImportBrowser = {
    newPage: () => {
      let win: Window | undefined;
      return Promise.resolve({
        setViewport: () => Promise.resolve(),
        goto: (url: string) => {
          const entry = pages[url] ?? { title: "Missing", html: "<p>not found</p>" };
          win = new Window({ url });
          win.document.title = entry.title;
          win.document.body.innerHTML = entry.html;
          Object.assign(globalThis, {
            document: win.document,
            window: win,
            location: win.location,
          });
          return Promise.resolve();
        },
        evaluate: (fn: (...args: never[]) => unknown, ...args: never[]) =>
          Promise.resolve(fn(...args)),
        screenshot: () => {
          shots += 1;
          return Promise.resolve(new Uint8Array([137, 80, 78, 71]));
        },
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      });
    },
  } as unknown as ImportBrowser;
  return { browser, closed: () => closed, shots: () => shots };
}

const HOME = "https://fake.example/";

describe("runImportPipeline — no filesystem, no puppeteer", () => {
  test("a single-page run emits a whole project through the sink", async () => {
    const { io, files, dirs } = memoryIo();
    const { browser, closed } = fakeBrowser({
      [HOME]: { title: "Fake Home", html: "<main><h1>Fake Home</h1><p>Body copy</p></main>" },
    });
    const phases: string[] = [];

    const result = await runImportPipeline(
      {
        url: HOME,
        browser,
        io,
        maxDepth: 0,
        styles: false,
        assets: false,
        scroll: false,
        componentize: false,
      },
      (e) => phases.push(e.phase),
    );

    expect([...files.keys()].toSorted()).toEqual([
      "layouts/base.json",
      "pages/index.json",
      "project.json",
    ]);
    expect(result.files.toSorted()).toEqual([
      "layouts/base.json",
      "pages/index.json",
      "project.json",
    ]);
    // The project shape is seeded even where nothing lands in it, so a host can open it early.
    expect(dirs).toEqual(["pages", "layouts", "components", "public"]);

    const page = JSON.parse(files.get("pages/index.json") as string) as {
      children: { tagName: string }[];
    };
    expect(page.children[0]?.tagName).toBe("main");

    /* The configuration comes back with the result. A caller committing to git cannot read it off
       a disk it does not have, and re-deriving it would be a second writer on the same bytes. */
    const project = JSON.parse(result.projectJson) as { name: string; $media: object };
    expect(project.name).toBe("Fake Home");
    expect(project.$media).toEqual({ "--": "1440px" });
    expect(files.get("project.json")).toBe(result.projectJson);

    expect(result.pages).toEqual([
      { route: "pages/index.json", title: "Fake Home", nodeCount: expect.any(Number) },
    ]);
    expect(result.references.size).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(closed()).toBe(1);
    expect(phases).toContain("emit");
  });

  test("a crawl walks same-origin links and emits a page per route", async () => {
    const { io, files } = memoryIo();
    const { browser } = fakeBrowser({
      [HOME]: {
        title: "Home",
        html: '<header>H</header><main><a href="/about">About</a></main><footer>F</footer>',
      },
      "https://fake.example/about": {
        title: "About",
        html: "<header>H</header><main>About us</main><footer>F</footer>",
      },
    });

    const result = await runImportPipeline({
      url: HOME,
      browser,
      io,
      maxDepth: 1,
      maxPages: 5,
      styles: false,
      assets: false,
      scroll: false,
      respectRobots: false,
      componentize: false,
    });

    expect(result.pages.map((p) => p.route)).toEqual(["pages/index.json", "pages/about.json"]);
    expect(files.has("pages/about.json")).toBe(true);
    // Two pages sharing a header and footer are what layout detection is for.
    const layout = JSON.parse(files.get("layouts/base.json") as string) as { children: unknown[] };
    expect(layout.children.length).toBeGreaterThan(1);
  });

  test("reference screenshots come back as bytes, keyed by route", async () => {
    const { io } = memoryIo();
    const { browser, shots } = fakeBrowser({
      [HOME]: { title: "Shot", html: "<main>Shot me</main>" },
    });

    const result = await runImportPipeline({
      url: HOME,
      browser,
      io,
      maxDepth: 0,
      styles: false,
      assets: false,
      scroll: false,
      componentize: false,
      referenceScreenshots: { fullPage: true },
    });

    expect(shots()).toBe(1);
    const ref = result.references.get("pages/index.json");
    expect(ref?.sourceUrl).toBe(HOME);
    expect(ref?.screenshot).toBeInstanceOf(Uint8Array);
  });

  test("a page over the node cap is a warning, not a failure", async () => {
    const { io } = memoryIo();
    const { browser } = fakeBrowser({
      [HOME]: { title: "Big", html: "<main><p>a</p><p>b</p><p>c</p></main>" },
    });

    const result = await runImportPipeline({
      url: HOME,
      browser,
      io,
      maxDepth: 0,
      maxNodesPerPage: 1,
      styles: false,
      assets: false,
      scroll: false,
      componentize: false,
    });

    expect(result.warnings.some((w) => w.includes("Large page"))).toBe(true);
  });

  test("an aborted signal stops before the first capture", async () => {
    const { io } = memoryIo();
    const { browser } = fakeBrowser({ [HOME]: { title: "X", html: "<main>x</main>" } });
    const controller = new AbortController();
    controller.abort();

    // oxlint-disable-next-line typescript/await-thenable -- rejects.toThrow resolves a Promise at runtime.
    await expect(
      runImportPipeline({
        url: HOME,
        browser,
        io,
        maxDepth: 0,
        styles: false,
        assets: false,
        scroll: false,
        componentize: false,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Import aborted");
  });

  test("the AI pass is asked for the model it was given, and nothing invents one", async () => {
    const { io } = memoryIo();
    const { browser } = fakeBrowser({
      [HOME]: {
        title: "Cards",
        html: "<main><div><h2>A</h2></div><div><h2>B</h2></div></main>",
      },
    });
    const seen: Record<string, unknown>[] = [];
    void mock.module("../src/ai-componentize.ts", () => ({
      aiComponentize: (heuristic: unknown, opts: Record<string, unknown>) => {
        seen.push(opts);
        return Promise.resolve(heuristic);
      },
    }));

    await runImportPipeline({
      url: HOME,
      browser,
      io,
      maxDepth: 0,
      styles: false,
      assets: false,
      scroll: false,
      componentize: { minInstances: 2, minDepth: 1 },
      ai: { apiKey: "sk-test", model: "@cf/meta/llama-3.1-8b-instruct" },
    });

    expect(seen).toEqual([
      { apiKey: "sk-test", baseUrl: undefined, model: "@cf/meta/llama-3.1-8b-instruct" },
    ]);
  });
});

describe("the pipeline's import graph", () => {
  test("value-imports nothing from puppeteer-core, which is what makes it deployable", async () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const queue = [join(import.meta.dir, "..", "src", "pipeline.ts")];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      const source = await readFile(file, "utf8");

      /* `import type` and `import { type X }` are erased before a bundler ever sees them; a bare
         `import { launch } from "puppeteer-core"` is the one that drags an unloadable module — and
         `child_process`, `net` and a binary path — into a Worker. */
      for (const match of source.matchAll(/^import\s+([\s\S]*?)from\s+"([^"]+)";$/gm)) {
        const [, clause = "", specifier = ""] = match;
        if (specifier === "puppeteer-core" && !clause.trimStart().startsWith("type ")) {
          offenders.push(`${file} imports puppeteer-core as a value`);
        }
        if (specifier.startsWith("./") && !clause.trimStart().startsWith("type ")) {
          queue.push(join(dirname(file), specifier));
        }
      }
    }

    expect(offenders).toEqual([]);
    // A graph of one file would pass vacuously; the pipeline really does reach the phases.
    expect(seen.size).toBeGreaterThan(10);
  });
});
