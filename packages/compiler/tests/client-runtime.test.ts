import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_RUNTIME_MODULES,
  importMapAssets,
  importMapAssetsInHtml,
  isPrefixSpecifier,
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

describe("isPrefixSpecifier", () => {
  /*
   * The two kinds of import-map key are told apart by their trailing slash and nothing else, and
   * only a caller that can tell them apart can treat a prefix value as the directory it is.
   */
  test("a trailing slash is what separates a prefix key from an exact one", () => {
    const { imports } = resolveClientRuntime();
    const keys = Object.keys(imports);
    const exact = CLIENT_RUNTIME_MODULES.map((mod) => mod.specifier);
    expect(keys.filter((key) => isPrefixSpecifier(key)).toSorted()).toEqual(
      exact.map((specifier) => `${specifier}/`).toSorted(),
    );
    expect(keys.filter((key) => !isPrefixSpecifier(key)).toSorted()).toEqual(exact.toSorted());
  });
});

/*
 * Resolution and bundling must agree about which backend they are on, so `canResolve` asks
 * `bundler.ts` rather than checking `typeof Bun` a second time. `JX_BUNDLER=esbuild` is the switch
 * that forces the Node path under Bun — the same parity check `sidecar-bundler.test.ts` runs on
 * `resolveSidecarEntry`.
 */
describe("the Node resolution backend", () => {
  test("JX_BUNDLER=esbuild resolves through createRequire with the same result", () => {
    const bunResolved = resolveClientRuntime();
    const { JX_BUNDLER: prev } = process.env;
    process.env.JX_BUNDLER = "esbuild";
    try {
      expect(resolveClientRuntime()).toEqual(bunResolved);
    } finally {
      if (prev === undefined) {
        delete process.env.JX_BUNDLER;
      } else {
        process.env.JX_BUNDLER = prev;
      }
    }
  });

  test("an unresolvable module falls back under the Node backend too", () => {
    const { JX_BUNDLER: prev } = process.env;
    process.env.JX_BUNDLER = "esbuild";
    try {
      const empty = mkdtempSync(join(tmpdir(), "jx-noresolve-"));
      const runtime = resolveClientRuntime(empty);
      expect(runtime.assetPaths).toEqual([]);
      expect(runtime.warnings).toHaveLength(CLIENT_RUNTIME_MODULES.length);
    } finally {
      if (prev === undefined) {
        delete process.env.JX_BUNDLER;
      } else {
        process.env.JX_BUNDLER = prev;
      }
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

/*
 * Issue #227: the build promised files it never wrote. The set that gates bundling was populated
 * at ONE of the several places a page can acquire an import map, so a project with interactivity
 * but no components shipped a map naming `/assets/vue-reactivity.js` with no `dist/assets/` at
 * all — 404, blank page, build reports success. Reading the set back out of the finished HTML is
 * what makes the promise and the output the same thing.
 */
describe("importMapAssets", () => {
  test("keeps the exact keys the build must write", () => {
    expect(importMapAssets(resolveClientRuntime().imports)).toEqual([
      "/assets/vue-reactivity.js",
      "/assets/lit-html.js",
    ]);
  });

  test("drops prefix keys — a directory is not a file any build writes", () => {
    expect(
      importMapAssets({ "lit-html": "/assets/lit-html.js", "lit-html/": "/assets/lit-html/" }),
    ).toEqual(["/assets/lit-html.js"]);
  });

  test("drops a CDN fallback — that module belongs to somebody else", () => {
    expect(importMapAssets({ "lit-html": "https://esm.sh/lit-html@3.3.0" })).toEqual([]);
  });
});

describe("importMapAssetsInHtml", () => {
  test("finds what a rendered map names", () => {
    const html = `<head>${renderImportMap(resolveClientRuntime().imports)}</head>`;

    expect(importMapAssetsInHtml(html)).toEqual([
      "/assets/vue-reactivity.js",
      "/assets/lit-html.js",
    ]);
  });

  /*
   * The page-template tiers write their map by hand rather than through `renderImportMap`, with
   * two exact keys and no prefixes — and that is the shape the component-less project shipped.
   */
  test("finds what a hand-written template map names", () => {
    const html = `<script type="importmap">
  {
    "imports": {
      "@vue/reactivity": "/assets/vue-reactivity.js",
      "lit-html": "/assets/lit-html.js"
    }
  }
  </script>`;

    expect(importMapAssetsInHtml(html)).toEqual([
      "/assets/vue-reactivity.js",
      "/assets/lit-html.js",
    ]);
  });

  test("finds nothing in a page that ships no map", () => {
    expect(importMapAssetsInHtml("<html><body>static</body></html>")).toEqual([]);
  });

  test("ignores a map it cannot parse rather than throwing mid-build", () => {
    expect(importMapAssetsInHtml('<script type="importmap">{ not json </script>')).toEqual([]);
    expect(importMapAssetsInHtml('<script type="importmap">{"imports":null}</script>')).toEqual([]);
    expect(importMapAssetsInHtml('<script type="importmap">{"imports":{"a":7}}</script>')).toEqual(
      [],
    );
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
   * The regression this mechanism exists to prevent, asserted the only way that cannot pass by
   * accident: LOAD the emitted asset and look at what it exports.
   *
   * A package-name external covers the package's subpaths, so bundling the subpath by bare
   * specifier emitted `export * from "lit-html/directives/class-map.js"` INTO
   * `/assets/lit-html/directives/class-map.js` — which the prefix key points straight back at. The
   * file imported itself, a self-referential module has an empty namespace, and every page using a
   * directive died on an undefined import while the build reported success. Every text assertion
   * about that file passed the whole time.
   */
  test("the emitted subpath exports the module's real API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-subpath-"));
    try {
      await Bun.write(join(dir, "assets", "b.js"), 'import "lit-html/directives/class-map.js";\n');
      await writeRuntimeSubpaths(dir);

      // Stand in for the import map, which is what resolves the core in a browser.
      await Bun.write(
        join(dir, "assets", "lit-html", "lit-html.js"),
        'export const noChange = Symbol("noChange");\n',
      );
      const emitted = (await import(
        join(dir, "assets", "lit-html", "directives", "class-map.js")
      )) as { classMap?: unknown };

      expect(typeof emitted.classMap).toBe("function");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  /*
   * The core stays shared. A package imports its own core by RELATIVE path from inside itself, and
   * a bundler keeps an external's specifier exactly as the source wrote it — so the shared copy is
   * reached by a stub written where that relative path lands in the OUTPUT tree. Two copies of lit
   * on a page is a documented breakage, not a size regression.
   */
  test("an emitted subpath reaches the shared core through a stub, not a second copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-subpath-"));
    try {
      await Bun.write(join(dir, "assets", "b.js"), 'import "lit-html/directives/class-map.js";\n');
      await writeRuntimeSubpaths(dir);

      const subpath = readFileSync(
        join(dir, "assets", "lit-html", "directives", "class-map.js"),
        "utf8",
      );
      // Left external exactly as lit-html's own source wrote it — the SPECIFIER is the contract;
      // Minification is free to close the space after `from`.
      expect(subpath).toContain('"../lit-html.js"');
      // …and that is where the stub lands, re-exporting the bare specifier the import map resolves.
      expect(readFileSync(join(dir, "assets", "lit-html", "lit-html.js"), "utf8")).toBe(
        'export * from "lit-html";\n',
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  // A subpath the package does not have is the author's typo, and it is named as one.
  test("a subpath that cannot be bundled is reported, not thrown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-subpath-"));
    try {
      await Bun.write(
        join(dir, "assets", "c.js"),
        'import "lit-html/directives/no-such-directive.js";\n',
      );

      const result = await writeRuntimeSubpaths(dir);

      expect(result.written).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(
        'Bundling runtime subpath "lit-html/directives/no-such-directive.js"',
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  /*
   * Discovery runs to closure because bundling one subpath can reveal the next — a directive
   * importing another directive stays external and is found on the following pass. A graph deeper
   * than the pass budget is reported rather than silently truncated: at that depth the likelier
   * explanation is a cycle in the scan than a real dependency chain.
   */
  test("a subpath graph deeper than the pass budget is reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-subpath-"));
    const fixture = mkdtempSync(join(tmpdir(), "jx-deep-pkg-"));
    try {
      const pkg = join(fixture, "node_modules", "lit-html");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ main: "./core.js", name: "lit-html", type: "module", version: "1.0.0" }),
      );
      writeFileSync(join(pkg, "core.js"), "export const noChange = 1;\n");
      // Each link imports the next by BARE subpath, so each pass discovers exactly one more.
      const depth = 12;
      for (let i = 1; i <= depth; i++) {
        writeFileSync(
          join(pkg, `a${i}.js`),
          i < depth ? `export * from "lit-html/a${i + 1}.js";\n` : "export const end = 1;\n",
        );
      }
      await Bun.write(join(dir, "assets", "seed.js"), 'import "lit-html/a1.js";\n');

      const result = await writeRuntimeSubpaths(dir, fixture);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("did not settle in 10 passes");
      // Everything it did manage is still on disk — the budget truncates, it does not roll back.
      expect(existsSync(join(dir, "assets", "lit-html", "a10.js"))).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  /*
   * An emitted asset the scan cannot read is skipped, not fatal. The build has already written
   * every page by this point, and a runtime subpath that goes missing is a broken import on one
   * page — throwing here would instead discard a build that otherwise succeeded.
   */
  test("an unreadable asset is skipped rather than failing the build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-subpath-"));
    try {
      await Bun.write(
        join(dir, "assets", "locked.js"),
        'import "lit-html/directives/repeat.js";\n',
      );
      chmodSync(join(dir, "assets", "locked.js"), 0o000);
      await Bun.write(
        join(dir, "assets", "readable.js"),
        'import "lit-html/directives/class-map.js";\n',
      );

      const result = await writeRuntimeSubpaths(dir);

      expect(result.errors).toEqual([]);
      // The readable asset's subpath still lands; the unreadable one's is simply never discovered.
      expect(existsSync(join(dir, "assets", "lit-html", "directives", "class-map.js"))).toBe(true);
      expect(existsSync(join(dir, "assets", "lit-html", "directives", "repeat.js"))).toBe(false);
    } finally {
      chmodSync(join(dir, "assets", "locked.js"), 0o600);
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
