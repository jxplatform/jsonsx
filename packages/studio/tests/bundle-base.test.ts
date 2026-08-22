/**
 * The bundle base (src/services/bundle-base.ts) — the anchor every shipped-asset URL resolves
 * against, and the fix for Monaco's workers 404ing on every host since the code-split.
 *
 * No DOM: these are three pure functions over one module-level string, so this file deliberately
 * does NOT import ./harness (which would pull happy-dom in for nothing).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { bundleUrl, resetBundleBase, setBundleBase } from "../src/services/bundle-base";

afterEach(() => {
  resetBundleBase();
});

describe("setBundleBase", () => {
  test("records the entry's DIRECTORY, not the entry file", () => {
    setBundleBase("https://example.test/studio-assets/dist/studio.js");
    expect(bundleUrl("x.js")).toBe("https://example.test/studio-assets/dist/x.js");
  });

  test("re-anchoring wins, so the iframe entry may set its own base in its own realm", () => {
    setBundleBase("https://example.test/a/dist/studio.js");
    setBundleBase("https://example.test/b/dist/iframe-entry.js");
    expect(bundleUrl("x.js")).toBe("https://example.test/b/dist/x.js");
  });

  test("a query or hash on the entry url does not leak into the base", () => {
    setBundleBase("https://example.test/dist/studio.js?t=17#x");
    expect(bundleUrl("w.js")).toBe("https://example.test/dist/w.js");
  });
});

describe("bundleUrl", () => {
  /* The four host layouts studio.md §11.1 names. Each stages the workers beside the ENTRY, which is
     the whole point: one expression, no host configuration, correct on all of them. */
  const HOSTS: [name: string, entry: string, workers: string][] = [
    [
      "repo dev server",
      "http://localhost:3000/packages/studio/dist/studio.js",
      "http://localhost:3000/packages/studio/dist/workers/json.worker.js",
    ],
    [
      "packaged desktop (views://)",
      "views://studio/dist/studio.js",
      "views://studio/dist/workers/json.worker.js",
    ],
    [
      "desktop loopback server",
      "http://127.0.0.1:54321/__studio__/dist/studio.js",
      "http://127.0.0.1:54321/__studio__/dist/workers/json.worker.js",
    ],
    [
      "cloud, under a staged prefix",
      "https://studio.jxsuite.com/studio-assets/dist/studio.js",
      "https://studio.jxsuite.com/studio-assets/dist/workers/json.worker.js",
    ],
  ];

  for (const [name, entry, expected] of HOSTS) {
    test(`resolves a worker beside the entry — ${name}`, () => {
      setBundleBase(entry);
      expect(bundleUrl("workers/json.worker.js")).toBe(expected);
    });
  }

  test("climbs out of dist/ for a package-root asset", () => {
    setBundleBase("http://localhost:3000/packages/studio/dist/studio.js");
    expect(bundleUrl("../canvas.html")).toBe("http://localhost:3000/packages/studio/canvas.html");
  });

  /* The regression this module exists for. The pre-fix expression was
     `new URL("workers/…", import.meta.url)` evaluated inside the module, which after the code-split
     is dist/chunks/monaco-setup-<hash>.js — so it resolved a directory nothing has ever staged. */
  test("does not resolve into chunks/, which is where import.meta.url used to land", () => {
    setBundleBase("http://localhost:3000/packages/studio/dist/studio.js");
    expect(bundleUrl("workers/editor.worker.js")).not.toContain("/chunks/");
  });

  test("throws, naming the path and the fix, when no entry has set a base", () => {
    expect(() => bundleUrl("workers/ts.worker.js")).toThrow(/workers\/ts\.worker\.js/);
    expect(() => bundleUrl("workers/ts.worker.js")).toThrow(/setBundleBase/);
  });
});
