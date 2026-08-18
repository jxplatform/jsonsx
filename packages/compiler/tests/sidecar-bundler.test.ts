/**
 * Sidecar-bundler.test.ts — timing-aware client bundling + extension `emit` (spec.md §12,
 * extensions.md §8.4)
 *
 * Exercises, with a hermetic fixture project (local extension + local node_modules package): `$src`
 * specifier classification and resolution, buildSite's rewrite → /assets/ bundling for npm: and
 * relative Function sidecars, `$bundle` hints from lowered defs, the esbuild fallback backend, the
 * extension `emit` step (write, section gating, traversal guard), and the compiled custom-element
 * onMount/onUnmount lifecycle conformance (spec §16.4).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bundleEntry,
  bundleWorkerSource,
  isBundleableSrc,
  resolveSidecarEntry,
  workerBundleOptions,
} from "../src/site/bundler";
import { buildSite } from "../src/site/site-build";
import { compileElement } from "../src/targets/compile-element";
import type { JxDocument } from "@jxsuite/schema/types";

const TMP = resolve(import.meta.dir, "__test-sidecar-bundler__");

function writeFile(relPath: string, content: string | object) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

const PROJECT = {
  build: { format: "directory", outDir: "./dist" },
  extensions: ["./ext"],
  name: "Sidecar Fixture",
  stuff: { a: 1, b: 2 },
};

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });

  writeFile("project.json", PROJECT);

  // Hermetic npm package the fixtures import via `npm:tiny-lib`.
  writeFile("node_modules/tiny-lib/package.json", {
    main: "index.js",
    name: "tiny-lib",
    type: "module",
    version: "1.0.0",
  });
  writeFile(
    "node_modules/tiny-lib/index.js",
    `export function greet(state) { return "hello-" + (state.who ?? "world"); }\n`,
  );

  // Local extension: section owner "stuff" with emit + a lowerable state class.
  writeFile("ext/jx-extension.json", {
    classes: { Stuff: "./Stuff.class.json" },
    name: "test-emitter",
    schemas: { project: "./project.fragment.schema.json" },
  });
  writeFile("ext/project.fragment.schema.json", {
    $id: "https://jxsuite.com/schema/ext/test-emitter/project/v1",
    properties: { stuff: { type: "object" } },
    type: "object",
  });
  writeFile("ext/Stuff.class.json", {
    $defs: {
      methods: {
        emit: { identifier: "emit", role: "emit", scope: "static", timing: ["compiler"] },
        lower: { identifier: "lower", role: "lower", scope: "static", timing: ["compiler"] },
      },
    },
    $implementation: "./stuff.js",
    project: { key: "stuff", title: "Stuff" },
    title: "Stuff",
  });
  writeFile(
    "ext/stuff.js",
    `export class Stuff {
  static emit(sectionValue, ctx) {
    const files = [{
      content: JSON.stringify({ keys: Object.keys(sectionValue ?? {}), routes: ctx.routes.length }),
      path: "/stuff-index.json",
    }];
    if (sectionValue && sectionValue.evil) {
      files.push({ content: "nope", path: "../evil.txt" });
    }
    return files;
  }
  static lower() {
    return { $bundle: ["npm:tiny-lib"], $prototype: "Function", body: "return 1;", timing: "client" };
  }
}
`,
  );

  // Interactive component with npm:, relative, and absolute-URL sidecars.
  writeFile("components/demo-widget.json", {
    children: [
      { attributes: { onclick: { $ref: "#/state/bump" } }, tagName: "button", textContent: "+1" },
      { tagName: "span", textContent: "${state.count}" },
    ],
    state: {
      bump: {
        $prototype: "Function",
        $src: "./demo-widget-helpers.js",
        parameters: [{ identifier: "state" }],
      },
      count: 0,
      greet: {
        $prototype: "Function",
        $src: "npm:tiny-lib",
        parameters: [{ identifier: "state" }],
      },
      prebuilt: {
        $prototype: "Function",
        $src: "/lib/prebuilt.js",
        parameters: [{ identifier: "state" }],
      },
      who: "jx",
    },
    tagName: "demo-widget",
  });
  writeFile(
    "components/demo-widget-helpers.js",
    `export function bump(state) { state.count += 1; }\n`,
  );

  // Component declaring a sidecar that does not exist on disk (historical permissive case).
  writeFile("components/ghost-widget.json", {
    children: [
      { attributes: { onclick: { $ref: "#/state/spook" } }, tagName: "button", textContent: "?" },
      { tagName: "span", textContent: "${state.n}" },
    ],
    state: {
      n: 0,
      spook: { $prototype: "Function", $src: "./ghost-helpers.js", parameters: ["state"] },
    },
    tagName: "ghost-widget",
  });

  // Dynamic page whose lowered state def registers a bundle via $bundle, plus a page-level
  // Relative sidecar (resolved against pages/).
  writeFile("pages/index.json", {
    children: [{ tagName: "p", textContent: "${state.magic}" }, { tagName: "demo-widget" }],
    state: {
      magic: { $prototype: "Stuff", timing: "client" },
      pgHelper: { $prototype: "Function", $src: "./page-helpers.js", parameters: ["state"] },
    },
    tagName: "main",
  });
  writeFile("pages/page-helpers.js", `export function pgHelper(state) { return state.who; }\n`);
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

// ─── Unit: specifier classification and resolution ───────────────────────────

describe("isBundleableSrc", () => {
  test("npm: and relative specifiers are bundleable; URLs and absolute paths are not", () => {
    expect(isBundleableSrc("npm:tiny-lib")).toBe(true);
    expect(isBundleableSrc("./helpers.js")).toBe(true);
    expect(isBundleableSrc("../lib/util.ts")).toBe(true);
    expect(isBundleableSrc("/assets/prebuilt.js")).toBe(false);
    expect(isBundleableSrc("https://esm.sh/left-pad")).toBe(false);
  });
});

describe("resolveSidecarEntry", () => {
  test("npm: resolves through node_modules from the project root", () => {
    const entry = resolveSidecarEntry("npm:tiny-lib", "/nonsense", TMP);
    expect(entry).toBe(resolve(TMP, "node_modules/tiny-lib/index.js"));
  });

  test("relative resolves against the declaring document's directory", () => {
    const entry = resolveSidecarEntry("./demo-widget-helpers.js", resolve(TMP, "components"), TMP);
    expect(entry).toBe(resolve(TMP, "components/demo-widget-helpers.js"));
  });

  test("unresolvable npm specifier throws", () => {
    expect(() => resolveSidecarEntry("npm:not-a-real-pkg-xyz", TMP, TMP)).toThrow();
  });

  test("JX_BUNDLER=esbuild forces createRequire resolution with the same result", () => {
    const { JX_BUNDLER: prev } = process.env;
    process.env.JX_BUNDLER = "esbuild";
    try {
      const entry = resolveSidecarEntry("npm:tiny-lib", "/nonsense", TMP);
      expect(entry).toBe(resolve(TMP, "node_modules/tiny-lib/index.js"));
    } finally {
      if (prev === undefined) {
        delete process.env.JX_BUNDLER;
      } else {
        process.env.JX_BUNDLER = prev;
      }
    }
  });
});

// ─── Integration: buildSite bundles sidecars and runs emit ───────────────────

describe("buildSite sidecar bundling + emit", () => {
  let errors: string[] = [];

  beforeAll(async () => {
    ({ errors } = await buildSite(TMP, { verbose: false }));
  });

  test("build completes without errors", () => {
    expect(errors).toEqual([]);
  });

  test("npm: sidecar from a component bundles to /assets/ with the lib inlined", () => {
    const bundled = readFileSync(resolve(TMP, "dist/assets/tiny-lib.js"), "utf8");
    expect(bundled).toContain("hello-");
    // Self-contained: no unresolved imports remain (path comments may mention node_modules).
    expect(bundled).not.toContain("npm:");
    expect(bundled).not.toMatch(/from\s+["']tiny-lib["']/);
  });

  test("relative sidecar bundles under its project-relative slug", () => {
    const bundled = readFileSync(
      resolve(TMP, "dist/assets/components-demo-widget-helpers.js"),
      "utf8",
    );
    expect(bundled).toContain("count += 1");
  });

  test("compiled component imports the /assets/ bundles, not the raw specifiers", () => {
    const module = readFileSync(resolve(TMP, "dist/components/demo-widget.js"), "utf8");
    expect(module).toContain("from '/assets/tiny-lib.js'");
    expect(module).toContain("from '/assets/components-demo-widget-helpers.js'");
    expect(module).not.toContain("npm:tiny-lib");
    expect(module).not.toContain("'./demo-widget-helpers.js'");
  });

  test("absolute-URL $src specifiers are served as-is, never bundled", () => {
    const module = readFileSync(resolve(TMP, "dist/components/demo-widget.js"), "utf8");
    expect(module).toContain("from '/lib/prebuilt.js'");
  });

  test("page-level relative sidecars bundle under the pages/ slug and rewrite app.js", () => {
    const appJs = readFileSync(resolve(TMP, "dist/app.js"), "utf8");
    expect(appJs).toContain("from '/assets/pages-page-helpers.js'");
    const bundled = readFileSync(resolve(TMP, "dist/assets/pages-page-helpers.js"), "utf8");
    expect(bundled).toContain("state.who");
  });

  test("$bundle hints from lowered defs register bundles without an importing document", () => {
    // The page's `magic` def lowers to an inline body; tiny-lib is bundled solely because
    // The lower() result named it in $bundle.
    expect(existsSync(resolve(TMP, "dist/assets/tiny-lib.js"))).toBe(true);
    const appJs = readFileSync(resolve(TMP, "dist/app.js"), "utf8");
    expect(appJs).toContain("return 1;");
    expect(appJs).not.toContain("$bundle");
  });

  test("a declared-but-absent relative sidecar warns and keeps its verbatim import", () => {
    // No build error (see the errors assertion above); the emitted module falls back to the
    // Historical unbundled import instead of a /assets/ URL.
    const module = readFileSync(resolve(TMP, "dist/components/ghost-widget.js"), "utf8");
    expect(module).toContain("from './ghost-helpers.js'");
    expect(existsSync(resolve(TMP, "dist/assets/components-ghost-helpers.js"))).toBe(false);
  });

  test("extension emit writes section-gated assets into dist", () => {
    const index = JSON.parse(readFileSync(resolve(TMP, "dist/stuff-index.json"), "utf8")) as {
      keys: string[];
      routes: number;
    };
    expect(index.keys).toEqual(["a", "b"]);
    expect(index.routes).toBeGreaterThan(0);
  });
});

describe("buildSite emit gating and traversal guard", () => {
  const GATED = resolve(import.meta.dir, "__test-sidecar-gated__");

  afterAll(() => {
    rmSync(GATED, { force: true, recursive: true });
  });

  function scaffold(project: object) {
    rmSync(GATED, { force: true, recursive: true });
    mkdirSync(resolve(GATED, "ext"), { recursive: true });
    for (const f of [
      "jx-extension.json",
      "Stuff.class.json",
      "project.fragment.schema.json",
      "stuff.js",
    ]) {
      writeFileSync(resolve(GATED, "ext", f), readFileSync(resolve(TMP, "ext", f)));
    }
    mkdirSync(resolve(GATED, "pages"), { recursive: true });
    writeFileSync(
      resolve(GATED, "pages/index.json"),
      JSON.stringify({ children: [{ tagName: "h1", textContent: "hi" }], tagName: "main" }),
      "utf8",
    );
    writeFileSync(resolve(GATED, "project.json"), JSON.stringify(project), "utf8");
  }

  test("emit is skipped when the owning section is absent", async () => {
    scaffold({
      build: { format: "directory", outDir: "./dist" },
      extensions: ["./ext"],
      name: "G",
    });
    const result = await buildSite(GATED, { verbose: false });
    expect(result.errors).toEqual([]);
    expect(existsSync(resolve(GATED, "dist/stuff-index.json"))).toBe(false);
  });

  test("emit paths escaping outDir are rejected and reported", async () => {
    scaffold({
      build: { format: "directory", outDir: "./dist" },
      extensions: ["./ext"],
      name: "G",
      stuff: { evil: true },
    });
    const result = await buildSite(GATED, { verbose: false });
    expect(result.errors.some((e) => e.includes("escapes outDir"))).toBe(true);
    expect(existsSync(resolve(GATED, "evil.txt"))).toBe(false);
    // In-bounds files earlier in the batch were already written when the bad path threw.
    expect(existsSync(resolve(GATED, "dist/stuff-index.json"))).toBe(true);
  });
});

describe("buildSite sidecar/worker failure reporting", () => {
  const ERRS = resolve(import.meta.dir, "__test-sidecar-errors__");

  beforeAll(() => {
    rmSync(ERRS, { force: true, recursive: true });
    const write = (rel: string, content: string | object) => {
      const abs = resolve(ERRS, rel);
      mkdirSync(resolve(abs, ".."), { recursive: true });
      writeFileSync(
        abs,
        typeof content === "string" ? content : JSON.stringify(content, null, 2),
        "utf8",
      );
    };
    write("project.json", {
      build: { adapter: "cloudflare-workers", format: "directory", outDir: "./dist" },
      name: "Sidecar Errors",
    });
    write("pages/index.json", { children: [{ tagName: "collide-widget" }], tagName: "main" });
    // Two existing sidecar files whose project-relative paths slug to the same asset name.
    write("components/collide-widget.json", {
      children: [{ tagName: "span", textContent: "${state.n}" }],
      state: {
        aOne: { $prototype: "Function", $src: "./alpha-beta.js", parameters: ["state"] },
        aTwo: { $prototype: "Function", $src: "./alpha/beta.js", parameters: ["state"] },
        broken: { $prototype: "Function", $src: "./broken-helpers.js", parameters: ["state"] },
        n: 0,
      },
      tagName: "collide-widget",
    });
    write("components/alpha-beta.js", "export function aOne(state) { return 1; }\n");
    write("components/alpha/beta.js", "export function aTwo(state) { return 2; }\n");
    // Exists (so it registers) but fails to parse at bundle time.
    write("components/broken-helpers.js", "export {  // unterminated\n");
    // A server function whose module imports an unresolvable package fails worker bundling.
    write("components/mail-widget.json", {
      children: [{ children: ["Mail"], tagName: "form" }],
      state: {
        sendMail: { $export: "sendMail", $src: "./mailer.server.js", timing: "server" },
      },
      tagName: "mail-widget",
    });
    write(
      "components/mailer.server.js",
      `import missing from "definitely-not-a-real-pkg-xyz";\nexport function sendMail() { return missing; }\n`,
    );
  });

  afterAll(() => {
    rmSync(ERRS, { force: true, recursive: true });
  });

  test("slug collisions, broken sidecars, and worker bundle failures land in errors[]", async () => {
    const result = await buildSite(ERRS, { verbose: false });
    // Collision between ./alpha-beta.js and ./alpha/beta.js on one asset slug.
    expect(
      result.errors.some((e) => e.includes("both map to /assets/components-alpha-beta.js")),
    ).toBe(true);
    // The colliding specifier and the broken sidecar keep their verbatim imports.
    const module = readFileSync(resolve(ERRS, "dist/components/collide-widget.js"), "utf8");
    expect(module).toContain("from '/assets/components-alpha-beta.js'");
    expect(module).toContain("from './alpha/beta.js'");
    // Registered-but-unparseable sidecar fails at bundle time, not silently.
    expect(result.errors.some((e) => e.includes('bundling sidecar "./broken-helpers.js"'))).toBe(
      true,
    );
    // Worker bundling failure is reported without aborting the build.
    expect(result.errors.some((e) => e.includes("Error bundling dist/worker.js"))).toBe(true);
    expect(existsSync(resolve(ERRS, "dist/index.html"))).toBe(true);
  });
});

// ─── esbuild fallback backend ────────────────────────────────────────────────

describe("bundleEntry esbuild fallback", () => {
  test("JX_BUNDLER=esbuild produces a self-contained ESM bundle", async () => {
    const outfile = resolve(TMP, "dist-esbuild-check/out.js");
    mkdirSync(resolve(TMP, "dist-esbuild-check"), { recursive: true });
    const { JX_BUNDLER: prev } = process.env;
    process.env.JX_BUNDLER = "esbuild";
    try {
      await bundleEntry(
        { entryPath: resolve(TMP, "node_modules/tiny-lib/index.js"), outfile },
        { external: [], target: "browser" },
      );
    } finally {
      if (prev === undefined) {
        delete process.env.JX_BUNDLER;
      } else {
        process.env.JX_BUNDLER = prev;
      }
    }
    const bundled = readFileSync(outfile, "utf8");
    expect(bundled).toContain("hello-");
    expect(bundled).toContain("export");
  });
});

describe("workerBundleOptions", () => {
  test("cloudflare adapters resolve with workerd conditions and keep platform imports external", () => {
    for (const adapter of ["cloudflare-workers", "cloudflare-pages"]) {
      expect(workerBundleOptions(adapter)).toEqual({
        conditions: ["workerd", "worker"],
        external: ["cloudflare:*", "node:*"],
        target: "workerd",
      });
    }
  });

  test("node and bun adapters bundle platform-native", () => {
    expect(workerBundleOptions("node")).toEqual({ target: "node" });
    expect(workerBundleOptions("bun")).toEqual({ target: "bun" });
  });
});

describe("bundleWorkerSource esbuild fallback", () => {
  test("JX_BUNDLER=esbuild bundles worker source via stdin, resolving from the project root", async () => {
    const outfile = resolve(TMP, "dist-esbuild-check/worker-out.js");
    mkdirSync(resolve(TMP, "dist-esbuild-check"), { recursive: true });
    const source = `import { greet } from "tiny-lib";\nexport default { fetch: () => new Response(greet({})) };\n`;
    const { JX_BUNDLER: prev } = process.env;
    process.env.JX_BUNDLER = "esbuild";
    try {
      await bundleWorkerSource(source, { adapter: "node", outfile, projectRoot: TMP });
    } finally {
      if (prev === undefined) {
        delete process.env.JX_BUNDLER;
      } else {
        process.env.JX_BUNDLER = prev;
      }
    }
    const bundled = readFileSync(outfile, "utf8");
    expect(bundled).toContain("hello-");
    expect(bundled).not.toMatch(/from\s*["']tiny-lib["']/);
  });
});

describe("bundleEntry failure reporting", () => {
  test("a broken entry rejects with the backend's diagnostics", async () => {
    const entry = resolve(TMP, "broken-entry.js");
    writeFileSync(entry, "export {  // unterminated\n", "utf8");
    const outfile = resolve(TMP, "dist-esbuild-check/broken.js");
    mkdirSync(resolve(TMP, "dist-esbuild-check"), { recursive: true });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(bundleEntry({ entryPath: entry, outfile }, { target: "browser" })).rejects.toThrow(
      /Bun\.build failed/,
    );
  });
});

// ─── Custom-element lifecycle conformance (spec §16.4) ───────────────────────

describe("compiled element onMount/onUnmount", () => {
  test("emitted module invokes state.onMount on a microtask and onUnmount on disconnect", async () => {
    const doc = {
      children: [{ tagName: "p", textContent: "${state.n}" }],
      state: {
        n: 0,
        onMount: { $prototype: "Function", arguments: ["state"], body: "state.n = 1;" },
        onUnmount: { $prototype: "Function", arguments: ["state"], body: "state.n = 2;" },
      },
      tagName: "life-cycle",
    } as unknown as JxDocument;
    const result = await compileElement(doc);
    const module = result.files[0]!.content;
    expect(module).toContain("queueMicrotask(() => this.state.onMount(this.state));");
    expect(module).toContain(
      "if (typeof this.state.onUnmount === 'function') { this.state.onUnmount(this.state); }",
    );
    // OnMount runs after connect, not during construction.
    const connectedAt = module.indexOf("connectedCallback()");
    const mountAt = module.indexOf("queueMicrotask(() => this.state.onMount");
    expect(mountAt).toBeGreaterThan(connectedAt);
  });
});
