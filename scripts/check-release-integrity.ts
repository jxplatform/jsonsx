/**
 * Every version in `.release-please-manifest.json` must have actually shipped: a GitHub release at
 * its tag, and — for the packages npm receives — that exact version on the registry.
 *
 * NOTHING ASKED THIS QUESTION BEFORE, and the answer was no for six weeks. Two independent ways to
 * lose a release, both of which exit 0:
 *
 * 1. Release-please drops a component whose changelog contains a raw `<tag>` (the defect written up in
 *    `commitlint.config.ts`). It logs "Pull request contains releases, but not for component:
 *    starters", creates the other 18, and succeeds. The manifest still says 1.5.0.
 * 2. The `release-please` job dies PART WAY THROUGH — a GitHub 5xx while it backfills file lists,
 *    which is exactly what a component with no tag provokes, because it forces a walk back through
 *    500 commits. Re-running the job then finds the pull request already labelled `autorelease:
 *    tagged`, so `releases_created` comes back `false` and `publish`, all four desktop bundlers,
 *    `nix-build` and `deploy-site` SKIP. A green run, no release.
 *
 * The visible damage from (1)+(2) was `@jxsuite/starters` sitting at 1.2.2 on npm while
 * `@jxsuite/create@1.3.2` and `@jxsuite/server@2.2.1` shipped declaring `^1.5.0` — so `npm install
 * @jxsuite/create` failed to resolve, for everyone, silently.
 *
 * This is the job that says so. It runs in `release-please.yml` with `if: always()`, so a crashed
 * or no-op release run still gets checked, and again on that workflow's daily schedule.
 *
 *     bun scripts/check-release-integrity.ts            # the gate
 *     bun scripts/check-release-integrity.ts --no-npm   # tags only (no registry round trips)
 */

import { readWorkspaces } from "./lib/workspaces.ts";

const CONFIG = "release-please-config.json";
const MANIFEST = ".release-please-manifest.json";

interface PackageConfig {
  component?: string;
  "include-v-in-tag"?: boolean;
  "include-component-in-tag"?: boolean;
  "tag-separator"?: string;
}
interface Config {
  packages: Record<string, PackageConfig>;
  "include-v-in-tag"?: boolean;
  "include-component-in-tag"?: boolean;
  "tag-separator"?: string;
}

export interface ReleaseTarget {
  /** Repo-relative workspace directory, e.g. `packages/starters`. */
  path: string;
  /** The tag release-please would have created, e.g. `starters-v1.5.0`. */
  tag: string;
  version: string;
  /** The npm package name, or null when this component never goes to npm (`desktop`). */
  npmName: string | null;
}

export interface ReleaseGap extends ReleaseTarget {
  missingRelease: boolean;
  missingFromNpm: boolean;
}

/**
 * Reproduce release-please's `TagName.toString()`: `<component><separator>v<version>`, with each
 * part defaulting at the top level and overridable per package. Derived rather than hardcoded so a
 * config change cannot make this gate quietly check the wrong tag.
 */
export function tagFor(path: string, version: string, config: Config): string {
  const pkg = config.packages[path] ?? {};
  const pick = <K extends keyof PackageConfig & keyof Config>(
    key: K,
    fallback: NonNullable<Config[K]>,
  ) => (pkg[key] ?? config[key] ?? fallback) as NonNullable<Config[K]>;

  const includeComponent = pick("include-component-in-tag", true);
  const includeV = pick("include-v-in-tag", true);
  const separator = pick("tag-separator", "-");
  const component = pkg.component ?? path.split("/").at(-1)!;

  const prefix = includeComponent ? `${component}${separator}` : "";
  return `${prefix}${includeV ? "v" : ""}${version}`;
}

/** What every manifest entry claims to have shipped. */
export async function readTargets(root = "."): Promise<ReleaseTarget[]> {
  const config = (await Bun.file(`${root}/${CONFIG}`).json()) as Config;
  const manifest = (await Bun.file(`${root}/${MANIFEST}`).json()) as Record<string, string>;
  const workspaces = await readWorkspaces(root);

  return Object.entries(manifest).map(([path, version]) => {
    const workspace = workspaces.find((w) => w.dir === path);
    return {
      path,
      tag: tagFor(path, version, config),
      version,
      npmName: workspace?.publishable ? workspace.name : null,
    };
  });
}

export interface Probes {
  /**
   * Does a GitHub RELEASE exist at this tag? A bare tag is not enough — the bundlers attach to The
   * release, and release-please creates both or neither.
   */
  releaseExists: (tag: string) => Promise<boolean>;
  npmHasVersion: (name: string, version: string) => Promise<boolean>;
}

export async function findGaps(targets: ReleaseTarget[], probes: Probes): Promise<ReleaseGap[]> {
  const gaps: ReleaseGap[] = [];
  for (const target of targets) {
    const missingRelease = !(await probes.releaseExists(target.tag));
    const missingFromNpm = target.npmName
      ? !(await probes.npmHasVersion(target.npmName, target.version))
      : false;
    if (missingRelease || missingFromNpm) {
      gaps.push({ ...target, missingRelease, missingFromNpm });
    }
  }
  return gaps;
}

export function report(gaps: ReleaseGap[]): string {
  const lines = gaps.map((g) => {
    const what = [
      g.missingRelease ? `no GitHub release \`${g.tag}\`` : null,
      g.missingFromNpm ? `not on npm as \`${g.npmName}@${g.version}\`` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `- **${g.path}** claims ${g.version} in the manifest — ${what}`;
  });

  const npmGaps = gaps.filter((g) => g.missingFromNpm).map((g) => g.path);
  const fixes: string[] = [];
  if (npmGaps.length > 0) {
    fixes.push(
      "Backfill npm (idempotent — already-published versions are skipped):\n\n" +
        "    gh workflow run publish.yml \\\n" +
        `      -f paths_released='${JSON.stringify(npmGaps)}' \\\n` +
        "      -f sha=$(git rev-parse origin/main)",
    );
  }
  if (gaps.some((g) => g.missingRelease)) {
    fixes.push(
      "A missing GitHub release means release-please skipped the component. Check the " +
        "`release-please` job log for “Pull request contains releases, but not for component” " +
        "and read the header of `commitlint.config.ts`.",
    );
  }

  return [...lines, "", ...fixes].join("\n");
}

if (import.meta.main) {
  const checkNpm = !process.argv.includes("--no-npm");

  const run = (cmd: string[]) =>
    Bun.spawnSync(cmd, { stderr: "ignore", stdout: "ignore" }).exitCode === 0;

  const probes: Probes = {
    releaseExists: async (tag) => run(["gh", "release", "view", tag, "--json", "tagName"]),
    npmHasVersion: async (name, version) => {
      if (!checkNpm) {
        return true;
      }
      // One retry: this runs immediately after `publish`, and the registry can take a few seconds
      // To answer for a version it has just accepted.
      if (run(["npm", "view", `${name}@${version}`, "version"])) {
        return true;
      }
      await Bun.sleep(15_000);
      return run(["npm", "view", `${name}@${version}`, "version"]);
    },
  };

  const targets = await readTargets();
  const gaps = await findGaps(targets, probes);

  if (gaps.length === 0) {
    console.log(
      `All ${targets.length} released components have a GitHub release, and npm has them.`,
    );
    process.exit(0);
  }

  console.error(`${gaps.length} of ${targets.length} released components never shipped:\n`);
  console.error(report(gaps));
  process.exit(1);
}
