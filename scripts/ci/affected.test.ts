/**
 * Golden tests for the CI gate, pinned against the REAL on-disk workspace graph.
 *
 * That is deliberate. A fixture graph would let a package rename pass here and then silently
 * un-gate a suite in CI; pinning to the real graph means renaming a package changes these
 * expectations and reds this file — which is the red X the design is built around.
 */

import { describe, expect, test } from "bun:test";
import { readWorkspaces } from "../lib/workspaces.ts";
import { anchorProblems, decide } from "./affected.ts";
import type { ExtraEdge } from "./affected.ts";

const workspaces = await readWorkspaces();

/** Flags of the workspaces whose test job would run for this diff. */
function flagsFor(...changed: string[]): string[] {
  const byDir = new Map(workspaces.map((w) => [w.dir, w.flag]));
  return decide(changed, workspaces)
    .testDirs.map((d) => byDir.get(d)!)
    .toSorted();
}

describe("the whole matrix", () => {
  test("a schema change reaches every workspace that depends on it", () => {
    const flags = flagsFor("packages/schema/src/schema.ts");
    /*
     * Every workspace, `ai` included. It used to be the one exception — it depended on nothing and
     * only studio depended on it — and it stopped being one the moment `streaming-client.ts` began
     * reading RFC 9457 problem bodies through `@jxsuite/protocol`, which depends on schema. That is
     * exactly the drift this file exists to make visible: a dependency added for a two-line read
     * widened the CI matrix, and the graph is pinned here so it says so out loud.
     */
    expect(flags).toContain("ai");
    expect(flags).toContain("studio");
    expect(flags).toContain("server");
    expect(flags).toContain("parser");
    expect(flags.length).toBe(workspaces.length);
  });

  test("a root manifest change runs everything", () => {
    const d = decide(["package.json"], workspaces);
    expect(d.mode).toBe("all");
    expect(d.testDirs.length).toBe(workspaces.length);
    expect(d.bundles).toEqual(["compiler", "runtime", "studio"]);
  });

  test("the gate's own source runs everything, so a PR editing it is not graded by it", () => {
    expect(decide(["scripts/ci/affected.ts"], workspaces).mode).toBe("all");
    expect(decide(["scripts/lib/workspaces.ts"], workspaces).mode).toBe("all");
    expect(decide([".github/workflows/test.yml"], workspaces).mode).toBe("all");
  });

  test("an unclassified path fails OPEN rather than narrowing the run", () => {
    const d = decide(["some-new-toplevel-dir/thing.ts"], workspaces);
    expect(d.mode).toBe("all");
    expect(d.reason).toContain("matches no rule");
  });
});

describe("nothing at all", () => {
  test("a docs-only diff runs no test job", () => {
    const d = decide(["docs/start/install.md"], workspaces);
    expect(d.testDirs).toEqual([]);
    expect(d.lensMutants).toBe(false);
    expect(d.bundles).toEqual([]);
  });

  test("a workflow-only diff runs no test job — the dependabot shape", () => {
    // A PR whose entire content is `actions/upload-artifact@4 -> @7` used to run 18 test jobs,
    // The full checks chain, three bundle builds and a Chromium screenshot capture.
    const d = decide([".github/workflows/publish.yml", ".github/dependabot.yml"], workspaces);
    expect(d.testDirs).toEqual([]);
    expect(d.bundles).toEqual([]);
    expect(d.nixBuild).toBe(false);
  });

  test("an empty diff runs nothing", () => {
    const d = decide([], workspaces);
    expect(d.testDirs).toEqual([]);
    expect(d.nixBuild).toBe(false);
  });
});

describe("the nix build", () => {
  // The gate that lets `nix / build` be part of the required `ci` check. Before it, the Nix
  // Workflow carried its own path-filtered `on: pull_request`, which can never be required: a
  // Path-filtered workflow that does not fire leaves the check pending forever.
  test("the flake and its lockfile run the nix build and NOTHING else", () => {
    // This is the shape of a Dependabot flake-input bump. It used to be in GLOBAL, which spent
    // The entire ~22-job matrix to answer a question only `nix build` can answer — no test suite
    // Reads flake.nix, flake.lock or bun.nix.
    for (const path of ["flake.nix", "flake.lock", "bun.nix"]) {
      const d = decide([path], workspaces);
      expect(d.nixBuild).toBe(true);
      expect(d.mode).toBe("affected");
      expect(d.testDirs).toEqual([]);
      expect(d.bundles).toEqual([]);
    }
  });

  test("the lockfile runs both — it moves the dependency set the tests AND the derivation use", () => {
    const d = decide(["bun.lock"], workspaces);
    expect(d.nixBuild).toBe(true);
    expect(d.mode).toBe("all");
  });

  test("the desktop app, the workflow, and the generator's own source are inputs", () => {
    expect(decide(["packages/desktop/package.nix"], workspaces).nixBuild).toBe(true);
    expect(decide([".github/workflows/nix.yml"], workspaces).nixBuild).toBe(true);
    expect(decide(["scripts/check-bun-nix.ts"], workspaces).nixBuild).toBe(true);
  });

  test("a change the derivation cannot notice does not pay for a nix build", () => {
    expect(decide(["docs/start/install.md"], workspaces).nixBuild).toBe(false);
    expect(decide(["packages/studio/src/studio.ts"], workspaces).nixBuild).toBe(false);
    expect(decide([".github/workflows/publish.yml"], workspaces).nixBuild).toBe(false);
  });

  test("an unclassified path fails OPEN into the nix build too", () => {
    // `src = lib.cleanSource ../..` — the derivation's input IS the tree, so a path nobody has
    // Classified is a path that may well change what it builds.
    expect(decide(["some-new-toplevel-dir/thing.ts"], workspaces).nixBuild).toBe(true);
  });

  test("nix.yml must not ALSO carry its own pull_request trigger", async () => {
    // Two triggers would mean two builds of the same commit on every pull request, in different
    // Concurrency groups, neither cancelling the other. test.yml owns this leg now.
    const workflow = await Bun.file(".github/workflows/nix.yml").text();
    const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(triggers).not.toContain("pull_request:");
    expect(triggers).toContain("workflow_call:");
  });

  test("test.yml requires the nix job, and gates it on this script's output", async () => {
    const workflow = await Bun.file(".github/workflows/test.yml").text();
    expect(workflow).toContain("gate_nix");
    expect(workflow).toContain("uses: ./.github/workflows/nix.yml");
    // The `ci` aggregate is the ONE name branch protection points at; a nix job it does not
    // Depend on is a nix job that cannot block an auto-merge.
    expect(workflow).toContain(
      "needs: [changes, test, checks, lens-mutants, nix, coverage-comment]",
    );
  });
});

describe("edges package.json cannot see", () => {
  test("a screenshot script retests studio ONLY — not studio's dependents", () => {
    // Studio's suite imports scripts/lib/png.ts. Desktop depends on studio, but desktop's tests
    // Do not read png.ts, so pulling desktop in would be over-running.
    expect(flagsFor("scripts/lib/png.ts")).toEqual(["studio"]);
    expect(flagsFor("scripts/screenshots/manifest.json")).toEqual(["studio"]);
    expect(flagsFor("scripts/check-shot-contract.ts")).toEqual(["studio"]);
  });

  test("a committed site config retests studio", () => {
    expect(flagsFor("sites/jxsuite.com/project.json")).toEqual(["studio"]);
    expect(flagsFor("sites/test-blank/pages/index.json")).toEqual(["studio"]);
  });

  test("a site page that is not a project config retests nothing", () => {
    expect(flagsFor("sites/jxsuite.com/pages/index.md")).toEqual([]);
  });

  test("examples retests the compiler, whose CLI suite compiles it as a fixture", () => {
    expect(flagsFor("examples/components/todo-app.json")).toEqual(["compiler"]);
  });

  test("an extension's source retests schema — the inverted edge", () => {
    // Nothing depends on @jxsuite/search, so without the edge this would be `search` alone and
    // Schema's class-drift test, which walks every extension's src, would not have run.
    expect(flagsFor("extensions/search/src/index.ts")).toEqual(["schema", "search"]);
  });

  test("the inverted edge adds schema WITHOUT dragging in schema's sixteen dependents", () => {
    const flags = flagsFor("extensions/search/src/index.ts");
    expect(flags).not.toContain("studio");
    expect(flags).not.toContain("server");
    expect(flags.length).toBe(2);
  });

  test("an extension change still expands its own real dependents", () => {
    const flags = flagsFor("extensions/parser/src/index.ts");
    expect(flags).toContain("parser");
    expect(flags).toContain("schema"); // The inverted edge.
    expect(flags).toContain("compiler"); // A genuine devDependency.
    expect(flags).toContain("desktop"); // A genuine runtime dependency.
  });
});

describe("lens-mutants", () => {
  test("runs when studio is in the test set", () => {
    expect(decide(["packages/studio/src/canvas/pane.ts"], workspaces).lensMutants).toBe(true);
    expect(decide(["scripts/lib/png.ts"], workspaces).lensMutants).toBe(true);
  });

  test("does not run for a package studio merely depends on", () => {
    // Studio IS retested for a markup change — markup is a real dependency — but the mutation
    // Targets are studio's own source, and a markup edit cannot make one of those mutants
    // Survive. Gating on the test set instead would fire this 87s job on most PRs in the repo.
    expect(flagsFor("packages/markup/src/index.ts")).toContain("studio");
    expect(decide(["packages/markup/src/index.ts"], workspaces).lensMutants).toBe(false);
  });

  test("does not run when studio is untouched", () => {
    expect(decide(["docs/x.md"], workspaces).lensMutants).toBe(false);
    expect(decide(["packages/server/src/server.ts"], workspaces).lensMutants).toBe(false);
  });
});

describe("bundles use the DEPENDENCY closure, not the dependent closure", () => {
  test("a studio change rebuilds only studio's bundle", () => {
    expect(decide(["packages/studio/src/studio.ts"], workspaces).bundles).toEqual(["studio"]);
  });

  test("a schema change rebuilds all three, because all three bundle it", () => {
    expect(decide(["packages/schema/src/schema.ts"], workspaces).bundles).toEqual([
      "compiler",
      "runtime",
      "studio",
    ]);
  });

  test("a runtime change rebuilds runtime, compiler and studio but not the reverse", () => {
    const { bundles } = decide(["packages/runtime/src/runtime.ts"], workspaces);
    expect(bundles).toContain("runtime");
    expect(bundles).toContain("compiler");
    expect(bundles).toContain("studio");
  });

  test("a server change rebuilds nothing — no bundle imports the server", () => {
    expect(decide(["packages/server/src/server.ts"], workspaces).bundles).toEqual([]);
  });

  test("a suite-only edge does not rebuild a bundle", () => {
    // Studio's tests read png.ts; studio's BUNDLE does not.
    expect(decide(["scripts/lib/png.ts"], workspaces).bundles).toEqual([]);
  });
});

describe("the rename ratchet", () => {
  test("the repository as committed has no anchor problems", () => {
    expect(anchorProblems(workspaces)).toEqual([]);
  });

  test("an edge whose evidence file has moved fails, naming the file and the edge", () => {
    const moved: ExtraEdge[] = [
      {
        patterns: ["scripts/whatever.ts"],
        seeds: ["packages/studio"],
        evidence: ["packages/studio/tests/this-test-was-renamed.test.ts"],
        why: "irrelevant",
      },
    ];
    const problems = anchorProblems(workspaces, moved);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("this-test-was-renamed.test.ts");
    expect(problems[0]).toContain("packages/studio");
  });

  test("an edge seeding a workspace that no longer exists fails", () => {
    const gone: ExtraEdge[] = [
      {
        patterns: ["x/**"],
        seeds: ["packages/renamed-away"],
        evidence: ["package.json"],
        why: "irrelevant",
      },
    ];
    expect(anchorProblems(workspaces, gone)[0]).toContain("packages/renamed-away");
  });

  test("a bundle naming a package that is not a workspace fails", () => {
    const problems = anchorProblems(workspaces, [], ["compiler", "not-a-package"]);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("not-a-package");
  });
});

describe("combinations", () => {
  test("a mixed diff unions its parts", () => {
    const flags = flagsFor("docs/x.md", "packages/markup/src/index.ts", "examples/foo.json");
    expect(flags).toContain("markup");
    expect(flags).toContain("compiler");
    expect(flags).toContain("import"); // Depends on markup.
  });

  test("one global path in a mixed diff still runs everything", () => {
    expect(decide(["docs/x.md", "bun.lock"], workspaces).mode).toBe("all");
  });
});
