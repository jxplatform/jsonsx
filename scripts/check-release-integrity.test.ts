/**
 * Covers `scripts/check-release-integrity.ts` — the gate that would have caught, on the day it
 * happened, `packages/starters` being versioned to 1.3.0 in the manifest and never released.
 *
 * The release probe is injected, so the assertions below never touch GitHub: what is tested is the
 * tag arithmetic (which must track `release-please-config.json`, not a hardcoded shape), the gap
 * logic, and that the report names the cause.
 */

import { describe, expect, test } from "bun:test";

import { findGaps, readTargets, report, tagFor } from "./check-release-integrity.ts";
import type { ReleaseTarget } from "./check-release-integrity.ts";

const CONFIG = {
  "include-v-in-tag": true,
  "include-component-in-tag": true,
  packages: {
    "packages/starters": { component: "starters" },
    "extensions/feed": { component: "feed" },
    "packages/odd": { "include-v-in-tag": false, "tag-separator": "@", component: "odd" },
    "packages/solo": { "include-component-in-tag": false },
    "packages/unnamed": {},
  },
};

const target = (over: Partial<ReleaseTarget> = {}): ReleaseTarget => ({
  path: "packages/starters",
  tag: "starters-v1.5.0",
  version: "1.5.0",
  ...over,
});

/** GitHub with exactly `releases` present. */
const released =
  (...releases: string[]) =>
  (tag: string) =>
    Promise.resolve(releases.includes(tag));

describe("tagFor", () => {
  test("matches the tags release-please actually created", () => {
    expect(tagFor("packages/starters", "1.5.0", CONFIG)).toBe("starters-v1.5.0");
    expect(tagFor("extensions/feed", "0.3.1", CONFIG)).toBe("feed-v0.3.1");
  });

  test("honours per-package overrides rather than assuming the default shape", () => {
    expect(tagFor("packages/odd", "2.0.0", CONFIG)).toBe("odd@2.0.0");
    expect(tagFor("packages/solo", "2.0.0", CONFIG)).toBe("v2.0.0");
  });

  test("falls back to the directory name when no component is configured", () => {
    expect(tagFor("packages/unnamed", "1.0.0", CONFIG)).toBe("unnamed-v1.0.0");
  });
});

describe("readTargets", () => {
  test("reads this repository's real manifest and derives a tag for every entry", async () => {
    const targets = await readTargets();
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(t.tag).toMatch(/^[a-z]+-v\d+\.\d+\.\d+/);
    }
  });

  test("every manifest entry is judged, including the ones npm never receives", async () => {
    const targets = await readTargets();
    // The desktop component ships as installers rather than to npm and still owes a release.
    // That is where the bundlers attach, and how desktop-v2.2.0 shipped with no installers.
    expect(targets.find((t) => t.path === "packages/desktop")).toBeDefined();
    expect(targets.find((t) => t.path === "packages/starters")).toBeDefined();
  });
});

describe("findGaps", () => {
  test("a released component is not a gap", async () => {
    expect(await findGaps([target()], released("starters-v1.5.0"))).toEqual([]);
  });

  test("the release-please skip: manifest bumped, nothing released", async () => {
    expect(await findGaps([target()], released())).toEqual([target()]);
  });

  test("judges every target, not just the first", async () => {
    const many = ["ai", "site", "runtime"].map((c) =>
      target({ path: `packages/${c}`, tag: `${c}-v1.5.0` }),
    );
    const gaps = await findGaps(many, released("ai-v1.5.0", "runtime-v1.5.0"));
    expect(gaps.map((g) => g.path)).toEqual(["packages/site"]);
  });
});

describe("report", () => {
  test("points at the cause, and at the publish that never ran either", async () => {
    const text = report(await findGaps([target()], released()));
    expect(text).toContain("packages/starters");
    expect(text).toContain("starters-v1.5.0");
    expect(text).toContain("but not for component");
    expect(text).toContain("commitlint.config.ts");
    expect(text).toContain("publish.yml");
  });

  test("says nothing about npm, which this gate no longer asks and cannot answer for", async () => {
    const text = report(await findGaps([target()], released()));
    // The registry probe was 0-for-3 on real failures; see this file's counterpart header.
    expect(text).not.toContain("npm view");
    expect(text).not.toContain("not on npm");
  });
});
