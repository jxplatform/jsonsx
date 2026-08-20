/**
 * The expensive failure here is silence: a range that ships wrong looks exactly like a range that
 * ships right until a user's `bun install` resolves it. So the tests that matter most are the ones
 * asserting the checker still SEES a problem — the unsatisfiable case, the missing key, and the
 * live tree.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  SURFACES,
  survey,
  unscoped,
  versionIndex,
  wantedRange,
} from "./check-template-versions.ts";
import { readWorkspaces } from "./lib/workspaces.ts";

const CONFIG = "release-please-config.json";

const workspaces = await readWorkspaces();
const versions = versionIndex(workspaces);

/** A throwaway repo with both surfaces, so the fixtures do not move when the real tree does. */
async function scratch(
  starter: Record<string, unknown>,
  map: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jx-templates-"));
  await Bun.write(
    join(root, "packages/starters/sites/demo/package.json"),
    `${JSON.stringify(starter, null, 2)}\n`,
  );
  await Bun.write(
    join(root, "packages/create/template-versions.json"),
    `${JSON.stringify(map, null, 2)}\n`,
  );
  return root;
}

const V = {
  compiler: versions.get("@jxsuite/compiler")!,
  parser: versions.get("@jxsuite/parser")!,
  runtime: versions.get("@jxsuite/runtime")!,
  server: versions.get("@jxsuite/server")!,
};

const GOOD_MAP = {
  compiler: wantedRange(V.compiler),
  parser: wantedRange(V.parser),
  runtime: wantedRange(V.runtime),
  server: wantedRange(V.server),
};

const GOOD_STARTER = {
  name: "demo",
  dependencies: { "@jxsuite/parser": wantedRange(V.parser) },
  devDependencies: {
    "@jxsuite/compiler": wantedRange(V.compiler),
    "@jxsuite/runtime": wantedRange(V.runtime),
  },
};

describe("wantedRange", () => {
  test("is a caret range over the released version", () => {
    expect(wantedRange("1.4.1")).toBe("^1.4.1");
  });
});

describe("survey", () => {
  test("a synced tree has nothing to say", async () => {
    const root = await scratch(GOOD_STARTER, GOOD_MAP);
    const { problems } = await survey(root, versions);
    expect(problems).toEqual([]);
    await rm(root, { force: true, recursive: true });
  });

  test("a range that cannot resolve the release is `unsatisfiable`, not mere drift", async () => {
    // This is the distinction that matters: `^1.5.0` against a released 1.5.3 is forward
    // Compatible and costs nothing, while `^0.19.0` against 1.5.0 is a template nobody can install.
    const root = await scratch(
      {
        ...GOOD_STARTER,
        devDependencies: { ...GOOD_STARTER.devDependencies, "@jxsuite/compiler": "^0.19.0" },
      },
      GOOD_MAP,
    );
    const { problems } = await survey(root, versions);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe("unsatisfiable");
    expect(problems[0]!.message).toContain("predates it");
    await rm(root, { force: true, recursive: true });
  });

  test("a merely-behind caret inside the same major is `drift`", async () => {
    /*
     * The behind-version is derived from a SYNTHETIC release rather than the live one. Deriving it
     * as `^<major>.<minor - 1>.0` worked only while compiler had a non-zero minor: at 2.0.0 the
     * clamp produced `^2.0.0`, the current version, so the fixture described no drift at all and
     * the test asserted `["drift"]` against `[]`. Moving one release ahead instead of one behind
     * keeps the scenario expressible at every version shape.
     */
    const [major, minor] = V.compiler.split(".");
    const ahead = `${major}.${Number(minor) + 1}.0`;
    const root = await scratch(GOOD_STARTER, { ...GOOD_MAP, compiler: wantedRange(ahead) });
    const { problems } = await survey(root, new Map(versions).set("@jxsuite/compiler", ahead));
    expect(problems.map((p) => p.kind)).toEqual(["drift"]);
    await rm(root, { force: true, recursive: true });
  });

  test("a required package in the wrong section is `missing`, and says which section", async () => {
    // Not cosmetic: release-please's extra-files jsonpath names the SECTION, so a compiler moved
    // Into `dependencies` is a template the release silently stops updating.
    const root = await scratch(
      {
        name: "demo",
        dependencies: {
          "@jxsuite/parser": wantedRange(V.parser),
          "@jxsuite/compiler": wantedRange(V.compiler),
        },
        devDependencies: { "@jxsuite/runtime": wantedRange(V.runtime) },
      },
      GOOD_MAP,
    );
    const { problems } = await survey(root, versions);
    const missing = problems.filter((p) => p.kind === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message).toContain("devDependencies");
    await rm(root, { force: true, recursive: true });
  });

  test("a workspace protocol in a published template is `shape`", async () => {
    const root = await scratch(
      { ...GOOD_STARTER, dependencies: { "@jxsuite/parser": "workspace:^" } },
      GOOD_MAP,
    );
    const { problems } = await survey(root, versions);
    expect(problems.map((p) => p.kind)).toEqual(["shape"]);
    expect(problems[0]!.message).toContain("ships to npm");
    await rm(root, { force: true, recursive: true });
  });

  test("an @jxsuite dependency the surface does not require is held to the same rule", async () => {
    const root = await scratch(
      {
        ...GOOD_STARTER,
        dependencies: { ...GOOD_STARTER.dependencies, "@jxsuite/markup": "^0.0.1" },
      },
      GOOD_MAP,
    );
    const { problems } = await survey(root, versions);
    expect(problems.map((p) => p.file)).toContain("packages/starters/sites/demo/package.json");
    expect(problems.some((p) => p.message.includes("@jxsuite/markup"))).toBe(true);
    await rm(root, { force: true, recursive: true });
  });

  test("a fix preserves key order and is idempotent", async () => {
    const root = await scratch(
      { ...GOOD_STARTER, dependencies: { "@jxsuite/parser": "^0.35.1" } },
      GOOD_MAP,
    );
    const rel = "packages/starters/sites/demo/package.json";
    const first = await survey(root, versions);
    expect(first.fixes.has(rel)).toBe(true);
    await Bun.write(join(root, rel), first.fixes.get(rel)!);

    const written = await Bun.file(join(root, rel)).json();
    expect(Object.keys(written)).toEqual(["name", "dependencies", "devDependencies"]);
    expect(written.dependencies["@jxsuite/parser"]).toBe(wantedRange(V.parser));

    const second = await survey(root, versions);
    expect(second.problems).toEqual([]);
    expect(second.fixes.size).toBe(0);
    await rm(root, { force: true, recursive: true });
  });
});

describe("against the committed tree", () => {
  test("every template range names its released version", async () => {
    // The gate expressed as a test, so drift is caught by `bun test scripts` even if the `checks`
    // Step is ever dropped.
    const { problems } = await survey(".", versions);
    expect(problems).toEqual([]);
  });

  test("the version map is importable by name, not just by relative path", async () => {
    // The Jx platform scaffolds cloud projects too, and today it writes `"@jxsuite/compiler":
    // "latest"` into every one of them — a floating reference resolved at the USER's build time,
    // Which a future major silently breaks. It cannot consume this map by a relative path, so the
    // Map has to be a named subpath export.
    const pkg = await Bun.file("packages/create/package.json").json();
    expect(pkg.exports["./template-versions.json"]).toBe("./template-versions.json");
  });

  test("packages/create ships the version map it imports", async () => {
    // The failure mode this guards is invisible in the monorepo and in every test: npm drops the
    // File, and `bun create @jxsuite` throws "Cannot find module ./template-versions.json" for
    // Every user while CI stays green.
    const pkg = await Bun.file("packages/create/package.json").json();
    expect(pkg.files).toContain("template-versions.json");
  });

  test("release-please rewrites every range the surfaces declare", async () => {
    // The checker and the config must agree, or a release corrects some ranges and leaves others —
    // Which is worse than leaving all of them, because it looks like it worked.
    const config = (await Bun.file(CONFIG).json()) as {
      packages: Record<string, { "extra-files"?: { path: string; jsonpath?: string }[] }>;
    };
    const declared = new Set<string>();
    for (const entry of Object.values(config.packages)) {
      for (const file of entry["extra-files"] ?? []) {
        declared.add(`${file.path}|${file.jsonpath}`);
      }
    }

    const expected = new Set<string>();
    for (const surface of SURFACES) {
      for (const { name, section } of surface.required) {
        if (surface.kind === "version-map") {
          expected.add(`/${surface.path}|$.${unscoped(name)}`);
          continue;
        }
        // Only packages a starter actually declares get a starter-side entry; @jxsuite/server is
        // Required of the scaffold map alone.
        const starter = await Bun.file("packages/starters/sites/blog/package.json").json();
        if (starter[section]?.[name] === undefined) {
          continue;
        }
        expected.add(`/${surface.path}/*/package.json|$.${section}[?(@property === '${name}')]`);
      }
    }

    const missing = [...expected].filter((e) => !declared.has(e)).toSorted();
    const extra = [...declared].filter((d) => !expected.has(d)).toSorted();
    expect({ extra, missing }).toEqual({ extra: [], missing: [] });
  });
});
