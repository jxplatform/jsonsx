/**
 * Tests for src/recent-store.ts — the user-level recent-projects file store.
 *
 * Node:os.homedir is mocked to a fresh temp directory per test so reads/writes hit a real (but
 * Disposable) filesystem location instead of the developer's home.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let home: string;

void mock.module("node:os", () => ({
  homedir: () => home,
}));

const { readRecents, writeRecents } = await import("../src/recent-store");

function storePath(): string {
  return join(home, ".jx", "recent-projects.json");
}

beforeEach(() => {
  home = mkdtempSync(join(process.env.TMPDIR || "/tmp", "jx-recent-"));
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

describe("readRecents", () => {
  test("returns [] when the store file does not exist", async () => {
    expect(await readRecents()).toEqual([]);
  });

  test("returns [] when the store file is corrupt JSON", async () => {
    mkdirSync(join(home, ".jx"), { recursive: true });
    writeFileSync(storePath(), "{not json", "utf8");
    expect(await readRecents()).toEqual([]);
  });

  test("returns [] when the stored JSON is not an array", async () => {
    mkdirSync(join(home, ".jx"), { recursive: true });
    writeFileSync(storePath(), JSON.stringify({ nope: true }), "utf8");
    expect(await readRecents()).toEqual([]);
  });
});

describe("writeRecents", () => {
  test("creates the parent directory and round-trips the list", async () => {
    const list = [{ name: "Demo", root: "/abs/demo", timestamp: 7 }];
    await writeRecents(list);
    expect(await readRecents()).toEqual(list);
  });

  test("overwrites a previously written list", async () => {
    await writeRecents([{ name: "A", root: "/a", timestamp: 1 }]);
    await writeRecents([{ name: "B", root: "/b", timestamp: 2 }]);
    const list = await readRecents();
    expect(list.map((p) => p.name)).toEqual(["B"]);
  });
});
