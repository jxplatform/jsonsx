/**
 * Release-please's package list is hand-written, and a package missing from it is invisible: never
 * versioned, never tagged, never changelogged, never published — with no error anywhere, because
 * nothing asks the question. `extensions/search` and `extensions/feed` sat like that, both
 * non-private with `publishConfig.provenance`, one of them a runtime dependency of the marketing
 * site. `scripts/publish-order.ts` could not have saved them either: it filters by
 * `paths_released`, and a package that is never released is never in it.
 *
 * So the list is checked against the workspace graph, both directions, the way
 * `scripts/ci/bundle-paths.test.ts` checks the bundle filter — the failure names which side to
 * fix.
 *
 * This lives flat in `scripts/` rather than `scripts/ci/` on purpose: it runs unconditionally via
 * `bun test --isolate scripts` in the `changes` job, and `scripts/ci/**` is in `affected.ts`'s
 * GLOBAL list, so putting it there would make editing release config run the full workspace
 * matrix.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { readWorkspaces } from "./lib/workspaces.ts";

const CONFIG = "release-please-config.json";
const MANIFEST = ".release-please-manifest.json";

/**
 * Components release-please versions and tags but npm never receives. Each needs a reason, because
 * the default reading of "in the config but not publishable" is a mistake.
 */
const NON_NPM_COMPONENTS: Record<string, string> = {
  "packages/desktop":
    "Ships as signed installers attached to the desktop-v* GitHub release. It declares no " +
    "publishConfig, so publish-order.ts drops it from the npm set — but it still needs a version " +
    "and a tag, because the four bundler workflows check out `desktop-v<version>`.",
};

interface PackageConfig {
  "release-type"?: string;
  component?: string;
  "extra-files"?: { type: string; path: string; jsonpath?: string; glob?: boolean }[];
}
interface Config {
  packages: Record<string, PackageConfig>;
  "extra-files"?: unknown;
}

const config = (await Bun.file(CONFIG).json()) as Config;
const manifest = (await Bun.file(MANIFEST).json()) as Record<string, string>;
const workspaces = await readWorkspaces();

describe("release-please config", () => {
  test("every publishable workspace is a component, and every component is accounted for", () => {
    const publishable = workspaces.filter((w) => w.publishable).map((w) => w.dir);
    const components = Object.keys(config.packages);

    const missing = publishable
      .filter((dir) => !components.includes(dir))
      .map((dir) => {
        const w = workspaces.find((x) => x.dir === dir)!;
        return `${dir} (${w.name}) — publishable, but absent from ${CONFIG}: never versioned, never tagged, never published`;
      })
      .toSorted();

    const extra = components
      .filter((dir) => !publishable.includes(dir) && !(dir in NON_NPM_COMPONENTS))
      .map(
        (dir) =>
          `${dir} — a release-please component, but not publishable and not in NON_NPM_COMPONENTS`,
      )
      .toSorted();

    expect({ extra, missing }).toEqual({ extra: [], missing: [] });
  });

  test("the config and the manifest name exactly the same packages", () => {
    const inConfig = Object.keys(config.packages).toSorted();
    const inManifest = Object.keys(manifest).toSorted();
    const missing = inConfig.filter((d) => !inManifest.includes(d));
    const extra = inManifest.filter((d) => !inConfig.includes(d));
    expect({ extra, missing }).toEqual({ extra: [], missing: [] });
  });

  test("the manifest agrees with every package.json on disk", () => {
    // This identity is what check-template-versions.ts stands on: it derives `^<version>` from the
    // Workspace's package.json, which is only the released version because release-please keeps
    // These two in lockstep. Proved here rather than assumed there.
    const disagreements: string[] = [];
    for (const [dir, version] of Object.entries(manifest)) {
      const w = workspaces.find((x) => x.dir === dir);
      if (!w) {
        disagreements.push(`${MANIFEST} names ${dir}, which is not a workspace`);
        continue;
      }
      if (w.version !== version) {
        disagreements.push(
          `${MANIFEST} says ${dir}=${version}, ${dir}/package.json says ${w.version}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("each component is the unscoped package name", () => {
    // The tag is `<component>-v<version>` and release-please.yml reads
    // `steps.rp.outputs['<dir>--release_created']`. A typo here orphans a tag silently.
    const wrong: string[] = [];
    for (const [dir, entry] of Object.entries(config.packages)) {
      const w = workspaces.find((x) => x.dir === dir);
      if (!w) {
        continue;
      }
      const expected = w.name.replace(/^@jxsuite\//, "");
      if (entry.component !== expected) {
        wrong.push(
          `${dir}: component "${entry.component}" should be "${expected}" (from ${w.name})`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  test("extra-files is never declared at the config root", () => {
    // Root keys are ReleaserConfigOptions defaults inherited by EVERY package, so a root
    // `extra-files` would have all nineteen components stamp their own version into every
    // Template in turn, each overwriting the last.
    expect(config["extra-files"]).toBeUndefined();
  });

  test("every scoped extra-files jsonpath uses the @property filter form", () => {
    // Measured against release-please 17.11.1's own GenericJson updater:
    //
    //   Bracket `$.devDependencies['@jxsuite/compiler']`
    //     Section+key present -> rewrites
    //     Section present, key ABSENT -> THROWS "Unknown value type"
    //   Filter `$.devDependencies[?(@property === '@jxsuite/compiler')]`
    //     Both, and a missing section -> rewrites or no-ops, never throws
    //
    // Jsonpath-plus reads a path segment beginning with `@` as a value-type selector (`@string()`),
    // And the throw happens inside buildChangeSet — which aborts the run and produces NO release PR
    // For ANY package. A starter that simply does not declare @jxsuite/server is enough to trigger
    // It, so this is one dropped dependency away at all times.
    const bad: string[] = [];
    for (const [dir, entry] of Object.entries(config.packages)) {
      for (const file of entry["extra-files"] ?? []) {
        const { jsonpath } = file;
        if (!jsonpath?.includes("@jxsuite/")) {
          continue;
        }
        if (!jsonpath.includes("@property")) {
          bad.push(
            `${dir}: jsonpath ${jsonpath} addresses a scoped key by bracket. Use ` +
              `[?(@property === '<name>')] — the bracket form throws when the section exists ` +
              `without the key, which fails the whole release.`,
          );
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("every extra-files path is repo-root-relative", () => {
    // Without the leading slash the path resolves relative to the COMPONENT directory, so
    // `packages/starters/...` under extensions/parser would silently address nothing.
    const bad: string[] = [];
    for (const [dir, entry] of Object.entries(config.packages)) {
      for (const file of entry["extra-files"] ?? []) {
        if (!file.path.startsWith("/")) {
          bad.push(
            `${dir}: extra-files path "${file.path}" must start with "/" to be repo-relative`,
          );
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("the node-workspace graph is acyclic", () => {
    // The node-workspace plugin walks `dependencies`, `devDependencies` and
    // `optionalDependencies`, and THROWS on a cycle (plugins/workspace.js visitPostOrder), which
    // Fails the whole release. `packages/compiler` already depends on `@jxsuite/create`, which
    // Depends on `@jxsuite/starters` — so giving starters a devDep on @jxsuite/compiler closes a
    // Loop. That is the obvious-looking edit this test exists to stop.
    const dirs = new Set(Object.keys(config.packages));
    const byName = new Map(workspaces.map((w) => [w.name, w]));
    const edges = new Map<string, string[]>();
    for (const dir of dirs) {
      const w = workspaces.find((x) => x.dir === dir);
      edges.set(
        dir,
        w
          ? [...w.deps, ...w.devDeps]
              .map((n) => byName.get(n)?.dir)
              .filter((d): d is string => Boolean(d) && dirs.has(d!))
          : [],
      );
    }

    const state = new Map<string, "open" | "done">();
    const cycles: string[] = [];
    const walk = (node: string, trail: string[]): void => {
      const seen = state.get(node);
      if (seen === "done") {
        return;
      }
      if (seen === "open") {
        cycles.push([...trail.slice(trail.indexOf(node)), node].join(" -> "));
        return;
      }
      state.set(node, "open");
      for (const next of edges.get(node) ?? []) {
        walk(next, [...trail, node]);
      }
      state.set(node, "done");
    };
    for (const dir of dirs) {
      walk(dir, []);
    }

    expect(cycles).toEqual([]);
  });
});

/**
 * The binary-cache verifier in .github/workflows/release-please.yml.
 *
 * It filed "Binary cache does not serve <tag>" against five consecutive releases — #161, #169,
 * #172, #178, #190 — while https://jxsuite.cachix.org was serving every single one of those store
 * paths on both architectures. The cause was one redirection: `out="$(nix eval --raw … 2>&1)"`.
 * `nix eval` writes its fetch progress and its evaluation warnings to stderr, so `$out` held eight
 * lines of `copying path '/nix/store/…' from 'https://nix-community.cachix.org'` and a
 * `stdenv.isLinux is deprecated` warning with the real path on the end.
 *
 * What made it invisible for five releases is that `nix path-info` answers a malformed argument and
 * a genuinely absent path with the SAME message — `getting status of "…": No such file or
 * directory`, exit 1 — so the job's own logs looked exactly like a cache that was empty.
 *
 * Neither assertion below can be made from the YAML's meaning, only from its text; that is the
 * price of a check that lives in a shell script inside a workflow. They are cheap and they name the
 * failure, which is more than the five issues managed between them.
 */
describe("the release workflow's binary-cache verifier", () => {
  const workflow = readFileSync(".github/workflows/release-please.yml", "utf8");

  /** Every `nix eval` invocation captured into a shell variable. */
  const captures = [...workflow.matchAll(/^\s*(?:if !\s*)?\w+="\$\(nix eval[^\n]*$/gm)].map((m) =>
    m[0].trim(),
  );

  test("captures a `nix eval` result at all — the anchor these tests depend on", () => {
    expect(captures.length).toBeGreaterThan(0);
  });

  test("never merges stderr into the value it captures", () => {
    // `2>&1` here is not a style question. It puts progress output inside a store path, and the
    // Resulting lookup fails in a way indistinguishable from an empty cache.
    for (const line of captures) {
      expect(
        line,
        `${line}\n  -> redirect stderr to a file, not into the captured value`,
      ).not.toContain("2>&1");
    }
  });

  test("keeps stderr, because the diagnostic is the reason it was captured", () => {
    // The original `2>&1` existed so a failed evaluation could be reported rather than vanishing.
    // Dropping stderr entirely would fix the bug and lose that, so the fix must redirect it
    // Somewhere the failure branch can still read.
    for (const line of captures) {
      expect(
        line,
        `${line}\n  -> send stderr to a file so the failure branch can quote it`,
      ).toMatch(/2>"?\$/);
    }
  });

  test("checks that what it got is a store path before asking the cache", () => {
    // Without this the job reports "the cache does not hold X" both when the cache is empty and
    // When it never understood X in the first place. Those need different words.
    //
    // Asserted against the extracted guard rather than the whole file, so a failure prints four
    // Lines instead of the entire workflow.
    const guard = /case\s+"\$out"\s+in\b([\s\S]*?)esac/.exec(workflow)?.[1];
    expect(guard, 'no `case "$out"` guard in the cache verifier').toBeDefined();
    expect(
      guard,
      "the guard must require a /nix/store path, not merely something under /nix",
    ).toContain("/nix/store/?*)");
  });
});
