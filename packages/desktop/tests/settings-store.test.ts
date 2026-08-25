/**
 * Tests for src/settings-store.ts — the user-level settings file store.
 *
 * Node:os is mocked to a temp home BEFORE the store (and env-paths, which captures homedir at
 * module load) is imported; $XDG_CONFIG_HOME is pinned under that home so the resolved config dir
 * is deterministic on Linux too. Per-test isolation comes from wiping the store dirs.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const HOME = mkdtempSync(join(process.env.TMPDIR || "/tmp", "jx-settings-"));
process.env.XDG_CONFIG_HOME = join(HOME, ".config");

void mock.module("node:os", () => {
  const homedir = () => HOME;
  const tmpdir = () => "/tmp";
  return { default: { homedir, tmpdir }, homedir, tmpdir };
});

const { patchSettings, readSettings, watchSettings } = await import("../src/settings-store");
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

describe("patchSettings", () => {
  test("creates the parent directory and stores the keys it names", async () => {
    await patchSettings({ set: { aiApiKey: "sk-abc", theme: "dark" } });
    expect(await readSettings()).toEqual({ aiApiKey: "sk-abc", theme: "dark" });
  });

  test("returns the store as it then stands", async () => {
    await patchSettings({ set: { a: "1" } });
    expect(await patchSettings({ set: { b: "2" } })).toEqual({ a: "1", b: "2" });
  });

  /**
   * The defect this whole module exists to remove. `writeSettings` replaced the file, so a window
   * holding only its own view of the settings — on chromium, an ordinary welcome window with its
   * own empty browser profile — overwrote everything another window had stored.
   */
  test("leaves keys the patch does not name exactly as they were", async () => {
    await patchSettings({ set: { aiApiKey: "sk-keep", theme: "dark" } });
    await patchSettings({ set: { theme: "light" } });
    expect(await readSettings()).toEqual({ aiApiKey: "sk-keep", theme: "light" });
  });

  /** A key a newer build wrote, or a hand-edit, survives a write by a build that never heard of it. */
  test("preserves keys this build does not know about", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify({ "jx.future.setting": "kept" }), "utf8");
    await patchSettings({ set: { aiApiKey: "sk-abc" } });
    expect(await readSettings()).toEqual({ "jx.future.setting": "kept", aiApiKey: "sk-abc" });
  });

  test("remove forgets exactly the keys it names", async () => {
    await patchSettings({ set: { a: "1", b: "2", c: "3" } });
    await patchSettings({ remove: ["a", "c"] });
    expect(await readSettings()).toEqual({ b: "2" });
  });

  test("removing an absent key is a no-op, not an error", async () => {
    await patchSettings({ set: { a: "1" } });
    await patchSettings({ remove: ["never-stored"] });
    expect(await readSettings()).toEqual({ a: "1" });
  });

  test("an empty patch leaves the store untouched", async () => {
    await patchSettings({ set: { a: "1" } });
    expect(await patchSettings({})).toEqual({ a: "1" });
  });

  test("set and remove in one patch apply together", async () => {
    await patchSettings({ set: { keep: "yes", old: "gone" } });
    await patchSettings({ remove: ["old"], set: { fresh: "new" } });
    expect(await readSettings()).toEqual({ fresh: "new", keep: "yes" });
  });

  test("writes the store file owner-only (0600) on POSIX", async () => {
    await patchSettings({ set: { aiApiKey: "sk-abc" } });
    if (process.platform !== "win32") {
      // oxlint-disable-next-line no-bitwise -- masking the permission bits out of st_mode
      expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    }
  });

  /**
   * `writeFile`'s `mode` applies only when it CREATES the file, so a store that arrived
   * world-readable — which `migrateLegacyStore`'s `copyFile` can produce, since it carries the
   * legacy file's mode — kept that mode through every subsequent write. Going via a fresh temp
   * inode and renaming is what makes the module's 0600 promise hold for an upgraded install.
   */
  test("repairs the mode of a store that already exists world-readable", async () => {
    if (process.platform === "win32") {
      return;
    }
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify({ aiApiKey: "sk-leaky" }), { mode: 0o644 });
    chmodSync(storePath(), 0o644);
    await patchSettings({ set: { aiApiKey: "sk-abc" } });
    // oxlint-disable-next-line no-bitwise -- masking the permission bits out of st_mode
    expect(statSync(storePath()).mode & 0o777).toBe(0o600);
  });

  test("leaves no temp file behind, so a reader never sees a partial store", async () => {
    await patchSettings({ set: { aiApiKey: "sk-abc" } });
    const strays = readdirSync(dirname(storePath())).filter((name) => name.includes(".tmp"));
    expect(strays).toEqual([]);
  });

  /**
   * Read-modify-write under one lock. Released between the halves — which is what the store this
   * replaces did — each of these would read the same empty base and the last would win, leaving one
   * key instead of three.
   */
  test("concurrent patches compose instead of overwriting each other", async () => {
    await Promise.all([
      patchSettings({ set: { first: "1" } }),
      patchSettings({ set: { second: "2" } }),
      patchSettings({ set: { third: "3" } }),
    ]);
    expect(await readSettings()).toEqual({ first: "1", second: "2", third: "3" });
  });

  test("a torn store reads as empty and is repaired by the next patch", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), '{"aiApiKey": "sk-tr', "utf8");
    expect(await readSettings()).toEqual({});
    await patchSettings({ set: { aiApiKey: "sk-abc" } });
    expect(await readSettings()).toEqual({ aiApiKey: "sk-abc" });
  });
});

describe("watchSettings", () => {
  /** Wait for `predicate`, or give up — `fs.watch` delivers on its own schedule. */
  async function until(predicate: () => boolean, ms = 2000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) {
        return true;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    return predicate();
  }

  /**
   * The only mechanism that crosses a process boundary. Every chromium window is its own process
   * with its own browser profile, so a change made in one is invisible to the others until
   * something re-reads the file.
   */
  test("reports the store after it changes on disk", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    const seen: Record<string, string>[] = [];
    const stop = watchSettings((settings) => seen.push(settings));
    try {
      await patchSettings({ set: { aiApiKey: "sk-watched" } });
      expect(await until(() => seen.some((s) => s.aiApiKey === "sk-watched"))).toBe(true);
    } finally {
      stop();
    }
  });

  test("stops reporting once the returned unsubscribe runs", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    const seen: Record<string, string>[] = [];
    const stop = watchSettings((settings) => seen.push(settings));
    await patchSettings({ set: { a: "1" } });
    await until(() => seen.length > 0);
    stop();
    const after = seen.length;
    await patchSettings({ set: { b: "2" } });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(seen.length).toBe(after);
  });

  /**
   * Some network filesystems have no watch capability. A window that never hears about another's
   * change is stale until its next boot — which is where it was before this existed.
   */
  test("degrades to a no-op where the directory cannot be watched", () => {
    rmSync(dirname(storePath()), { force: true, recursive: true });
    const stop = watchSettings(() => {});
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
