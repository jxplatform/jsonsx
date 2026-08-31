/**
 * Every version in `.release-please-manifest.json` must have actually shipped a GitHub release at
 * its tag.
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
 *     bun scripts/check-release-integrity.ts
 *
 * ## It deliberately does NOT ask npm, and there is evidence behind that
 *
 * It used to, and the registry probe was removed rather than made more patient. `npm publish`
 * printing `+ @jxsuite/ai@0.37.0` does not mean `npm view @jxsuite/ai@0.37.0` will find it: the
 * version's `time` entry in the packument is stamped when the registry finishes WRITING, and that
 * trails acceptance by up to three minutes, for a package or two per release, unpredictably. (On
 * the 2026-08-30 release: `connector` +76s, `site` +96s, `ai` +187s — and the other sixteen
 * packages in that same run were readable within a second.)
 *
 * So the probe filed an issue every time it raced a slow write. Every "Released versions that never
 * shipped" issue this repository has ever had, against when npm actually became readable:
 *
 *     #177  @jxsuite/ai@0.36.2         readable  39s AFTER the issue was filed
 *     #199  @jxsuite/connector@0.5.3   readable  36s AFTER the issue was filed
 *     #264  @jxsuite/ai@0.37.0         readable  82s AFTER the issue was filed
 *     #264  @jxsuite/site@1.1.0        readable   1s AFTER the issue was filed
 *
 * Nought for three: not one real catch, and three rounds of someone investigating a release that
 * was already fine. A detector whose every firing is noise teaches people to ignore the firing that
 * is not, which costs more than the check was ever worth.
 *
 * The release check is the half that had the value anyway. The six-week `starters` incident had NO
 * TAG AND NO RELEASE — not merely a missing publish — so this catches it. And it cannot fail the
 * way the npm probe did: `gh release view` is read-after-write consistent, so a 404 means the
 * release is genuinely absent rather than merely not replicated yet.
 */

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

  return Object.entries(manifest).map(([path, version]) => ({
    path,
    tag: tagFor(path, version, config),
    version,
  }));
}

/**
 * Does a GitHub RELEASE exist at this tag? A bare tag is not enough — the bundlers attach to the
 * release, and release-please creates both or neither.
 */
export type ReleaseExists = (tag: string) => Promise<boolean>;

/** The manifest entries whose release release-please never actually created. */
export async function findGaps(
  targets: ReleaseTarget[],
  releaseExists: ReleaseExists,
): Promise<ReleaseTarget[]> {
  const gaps: ReleaseTarget[] = [];
  for (const target of targets) {
    if (!(await releaseExists(target.tag))) {
      gaps.push(target);
    }
  }
  return gaps;
}

export function report(gaps: ReleaseTarget[]): string {
  const lines = gaps.map(
    (g) => `- **${g.path}** claims ${g.version} in the manifest — no GitHub release \`${g.tag}\``,
  );

  return [
    ...lines,
    "",
    "A missing GitHub release means release-please skipped the component. Check the " +
      "`release-please` job log for “Pull request contains releases, but not for component” " +
      "and read the header of `commitlint.config.ts`.",
    "",
    "Nothing was published for a component with no release, so re-running `publish.yml` for it " +
      "once the release exists is the second half of the fix — it is idempotent.",
  ].join("\n");
}

if (import.meta.main) {
  const releaseExists: ReleaseExists = async (tag) =>
    Bun.spawnSync(["gh", "release", "view", tag, "--json", "tagName"], {
      stderr: "ignore",
      stdout: "ignore",
    }).exitCode === 0;

  const targets = await readTargets();
  const gaps = await findGaps(targets, releaseExists);

  if (gaps.length === 0) {
    console.log(`All ${targets.length} released components have a GitHub release.`);
    process.exit(0);
  }

  console.error(`${gaps.length} of ${targets.length} released components never shipped:\n`);
  console.error(report(gaps));
  process.exit(1);
}
