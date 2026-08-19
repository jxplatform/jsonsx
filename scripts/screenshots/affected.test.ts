/**
 * The shot decider narrows a lane whose failure mode is a bot commit on your branch, so the
 * expensive mistake is narrowing too far: a picture that moved and was never re-taken ships wrong
 * and no check will ever say so. Every test here that matters is therefore a test that it did NOT
 * narrow — unknown paths, missing anchors, an empty subset.
 */

import { describe, expect, test } from "bun:test";

import { assertAnchors, decide } from "./affected.ts";
import { validateManifest } from "./lib/types.ts";
import type { Manifest, Shot } from "./lib/types.ts";

const MANIFEST = "scripts/screenshots/manifest.json";
const live = validateManifest(await Bun.file(MANIFEST).json());

function shot(name: string, project?: string, quarantined?: boolean): Shot {
  return {
    name,
    ...(project === undefined ? {} : { open: { project } }),
    ...(quarantined
      ? { status: { reason: "test fixture", since: "deadbeef", state: "quarantined" as const } }
      : {}),
  };
}

function manifest(shots: Shot[]): Manifest {
  return { contract: 1, outDir: "docs/images", shots };
}

const FIXTURE = manifest([
  shot("alpha", "packages/starters/sites/blog"),
  shot("beta", "packages/starters/sites/blog"),
  shot("gamma", "packages/starters/sites/shop"),
  shot("delta", "scripts/screenshots/fixtures/counter"),
  shot("new-project", "packages/starters/sites/real-estate"),
  shot("welcome-screen"),
]);

describe("decide", () => {
  test("a Studio change can move any picture, so nothing is narrowed", () => {
    const d = decide(["packages/studio/src/shell.ts"], FIXTURE);
    expect(d.mode).toBe("all");
    expect(d.reason).toContain("packages/studio/src/shell.ts");
    expect(d.shots).toEqual([]);
  });

  test("the decider's own inputs are global, so a PR editing it is not graded by it", () => {
    for (const path of [
      "scripts/screenshots/affected.ts",
      "scripts/screenshots/manifest.json",
      "scripts/screenshots/lib/shot.ts",
      "scripts/screenshots/run.ts",
      "scripts/check-image-lock.ts",
      "scripts/lib/png.ts",
      ".github/workflows/screenshots.yml",
      "bun.lock",
    ]) {
      expect(decide([path], FIXTURE).mode).toBe("all");
    }
  });

  test("a project-root change selects exactly the shots that open it", () => {
    const d = decide(["packages/starters/sites/blog/pages/index.md"], FIXTURE);
    expect(d.mode).toBe("subset");
    expect(d.shots).toEqual(["alpha", "beta"]);
    expect(d.skipped).toEqual(["gamma", "delta", "new-project", "welcome-screen"]);
  });

  test("fixture projects narrow the same way starters do", () => {
    // 22 of the 61 shots open a fixture, and every one of them sits under the widest entry in
    // The paths filter, `scripts/screenshots/**`. Narrowing them is most of the win.
    const d = decide(["scripts/screenshots/fixtures/counter/project.json"], FIXTURE);
    expect(d.mode).toBe("subset");
    expect(d.shots).toEqual(["delta"]);
  });

  test("registry.json selects the shot that photographs the whole registry", () => {
    const d = decide(["packages/starters/registry.json"], FIXTURE);
    expect(d.mode).toBe("subset");
    expect(d.shots).toEqual(["new-project"]);
  });

  test("an unclassified path fails open AND names itself", () => {
    const d = decide(["some/new/top-level/thing.ts"], FIXTURE);
    expect(d.mode).toBe("all");
    // Naming it is the point: this is the line that tells someone to classify a new directory.
    expect(d.reason).toContain("some/new/top-level/thing.ts");
  });

  test("one unclassified path among many classified ones still runs everything", () => {
    const d = decide(["packages/starters/sites/blog/pages/index.md", "some/new/thing.ts"], FIXTURE);
    expect(d.mode).toBe("all");
  });

  test("an empty diff runs everything", () => {
    expect(decide([], FIXTURE).mode).toBe("all");
  });

  test("the longest project root wins, so a suffixed sibling is not swallowed", () => {
    const m = manifest([
      shot("outer", "scripts/screenshots/fixtures/first-collection"),
      shot("inner", "scripts/screenshots/fixtures/first-collection-state"),
    ]);
    const d = decide(["scripts/screenshots/fixtures/first-collection-state/project.json"], m);
    expect(d.shots).toEqual(["inner"]);
  });

  test("a project root is not matched by a path that merely shares its prefix", () => {
    const m = manifest([shot("only", "packages/starters/sites/blog")]);
    // `blog-extra` starts with `blog` but is a different directory.
    expect(decide(["packages/starters/sites/blog-extra/x.md"], m).mode).toBe("all");
  });

  test("quarantined shots are never selected and never counted", () => {
    const m = manifest([
      shot("live", "packages/starters/sites/blog"),
      shot("rotten", "packages/starters/sites/blog", true),
    ]);
    const d = decide(["packages/starters/sites/blog/x.md"], m);
    expect(d.shots).toEqual(["live"]);
  });

  test("a diff whose every shot is quarantined is `none`, never an empty subset", () => {
    // An empty `--only` means ALL shots to the runner, so this must be its own mode.
    const m = manifest([shot("rotten", "packages/starters/sites/blog", true)]);
    const d = decide(["packages/starters/sites/blog/x.md"], m);
    expect(d.mode).toBe("none");
    expect(d.shots).toEqual([]);
  });
});

describe("against the committed manifest", () => {
  test("every anchor names a shot that exists", () => {
    expect(() => assertAnchors(live)).not.toThrow();
  });

  test("assertAnchors throws when the anchored shot is renamed away", () => {
    const without = manifest(live.shots.filter((s) => s.name !== "new-project"));
    expect(() => assertAnchors(without)).toThrow(/new-project/);
  });

  test("every name the decider can emit is a real shot the runner would accept", () => {
    // `--only` matches SHOT names, not image names, and an unmatched name aborts the run with
    // `no shots matched`. So a typo here is a red lane, not a quiet no-op.
    const names = new Set(live.shots.map((s) => s.name));
    const projects = new Set(
      live.shots.map((s) => s.open?.project).filter((p): p is string => Boolean(p)),
    );
    for (const project of projects) {
      const d = decide([`${project}/project.json`], live);
      expect(d.mode).toBe("subset");
      expect(d.shots.length).toBeGreaterThan(0);
      for (const name of d.shots) {
        expect(names.has(name)).toBe(true);
      }
    }
  });

  test("a starter no shot opens still narrows to nothing rather than running everything", () => {
    // `saas` is one of the six starters photographed by nothing, and it is not in the paths
    // Filter either. This asserts the two agree: were it ever let in, it must not run all 61.
    const d = decide(["packages/starters/sites/saas/pages/index.md"], live);
    expect(d.mode).toBe("all");
    expect(d.reason).toContain("unclassified");
  });
});
