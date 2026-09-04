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

  test("an accordion is emitted as native <details>, not inert directives", async () => {
    /* The source drives it with a client framework the clone does not ship, so carried across
       verbatim it is markup nothing can ever open - and its content is unreachable. */
    const row = (index: number, title: string, body: string): string =>
      `<div class="accordion-item" :class="{ 'active': open_accordion_item === ${index} }">
         <div class="accordion-title" @click="open_accordion_item = (open_accordion_item === ${index} ? null : ${index})"><h5>${title}</h5></div>
         <div class="accordion-text" x-show="open_accordion_item === ${index}" hidden=""><p>${body}</p></div>
       </div>`;
    const { io, files } = memoryIo();
    const { browser } = fakeBrowser({
      [HOME]: {
        title: "Specs",
        html: `<main><div x-data="{ open_accordion_item: null }" class="accordion-wrapper">${row(0, "Available Sizes", "12x12 to 40x80")}${row(1, "Roof Pitch", "8/12")}</div></main>`,
      },
    });
    const phases: string[] = [];

    await runImportPipeline(
      { browser, io, url: HOME, styles: false, assets: false, scroll: false, maxDepth: 0 },
      (event) => phases.push(event.phase),
    );

    const page = String(files.get("pages/index.json") ?? "");
    const everything = [...files.values()].map(String).join("\n");

    /* The disclosure stays in the page as a real <details>. It must NOT become a component: a
       component template root takes the component's own tag name, so promoting it would hand
       back a custom element with none of the browser behaviour that made the rewrite worth doing. */
    expect(page).toContain('"details"');
    expect(page).toContain('"summary"');
    expect(page.match(/"details"/g)).toHaveLength(2);
    // Same widget, one name, so the two rows stay mutually exclusive the way the source was.
    expect(page.match(/open-accordion-item-0/g)).toHaveLength(2);

    // The content both rows were hiding is now reachable.
    expect(everything).toContain("12x12 to 40x80");
    expect(everything).toContain("8/12");
    // And the directives that could never run are gone.
    for (const directive of ["x-show", "x-data", "@click", ":class"]) {
      expect(everything).not.toContain(directive);
    }
    expect(phases).toContain("convert");
  });

  test("a dropdown is emitted as a working popover, not a permanently hidden panel", async () => {
    /* The corpus's submenu came out as `{ display: grid, opacity: 0, position: absolute }` with
       nothing left anywhere to change the opacity: every signal preserved, and the menu unable to
       open ever again. */
    const { io, files } = memoryIo();
    const { browser } = fakeBrowser({
      [HOME]: {
        title: "Nav",
        html: `<nav><li><span><button aria-haspopup="true" aria-expanded="false">Models</button></span><ul id="submenu" style="display:grid;opacity:0;position:absolute;z-index:10"><li><a href="/lancaster">Lancaster</a></li></ul></li></nav>`,
      },
    });
    const phases: string[] = [];

    /* MaxDepth 0 takes the single-page path, which skips the crawl entirely - a genuinely separate
       copy of the styles, assets and convert stages that a crawl-only test never reaches. */
    await runImportPipeline(
      { browser, io, url: HOME, assets: false, scroll: false, maxDepth: 0 },
      (event) => phases.push(event.phase),
    );

    const page = String(files.get("pages/index.json") ?? "");
    expect(page).toContain('"popover": "auto"');
    expect(page).toContain('"popovertarget": "submenu"');
    // The closed state must not survive in the base rule, where it beats the UA sheet.
    const panel = JSON.parse(page) as unknown;
    expect(JSON.stringify(panel)).toContain(":popover-open");
    expect(phases).toContain("convert");
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

  test("a read-more control becomes a disclosure, freeing the copy behind it", async () => {
    /* The site already declared which control opens which panel, in `aria-expanded` plus
       `aria-controls`. The script that acted on it is gone, so the panel's copy was on disk and
       unreachable - the largest body of trapped text on the reference corpus. */
    const { io, files } = memoryIo();
    const { browser } = fakeBrowser({
      [HOME]: {
        title: "Specs",
        html: `<main><div><div><p>Intro</p></div><div id="more-1" hidden><p>the hidden remainder</p></div><p><a role="button" aria-expanded="false" aria-controls="more-1" tabindex="-1">Read more</a></p></div></main>`,
      },
    });
    const phases: string[] = [];

    await runImportPipeline(
      { browser, io, url: HOME, assets: false, scroll: false, maxDepth: 0 },
      (event) => phases.push(event.phase),
    );

    const everything = [...files.values()].map(String).join("\n");
    expect(everything).toContain('"details"');
    expect(everything).toContain('"summary"');
    expect(everything).toContain("the hidden remainder");
    expect(everything).toContain("Read more");
    // The control is gone, and with it the state nothing could change.
    expect(everything).not.toContain("aria-expanded");
    expect(phases).toContain("convert");
  });

  test("both conversions also run on the crawl path", async () => {
    /* The styles, assets and convert stages exist TWICE - once for a single page and again for a
       crawl - and a multi-page import only ever runs the second copy. A pass verified on one path
       is not verified on the other. */
    const widgets =
      `<div x-data="{ open: null }">` +
      `<div><div @click="open = (open === 0 ? null : 0)"><h5>One</h5></div>` +
      `<div x-show="open === 0" hidden=""><p>first</p></div></div>` +
      `<div><div @click="open = (open === 1 ? null : 1)"><h5>Two</h5></div>` +
      `<div x-show="open === 1" hidden=""><p>second</p></div></div></div>` +
      `<nav><span><button aria-haspopup="true">Menu</button></span>` +
      `<ul id="sub" style="opacity:0;position:absolute"><li>item</li></ul></nav>`;
    const { io, files } = memoryIo();
    const { browser } = fakeBrowser({
      [HOME]: { title: "Home", html: `<main><a href="${HOME}b">b</a>${widgets}</main>` },
      [`${HOME}b`]: { title: "B", html: `<main>${widgets}</main>` },
    });
    const phases: string[] = [];

    await runImportPipeline(
      { browser, io, url: HOME, assets: false, scroll: false, maxPages: 2 },
      (event) => phases.push(event.phase),
    );

    const everything = [...files.values()].map(String).join("\n");
    expect(everything).toContain('"details"');
    expect(everything).toContain('"popover": "auto"');
    expect(everything).toContain("popovertarget");
    expect(phases).toContain("convert");
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
