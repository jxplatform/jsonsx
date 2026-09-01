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
    /*
     * Every workspace EXCEPT `extension-catalog`, which depends on nothing at all. That is not an
     * oversight in its manifest: it is the catalogue of first-party extensions, and it names them
     * as data precisely so that no core package acquires a dependency on `extensions/*`
     * (specs/extensions.md §2). A dependency added to satisfy this assertion would be the very
     * edge the rule forbids, so the exception is the design working.
     */
    const standalone = workspaces.filter((w) => w.flag === "extension-catalog");
    expect(standalone.length).toBe(1);
    expect(flags).not.toContain("extension-catalog");
    expect(flags.length).toBe(workspaces.length - standalone.length);
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
  });

  test("an empty diff runs nothing", () => {
    const d = decide([], workspaces);
    expect(d.testDirs).toEqual([]);
    expect(d.bundles).toEqual([]);
  });
});

describe("the nix build", () => {
  /*
   * It runs on the RELEASE pull request alone. It used to be gated on the derivation's own inputs
   * — bun.lock, package.json, packages/desktop/** — which is most Dependabot pull requests, and it
   * is by far the slowest job in this workflow. The trade is deliberate and it is a real one: a
   * dependency bump that breaks packaging no longer blocks its own auto-merge. It is caught one
   * step later instead, on the release pull request, where `ci` still requires this job.
   */
  test("nix is gated on the release branch, not on a diff", async () => {
    const workflow = await Bun.file(".github/workflows/test.yml").text();
    expect(workflow).toContain("if: startsWith(github.head_ref, 'release-please--')");
    expect(workflow).toContain("uses: ./.github/workflows/nix.yml");
    // `head_ref` is empty on `push`, so the push-to-main run of THIS workflow does not build nix.
    // Nix.yml's own `push: main` trigger owns that leg, and it exists for the cache, not the check.
    expect(workflow).not.toContain("needs.changes.outputs.nix");
  });

  test("the branch prefix is the one release-please actually opens", () => {
    // Not derivable from release-please-config.json: the branch name is release-please's default,
    // `release-please--branches--<target>`. Pinned from the merged pull requests in this repo
    // (#171, #164, #159 … all `release-please--branches--main`), and asserted here so a change to
    // `separate-pull-requests` or a branch-prefix setting has to come past this line.
    expect("release-please--branches--main".startsWith("release-please--")).toBe(true);
  });

  test("ci still depends on nix, so a red derivation blocks the RELEASE pull request", async () => {
    // The whole value of moving it: skipped is green, failed is not. `ci` is the one name branch
    // Protection points at, and a nix job it does not depend on could not block anything.
    const workflow = await Bun.file(".github/workflows/test.yml").text();
    expect(workflow).toContain(
      "needs: [changes, test, checks, lens-mutants, studio-dist, nix, coverage-comment]",
    );
  });

  test("the derivation's inputs still cost NOTHING in the test matrix", () => {
    // This is what kept flake.nix out of GLOBAL, and it outlives the gate: no test suite reads
    // These, so they must not fail open into the whole ~22-job fan-out either.
    for (const path of ["flake.nix", "flake.lock", "bun.nix"]) {
      const d = decide([path], workspaces);
      expect(d.mode).toBe("affected");
      expect(d.testDirs).toEqual([]);
      expect(d.bundles).toEqual([]);
    }
  });

  test("nix.yml must not ALSO carry its own pull_request trigger", async () => {
    // Two triggers would mean two builds of the same commit on the release pull request, in
    // Different concurrency groups, neither cancelling the other. test.yml owns this leg.
    const workflow = await Bun.file(".github/workflows/nix.yml").text();
    const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(triggers).not.toContain("pull_request:");
    expect(triggers).toContain("workflow_call:");
  });

  test("test.yml requires studio-dist, and gates it on this script's output", async () => {
    // The dist gate needs a real build, so it cannot live in `checks`. That makes it a job of its
    // Own, and a job of its own is only load-bearing if the `ci` aggregate depends on it — the
    // Assertion above pins that. This one pins the other half: it runs when, and only when, the
    // Diff can reach studio's bundle. It consumes `gate_bundle`, which affected.ts already computes
    // For bundle-analysis, so there is no second gate to keep in step.
    const workflow = await Bun.file(".github/workflows/test.yml").text();
    expect(workflow).toContain("if: contains(fromJSON(needs.changes.outputs.bundles), 'studio')");
  });

  test("every output the changes job forwards is one this script actually writes", async () => {
    /*
     * The mirror of the rule below, and the same silent failure from the other end: a job output
     * Wired to `steps.affected.outputs.<name>` that the script never writes resolves to the empty
     * String, so every consumer of it quietly reads false. `gate_nix` became exactly that the
     * Moment the nix gate was deleted, and only this assertion would have said so.
     */
    const workflow = await Bun.file(".github/workflows/test.yml").text();
    const script = await Bun.file("scripts/ci/affected.ts").text();
    const block = workflow.slice(workflow.indexOf("    outputs:"), workflow.indexOf("    steps:"));
    const wired = [...block.matchAll(/steps\.affected\.outputs\.(\w+)/g)].map((m) => m[1]);
    const written = new Set([...script.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
    expect(wired.length).toBeGreaterThan(0);
    expect(wired.filter((name) => !written.has(name))).toEqual([]);
  });

  test("every needs.changes output a job reads is one the changes job declares", async () => {
    // A `needs.<job>.outputs.<name>` that the producing job never declares is not an error in
    // Actions — it resolves to the empty string. So `contains(fromJSON(""), 'studio')` is simply
    // False, forever, and the job it guards silently never runs. That is exactly how studio-dist
    // Shipped dead: affected.ts sets the STEP output `gate_bundle`, the changes job forwarded
    // Five other outputs and not that one, and nothing anywhere said so.
    const workflow = await Bun.file(".github/workflows/test.yml").text();
    const block = workflow.slice(workflow.indexOf("    outputs:"), workflow.indexOf("    steps:"));
    const declared = new Set([...block.matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]));
    const read = new Set(
      [...workflow.matchAll(/needs\.changes\.outputs\.(\w+)/g)].map((m) => m[1]),
    );
    expect(declared.size).toBeGreaterThan(0);
    expect([...read].filter((name) => !declared.has(name))).toEqual([]);
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
