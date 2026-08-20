import { describe, expect, test } from "bun:test";
import { dependencyClosure, dependentClosure, readWorkspaces } from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";

/** A hand-built graph, so the closure tests do not move when the real repo does. */
function fixture(): Workspace[] {
  const w = (dir: string, deps: string[] = [], devDeps: string[] = []): Workspace => ({
    dir,
    name: `@jxsuite/${dir.split("/")[1]}`,
    flag: dir.split("/")[1]!,
    publishable: true,
    version: "1.0.0",
    deps,
    devDeps,
  });
  return [
    w("packages/base"),
    w("packages/mid", ["@jxsuite/base"]),
    w("packages/leaf", ["@jxsuite/mid"]),
    w("packages/sibling", ["@jxsuite/base"]),
    // Depends on nothing shipped, but its TESTS use mid.
    w("extensions/tester", [], ["@jxsuite/mid"]),
  ];
}

describe("readWorkspaces", () => {
  test("reads every packages/* and extensions/* member of the real repo", async () => {
    const ws = await readWorkspaces();
    const flags = ws.map((x) => x.flag);
    expect(flags).toContain("schema");
    expect(flags).toContain("studio");
    expect(flags).toContain("parser");
    // Every workspace directory in the repo is a workspace here; if this drifts, the CI matrix
    // Silently loses a package (the exact failure the derived matrix exists to prevent).
    expect(ws.length).toBeGreaterThanOrEqual(18);
  });

  test("every workspace reports a real semver version", async () => {
    // Check-template-versions.ts derives `^<version>` from this, so an empty or malformed one
    // Would be proposed as a range into every published starter manifest.
    const ws = await readWorkspaces();
    for (const w of ws) {
      expect(w.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  test("is sorted by dir, so callers need not sort", async () => {
    const ws = await readWorkspaces();
    expect(ws.map((x) => x.dir)).toEqual(ws.map((x) => x.dir).toSorted());
  });

  test("separates runtime deps from dev deps", async () => {
    const ws = await readWorkspaces();
    const compiler = ws.find((x) => x.flag === "compiler")!;
    expect(compiler.deps).toContain("@jxsuite/schema");
    // Compiler dev-depends on parser, an EXTENSION. specs/extensions.md §2 forbids that as a
    // Runtime dep, so if this ever appears in `deps` the dep-rules gate is broken too.
    expect(compiler.devDeps).toContain("@jxsuite/parser");
    expect(compiler.deps).not.toContain("@jxsuite/parser");
  });

  test("marks desktop unpublishable and schema publishable", async () => {
    const ws = await readWorkspaces();
    expect(ws.find((x) => x.flag === "desktop")!.publishable).toBe(false);
    expect(ws.find((x) => x.flag === "schema")!.publishable).toBe(true);
  });

  test("returns nothing for a root with no workspace directories", async () => {
    expect(await readWorkspaces("/nonexistent-root")).toEqual([]);
  });
});

describe("dependentClosure", () => {
  const ws = fixture();

  test("includes the seed itself", () => {
    expect([...dependentClosure(ws, ["packages/leaf"])]).toEqual(["packages/leaf"]);
  });

  test("walks transitively upward", () => {
    expect([...dependentClosure(ws, ["packages/base"])].toSorted()).toEqual([
      "extensions/tester",
      "packages/base",
      "packages/leaf",
      "packages/mid",
      "packages/sibling",
    ]);
  });

  test("counts a devDependency, because tests import them", () => {
    expect([...dependentClosure(ws, ["packages/mid"], "all")]).toContain("extensions/tester");
  });

  test("ignores devDependencies when asked for the runtime graph only", () => {
    expect([...dependentClosure(ws, ["packages/mid"], "runtime")]).not.toContain(
      "extensions/tester",
    );
  });

  test("ignores a dependency name that is not a workspace", () => {
    const external = [{ ...ws[0]!, deps: ["@jxsuite/published-elsewhere"] }] satisfies Workspace[];
    expect([...dependentClosure(external, ["packages/base"])]).toEqual(["packages/base"]);
  });

  test("terminates on a cycle", () => {
    const cyclic: Workspace[] = [
      { ...ws[0]!, deps: ["@jxsuite/mid"] },
      { ...ws[1]!, deps: ["@jxsuite/base"] },
    ];
    expect([...dependentClosure(cyclic, ["packages/base"])].toSorted()).toEqual([
      "packages/base",
      "packages/mid",
    ]);
  });
});

describe("dependencyClosure", () => {
  const ws = fixture();

  test("walks downward, the opposite direction from dependentClosure", () => {
    expect([...dependencyClosure(ws, ["packages/leaf"])].toSorted()).toEqual([
      "packages/base",
      "packages/leaf",
      "packages/mid",
    ]);
  });

  test("a root package pulls in nothing", () => {
    expect([...dependencyClosure(ws, ["packages/base"])]).toEqual(["packages/base"]);
  });

  test("defaults to runtime edges, because a bundle ships runtime deps only", () => {
    expect([...dependencyClosure(ws, ["extensions/tester"])]).toEqual(["extensions/tester"]);
    expect([...dependencyClosure(ws, ["extensions/tester"], "all")].toSorted()).toEqual([
      "extensions/tester",
      "packages/base",
      "packages/mid",
    ]);
  });
});
