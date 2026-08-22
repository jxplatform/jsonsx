/**
 * Watch-policy.test.ts — the entry filter that keeps a watcher inside its project.
 *
 * Every case here is a thing found under a real home directory when a launcher adopted it as a
 * project root: unix sockets fs.watch answers with ENXIO, and `~/.wine/dosdevices/z:`, a symlink to
 * `/`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Stats } from "node:fs";
import { createWatchIgnore } from "../src/watch-policy";

const ROOT = join(import.meta.dir, "_fixtures_watch_policy", "project");
const OUTSIDE = join(import.meta.dir, "_fixtures_watch_policy", "outside");

mkdirSync(join(ROOT, "pages"), { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(ROOT, "project.json"), "{}");
writeFileSync(join(OUTSIDE, "secret.txt"), "not project content");

function link(target: string, name: string): string {
  const path = join(ROOT, name);
  rmSync(path, { force: true });
  symlinkSync(target, path);
  return path;
}

const escaping = link(OUTSIDE, "z:");
const contained = link(join(ROOT, "pages"), "alias");
const dangling = link(join(OUTSIDE, "gone"), "dangling");

afterAll(() => {
  rmSync(join(import.meta.dir, "_fixtures_watch_policy"), { force: true, recursive: true });
});

const ignore = createWatchIgnore(ROOT, (path) => path.includes("/node_modules/"));

describe("createWatchIgnore", () => {
  test("keeps directories and regular files", () => {
    const file = join(ROOT, "project.json");
    const dir = join(ROOT, "pages");
    expect(ignore(file, statSync(file))).toBe(false);
    expect(ignore(dir, statSync(dir))).toBe(false);
  });

  test("applies the caller's own name rule before looking at the entry at all", () => {
    // No stats: a name rule is all there is to judge by, and it still decides.
    expect(ignore(join(ROOT, "node_modules", "left-pad"))).toBe(true);
    expect(ignore(join(ROOT, "pages", "index.json"))).toBe(false);
  });

  test("drops a symlink whose target leaves the root, keeps one that stays inside", () => {
    // The `.wine/dosdevices/z:` case: following it is how one watcher became a filesystem walk.
    expect(ignore(escaping, lstatSync(escaping))).toBe(true);
    expect(ignore(contained, lstatSync(contained))).toBe(false);
  });

  test("drops a dangling symlink rather than reporting its unresolvable target", () => {
    expect(ignore(dangling, lstatSync(dangling))).toBe(true);
  });

  test("drops entries that are neither a directory nor a regular file", () => {
    // A unix socket — fs.watch answers ENXIO, which chokidar raises as an `error` event.
    const socketish = {
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    } as unknown as Stats;
    expect(ignore(join(ROOT, "app.sock"), socketish)).toBe(true);
  });

  test("falls back to the lexical path when the root itself cannot be resolved", () => {
    const gone = join(import.meta.dir, "_fixtures_watch_policy", "no-such-root");
    const ignoreGone = createWatchIgnore(gone, () => false);
    // Nothing can be inside an unresolvable root, so every symlink under it reads as escaping.
    expect(ignoreGone(escaping, lstatSync(escaping))).toBe(true);
  });
});
