/**
 * Tests for src/recent-store.ts — the user-level recent-projects file store.
 *
 * Node:os is mocked to a temp home BEFORE the store (and env-paths, which captures homedir at
 * module load) is imported; $XDG_CONFIG_HOME is pinned under that home so the resolved config dir
 * is deterministic on Linux too. Per-test isolation comes from wiping the store dirs.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HOME = mkdtempSync(join(process.env.TMPDIR || "/tmp", "jx-recent-"));
process.env.XDG_CONFIG_HOME = join(HOME, ".config");

void mock.module("node:os", () => {
  const homedir = () => HOME;
  const tmpdir = () => "/tmp";
  return { default: { homedir, tmpdir }, homedir, tmpdir };
});

const { readRecents, writeRecents } = await import("../src/recent-store");
const { configFile } = await import("../src/user-config");

/** The platform-conventional store path (XDG under the temp home on Linux). */
function storePath(): string {
  return configFile("recent-projects.json");
}

function legacyPath(): string {
  return join(HOME, ".jx", "recent-projects.json");
}

beforeEach(() => {
  rmSync(dirname(storePath()), { force: true, recursive: true });
  rmSync(join(HOME, ".jx"), { force: true, recursive: true });
});

afterAll(() => {
  rmSync(HOME, { force: true, recursive: true });
});

describe("readRecents", () => {
  test("returns [] when the store file does not exist", async () => {
    expect(await readRecents()).toEqual([]);
  });

  test("returns [] when the store file is corrupt JSON", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), "{not json", "utf8");
    expect(await readRecents()).toEqual([]);
  });

  test("returns [] when the stored JSON is not an array", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify({ nope: true }), "utf8");
    expect(await readRecents()).toEqual([]);
  });

  test("migrates a legacy ~/.jx/recent-projects.json into the config dir on first read", async () => {
    mkdirSync(dirname(legacyPath()), { recursive: true });
    writeFileSync(
      legacyPath(),
      JSON.stringify([{ name: "Legacy", root: "/abs/legacy", timestamp: 5 }]),
      "utf8",
    );

    const list = await readRecents();
    expect(list.map((p) => p.name)).toEqual(["Legacy"]);
    // The store now lives at the new location; the legacy file survives for downgrades.
    expect(statSync(storePath()).isFile()).toBe(true);
    expect(statSync(legacyPath()).isFile()).toBe(true);
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
