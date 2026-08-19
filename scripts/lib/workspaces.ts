/**
 * The one reader of the `@jxsuite` workspace dependency graph.
 *
 * Three scripts had grown their own copy of "readdir packages/ and extensions/, parse each
 * package.json, keep the `@jxsuite/*` deps": `publish-order.ts`, `check-dep-rules.ts`, and (would
 * have been) `ci/affected.ts`. They disagree in ways that matter — publish-order counts runtime
 * deps only, dep-rules counts runtime deps and scans source, and the CI gate needs devDependencies
 * too. Divergence between them is silent by construction, since each is right about its own
 * question and wrong about the others', so the graph is read once here and each caller selects the
 * edge set its question actually needs.
 *
 * `deps` is the PUBLISH graph: dependencies, peerDependencies, optionalDependencies. `devDeps` is
 * what makes the difference for TESTING: a package's tests import its devDependencies, so
 * `compiler` (dev: connector, parser), `server` (dev: auth, connector, parser) and
 * `formulas`/`parser` (dev: runtime) must be retested when those change, even though none of it
 * ships.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const WORKSPACE_ROOTS = ["packages", "extensions"];

export interface Workspace {
  /** Full repo-relative path, e.g. "packages/server". */
  dir: string;
  /** The npm name, e.g. "@jxsuite/server". */
  name: string;
  /** Codecov flag / artifact name. Flags cannot contain "/", so this is the basename. */
  flag: string;
  /** True when the package is published to npm (not private, declares publishConfig). */
  publishable: boolean;
  /**
   * The version on disk.
   *
   * Release-please writes this in the release commit, so it is the about-to-be-published version on
   * the release branch and the last-published version everywhere else. That makes it the one number
   * a template's dependency range can be checked against at EVERY commit — see
   * scripts/check-template-versions.ts, and the manifest identity asserted in
   * scripts/release-config.test.ts.
   */
  version: string;
  /** Runtime dependency names: dependencies, peerDependencies, optionalDependencies. */
  deps: string[];
  /** Dev dependency names. Tests import these; the publish graph does not. */
  devDeps: string[];
}

function jxOnly(...records: (Record<string, string> | undefined)[]): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const name of Object.keys(record ?? {})) {
      if (name.startsWith("@jxsuite/")) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Every workspace under `packages/` and `extensions/`, sorted by dir so callers are deterministic
 * without each having to remember to sort.
 */
export async function readWorkspaces(root = "."): Promise<Workspace[]> {
  const found: Workspace[] = [];
  for (const group of WORKSPACE_ROOTS) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) {
      continue;
    }
    for (const entry of readdirSync(groupDir)) {
      const file = Bun.file(join(groupDir, entry, "package.json"));
      if (!(await file.exists())) {
        continue;
      }
      const j = await file.json();
      found.push({
        dir: `${group}/${entry}`,
        name: j.name,
        flag: entry,
        publishable: j.private !== true && j.publishConfig != null,
        version: j.version ?? "",
        deps: jxOnly(j.dependencies, j.peerDependencies, j.optionalDependencies),
        devDeps: jxOnly(j.devDependencies),
      });
    }
  }
  return found.toSorted((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Reverse-edge closure: given some workspaces, every workspace whose tests could observe a change
 * in them. `edges` picks which dependency kinds count — the CI gate passes "all", a publish-order
 * question would pass "runtime".
 *
 * Returns dirs, including the seeds themselves.
 */
export function dependentClosure(
  workspaces: Workspace[],
  seedDirs: Iterable<string>,
  edges: "runtime" | "all" = "all",
): Set<string> {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  /** Package name -> dirs of the workspaces that depend on it. */
  const dependents = new Map<string, string[]>();
  for (const w of workspaces) {
    const names = edges === "all" ? [...w.deps, ...w.devDeps] : w.deps;
    for (const dep of names) {
      if (!byName.has(dep)) {
        continue; // A name with no workspace: published-only, not part of this graph.
      }
      const list = dependents.get(dep) ?? [];
      list.push(w.dir);
      dependents.set(dep, list);
    }
  }

  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const reached = new Set<string>();
  const queue = [...seedDirs];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (reached.has(dir)) {
      continue;
    }
    reached.add(dir);
    const w = byDir.get(dir);
    if (!w) {
      continue;
    }
    for (const next of dependents.get(w.name) ?? []) {
      if (!reached.has(next)) {
        queue.push(next);
      }
    }
  }
  return reached;
}

/**
 * Forward closure: a workspace plus everything it imports. This is the direction a BUNDLE cares
 * about — a bundle of studio must be rebuilt when studio or anything studio pulls in changes, which
 * is the exact opposite of which suites must be retested.
 */
export function dependencyClosure(
  workspaces: Workspace[],
  seedDirs: Iterable<string>,
  edges: "runtime" | "all" = "runtime",
): Set<string> {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const reached = new Set<string>();
  const queue = [...seedDirs];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (reached.has(dir)) {
      continue;
    }
    reached.add(dir);
    const w = byDir.get(dir);
    if (!w) {
      continue;
    }
    const names = edges === "all" ? [...w.deps, ...w.devDeps] : w.deps;
    for (const name of names) {
      const dep = byName.get(name);
      if (dep && !reached.has(dep.dir)) {
        queue.push(dep.dir);
      }
    }
  }
  return reached;
}
