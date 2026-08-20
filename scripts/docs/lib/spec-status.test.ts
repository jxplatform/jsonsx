/**
 * The version arithmetic behind `spec:bump` and `docs:status`.
 *
 * `versionFloor` exists because of a real collision: two branches each released `specs/studio.md`
 * as `0.9.31-draft`, because `spec:bump` read only the working file and neither branch could see
 * what the other had published. It surfaced at merge time as an ordering error, and the fix was
 * renumbering a header, a footer and two changelog entries by hand.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { compareSpecVersion, splitVersion, versionFloor } from "./spec-status.ts";

function v(raw: string) {
  const parsed = splitVersion(raw);
  if (!parsed) {
    throw new Error(`fixture "${raw}" is not a spec version`);
  }
  return parsed;
}

describe("versionFloor", () => {
  test("a base ahead of the working file raises the floor, and says it did", () => {
    // The exact shape of the collision: forked at 0.9.30, main released 0.9.31 meanwhile.
    // Bumping from 0.9.30 would mint 0.9.31 a second time.
    const { version, raised } = versionFloor(v("0.9.30-draft"), v("0.9.31-draft"));
    expect(version.raw).toBe("0.9.31-draft");
    expect(raised).toBe(true);
  });

  test("a base level with the working file changes nothing", () => {
    const { version, raised } = versionFloor(v("0.9.33-draft"), v("0.9.33-draft"));
    expect(version.raw).toBe("0.9.33-draft");
    expect(raised).toBe(false);
  });

  test("a base BEHIND the working file is ignored", () => {
    // The ordinary case on a branch that has already released once: the local file is ahead, and
    // The base must not drag it back.
    const { version, raised } = versionFloor(v("0.9.34-draft"), v("0.9.31-draft"));
    expect(version.raw).toBe("0.9.34-draft");
    expect(raised).toBe(false);
  });

  test("no base at all means no floor", () => {
    // An unfetched ref, a shallow clone, or a spec this branch is the one to add.
    const { version, raised } = versionFloor(v("0.1.0-draft"), null);
    expect(version.raw).toBe("0.1.0-draft");
    expect(raised).toBe(false);
  });

  test("a released base outranks the same tuple still in draft", () => {
    // `2.1.0-draft` < `2.1.0`, so graduating on main must still raise a drafting branch's floor.
    const { version, raised } = versionFloor(v("2.1.0-draft"), v("2.1.0"));
    expect(version.raw).toBe("2.1.0");
    expect(raised).toBe(true);
  });

  test("it compares numerically, not lexically", () => {
    // "0.9.9" vs "0.9.10": string comparison puts 9 after 10 and would miss the collision.
    const { version, raised } = versionFloor(v("0.9.9-draft"), v("0.9.10-draft"));
    expect(version.raw).toBe("0.9.10-draft");
    expect(raised).toBe(true);
  });
});

describe("compareSpecVersion", () => {
  test("orders by major, then minor, then patch, then draft", () => {
    expect(compareSpecVersion("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareSpecVersion("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSpecVersion("0.9.10", "0.9.9")).toBeGreaterThan(0);
    expect(compareSpecVersion("2.1.0-draft", "2.1.0")).toBeLessThan(0);
    expect(compareSpecVersion("0.9.31-draft", "0.9.31-draft")).toBe(0);
  });

  test("an unparseable version is null rather than a guess", () => {
    expect(compareSpecVersion("not-a-version", "1.0.0")).toBeNull();
  });
});

describe("against the committed specs", () => {
  test("no spec declares the same version twice in its changelog", () => {
    // The regression this whole change is about, asserted directly rather than inferred from the
    // Newest-first rule, which reports a collision as an ordering fault and sends you looking at
    // The wrong thing.
    const offenders: string[] = [];
    for (const file of [...new Bun.Glob("*.md").scanSync({ cwd: "specs" })].toSorted()) {
      const text = readFileSync(join("specs", file), "utf8");
      const seen = new Map<string, number>();
      for (const match of text.matchAll(/^- \*\*(\d+\.\d+\.\d+(?:-draft)?)\*\*/gm)) {
        const version = match[1]!;
        seen.set(version, (seen.get(version) ?? 0) + 1);
      }
      for (const [version, count] of seen) {
        if (count > 1) {
          offenders.push(`specs/${file}: ${count} changelog entries claim ${version}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
