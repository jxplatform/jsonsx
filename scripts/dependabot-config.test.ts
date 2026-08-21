/**
 * The dependency autopilot is configuration, and configuration is the kind of thing that fails
 * SILENTLY: a Dependabot entry pointed at the wrong directory, or naming an ecosystem that cannot
 * see this repository's lockfile, does not error — it simply never opens a pull request, and the
 * absence of pull requests looks exactly like "nothing to update". Every assertion below is a
 * condition under which Dependabot would go quiet rather than complain.
 *
 * It lives flat in `scripts/` rather than `scripts/ci/` for the same reason
 * `scripts/release-config.test.ts` does: it runs unconditionally via `bun test --isolate scripts`
 * in test.yml's `changes` job, and `scripts/ci/**` is in `affected.ts`'s GLOBAL list, so putting it
 * there would make editing dependency policy run the full workspace matrix.
 *
 * The policy this guards is written up in CLAUDE.md, "Dependency Autopilot".
 */

import { describe, expect, test } from "bun:test";

import { readWorkspaces } from "./lib/workspaces.ts";

const CONFIG = ".github/dependabot.yml";
const AUTO_MERGE = ".github/workflows/dependabot-auto-merge.yml";

interface Group {
  "applies-to"?: string;
  patterns?: string[];
  "exclude-patterns"?: string[];
  "update-types"?: string[];
  "dependency-type"?: string;
}
interface Update {
  "package-ecosystem": string;
  directory?: string;
  directories?: string[];
  schedule: { interval: string; day?: string };
  groups?: Record<string, Group>;
  cooldown?: Record<string, unknown>;
  ignore?: { "dependency-name"?: string }[];
  "versioning-strategy"?: string;
  reviewers?: unknown;
  "open-pull-requests-limit"?: number;
}
interface Config {
  version: number;
  updates: Update[];
}

const config = Bun.YAML.parse(await Bun.file(CONFIG).text()) as Config;
const manifest = (await Bun.file("package.json").json()) as {
  workspaces?: string[];
  packageManager?: string;
  devDependencies?: Record<string, string>;
};
const byEcosystem = new Map(config.updates.map((u) => [u["package-ecosystem"], u]));

/**
 * What this repository actually contains, and therefore what Dependabot may be asked to update. An
 * entry naming anything else is a typo that costs nothing at validation time and everything at
 * runtime — Dependabot rejects the whole file, so ALL updates stop, not just the bad entry.
 */
const EXPECTED: Record<string, string> = {
  "github-actions": "every `uses:` in .github/workflows/** and .github/actions/**",
  bun: "the root bun.lock and all 21 workspace package.json files",
  nix: "the four root inputs of flake.nix, recorded in flake.lock",
};

describe("the ecosystems declared", () => {
  test("are exactly the ones this repository has something for", () => {
    const declared = [...byEcosystem.keys()].toSorted();
    expect(declared).toEqual(Object.keys(EXPECTED).toSorted());
  });

  test("do NOT include `npm` alongside `bun`", () => {
    // The npm ecosystem covers pnpm and yarn but has no bun.lock code path at all — its file
    // Fetcher takes package-lock.json, yarn.lock, pnpm-lock.yaml and npm-shrinkwrap.json, and its
    // `required_files_in?` is satisfied by package.json alone. So an `npm` entry here would look
    // Like it worked, open pull requests for the same bumps the `bun` entry does, and leave
    // Bun.lock stale in every one of them.
    expect(byEcosystem.has("npm")).toBe(false);
  });

  test("each declare the repository root and no directory globs", () => {
    for (const [name, update] of byEcosystem) {
      expect(update.directory, `${name} must name a directory`).toBe("/");
      // `directories: ["/packages/*"]` is the trap. A sub-directory bun job resolves the lockfile
      // Upward and lands on the SAME root bun.lock, which is the "overlap in directories" the
      // Documentation forbids — duplicate, conflicting pull requests for one dependency.
      expect(update.directories, `${name} must not glob directories`).toBeUndefined();
    }
  });
});

describe("the bun entry can actually see this workspace", () => {
  const bun = byEcosystem.get("bun")!;

  test("the root manifest declares workspaces, which is how one entry covers all of them", () => {
    // Dependabot's bun file fetcher reads these globs and fetches every matched package.json.
    // Without them the entry would update the root manifest only, and eighteen packages would
    // Silently never receive an update.
    expect(manifest.workspaces?.length ?? 0).toBeGreaterThan(0);
  });

  test("every workspace on disk is reachable from a root workspaces glob", async () => {
    const workspaces = await readWorkspaces();
    const globs = (manifest.workspaces ?? []).map((g) => new Bun.Glob(g));
    const unreachable = workspaces
      .map((w) => w.dir)
      .filter((dir) => !globs.some((g) => g.match(dir)));
    expect(
      unreachable,
      `these workspaces match no root \`workspaces\` glob, so Dependabot never fetches their ` +
        `manifests and their dependencies are updated by nobody`,
    ).toEqual([]);
  });

  test("the lockfile is the text format, at a version Dependabot's bun can parse", async () => {
    // THE trap, and it is silent. Dependabot's updater image pins Bun 1.3.14, whose highest
    // Readable `lockfileVersion` is 1; Bun 1.4 raised the default for NEW lockfiles to 2. The
    // Guard exists in dependabot-core because without it bun discards a lockfile it cannot parse,
    // Re-resolves from scratch and writes a DOWNGRADED one back while exiting zero. With it, the
    // Job fails as `DependencyFileNotSupported` and bun updates simply stop arriving.
    //
    // Read as TEXT, not JSON: `bun.lock` is JSONC — it carries trailing commas that
    // `JSON.parse` rejects — and the one field this needs is on line two.
    const lock = await Bun.file("bun.lock").text();
    const head = lock.slice(0, 512);
    const version = /"lockfileVersion"\s*:\s*(\d+)/.exec(head)?.[1];
    expect(
      version,
      "bun.lock has no lockfileVersion; is it still the binary bun.lockb?",
    ).toBeDefined();
    expect(
      Number(version),
      "regenerate with a bun that writes lockfileVersion 1",
    ).toBeLessThanOrEqual(1);
  });

  test("no `packageManager` field steers the fetcher away from bun", () => {
    // `setup("bun")` returns early unless this field is absent, is `bun`, or starts with `bun@`.
    // A `pnpm@9`/`npm@11` value makes the fetcher skip bun.lock entirely — a config that looks
    // Correct and updates no lockfile.
    const pm = manifest.packageManager;
    expect(pm === undefined || pm === "bun" || pm.startsWith("bun@")).toBe(true);
  });

  test("release-please's ranges are left to release-please", () => {
    // Every published @jxsuite range inside a template is rewritten by release-please in the
    // Release commit (`extra-files`) and gated by `bun run templates:check`. A Dependabot bump of
    // The same range is a second writer on the same line, and the two would fight every release.
    const ignored = (bun.ignore ?? []).map((i) => i["dependency-name"]);
    expect(ignored).toContain("@jxsuite/*");
  });

  test("declares no `versioning-strategy`, which bun does not support", () => {
    // Documented for bundler, cargo, composer, helm, mix, npm, pip, pub and uv. Setting it for
    // Bun is not an error — it is ignored, which is worse: the file reads as though a strategy
    // Was chosen.
    expect(bun["versioning-strategy"]).toBeUndefined();
    expect(byEcosystem.get("nix")!["versioning-strategy"]).toBeUndefined();
  });

  test("its groups cover everything, so no dependency escapes into its own pull request", () => {
    const groups = Object.values(bun.groups ?? {});
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.patterns).toEqual(["*"]);
    }
    // Between them the groups must name every update type, or the ones left out arrive one
    // Pull request per dependency — and every bun pull request costs the FULL test matrix
    // (bun.lock is in affected.ts's GLOBAL list).
    const covered = new Set(
      groups.flatMap((g) => g["update-types"] ?? ["major", "minor", "patch"]),
    );
    expect([...covered].toSorted()).toEqual(["major", "minor", "patch"]);
  });

  test("declares no group-level `dependency-type`, which is not supported for bun", () => {
    // Documented for bundler, composer, mix, maven, npm and pip. On a bun group it silently
    // Matches nothing, which empties the group rather than narrowing it.
    for (const g of Object.values(bun.groups ?? {})) {
      expect(g["dependency-type"]).toBeUndefined();
    }
  });
});

describe("the nix entry", () => {
  const nix = byEcosystem.get("nix")!;

  test("both files its fetcher requires are present at the declared directory", async () => {
    // `required_files_in?` is `flake.nix && flake.lock`. With either missing the repository is
    // Never even fetched, and the entry does nothing at all.
    expect(await Bun.file("flake.nix").exists()).toBe(true);
    expect(await Bun.file("flake.lock").exists()).toBe(true);
  });

  test("every root flake input is a plain named input the updater can move", async () => {
    // It updates ROOT-level inputs only, one `nix flake update <name>` at a time. An input this
    // Test cannot see is an input nothing will ever update.
    const lock = (await Bun.file("flake.lock").json()) as {
      nodes: Record<string, unknown>;
      root: string;
    };
    const root = lock.nodes[lock.root] as { inputs?: Record<string, unknown> };
    const inputs = Object.keys(root.inputs ?? {});
    expect(inputs.length).toBeGreaterThan(0);
    for (const name of inputs) {
      expect(name, "a flake input name must be a plain identifier").toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("uses only the cooldown granularity nix supports", () => {
    // `default-days` is supported for Nix flakes; the `semver-*-days` keys are not, because a
    // Flake input is a commit and has no version to classify.
    for (const key of Object.keys(nix.cooldown ?? {})) {
      expect(key, `${key} is not supported for the nix ecosystem`).toBe("default-days");
    }
  });

  test("is grouped, so four inputs are one decision rather than four nix builds", () => {
    expect(Object.keys(nix.groups ?? {})).toHaveLength(1);
  });
});

describe("no removed or inert options", () => {
  test("nothing declares `reviewers`, which GitHub.com has withdrawn", () => {
    for (const [name, update] of byEcosystem) {
      expect(update.reviewers, `${name} declares a withdrawn option`).toBeUndefined();
    }
  });

  test("every entry declares a schedule and a pull-request budget", () => {
    for (const [name, update] of byEcosystem) {
      expect(update.schedule?.interval, `${name} has no schedule`).toBeTruthy();
      // The default is 5, and a grouped ecosystem that hits the cap stops silently: no error, no
      // Pull request, just fewer updates than were asked for.
      expect(update["open-pull-requests-limit"], `${name} has no explicit limit`).toBeGreaterThan(
        0,
      );
    }
  });
});

const autoMergeWorkflow = await Bun.file(AUTO_MERGE).text();

describe("the auto-merge workflow", () => {
  const workflow = autoMergeWorkflow;

  test("keys off the pull request's AUTHOR, not the actor", () => {
    // `github.actor` is whoever triggered the run and changes on a manual re-run; the author of a
    // Dependabot branch never does. Guarding on the actor would let a human re-run turn the
    // Automation off — or on.
    expect(workflow).toContain("github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(workflow).not.toContain("github.actor == 'dependabot[bot]'");
  });

  test("refuses to act unless `ci` is a required status check", () => {
    // The whole safety property. `gh pr merge --auto` FAILS OPEN — with no required check it
    // Performs an ordinary merge instead — so the workflow asserts the gate exists before
    // Delegating to it, and uses the GraphQL mutation, which errors rather than merging.
    expect(workflow).toContain("required_status_checks");
    expect(workflow).toContain("enablePullRequestAutoMerge");
  });

  test("does not reach for a secret, which would resolve empty on a Dependabot event", () => {
    // On Dependabot-triggered events `secrets.*` reads the separate Dependabot store, not the
    // Actions one. A secret referenced here and stored there would arrive as an empty string —
    // A failure that reads as a malformed value rather than a missing one.
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]);
    expect([...new Set(secrets)]).toEqual(["GITHUB_TOKEN"]);
  });
});
