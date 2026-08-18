import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_RUNTIME_MODULES,
  renderImportMap,
  resolveClientRuntime,
  writeClientRuntime,
  writeRuntimeSubpaths,
} from "../src/site/client-runtime.ts";

describe("resolveClientRuntime", () => {
  test("points both modules at /assets/ when they resolve", () => {
    const runtime = resolveClientRuntime();

    /*
     * Four entries, not two: each module contributes an exact key and a `/`-suffixed PREFIX key.
     * The prefix is what resolves `lit-html/directives/class-map.js`, which a component or a
     * sidecar imports and which a package-name external leaves in the output.
     */
    expect(runtime.imports).toEqual({
      "@vue/reactivity": "/assets/vue-reactivity.js",
      "@vue/reactivity/": "/assets/@vue/reactivity/",
      "lit-html": "/assets/lit-html.js",
      "lit-html/": "/assets/lit-html/",
    });
    expect(runtime.assetPaths).toEqual(["/assets/vue-reactivity.js", "/assets/lit-html.js"]);
    expect(runtime.warnings).toEqual([]);
  });

  /*
   * The CDN is the fallback, not the default. It used to be the only answer, which put a third
   * party in the load path of every interactive page and made `default-src 'self'` impossible.
   */
  test("falls back to the CDN, loudly, when a module cannot be resolved", () => {
    const empty = mkdtempSync(join(tmpdir(), "jx-no-runtime-"));
    try {
      const runtime = resolveClientRuntime(empty);

      expect(runtime.assetPaths).toEqual([]);
      expect(Object.values(runtime.imports).every((url) => url.startsWith("https://"))).toBe(true);
      expect(runtime.warnings).toHaveLength(CLIENT_RUNTIME_MODULES.length);
      expect(runtime.warnings[0]).toContain("default-src 'self'");
    } finally {
      rmSync(empty, { force: true, recursive: true });
    }
  });
});

describe("renderImportMap", () => {
  test("renders the imports object as an importmap script", () => {
    const html = renderImportMap({ "lit-html": "/assets/lit-html.js" });

    expect(html.startsWith('<script type="importmap">')).toBe(true);
    expect(html).toContain('"lit-html": "/assets/lit-html.js"');
    expect(JSON.parse(html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""))).toEqual({
      imports: { "lit-html": "/assets/lit-html.js" },
    });
  });

  test("escapes a URL that would otherwise break the JSON", () => {
    expect(renderImportMap({ x: 'a"b' })).toContain(String.raw`"a\"b"`);
  });
});

describe("writeClientRuntime", () => {
  test("bundles only the modules the build actually used", async () => {
    const out = mkdtempSync(join(tmpdir(), "jx-runtime-out-"));
    try {
      const result = await writeClientRuntime(
        { assetPaths: ["/assets/lit-html.js"], imports: {}, warnings: [] },
        out,
      );

      expect(result.errors).toEqual([]);
      expect(result.written).toBe(1);
      expect(existsSync(join(out, "assets/lit-html.js"))).toBe(true);
      expect(existsSync(join(out, "assets/vue-reactivity.js"))).toBe(false);
    } finally {
      rmSync(out, { force: true, recursive: true });
    }
  }, 30_000);

  /*
   * Bun picks a package's `development` export condition unless the build says otherwise, and it
   * reads that from the build's own `define` — not from an env var set after the process started.
   * Left alone it shipped lit-html's 31 kB dev build, which logs into every visitor's console.
   */
  test("bundles the production build of lit-html, not the development one", async () => {
    const out = mkdtempSync(join(tmpdir(), "jx-runtime-prod-"));
    try {
      await writeClientRuntime(
        { assetPaths: ["/assets/lit-html.js"], imports: {}, warnings: [] },
        out,
      );
      const bundle = readFileSync(join(out, "assets/lit-html.js"), "utf8");

      expect(bundle).not.toContain("Lit is in dev mode");
      expect(bundle).not.toContain("process.env.NODE_ENV");
    } finally {
      rmSync(out, { force: true, recursive: true });
    }
  }, 30_000);

  test("an unbundleable module lands in errors rather than throwing", async () => {
    const out = mkdtempSync(join(tmpdir(), "jx-runtime-err-"));
    const empty = mkdtempSync(join(tmpdir(), "jx-runtime-empty-"));
    try {
      const result = await writeClientRuntime(
        { assetPaths: ["/assets/lit-html.js"], imports: {}, warnings: [] },
        out,
        empty,
      );

      expect(result.written).toBe(0);
      expect(result.errors[0]).toContain("lit-html");
    } finally {
      rmSync(out, { force: true, recursive: true });
      rmSync(empty, { force: true, recursive: true });
    }
  }, 30_000);
});

describe("package subpaths (site-architecture.md §8.7)", () => {
  /*
   * A page's bundles do not only import `lit-html`; a component or a `$src` sidecar imports
   * `lit-html/directives/class-map.js`. A package-name external covers the package's SUBPATHS too,
   * so those specifiers survive into the output — verified against Bun, not assumed — and an
   * import map with only exact keys cannot resolve them. The page then dies before rendering with
   * `Failed to resolve module specifier`, which is what these two mechanisms exist to prevent.
   */
  test("every runtime module contributes a prefix key alongside its exact one", () => {
    const { imports } = resolveClientRuntime();
    for (const mod of CLIENT_RUNTIME_MODULES) {
      expect({ key: `${mod.specifier}/`, value: imports[`${mod.specifier}/`] }).toEqual({
        key: `${mod.specifier}/`,
        value: mod.assetDir,
      });
    }
  });

  // Both halves must end in `/` or it is an exact mapping that matches nothing.
  test("a prefix mapping has a trailing slash on both sides", () => {
    for (const mod of CLIENT_RUNTIME_MODULES) {
      expect(mod.assetDir.endsWith("/")).toBe(true);
      expect(mod.assetDir.startsWith("/")).toBe(true);
    }
  });

  test("the prefix key resolves a subpath to the directory the assets land in", () => {
    const { imports } = resolveClientRuntime();
    const dir = imports["lit-html/"];
    expect(`${dir}directives/class-map.js`).toBe("/assets/lit-html/directives/class-map.js");
  });

  test("writes the subpaths an emitted bundle imports, and nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-subpath-"));
    try {
      await Bun.write(
        join(dir, "assets", "some-bundle.js"),
        'import "lit-html/directives/class-map.js";\nexport const a = 1;\n',
      );
      const result = await writeRuntimeSubpaths(dir);
      expect(result.errors).toEqual([]);
      expect(existsSync(join(dir, "assets", "lit-html", "directives", "class-map.js"))).toBe(true);
      // Not referenced by anything, so not written: the set is discovered, never enumerated.
      expect(existsSync(join(dir, "assets", "lit-html", "directives", "repeat.js"))).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  /*
   * The emitted subpath keeps the package core external, so it imports the ONE shared copy rather
   * than inlining a second. Two copies of lit on a page is a documented breakage, not a size
   * regression.
   */
  test("an emitted subpath still imports the shared core", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-subpath-"));
    try {
      await Bun.write(join(dir, "assets", "b.js"), 'import "lit-html/directives/class-map.js";\n');
      await writeRuntimeSubpaths(dir);
      const text = readFileSync(
        join(dir, "assets", "lit-html", "directives", "class-map.js"),
        "utf8",
      );
      expect(text).toContain("lit-html");
      expect(text).not.toContain("class ReactiveElement");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("no assets directory is not an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-subpath-"));
    try {
      const result = await writeRuntimeSubpaths(dir);
      expect(result).toEqual({ errors: [], written: 0 });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
