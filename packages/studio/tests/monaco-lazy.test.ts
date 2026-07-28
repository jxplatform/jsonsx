/**
 * Lazy Monaco (W4) — memoization, the sync accessor's contract, and the load-once guarantee.
 *
 * Monaco is two thirds of the studio bundle and most sessions never open a code view, so it must
 * not be reachable from the eager import graph. These tests pin the loader's behaviour; the "not in
 * the entry bundle" half is enforced by the build (`splitting: true` plus the chunk naming contract
 * in scripts/build.ts).
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

void mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (u: string) => ({ toString: () => u }) },
  editor: { create: () => ({}) },
  languages: { registerCompletionItemProvider: () => {} },
}));

void mock.module("../src/services/monaco-setup", () => ({
  modelUriFor: (p: string) => `file:///${p}`,
}));

const { isMonacoLoaded, loadedMonaco, loadMonaco, resetMonacoLazy } =
  await import("../src/services/monaco-lazy");

beforeEach(() => {
  resetMonacoLazy();
});

afterEach(() => {
  resetMonacoLazy();
});

describe("loadMonaco", () => {
  test("does not load until asked", () => {
    expect(isMonacoLoaded()).toBe(false);
    expect(loadedMonaco()).toBeNull();
  });

  test("resolves the namespace and reports loaded", async () => {
    const monaco = await loadMonaco();
    expect(monaco.MarkerSeverity.Error).toBe(8);
    expect(isMonacoLoaded()).toBe(true);
    expect(loadedMonaco()).toBe(monaco);
  });

  test("is memoized — a second call returns the same namespace", async () => {
    const first = await loadMonaco();
    const second = await loadMonaco();
    expect(second).toBe(first);
  });

  test("concurrent callers share ONE in-flight load", async () => {
    // Promise identity, not merely the same resolved value: monaco-setup registers the worker
    // Factory and the JSON/TS/JS language contributions as import side effects, so two racing
    // Callers must not each drive a load.
    const a = loadMonaco();
    const b = loadMonaco();
    expect(a).toBe(b);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
  });

  test("a load after a reset starts a fresh in-flight promise", async () => {
    const first = loadMonaco();
    await first;
    resetMonacoLazy();
    const second = loadMonaco();
    expect(second).not.toBe(first);
    expect(await second).toBeTruthy();
  });
});

describe("loadedMonaco", () => {
  test("stays null until a load completes, then returns the namespace", async () => {
    const pending = loadMonaco();
    // Synchronously after kicking off the load, nothing is available yet — call sites that use the
    // Sync accessor are only reachable with an editor already mounted.
    expect(loadedMonaco()).toBeNull();
    const monaco = await pending;
    expect(loadedMonaco()).toBe(monaco);
  });
});
