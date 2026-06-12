import { describe, expect, mock, test } from "bun:test";

// Make the electrobun import fail so init() exercises its catch path.
// The real electrobun module starts a server on import; it must never load in tests.
mock.module("electrobun/bun", () => {
  throw new Error("electrobun unavailable in test env");
});

const { init, openFileDialog } = await import("../src/utils");

describe("openFileDialog before init", () => {
  test("returns null when Utils was never initialized", async () => {
    const result = await openFileDialog();
    expect(result).toBeNull();
  });
});

describe("init failure handling", () => {
  test("init swallows electrobun import failure", async () => {
    await expect(init()).resolves.toBeUndefined();
  });

  test("openFileDialog still returns null after failed init", async () => {
    await init();
    const result = await openFileDialog();
    expect(result).toBeNull();
  });
});
