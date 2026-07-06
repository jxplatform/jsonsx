/**
 * Tests for src/settings-store.ts — the user-level settings file store.
 *
 * Node:os is mocked to a temp home BEFORE the store (and env-paths, which captures homedir at
 * module load) is imported; $XDG_CONFIG_HOME is pinned under that home so the resolved config dir
 * is deterministic on Linux too. Per-test isolation comes from wiping the store dirs.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HOME = mkdtempSync(join(process.env.TMPDIR || "/tmp", "jx-settings-"));
process.env.XDG_CONFIG_HOME = join(HOME, ".config");

void mock.module("node:os", () => {
  const homedir = () => HOME;
  const tmpdir = () => "/tmp";
  return { default: { homedir, tmpdir }, homedir, tmpdir };
});

const { readSettings, writeSettings } = await import("../src/settings-store");
const { configFile } = await import("../src/user-config");

/** The platform-conventional store path (XDG under the temp home on Linux). */
function storePath(): string {
  return configFile("settings.json");
}

function legacyPath(): string {
  return join(HOME, ".jx", "settings.json");
}

beforeEach(() => {
  rmSync(dirname(storePath()), { force: true, recursive: true });
  rmSync(join(HOME, ".jx"), { force: true, recursive: true });
});

afterAll(() => {
  rmSync(HOME, { force: true, recursive: true });
});

describe("readSettings", () => {
  test("returns {} when the store file does not exist", async () => {
    expect(await readSettings()).toEqual({});
  });

  test("returns {} when the store file is corrupt JSON", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), "{not json", "utf8");
    expect(await readSettings()).toEqual({});
  });

  test("returns {} when the stored JSON is not an object", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(["nope"]), "utf8");
    expect(await readSettings()).toEqual({});
    writeFileSync(storePath(), "null", "utf8");
    expect(await readSettings()).toEqual({});
  });

  test("drops non-string values on read", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(
      storePath(),
      JSON.stringify({
        aiApiKey: "sk-abc",
        cleared: null,
        count: 3,
        enabled: true,
        nested: { a: 1 },
        theme: "dark",
      }),
      "utf8",
    );
    expect(await readSettings()).toEqual({ aiApiKey: "sk-abc", theme: "dark" });
  });

  test("migrates a legacy ~/.jx/settings.json into the config dir on first read", async () => {
    mkdirSync(dirname(legacyPath()), { recursive: true });
    writeFileSync(legacyPath(), JSON.stringify({ aiApiKey: "sk-legacy" }), "utf8");

    expect(await readSettings()).toEqual({ aiApiKey: "sk-legacy" });
    // The store now lives at the new location; the legacy file survives for downgrades.
    expect(statSync(storePath()).isFile()).toBe(true);
    expect(statSync(legacyPath()).isFile()).toBe(true);
  });

  test("an existing new-location store wins over a legacy file", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify({ key: "new" }), "utf8");
    mkdirSync(dirname(legacyPath()), { recursive: true });
    writeFileSync(legacyPath(), JSON.stringify({ key: "legacy" }), "utf8");
    expect(await readSettings()).toEqual({ key: "new" });
  });

  test("an unreadable legacy store falls back to a fresh start", async () => {
    // A directory where the legacy file should be makes copyFile reject.
    mkdirSync(legacyPath(), { recursive: true });
    expect(await readSettings()).toEqual({});
  });
});

describe("writeSettings", () => {
  test("creates the parent directory and round-trips the map", async () => {
    const settings = { aiApiKey: "sk-abc", theme: "dark" };
    await writeSettings(settings);
    expect(await readSettings()).toEqual(settings);
  });

  test("overwrites previously written settings", async () => {
    await writeSettings({ a: "1" });
    await writeSettings({ b: "2" });
    expect(await readSettings()).toEqual({ b: "2" });
  });

  test("writes the store file owner-only (0600) on POSIX", async () => {
    await writeSettings({ aiApiKey: "sk-abc" });
    if (process.platform !== "win32") {
      // oxlint-disable-next-line no-bitwise -- masking the permission bits out of st_mode
      expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    }
  });
});
