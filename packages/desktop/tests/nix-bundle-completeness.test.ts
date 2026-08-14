/**
 * What the Nix bundle must contain, checked against what the desktop app declares.
 *
 * `package.nix`'s installPhase copies a fixed list of workspace directories and then runs
 *
 *     find $out/lib/jx-studio/node_modules -xtype l -delete
 *
 * To clear the workspace symlinks Bun made for members it did not copy. That line deletes; it does
 * not warn. So a dependency whose directory is not on the copy list is removed from the bundle
 * silently, and nothing fails until a user hits the code path that needs it.
 *
 * It happened. `@jxsuite/parser` moved into `extensions/` with the Extension Framework, the
 * installPhase copied only `packages/`, and `node_modules/@jxsuite/parser ->
 * ../../extensions/parser` dangled and was pruned. Because `packages/schema`'s loader refuses BY
 * DESIGN to read a first-party `@jxsuite/*` schema out of the project's own `node_modules` (that
 * refusal is what stops a stale published core from shadowing the workspace one), it had nowhere
 * left to read the parser's project fragment from. Every project declaring any extension lost its
 * per-project Monaco schemas, and said so only as a stack trace in the desktop log.
 *
 * The check is static — no `nix build`, no network, milliseconds — and it is the one that would
 * have caught it: every `@jxsuite/*` dependency the desktop app declares must live under a
 * directory the installPhase copies.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");

/** The workspace directories `package.nix` copies into `$out/lib/jx-studio`. */
function copiedDirs(): string[] {
  const nix = readFileSync(resolve(REPO, "packages/desktop/package.nix"), "utf8");
  return [...nix.matchAll(/^\s*cp -r (\w+) \$out\/lib\/jx-studio/gm)].map((m) => m[1]!);
}

/** The `@jxsuite/*` packages the desktop app declares as runtime dependencies. */
function declaredJxDeps(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(REPO, "packages/desktop/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith("@jxsuite/"));
}

describe("the Nix bundle ships what the desktop app depends on", () => {
  test("the installPhase copies both workspace trees", () => {
    // `extensions` is the one that was missing. Named explicitly so removing it fails HERE, with a
    // Sentence, rather than in a user's log six weeks later.
    expect(copiedDirs()).toEqual(
      expect.arrayContaining(["node_modules", "packages", "extensions"]),
    );
  });

  test("every declared @jxsuite dependency lives under a copied directory", () => {
    const copied = new Set(copiedDirs());
    const declared = declaredJxDeps();
    // Not vacuous: the app really does declare a set of them, and one really does live in
    // `extensions/`.
    expect(declared.length).toBeGreaterThan(5);

    const orphans: string[] = [];
    for (const name of declared) {
      const link = resolve(REPO, "node_modules", name);
      let target: string;
      try {
        // A workspace member is a symlink; anything else is a real install and not our problem.
        target = statSync(link).isDirectory() ? readlinkSync(link) : "";
      } catch {
        continue;
      }
      if (!target) {
        continue;
      }
      // `../../extensions/parser` → `extensions`.
      const [top] = target.replaceAll("../", "").split("/");
      if (top && !copied.has(top)) {
        orphans.push(`${name} → ${target} (installPhase never copies "${top}/")`);
      }
    }
    expect(orphans).toEqual([]);
  });
});
