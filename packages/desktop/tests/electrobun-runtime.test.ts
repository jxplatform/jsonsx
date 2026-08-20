/**
 * The Windows packaging scripts used to read Electrobun's runtime binaries out of
 * `node_modules/electrobun/dist-win-x64`. Electrobun 2 deleted that path — the npm package is a
 * Hutch bootstrap with no runtime — so the resolver under test is the only thing standing between a
 * release build and an MSI containing no launcher. Both failure modes it must not have are silent:
 * pointing at a directory that does not exist, and pointing at the wrong Electrobun version's
 * binaries.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HUTCH_TARGET,
  WINDOWS_RUNTIME_FILES,
  describeRuntimeSearch,
  hutchHome,
  productDir,
  resolveWindowsRuntime,
} from "../scripts/electrobun-runtime.ts";

const VERSION = "2.0.1-beta.12";

/** A throwaway Hutch home with `launcher.exe` planted at `products/electrobun/<version>/<target>`. */
function fakeCache(target: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "jx-hutch-"));
  if (target) {
    const dir = join(home, "products", "electrobun", VERSION, target);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "launcher.exe"), "");
  }
  return home;
}

describe("hutchHome", () => {
  test("prefers HUTCH_HOME, then the deprecated DASH_HOME, then ~/.hutch", () => {
    expect(hutchHome({ DASH_HOME: "/dash", HUTCH_HOME: "/hutch" }, "/home/u")).toBe("/hutch");
    expect(hutchHome({ DASH_HOME: "/dash" }, "/home/u")).toBe("/dash");
    expect(hutchHome({}, "/home/u")).toBe(join("/home/u", ".hutch"));
  });
});

describe("productDir", () => {
  /* Hutch's platform token is `windows-x64`. Electrobun's OS token everywhere else — artifact
     prefixes, ELECTROBUN_OS, the build folder name — is `win`. Spelling this wrong resolves to a
     directory that does not exist, which is exactly what the fallback search then papers over, so
     pin the literal. */
  test("uses Hutch's windows-x64 target token, not electrobun's win", () => {
    expect(HUTCH_TARGET).toBe("windows-x64");
    expect(productDir(VERSION, "/h")).toBe(
      join("/h", "products", "electrobun", VERSION, "windows-x64"),
    );
  });
});

describe("resolveWindowsRuntime", () => {
  test("finds the pinned version's runtime at the expected target directory", () => {
    const home = fakeCache(HUTCH_TARGET);
    try {
      const { dir, searched } = resolveWindowsRuntime(VERSION, home);
      expect(dir).toBe(productDir(VERSION, home));
      expect(searched).toEqual([productDir(VERSION, home)]);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("falls back to searching the pinned version when Hutch relayouts the target dir", () => {
    const home = fakeCache("win-x64-something-else");
    try {
      const { dir } = resolveWindowsRuntime(VERSION, home);
      expect(dir).toBe(join(home, "products", "electrobun", VERSION, "win-x64-something-else"));
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  /* The search is deliberately scoped to the pinned version's directory rather than the whole
     product cache: a developer who has built against several Electrobun releases has all of them
     cached, and a wider search would happily hand this release's MSI another release's launcher. */
  test("does not reach into another cached version", () => {
    const home = mkdtempSync(join(tmpdir(), "jx-hutch-"));
    try {
      const other = join(home, "products", "electrobun", "1.99.0", HUTCH_TARGET);
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "launcher.exe"), "");

      expect(resolveWindowsRuntime(VERSION, home).dir).toBeNull();
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("reports every place it looked when nothing answers", () => {
    const home = fakeCache(null);
    try {
      const { dir, searched } = resolveWindowsRuntime(VERSION, home);
      expect(dir).toBeNull();
      expect(searched).toHaveLength(2);

      const message = describeRuntimeSearch(searched);
      for (const path of searched) {
        expect(message).toContain(path);
      }
      expect(message).toContain("sync");
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

describe("WINDOWS_RUNTIME_FILES", () => {
  /* The Bun executable belongs in neither list by default: the MSI appends it, and the MSIX
     compiles its own from a patched main.js. Sharing it here would overwrite the patched copy. */
  test("carries the launcher and native libraries but not bun.exe", () => {
    expect(WINDOWS_RUNTIME_FILES).toContain("launcher.exe");
    expect(WINDOWS_RUNTIME_FILES).toContain("libNativeWrapper.dll");
    expect(WINDOWS_RUNTIME_FILES).not.toContain("bun.exe");
  });
});
