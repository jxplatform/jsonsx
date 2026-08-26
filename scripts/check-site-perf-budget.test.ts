/**
 * Tests for check-site-perf-budget.ts — the eager-reference derivation the ceilings are built on.
 *
 * The derivation is the part worth testing: a ceiling is only a tripwire if the set of bytes it
 * covers is the set a first visit actually downloads. Over-collect and the number is noise;
 * under-collect and an asset can be added to every page without any ceiling noticing.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eagerRefs } from "./check-site-perf-budget.ts";

describe("eagerRefs", () => {
  test("collects stylesheets, module scripts and preload hints", () => {
    const html = `<head>
      <link rel="stylesheet" href="/components/a.css">
      <link rel="modulepreload" href="/assets/vue.js">
      <link rel="preload" href="/fonts/x.woff2" as="font">
      </head><body>
      <script type="module" src="/components/a.js"></script>
      </body>`;
    expect(eagerRefs(html).toSorted()).toEqual([
      "assets/vue.js",
      "components/a.css",
      "components/a.js",
      "fonts/x.woff2",
    ]);
  });

  test("reads rel and href in either order", () => {
    expect(eagerRefs('<link href="/a.css" rel="stylesheet">')).toEqual(["a.css"]);
  });

  test("ignores rel values that are not a fetch", () => {
    const html = `<link rel="icon" href="/favicon.svg">
      <link rel="canonical" href="/page/">
      <link rel="alternate" href="/feed.xml">`;
    expect(eagerRefs(html)).toEqual([]);
  });

  test("ignores cross-origin and protocol-relative references", () => {
    const html = `<link rel="stylesheet" href="https://cdn.example.com/x.css">
      <script src="//cdn.example.com/y.js"></script>
      <script src="/local.js"></script>`;
    expect(eagerRefs(html)).toEqual(["local.js"]);
  });

  /*
   * The whole point of deriving the set from markup: a module reached only through a dynamic
   * import() is not in the HTML, and is not in the first visit either. Counting it would charge
   * every page for code most visitors never load.
   */
  test("does not see a dynamically imported module", () => {
    const html = `<script type="module" src="/components/search.js"></script>`;
    expect(eagerRefs(html)).toEqual(["components/search.js"]);
    expect(eagerRefs(html)).not.toContain("assets/search-client.js");
  });

  test("strips query strings and fragments, and dedupes", () => {
    const html = `<link rel="modulepreload" href="/a.js">
      <script type="module" src="/a.js?v=2"></script>
      <script type="module" src="/a.js#x"></script>`;
    expect(eagerRefs(html)).toEqual(["a.js"]);
  });

  test("an inline script with no src contributes nothing", () => {
    expect(eagerRefs("<script>var a = 1;</script>")).toEqual([]);
  });
});

describe("check-site-perf-budget CLI", () => {
  function site(budget: unknown, dist: Record<string, string> | null): string {
    const dir = mkdtempSync(join(tmpdir(), "jx-perf-budget-"));
    writeFileSync(join(dir, "perf-budget.json"), JSON.stringify(budget), "utf8");
    if (dist) {
      for (const [path, content] of Object.entries(dist)) {
        const abs = join(dir, "dist", path);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content, "utf8");
      }
    }
    return dir;
  }

  async function run(dir: string) {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "check-site-perf-budget.ts"), dir], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, output: stdout + stderr };
  }

  test("a page ceiling covers the HTML plus what it eagerly loads", async () => {
    const dir = site(
      { pages: { "index.html": 10_000 } },
      { "app.js": "x".repeat(5000), "index.html": '<script src="/app.js"></script>' },
    );
    try {
      const { code, output } = await run(dir);
      expect(code).toBe(0);
      expect(output).toContain("app.js");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("exceeding a ceiling fails and says by how much", async () => {
    // Incompressible content, so the gz size actually exceeds the ceiling.
    const noise = Array.from({ length: 40_000 }, (_, i) =>
      String.fromCodePoint(32 + ((i * 7) % 94)),
    ).join("");
    const dir = site({ files: { "big.txt": 100 } }, { "big.txt": noise });
    try {
      const { code, output } = await run(dir);
      expect(code).toBe(1);
      expect(output).toContain("exceeds ceiling");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  /* A declared key that is not there is a FAILURE, not a skip: renaming an artifact must not
     quietly retire its ceiling. */
  test("a declared key missing from dist is a failure, not a skip", async () => {
    const dir = site({ files: { "gone.js": 1000 } }, { "index.html": "<html></html>" });
    try {
      const { code, output } = await run(dir);
      expect(code).toBe(1);
      expect(output).toContain("not present in dist/");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("a page pointing at an asset the build never wrote is a failure", async () => {
    const dir = site(
      { pages: { "index.html": 10_000 } },
      { "index.html": '<link rel="stylesheet" href="/missing.css">' },
    );
    try {
      const { code, output } = await run(dir);
      expect(code).toBe(1);
      expect(output).toContain("missing asset");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("no dist yet is a skip, so it is safe to run in any order", async () => {
    const dir = site({ files: { "a.js": 10 } }, null);
    try {
      const { code, output } = await run(dir);
      expect(code).toBe(0);
      expect(output).toContain("skipping");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("tolerance is applied above the ceiling", async () => {
    const noise = Array.from({ length: 4000 }, (_, i) =>
      String.fromCodePoint(32 + ((i * 7) % 94)),
    ).join("");
    const exact = Bun.gzipSync(Buffer.from(noise), { level: 9 }).length;
    const dir = site({ files: { "a.txt": exact - 10 }, tolerance: 0.5 }, { "a.txt": noise });
    try {
      const result = await run(dir);
      expect(result.code).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
