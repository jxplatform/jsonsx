/**
 * Decides which CI jobs a pull request can actually fail, and emits that decision as GitHub Actions
 * job outputs. Consumed by the `changes` job in .github/workflows/test.yml.
 *
 * The rule this implements: a check runs when its inputs changed, and not otherwise. The rule it
 * does NOT implement: gating everything. Measured on green run 31489926926, lint is 1s, both
 * typechecks are 5s, and all four docs gates together are 3s — while a fresh job costs ~15s to
 * provision. Gating those would make CI slower. Only three things here are worth a gate: the
 * per-workspace test matrix (0.3-5.3 min each), `check-lens-mutants` (87s), and the bundle builds
 * (20s each). Everything else stays unconditional in the `checks` job.
 *
 * Correctness before economy. Three properties matter more than any minute saved:
 *
 * 1. The matrix is DERIVED from disk. The hand-maintained 18-entry list it replaces had no guard at
 *    all: add a package, forget to list it, and it is never tested.
 * 2. `package.json` is not the whole graph. Several suites reach across workspaces at the filesystem
 *    level and are invisible to a dependency reader — see EXTRA_EDGES, where each one carries the
 *    test file that proves it, asserted to exist on startup.
 * 3. Unknown paths FAIL OPEN. A changed file matching no rule turns everything on rather than quietly
 *    narrowing the run. New top-level directories therefore cost a full run, once, until someone
 *    classifies them — which is the right direction to be wrong in.
 *
 * In CI it derives the diff from the merge base with the base branch. To see what a working diff
 * would trigger, pipe one in:
 *
 *     git diff --name-only origin/main... | bun scripts/ci/affected.ts --stdin
 */

import { existsSync } from "node:fs";
import { dependencyClosure, dependentClosure, readWorkspaces } from "../lib/workspaces.ts";
import type { Workspace } from "../lib/workspaces.ts";

/**
 * A change to any of these invalidates every assumption below, so everything runs. The gate's own
 * inputs are in here on purpose: a PR that edits the gate must not be graded by it.
 */
const GLOBAL = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "types.d.ts",
  ".oxlintrc.json",
  ".oxlintrc.typecheck.json",
  ".oxlintignore",
  "flake.nix",
  "flake.lock",
  "bun.nix",
  ".github/workflows/test.yml",
  ".github/actions/**",
  "scripts/ci/**",
  "scripts/lib/workspaces.ts",
];

/**
 * Dependency edges that exist in the filesystem but not in any `package.json`. Each declares the
 * test file that justifies it; those files are asserted to exist at startup, so deleting one reds
 * this script — the FIRST job in the graph — instead of silently un-gating a suite.
 */
export interface ExtraEdge {
  /** Changed-path globs that trigger this edge. */
  patterns: string[];
  /** Workspace dirs to add to the test set (their dependents come along automatically). */
  seeds: string[];
  /** Files proving the edge is real. Asserted to exist. */
  evidence: string[];
  why: string;
}

const EXTRA_EDGES: ExtraEdge[] = [
  {
    patterns: ["packages/runtime/src/runtime.ts"],
    seeds: ["packages/compiler"],
    evidence: ["packages/compiler/tests/shadow-dom.test.ts"],
    why: "The shadow-DOM contract (spec.md §16.6) spans the compiler and the runtime, and the compiler's test drives the element emitter that both produce and consume.",
  },
  {
    patterns: [
      "scripts/check-image-lock.ts",
      "scripts/check-shot-contract.ts",
      "scripts/check-command-levels.ts",
      "scripts/check-chrome-budget.ts",
      "scripts/lib/png.ts",
      "scripts/screenshots/**",
    ],
    seeds: ["packages/studio"],
    evidence: [
      "packages/studio/tests/image-lock.test.ts",
      "packages/studio/tests/shot-contract-diff-gaps.test.ts",
      "packages/studio/tests/commands-ci-checks.test.ts",
      "packages/studio/tests/automation-commands.test.ts",
    ],
    why: "Studio's suite imports these CI scripts directly and spawns two more of them, and reads the screenshot manifest and its contract fixtures.",
  },
  {
    patterns: ["sites/*/project.json", "sites/test-blank/**"],
    seeds: ["packages/studio"],
    evidence: [
      "packages/studio/tests/project-config.test.ts",
      "packages/studio/tests/harness/load-fixture.ts",
    ],
    why: "project-config globs every committed sites/*/project.json as its only real-formatting fixture; the DOM harness loads sites/test-blank as its site.",
  },
  {
    patterns: ["examples/**"],
    seeds: ["packages/compiler"],
    evidence: [
      "packages/compiler/tests/cli.test.ts",
      "packages/compiler/tests/compile-element.test.ts",
    ],
    why: "The CLI suite compiles examples/ as its fixture site, and compile-element loads components out of examples/components.",
  },
  {
    patterns: ["extensions/*/src/**", "extensions/*/schemas/**"],
    seeds: ["packages/schema"],
    evidence: [
      "packages/schema/tests/validate-project.test.ts",
      "packages/schema/tests/class-schema-drift.test.ts",
    ],
    why: "An INVERTED edge: extensions depend on schema, yet schema's tests read parser's committed fragment and walk every extension's src for class definitions.",
  },
  {
    patterns: ["extensions/feed/src/**", "extensions/parser/src/**"],
    seeds: ["packages/compiler"],
    evidence: ["packages/compiler/tests/feed-integration.test.ts"],
    why: "The compiler's one end-to-end feed test builds a project that loads @jxsuite/parser and @jxsuite/feed, so a change to either extension's src can break a compiler test.",
  },
];

/**
 * Paths that are understood to affect no test workspace. Anything matching neither these, nor a
 * workspace prefix, nor an extra edge, nor GLOBAL, turns everything on (see FAIL OPEN above).
 */
const NO_TESTS = [
  "docs/**",
  "specs/**",
  "scripts/docs/**",
  "sites/**",
  ".github/**",
  ".husky/**",
  ".claude/**",
  "branding/**",
  "*.md",
  "LICENSE",
  "codecov.yml",
  ".gitattributes",
  ".gitignore",
  ".oxfmtrc.json",
  ".pre-commit-config.yaml",
  "commitlint.config.js",
  "release-please-config.json",
  ".release-please-manifest.json",
];

/** Bundles built by bundle-analysis.yml, keyed by the workspace whose bundle it is. */
const BUNDLES = ["compiler", "runtime", "studio"];

function matches(path: string, patterns: string[]): boolean {
  return patterns.some((p) => new Bun.Glob(p).match(path));
}

/** The workspace a path lives in, if any. */
function owningWorkspace(path: string, workspaces: Workspace[]): string | undefined {
  return workspaces.find((w) => path === w.dir || path.startsWith(`${w.dir}/`))?.dir;
}

/**
 * Every anchor this script's correctness depends on. A rename that moves one of these reds the gate
 * by name rather than degrading it to a narrower run nobody notices.
 */
export function anchorProblems(
  workspaces: Workspace[],
  edges: ExtraEdge[] = EXTRA_EDGES,
  bundles: string[] = BUNDLES,
): string[] {
  const problems: string[] = [];

  for (const edge of edges) {
    for (const file of edge.evidence) {
      if (!existsSync(file)) {
        problems.push(
          `EXTRA_EDGES evidence is gone: ${file}\n` +
            `  That file is why ${edge.seeds.join(", ")} is retested for ${edge.patterns[0]}.\n` +
            `  If the edge is genuinely gone, delete it from scripts/ci/affected.ts. If the test\n` +
            `  simply moved, point the evidence at its new path.`,
        );
      }
    }
    for (const seed of edge.seeds) {
      if (!workspaces.some((w) => w.dir === seed)) {
        problems.push(`EXTRA_EDGES seeds a workspace that does not exist: ${seed}`);
      }
    }
  }

  // Every workspace the matrix will emit must carry a coverage threshold — CLAUDE.md's per-file
  // Ratchet is enforced by each workspace's own bunfig, and a workspace without one is silently
  // Exempt from the policy.
  for (const w of workspaces) {
    const bunfig = `${w.dir}/bunfig.toml`;
    if (!existsSync(bunfig)) {
      problems.push(
        `${w.dir} has no bunfig.toml, so it has no coverageThreshold and the per-file coverage\n` +
          `  ratchet does not apply to it. See CLAUDE.md, Testing & Coverage Policy.`,
      );
    }
  }

  for (const bundle of bundles) {
    if (!workspaces.some((w) => w.flag === bundle)) {
      problems.push(
        `BUNDLES names '${bundle}', which is not a workspace. bundle-analysis.yml builds it, so\n` +
          `  either the package was renamed or the workflow's matrix is stale.`,
      );
    }
  }

  return problems;
}

function assertAnchors(workspaces: Workspace[]): void {
  const problems = anchorProblems(workspaces);
  if (problems.length > 0) {
    console.error(`affected.ts: ${problems.length} anchor(s) failed:\n\n${problems.join("\n\n")}`);
    process.exit(1);
  }
}

interface Decision {
  mode: "all" | "affected";
  reason: string;
  testDirs: string[];
  lensMutants: boolean;
  bundles: string[];
}

export function decide(changed: string[], workspaces: Workspace[]): Decision {
  const all = (reason: string): Decision => ({
    mode: "all",
    reason,
    testDirs: workspaces.map((w) => w.dir),
    lensMutants: true,
    bundles: [...BUNDLES],
  });

  if (changed.length === 0) {
    return {
      mode: "affected",
      reason: "no files changed",
      testDirs: [],
      lensMutants: false,
      bundles: [],
    };
  }

  // Two different things, deliberately kept apart.
  //
  // `changedWorkspaces` are packages whose own source moved. Their DEPENDENTS must be retested
  // Too, because every package resolves its @jxsuite deps straight to `src/` and CI never builds
  // First — a schema edit is observable in all seventeen suites downstream of it.
  //
  // `edgeTargets` are suites that read a file outside their own workspace. Only THAT suite is
  // Affected; nothing downstream of it is. Expanding these was the first version's bug: it made
  // Any extension source change retest all seventeen workspaces, because `class-schema-drift`
  // Reads `extensions/*/src` and schema has sixteen dependents. Schema's TEST is affected;
  // Schema's OUTPUT is not.
  const changedWorkspaces = new Set<string>();
  const edgeTargets = new Set<string>();
  const reasons: string[] = [];

  for (const path of changed) {
    if (matches(path, GLOBAL)) {
      return all(`${path} invalidates every assumption`);
    }

    const edge = EXTRA_EDGES.find((e) => matches(path, e.patterns));
    if (edge) {
      for (const seed of edge.seeds) {
        if (!edgeTargets.has(seed)) {
          edgeTargets.add(seed);
          reasons.push(`${path} -> ${seed}`);
        }
      }
      // Fall through: a path can be BOTH a workspace's own source and an edge trigger
      // (`extensions/parser/src/**` changes parser and is read by schema's tests).
    }

    const owner = owningWorkspace(path, workspaces);
    if (owner) {
      changedWorkspaces.add(owner);
      continue;
    }

    if (edge || matches(path, NO_TESTS)) {
      continue;
    }

    // FAIL OPEN. A path nobody classified is a path whose blast radius nobody knows.
    return all(`${path} matches no rule in affected.ts — running everything`);
  }

  const testDirs = [
    ...dependentClosure(workspaces, changedWorkspaces).union(edgeTargets),
  ].toSorted();

  // A bundle rebuilds when the thing it bundles changes — the DEPENDENCY closure, the opposite
  // Direction from which suites must be retested. Only real source changes count: an edge target
  // Means someone's test reads a file, not that the bundle's input moved.
  const bundles = BUNDLES.filter((flag) => {
    const w = workspaces.find((x) => x.flag === flag)!;
    const inputs = dependencyClosure(workspaces, [w.dir]);
    return [...changedWorkspaces].some((s) => inputs.has(s));
  });

  return {
    mode: "affected",
    reason:
      reasons.length > 0 ? reasons.join("; ") : `${changedWorkspaces.size} workspace(s) changed`,
    testDirs,
    // Studio's OWN tree, not merely "studio is being retested". The mutation targets are files
    // Under packages/studio/src and the assertions are studio's own test files, so a change to
    // Something studio merely depends on — markup, schema — cannot make a mutant survive that
    // Would not have survived before. Gating on the test set instead would fire this 87s job on
    // Most PRs in the repo, since studio sits downstream of nearly everything.
    lensMutants: changedWorkspaces.has("packages/studio") || edgeTargets.has("packages/studio"),
    bundles,
  };
}

async function changedFiles(): Promise<string[]> {
  if (Bun.argv.includes("--stdin")) {
    const text = await Bun.stdin.text();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  const baseRef = process.env.BASE_REF || "main";
  const base = `origin/${baseRef}`;
  const mergeBase = Bun.spawnSync(["git", "merge-base", base, "HEAD"]);
  if (mergeBase.exitCode !== 0) {
    console.error(`affected.ts: no merge base with ${base}; running everything`);
    return [];
  }
  const diff = Bun.spawnSync([
    "git",
    "diff",
    "--name-only",
    mergeBase.stdout.toString().trim(),
    "HEAD",
  ]);
  if (diff.exitCode !== 0) {
    console.error("affected.ts: git diff failed; running everything");
    return [];
  }
  return diff.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const workspaces = await readWorkspaces();
  assertAnchors(workspaces);

  const event = process.env.GITHUB_EVENT_NAME ?? "";
  let decision: Decision;

  if (event && event !== "pull_request") {
    // Push to main, the nightly cron, and manual dispatch all run everything. This is the
    // Safety net for a gate mapping that has gone stale, and it is what keeps every Codecov
    // Flag's baseline on main complete for `carryforward` to carry from (codecov.yml).
    decision = {
      mode: "all",
      reason: `${event} is never gated`,
      testDirs: workspaces.map((w) => w.dir),
      lensMutants: true,
      bundles: [...BUNDLES],
    };
  } else {
    const changed = await changedFiles();
    decision =
      changed.length === 0 && event
        ? {
            mode: "all",
            reason: "could not determine the diff",
            testDirs: workspaces.map((w) => w.dir),
            lensMutants: true,
            bundles: [...BUNDLES],
          }
        : decide(changed, workspaces);
  }

  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const include = decision.testDirs.map((dir) => ({ dir, flag: byDir.get(dir)!.flag }));

  const outputs: Record<string, string> = {
    mode: decision.mode,
    reason: decision.reason,
    test_matrix: JSON.stringify({ include }),
    has_tests: String(include.length > 0),
    all_workspaces: JSON.stringify(workspaces.map((w) => w.flag)),
    gate_lens_mutants: String(decision.lensMutants),
    gate_bundle: JSON.stringify(decision.bundles),
    has_bundle: String(decision.bundles.length > 0),
  };

  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    await Bun.write(
      outFile,
      `${
        ((await Bun.file(outFile).exists()) ? await Bun.file(outFile).text() : "") +
        Object.entries(outputs)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      }\n`,
    );
  } else {
    for (const [k, v] of Object.entries(outputs)) {
      console.log(`${k}=${v}`);
    }
  }

  // A skipped job is only trustworthy if it says why it was skipped.
  const ran = new Set(decision.testDirs);
  const table = [
    `### CI scope — \`${decision.mode}\``,
    "",
    decision.reason,
    "",
    "| workspace | tests |",
    "|---|---|",
    ...workspaces.map((w) => `| \`${w.flag}\` | ${ran.has(w.dir) ? "ran" : "not affected"} |`),
    "",
    `lens-mutants: ${decision.lensMutants ? "ran" : "not affected"} · ` +
      `bundles: ${decision.bundles.length > 0 ? decision.bundles.join(", ") : "none"}`,
  ].join("\n");

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await Bun.write(
      summary,
      `${((await Bun.file(summary).exists()) ? await Bun.file(summary).text() : "") + table}\n`,
    );
  } else {
    console.error(`\n${table}`);
  }
}

if (import.meta.main) {
  await main();
}
