/**
 * Regression guard for the studio path-separator convention.
 *
 * Every path `project-session.ts` returns to the studio MUST be forward-slash and project-relative.
 * Node's `relative()` and `Bun.Glob.scan()` both emit OS-native backslashes on Windows, which break
 * the studio's forward-slash assumptions (e.g. `findContentTypeSchema`'s `source` prefix matching —
 * this caused image/format frontmatter widgets to silently disappear in the Windows desktop app).
 *
 * CI runs on Linux, where `relative()` never produces backslashes, so a runtime "no backslash"
 * check would pass vacuously and catch nothing. These STATIC checks enforce the convention at the
 * source instead, on any OS. If one trips, route the path through `toPosix()` / `relPosix()` rather
 * than relaxing the rule (see the "Path convention" note in project-session.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "project-session.ts"), "utf8");

describe("studio path-separator convention", () => {
  test("separator normalization is centralized in toPosix()", () => {
    // Exactly one hand-rolled `\` -> `/` replacement may exist, and it must be the toPosix helper.
    // Anything else means a handler is normalizing ad hoc (or forgetting to) — use toPosix instead.
    const replacements = SRC.match(/replaceAll\("\\\\", ?"\/"\)/g) ?? [];
    expect(replacements.length).toBe(1);
    expect(SRC).toMatch(/function toPosix\(p: string\): string \{\s*return p\.replaceAll\("\\\\"/);
  });

  test("raw Bun.Glob.scan() results are bound as rawMatch and normalized via toPosix()", () => {
    // Convention: iterate glob matches as `rawMatch`, then `const match = toPosix(rawMatch)`.
    // This keeps the un-normalized value from ever reaching a response (e.g. `path: rawMatch`).
    const scanLoops = SRC.match(/for await \(const (\w+) of [^)]*\.scan\(/g) ?? [];
    expect(scanLoops.length).toBeGreaterThan(0);
    for (const loop of scanLoops) {
      expect(loop).toContain("rawMatch");
    }
    // `rawMatch` may appear ONLY in the loop binding or wrapped in toPosix(rawMatch).
    const allUses = SRC.match(/\brawMatch\b/g) ?? [];
    const allowedUses = SRC.match(/const rawMatch of|toPosix\(rawMatch\)/g) ?? [];
    expect(allUses.length).toBe(allowedUses.length);
  });

  test("studio path fields are never assigned a bare relative() result", () => {
    // Returned path fields must use relPosix(), never a raw relative(...) that leaks backslashes.
    expect(SRC).not.toMatch(/\b(?:path|sitePath|from|to):\s*relative\(/);
  });

  test("the normalization helpers exist", () => {
    expect(SRC).toMatch(/function toPosix\(/);
    expect(SRC).toMatch(/function relPosix\(/);
  });
});
