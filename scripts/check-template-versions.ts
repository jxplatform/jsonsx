/**
 * Every `@jxsuite/*` dependency range that ships inside a TEMPLATE must name the version that was
 * actually released.
 *
 * There are two such surfaces and neither is a workspace, so `bun install` never resolves them and
 * nothing kept them current:
 *
 * 1. `packages/starters/sites/*` — `@jxsuite/starters` PUBLISHES `sites/`, so these are the ranges a
 *    user's `bun install` resolves, and the ones Studio installs when it iterates a starter. They
 *    are not bun workspace members (the root globs are `packages/*`, `extensions/*`, `examples`,
 *    `sites/*`), so `workspace:^` is not available and a real semver range is required.
 * 2. `packages/create/template-versions.json` — the ranges `buildPackageJson()` stamps into every
 *    scaffolded project, INCLUDING starter clones, whose `package.json` it rebuilds from scratch.
 *
 * They had drifted past 1.0 entirely: `^0.19.0` for a compiler released at 1.5.0, and most starters
 * were no better. Every one of those ranges was unresolvable against anything published, so a
 * scaffolded project installed a toolchain that predates the template it came from — and Studio
 * greeted anyone opening a starter with an "Update @jxsuite packages?" modal, which is also what
 * was covering the canvas in four screenshot shots.
 *
 * WHO WRITES THESE. Not this script, in the normal case: release-please rewrites them inside its
 * own release commit via `extra-files` (release-please-config.json), so the tree `publish.yml`
 * packs from already carries the right ranges and this check is green on the release PR's first
 * run. `--fix` is for the drift that predates that, and for a template gaining a dependency.
 *
 * The source of truth is each workspace's own `package.json` version, which is the same number
 * release-please writes — so the invariant "range == ^<workspace version>" holds at every commit on
 * every branch, which is what makes this safe to block on.
 *
 *     bun scripts/check-template-versions.ts        # the gate
 *     bun scripts/check-template-versions.ts --fix  # rewrite the ranges, then exit 0
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { readWorkspaces } from "./lib/workspaces.ts";
import type { Workspace } from "./lib/workspaces.ts";

export type Section = "dependencies" | "devDependencies";

export interface TemplateSurface {
  /** Repo-relative path, or a directory whose children each hold a `package.json`. */
  path: string;
  kind: "package-json-dir" | "version-map";
  /** The `@jxsuite` packages this surface must declare, and where. */
  required: { name: string; section: Section }[];
  why: string;
}

/**
 * Adding a surface is one line here. The release-please `extra-files` entries that keep these
 * current are asserted against this table in scripts/check-template-versions.test.ts, so the two
 * cannot drift.
 */
export const SURFACES: TemplateSurface[] = [
  {
    path: "packages/starters/sites",
    kind: "package-json-dir",
    required: [
      { name: "@jxsuite/parser", section: "dependencies" },
      { name: "@jxsuite/compiler", section: "devDependencies" },
      { name: "@jxsuite/runtime", section: "devDependencies" },
    ],
    why:
      "@jxsuite/starters publishes sites/, so these are the ranges an end user's `bun install` " +
      "resolves and the ones Studio installs when iterating a starter.",
  },
  {
    path: "packages/create/template-versions.json",
    kind: "version-map",
    required: [
      { name: "@jxsuite/parser", section: "dependencies" },
      { name: "@jxsuite/compiler", section: "devDependencies" },
      { name: "@jxsuite/runtime", section: "devDependencies" },
      { name: "@jxsuite/server", section: "devDependencies" },
    ],
    why:
      "buildPackageJson() in packages/create/generate.ts stamps these into every scaffolded " +
      "project, including starter clones whose package.json it rebuilds from scratch.",
  },
];

export type ProblemKind = "drift" | "unsatisfiable" | "missing" | "shape";

export interface Problem {
  kind: ProblemKind;
  file: string;
  message: string;
}

/** `@jxsuite/parser` → `parser`. Also release-please's component name, and the version-map key. */
export function unscoped(name: string): string {
  return name.slice("@jxsuite/".length);
}

export function wantedRange(version: string): string {
  return `^${version}`;
}

/** The version each `@jxsuite/*` package is at on disk, by npm name. */
export function versionIndex(workspaces: Workspace[]): Map<string, string> {
  return new Map(workspaces.map((w) => [w.name, w.version]));
}

function checkRange(
  file: string,
  name: string,
  range: string,
  version: string,
  problems: Problem[],
): string | null {
  const want = wantedRange(version);
  if (range === want) {
    return null;
  }
  if (!/^\^\d+\.\d+\.\d+/.test(range)) {
    problems.push({
      kind: "shape",
      file,
      message:
        `${name} is "${range}", which is not a \`^X.Y.Z\` range. This file ships to npm, so a ` +
        `workspace protocol or a floating tag cannot be used here — it must name a real version.`,
    });
    return want;
  }
  if (!Bun.semver.satisfies(version, range)) {
    problems.push({
      kind: "unsatisfiable",
      file,
      message:
        `${name} is "${range}", which cannot resolve the released ${version} — anyone installing ` +
        `this template gets a package that predates it. Wanted "${want}".`,
    });
    return want;
  }
  problems.push({
    kind: "drift",
    file,
    message: `${name} is "${range}"; wanted "${want}".`,
  });
  return want;
}

interface Surveyed {
  problems: Problem[];
  /** File → the JSON to write when fixing. Absent when nothing in that file changed. */
  fixes: Map<string, string>;
}

export async function survey(root: string, versions: Map<string, string>): Promise<Surveyed> {
  const problems: Problem[] = [];
  const fixes = new Map<string, string>();

  for (const surface of SURFACES) {
    if (surface.kind === "package-json-dir") {
      const dir = join(root, surface.path);
      for (const entry of readdirSync(dir).toSorted()) {
        const rel = `${surface.path}/${entry}/package.json`;
        const file = Bun.file(join(dir, entry, "package.json"));
        if (!(await file.exists())) {
          continue;
        }
        const parsed = (await file.json()) as Record<string, Record<string, string> | undefined>;
        let changed = false;

        for (const { name, section } of surface.required) {
          const bag = parsed[section];
          const range = bag?.[name];
          if (typeof range !== "string") {
            problems.push({
              kind: "missing",
              file: rel,
              message:
                `${name} is not in ${section}. release-please's extra-files jsonpath targets ` +
                `${section}, so this template would be skipped silently on every release.`,
            });
            continue;
          }
          const want = checkRange(rel, name, range, versions.get(name)!, problems);
          if (want) {
            bag[name] = want;
            changed = true;
          }
        }

        // Any other @jxsuite range the template happens to declare is held to the same rule.
        for (const section of ["dependencies", "devDependencies"] as Section[]) {
          const bag = parsed[section];
          if (!bag) {
            continue;
          }
          for (const name of Object.keys(bag)) {
            if (!name.startsWith("@jxsuite/") || surface.required.some((r) => r.name === name)) {
              continue;
            }
            const version = versions.get(name);
            if (!version) {
              continue;
            }
            const want = checkRange(rel, name, bag[name]!, version, problems);
            if (want) {
              bag[name] = want;
              changed = true;
            }
          }
        }

        if (changed) {
          fixes.set(rel, `${JSON.stringify(parsed, null, 2)}\n`);
        }
      }
      continue;
    }

    const rel = surface.path;
    const file = Bun.file(join(root, rel));
    const parsed = ((await file.exists()) ? await file.json() : {}) as Record<string, string>;
    let changed = false;
    for (const { name } of surface.required) {
      const key = unscoped(name);
      const range = parsed[key];
      if (typeof range !== "string") {
        problems.push({
          kind: "missing",
          file: rel,
          message:
            `"${key}" is absent. generate.ts reads it to stamp ${name} into every scaffolded ` +
            `project, so a missing key is a scaffold that cannot install.`,
        });
        parsed[key] = wantedRange(versions.get(name)!);
        changed = true;
        continue;
      }
      const want = checkRange(rel, name, range, versions.get(name)!, problems);
      if (want) {
        parsed[key] = want;
        changed = true;
      }
    }
    if (changed) {
      fixes.set(rel, `${JSON.stringify(parsed, null, 2)}\n`);
    }
  }

  return { problems, fixes };
}

if (import.meta.main) {
  const fix = process.argv.includes("--fix");
  const workspaces = await readWorkspaces();
  const versions = versionIndex(workspaces);

  const unknown = SURFACES.flatMap((s) => s.required)
    .map((r) => r.name)
    .filter((name, i, all) => all.indexOf(name) === i && !versions.has(name));
  if (unknown.length > 0) {
    console.error(
      `check-template-versions: SURFACES requires ${unknown.join(", ")}, which is not a workspace ` +
        `in packages/* or extensions/*. Rename it there, or drop it here.`,
    );
    process.exit(1);
  }

  const { problems, fixes } = await survey(".", versions);

  if (fix) {
    // `missing` is not repaired: inventing a dependency for a template is an authoring decision,
    // Not a mechanical one. The version map is the exception — a key it must have is a key it had.
    const blocking = problems.filter(
      (p) => p.kind === "missing" && !p.file.endsWith("template-versions.json"),
    );
    for (const [file, text] of fixes) {
      await Bun.write(file, text);
    }
    if (fixes.size > 0) {
      // Match the repo's formatter, so `bun run format` is a no-op afterwards and the pre-commit
      // Hook never produces a surprise diff.
      Bun.spawnSync(["bunx", "oxfmt", ...fixes.keys()], { stdout: "ignore", stderr: "ignore" });
    }
    console.log(
      `check-template-versions: rewrote ${fixes.size} file(s) across ${SURFACES.length} surface(s).`,
    );
    if (blocking.length > 0) {
      console.error("\nStill wrong, and not mechanically fixable:\n");
      for (const p of blocking) {
        console.error(`  ✗ ${p.file}: ${p.message}`);
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (problems.length > 0) {
    console.error("Template dependency ranges do not name the versions that were released:\n");
    let current = "";
    for (const p of problems) {
      if (p.file !== current) {
        console.error(`  ${p.file}`);
        current = p.file;
      }
      console.error(`    ✗ [${p.kind}] ${p.message}`);
    }
    console.error(
      "\nThese ranges ship to users: @jxsuite/starters publishes sites/, and " +
        "packages/create stamps the version map into every scaffolded project.\n" +
        "Run `bun run templates:sync` to bring them to the released versions.",
    );
    process.exit(1);
  }

  const files = SURFACES.length;
  console.log(
    `template-versions OK: every @jxsuite range across ${files} surface(s) names its released ` +
      `version.`,
  );
}
