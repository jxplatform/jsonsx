/**
 * `bundle-analysis.yml` gates itself with a hand-written `paths:` list, because a workflow-level
 * filter costs nothing while a gate job would cost ~15s to provision — but a hand-written list of
 * package directories is exactly the thing that goes stale the moment someone adds a dependency.
 *
 * So it is checked against the graph. Give `@jxsuite/studio` a new dependency and forget this file,
 * and the list no longer matches the closure: red, naming both sides.
 */

import { describe, expect, test } from "bun:test";
import { dependencyClosure, readWorkspaces } from "../lib/workspaces.ts";

const WORKFLOW = ".github/workflows/bundle-analysis.yml";

/** Paths in the filter that are not workspace globs, and so are not derivable from the graph. */
const NON_WORKSPACE = ["bun.lock", ".github/workflows/bundle-analysis.yml"];

interface Workflow {
  on: { pull_request: { paths: string[] } };
  jobs: { "bundle-analysis": { strategy: { matrix: { package: string[] } } } };
}

const workflow = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as Workflow;
const workspaces = await readWorkspaces();

describe("bundle-analysis.yml paths", () => {
  const bundles = workflow.jobs["bundle-analysis"].strategy.matrix.package;

  test("every bundle in the matrix is a real workspace", () => {
    for (const bundle of bundles) {
      expect(workspaces.some((w) => w.flag === bundle)).toBe(true);
    }
  });

  test("the paths filter is exactly the dependency closure of the bundles it builds", () => {
    const expected = new Set<string>();
    for (const bundle of bundles) {
      const w = workspaces.find((x) => x.flag === bundle)!;
      for (const dir of dependencyClosure(workspaces, [w.dir])) {
        expected.add(`${dir}/**`);
      }
    }

    const committed = workflow.on.pull_request.paths.filter((p) => !NON_WORKSPACE.includes(p));

    // Named both ways round, so the failure says which side to fix.
    const missing = [...expected].filter((p) => !committed.includes(p)).toSorted();
    const extra = committed.filter((p) => !expected.has(p)).toSorted();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  test("the lockfile and the workflow itself stay in the filter", () => {
    for (const path of NON_WORKSPACE) {
      expect(workflow.on.pull_request.paths).toContain(path);
    }
  });
});
