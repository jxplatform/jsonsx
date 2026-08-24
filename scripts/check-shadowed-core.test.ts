/**
 * A starter that has been iterated inside Studio has been `bun install`ed, and a starter pins
 * PUBLISHED versions because it is a template. These tests pin the three distinctions that decide
 * what may be deleted: first-party vs third-party, real directory vs workspace symlink, and the
 * lockfile that would otherwise reproduce the shadow on the next install.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findShadows, removeScopeBinLinks, removeShadow, shadowsIn } from "./check-shadowed-core";

/** A project root with the given packages installed under `node_modules`. */
function projectWith(
  packages: { name: string; version?: string; symlink?: boolean; dangling?: boolean }[],
): string {
  const root = mkdtempSync(resolve(tmpdir(), "jx-shadow-"));
  writeFileSync(join(root, "project.json"), JSON.stringify({ name: "fixture" }));
  for (const pkg of packages) {
    const dir = join(root, "node_modules", pkg.name);
    if (pkg.dangling) {
      /* A link to a target that is deliberately never created — the package moved out from under
         an install that predates the move. A JUNCTION, like every directory link in this file:
         Windows refuses a plain directory symlink with EPERM unless the process is elevated or
         Developer Mode is on, while junctions need neither — and are what Bun itself makes for
         workspace links. The argument is ignored on POSIX. */
      mkdirSync(resolve(dir, ".."), { recursive: true });
      symlinkSync(join(root, "moved-away"), dir, "junction");
      continue;
    }
    if (pkg.symlink) {
      const target = join(root, "workspace-target");
      mkdirSync(target, { recursive: true });
      mkdirSync(resolve(dir, ".."), { recursive: true });
      symlinkSync(target, dir, "junction");
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: pkg.name, version: pkg.version ?? "0.0.1" }),
    );
  }
  return root;
}

describe("what counts as a shadow", () => {
  test("a real first-party package does, and reports the version it would answer with", () => {
    const root = projectWith([{ name: "@jxsuite/schema", version: "0.35.0" }]);
    try {
      const found = shadowsIn(root);
      expect(found).toHaveLength(1);
      expect(found[0]!.specifier).toBe("@jxsuite/schema");
      expect(found[0]!.version).toBe("0.35.0");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a workspace symlink does not — that is `examples/`, and it is the correct answer", () => {
    const root = projectWith([{ name: "@jxsuite/compiler", symlink: true }]);
    try {
      expect(shadowsIn(root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("third-party packages do not — the install is wanted, it is how a starter previews", () => {
    const root = projectWith([
      { name: "@shoelace-style/shoelace", version: "2.20.1" },
      { name: "@jxsuite/runtime", version: "0.19.0" },
    ]);
    try {
      expect(shadowsIn(root).map((s) => s.specifier)).toEqual(["@jxsuite/runtime"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a half-written install still shadows, and is reported without a version", () => {
    const root = mkdtempSync(resolve(tmpdir(), "jx-shadow-partial-"));
    try {
      mkdirSync(join(root, "node_modules", "@jxsuite", "schema"), { recursive: true });
      const found = shadowsIn(root);
      expect(found).toHaveLength(1);
      expect(found[0]!.version).toBe("unknown");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a root with no node_modules at all is quiet", () => {
    const root = projectWith([]);
    try {
      expect(shadowsIn(root)).toEqual([]);
      expect(findShadows([root])).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("removal", () => {
  test("takes the first-party package and the lockfile, and leaves the rest of the install", () => {
    const root = projectWith([
      { name: "@jxsuite/schema", version: "0.35.0" },
      { name: "@shoelace-style/shoelace", version: "2.20.1" },
    ]);
    writeFileSync(join(root, "bun.lock"), "{}");
    try {
      const [shadow] = shadowsIn(root);
      removeShadow(shadow!);

      expect(existsSync(join(root, "node_modules", "@jxsuite", "schema"))).toBe(false);
      // The lockfile goes too, or the next install faithfully reproduces what was just removed.
      expect(existsSync(join(root, "bun.lock"))).toBe(false);
      // …and the third-party dependency the starter actually previews with survives.
      expect(existsSync(join(root, "node_modules", "@shoelace-style/shoelace"))).toBe(true);
      expect(shadowsIn(root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("is idempotent — a second pass over a clean root is a no-op", () => {
    const root = projectWith([{ name: "@jxsuite/schema" }]);
    try {
      const [shadow] = shadowsIn(root);
      removeShadow(shadow!);
      expect(() => removeShadow(shadow!)).not.toThrow();
      expect(shadowsIn(root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("prunes the scope directory it emptied, and node_modules if that emptied too", () => {
    const root = projectWith([{ name: "@jxsuite/schema" }]);
    try {
      removeShadow(shadowsIn(root)[0]!);
      expect(existsSync(join(root, "node_modules"))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("but keeps node_modules when a third-party package is still living in it", () => {
    const root = projectWith([{ name: "@jxsuite/schema" }, { name: "@shoelace-style/shoelace" }]);
    try {
      removeShadow(shadowsIn(root)[0]!);
      expect(existsSync(join(root, "node_modules", "@jxsuite"))).toBe(false);
      expect(existsSync(join(root, "node_modules", "@shoelace-style/shoelace"))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("findShadows across roots", () => {
  test("reports every offending root, and names which package each one shadows", () => {
    const clean = projectWith([{ name: "@shoelace-style/shoelace" }]);
    const dirty = projectWith([{ name: "@jxsuite/schema", version: "0.35.0" }]);
    try {
      const found = findShadows([clean, dirty]);
      expect(found).toHaveLength(1);
      expect(found[0]!.root).toBe(dirty);
    } finally {
      rmSync(clean, { force: true, recursive: true });
      rmSync(dirty, { force: true, recursive: true });
    }
  });
});

describe("a dangling first-party symlink", () => {
  test("is reported, because a link to nothing still beats the link that replaced it", () => {
    /*
     * The skip used to be "is it a symlink", which is right only while the target exists. When
     * @jxsuite/parser moved from packages/ to extensions/, examples/node_modules kept a link to
     * the old path — and a nested node_modules entry wins over the root link, so the import failed
     * outright while the checker reported the tree clean.
     */
    const root = projectWith([{ dangling: true, name: "@jxsuite/parser" }]);
    try {
      const found = shadowsIn(root);
      expect(found).toHaveLength(1);
      expect(found[0]!.kind).toBe("dangling");
      expect(found[0]!.specifier).toBe("@jxsuite/parser");
      expect(found[0]!.version).toBe("unresolvable");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("is distinguished from a resolving workspace link, which stays skipped", () => {
    const root = projectWith([
      { dangling: true, name: "@jxsuite/parser" },
      { name: "@jxsuite/schema", symlink: true },
    ]);
    try {
      expect(shadowsIn(root).map((s) => s.specifier)).toEqual(["@jxsuite/parser"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("--fix removes the link and leaves the lockfile alone", () => {
    /*
     * The lockfile is innocent here. A shadow's lockfile would faithfully reproduce the published
     * copy on the next install, which is why removeShadow deletes it — but a stale link is not
     * something the lockfile describes, and removing it would force a needless reinstall.
     */
    const root = projectWith([{ dangling: true, name: "@jxsuite/parser" }]);
    try {
      writeFileSync(join(root, "bun.lock"), "{}");
      removeShadow(shadowsIn(root)[0]!);
      expect(existsSync(join(root, "bun.lock"))).toBe(true);
      expect(shadowsIn(root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

/**
 * Whether this machine can create a symlink to a FILE.
 *
 * The two tests below are about `.bin` entries, which are file links, and Windows refuses those
 * with EPERM unless the process is elevated or Developer Mode is on — a directory junction is no
 * substitute. Probed rather than branched on `process.platform`, so the tests run on a Windows
 * machine that does allow it, and are reported as skipped rather than passing vacuously on one that
 * does not.
 */
const canSymlinkFiles = (() => {
  const probeRoot = mkdtempSync(join(tmpdir(), "shadow-symlink-probe-"));
  try {
    const target = join(probeRoot, "target.js");
    writeFileSync(target, "");
    symlinkSync(target, join(probeRoot, "link.js"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { force: true, recursive: true });
  }
})();

describe("the bin links a removed shadow leaves behind", () => {
  test.skipIf(!canSymlinkFiles)(
    "a link into the deleted scope goes with it, and a foreign one stays",
    () => {
      /* This is not tidiness. A dangling symlink is not skipped by a recursive copy, it THROWS —
       the desktop build copies packages/starters/sites wholesale into the app and died on
       `ENOENT: statx .../node_modules/.bin/jx`, a link left by an install whose @jxsuite/compiler
       this cleaner had already removed. */
      const root = mkdtempSync(join(tmpdir(), "shadow-bin-"));
      const nodeModules = join(root, "node_modules");
      mkdirSync(join(nodeModules, ".bin"), { recursive: true });
      symlinkSync("../@jxsuite/compiler/src/cli.js", join(nodeModules, ".bin", "jx"));
      symlinkSync("../js-yaml/bin/js-yaml.mjs", join(nodeModules, ".bin", "js-yaml"));

      const removed = removeScopeBinLinks(nodeModules);

      expect(removed).toHaveLength(1);
      expect(removed[0]).toContain("jx");
      // `readdirSync`, not `existsSync`: the foreign link is dangling too (its target was never
      // Created here), and existsSync FOLLOWS a symlink, so it answers false for a link that is
      // Very much still on disk. Judging survival by the link itself is the whole point.
      expect(readdirSync(join(nodeModules, ".bin"))).toEqual(["js-yaml"]);
      rmSync(root, { force: true, recursive: true });
    },
  );

  test.skipIf(!canSymlinkFiles)("the .bin directory itself goes once nothing is left in it", () => {
    const root = mkdtempSync(join(tmpdir(), "shadow-bin-"));
    const nodeModules = join(root, "node_modules");
    mkdirSync(join(nodeModules, ".bin"), { recursive: true });
    symlinkSync("../@jxsuite/compiler/src/cli.js", join(nodeModules, ".bin", "jx"));

    removeScopeBinLinks(nodeModules);

    expect(existsSync(join(nodeModules, ".bin"))).toBe(false);
    rmSync(root, { force: true, recursive: true });
  });

  test("a real file in .bin is never touched — only symlinks are judged", () => {
    const root = mkdtempSync(join(tmpdir(), "shadow-bin-"));
    const nodeModules = join(root, "node_modules");
    mkdirSync(join(nodeModules, ".bin"), { recursive: true });
    writeFileSync(join(nodeModules, ".bin", "jx"), "#!/bin/sh\n");

    expect(removeScopeBinLinks(nodeModules)).toEqual([]);
    expect(existsSync(join(nodeModules, ".bin", "jx"))).toBe(true);
    rmSync(root, { force: true, recursive: true });
  });

  test("no .bin at all is not an error", () => {
    const root = mkdtempSync(join(tmpdir(), "shadow-bin-"));
    mkdirSync(join(root, "node_modules"), { recursive: true });
    expect(removeScopeBinLinks(join(root, "node_modules"))).toEqual([]);
    rmSync(root, { force: true, recursive: true });
  });
});
