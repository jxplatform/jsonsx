import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_RUNTIME_MODULES,
  renderImportMap,
  resolveClientRuntime,
  writeClientRuntime,
} from "../src/site/client-runtime.ts";

describe("resolveClientRuntime", () => {
  test("points both modules at /assets/ when they resolve", () => {
    const runtime = resolveClientRuntime();

    expect(runtime.imports).toEqual({
      "@vue/reactivity": "/assets/vue-reactivity.js",
      "lit-html": "/assets/lit-html.js",
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
