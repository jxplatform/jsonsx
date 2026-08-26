/**
 * Covers `scripts/check-release-integrity.ts` — the gate that would have caught, on the day it
 * happened, `packages/starters` being versioned to 1.3.0 in the manifest and never released.
 *
 * The probes are injected, so the assertions below never touch GitHub or the npm registry: what is
 * tested is the tag arithmetic (which must track `release-please-config.json`, not a hardcoded
 * shape), the gap logic, and that the report tells you what to run.
 */

import { describe, expect, test } from "bun:test";

import { findGaps, readTargets, report, tagFor } from "./check-release-integrity.ts";
import type { Probes, ReleaseTarget } from "./check-release-integrity.ts";

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
  npmName: "@jxsuite/starters",
  ...over,
});

const probes = (present: { releases?: string[]; npm?: string[] }): Probes => ({
  releaseExists: (tag) => Promise.resolve((present.releases ?? []).includes(tag)),
  npmHasVersion: (name, version) =>
    Promise.resolve((present.npm ?? []).includes(`${name}@${version}`)),
});

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

  test("desktop is a component npm never receives, so it carries no npm name", async () => {
    const targets = await readTargets();
    const desktop = targets.find((t) => t.path === "packages/desktop");
    expect(desktop?.npmName).toBeNull();
  });

  test("a publishable component carries the name npm must have", async () => {
    const targets = await readTargets();
    expect(targets.find((t) => t.path === "packages/starters")?.npmName).toBe("@jxsuite/starters");
  });
});

describe("findGaps", () => {
  test("a fully shipped component is not a gap", async () => {
    const gaps = await findGaps(
      [target()],
      probes({ npm: ["@jxsuite/starters@1.5.0"], releases: ["starters-v1.5.0"] }),
    );
    expect(gaps).toEqual([]);
  });

  test("the release-please skip: manifest bumped, nothing released", async () => {
    const gaps = await findGaps([target()], probes({}));
    expect(gaps).toEqual([{ ...target(), missingFromNpm: true, missingRelease: true }]);
  });

  test("the crashed-publish case: the release exists but npm never got it", async () => {
    const gaps = await findGaps([target()], probes({ releases: ["starters-v1.5.0"] }));
    expect(gaps[0].missingRelease).toBe(false);
    expect(gaps[0].missingFromNpm).toBe(true);
  });

  test("a non-npm component is judged on its release alone", async () => {
    const desktop = target({
      npmName: null,
      path: "packages/desktop",
      tag: "desktop-v2.2.1",
      version: "2.2.1",
    });
    expect(await findGaps([desktop], probes({ releases: ["desktop-v2.2.1"] }))).toEqual([]);
    const gaps = await findGaps([desktop], probes({}));
    expect(gaps[0].missingFromNpm).toBe(false);
  });
});

describe("report", () => {
  test("an npm gap comes with the command that backfills it", async () => {
    const text = report(await findGaps([target()], probes({ releases: ["starters-v1.5.0"] })));
    expect(text).toContain("@jxsuite/starters@1.5.0");
    expect(text).toContain("gh workflow run publish.yml");
    expect(text).toContain('["packages/starters"]');
  });

  test("a missing release points at the cause instead of at npm", async () => {
    const text = report(await findGaps([target()], probes({})));
    expect(text).toContain("starters-v1.5.0");
    expect(text).toContain("but not for component");
    expect(text).toContain("commitlint.config.ts");
  });
});
