import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DESKTOP_MANIFEST,
  describe as explain,
  devkitDrift,
  evaluate,
  inspect,
  pinnedVersion,
  SDK_ENTRY_POINTS,
  SDK_SRC,
  SPARSE_PATTERNS,
  STUB_CONTENTS,
  STUB_PATH,
  tagFor,
  VENDOR_DIR,
  VENDOR_MANIFEST,
  vendoredVersion,
} from "./check-electrobun-vendor.ts";

const repoRoot = resolve(import.meta.dir, "..");
const at = (path: string) => resolve(repoRoot, path);

describe("reading the pin", () => {
  test("accepts an exact version, including a prerelease", () => {
    expect(pinnedVersion({ devDependencies: { electrobun: "2.0.1" } })).toBe("2.0.1");
    expect(pinnedVersion({ devDependencies: { electrobun: "2.0.2-beta.10" } })).toBe(
      "2.0.2-beta.10",
    );
  });

  /* A range names a set of releases and therefore no single tag to check out. Guessing one would
     put the submodule at a version the lockfile never resolved. */
  test("rejects anything that does not name one release", () => {
    for (const range of ["^2.0.1", "~2.0.1", ">=2 <3", "latest", "*"]) {
      expect({
        range,
        resolved: pinnedVersion({ devDependencies: { electrobun: range } }),
      }).toEqual({ range, resolved: undefined });
    }
    expect(pinnedVersion({ devDependencies: {} })).toBeUndefined();
    expect(pinnedVersion({})).toBeUndefined();
  });
});

describe("reading the submodule", () => {
  test("reports the version it declares, or nothing when it is absent", () => {
    expect(vendoredVersion({ version: "2.0.1" })).toBe("2.0.1");
    expect(vendoredVersion({ version: 201 })).toBeUndefined();
    expect(vendoredVersion({})).toBeUndefined();
  });

  test("the tag is the version with a v", () => {
    expect(tagFor("2.0.1")).toBe("v2.0.1");
  });
});

describe("judging what was found", () => {
  const ok = { pinned: "2.0.1", vendored: "2.0.1", missing: [], hasStub: true };

  test("passes only when the pin, the checkout, the sources and the stub all line up", () => {
    expect(evaluate(ok).ok).toBe(true);
    expect(evaluate(ok).problem).toBeUndefined();
  });

  test("names each way it can fail", () => {
    expect(evaluate({ ...ok, pinned: undefined }).problem).toBe("no-pin");
    expect(evaluate({ ...ok, vendored: undefined }).problem).toBe("not-initialised");
    expect(evaluate({ ...ok, vendored: "2.0.2" }).problem).toBe("version-mismatch");
    expect(evaluate({ ...ok, missing: [`${SDK_SRC}/browser/index.ts`] }).problem).toBe(
      "missing-sources",
    );
    expect(evaluate({ ...ok, hasStub: false }).problem).toBe("no-stub");
  });

  /* The mismatch is the one a Dependabot bump produces, so its message has to name BOTH versions —
     a reader who only sees "mismatch" cannot tell which side to move. */
  test("a mismatch says which version is where, and what to run", () => {
    const message = explain(evaluate({ ...ok, vendored: "2.0.1", pinned: "2.0.2" }));
    expect(message).toContain("2.0.1");
    expect(message).toContain("2.0.2");
    expect(message).toContain("v2.0.2");
    expect(message).toContain("electrobun:sync");
  });

  test("every failure tells the reader what to run", () => {
    for (const facts of [
      { ...ok, vendored: undefined },
      { ...ok, vendored: "2.0.2" },
      { ...ok, missing: ["x"] },
      { ...ok, hasStub: false },
    ]) {
      expect(explain(evaluate(facts))).toContain("electrobun:sync");
    }
  });
});

describe("what the sparse checkout keeps", () => {
  /* Upstream interleaves ~40 `*.test.ts` files with its sources and ships a `.md` among them.
     Left in the tree they would be collected by a root-level `bun test`, rewritten by
     `bun run format:md`, and globbed by check-coverage-manifest.ts. None is reachable from an entry
     point, so excluding them is free — and these three lines are the entire reason it is free. */
  test("excludes the upstream test files and markdown that would collide with our gates", () => {
    expect(SPARSE_PATTERNS).toContain("!*.test.ts");
    expect(SPARSE_PATTERNS).toContain("!**/__tests__/**");
    expect(SPARSE_PATTERNS).toContain("!*.md");
  });

  /* `sdks/main` reaches sideways into ../../config, ../../../shared and ../../../preload, so
     narrowing the list further does not shrink the checkout — it breaks resolution. */
  test("keeps all five directories the SDK's entry points reach across", () => {
    for (const dir of ["browser", "config", "preload", "shared", "sdks/main"]) {
      expect(SPARSE_PATTERNS).toContain(`/package/src/${dir}/`);
    }
  });

  test("the entry points live under the vendored source root", () => {
    expect(SDK_ENTRY_POINTS.length).toBeGreaterThan(0);
    for (const entry of SDK_ENTRY_POINTS) {
      expect({ entry, under: entry.startsWith(`${SDK_SRC}/`) }).toEqual({ entry, under: true });
    }
  });
});

/* The stub stands in for a file upstream generates by bundling its preload. Nothing in a typecheck
   reads the strings, and this is byte-for-byte what upstream's own devkit contract tests write. */
test("the generated stub is the two exports proc/native.ts imports", () => {
  expect(STUB_CONTENTS).toBe(
    'export const preloadScript = "";\nexport const preloadScriptSandboxed = "";\n',
  );
  expect(STUB_PATH.endsWith("/preload/.generated/compiled.ts")).toBe(true);
});

/* These run for real in CI: the `changes` job checks the submodule out before `bun test scripts`.
   The skip is for a working tree whose submodule was never initialised, where an unrelated script
   test run should not fail on it. */
const vendored = existsSync(at(VENDOR_MANIFEST));

describe.skipIf(!vendored)("against the checked-out submodule", () => {
  test("the pin and the checkout agree, with sources and stub in place", () => {
    expect(inspect(repoRoot).ok).toBe(true);
  });

  test("every entry point the tsconfig maps to is on disk", () => {
    for (const entry of SDK_ENTRY_POINTS) {
      expect({ entry, exists: existsSync(at(entry)) }).toEqual({ entry, exists: true });
    }
  });

  /* The upstream half of the carve-out asserted in packages/desktop/tests/electrobun-config.test.ts:
     the SDK still exports raw TypeScript. The day it ships declarations, `skipLibCheck` starts
     working and packages/desktop can rejoin the root tsconfig. */
  test("the SDK still exports raw .ts, not declarations", () => {
    const manifest = JSON.parse(readFileSync(at(VENDOR_MANIFEST), "utf8")) as {
      exports: Record<string, string>;
    };
    const entries = Object.values(manifest.exports);
    expect(entries.length).toBeGreaterThan(0);
    for (const target of entries) {
      expect({
        declaration: target.endsWith(".d.ts"),
        source: target.endsWith(".ts"),
        target,
      }).toEqual({ declaration: false, source: true, target });
    }
  });

  /* The desktop tsconfig hand-lists the subpaths it imports rather than extending a generated
     46-entry path map, so the two lists can drift apart silently. They are the same
     files: the tsconfig's are relative to packages/desktop, these are relative to the repo root. */
  test("the desktop tsconfig's paths are exactly the entry points this script guards", () => {
    const targets = readFileSync(at("packages/desktop/tsconfig.json"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith('"electrobun'))
      .flatMap((line) => [...line.matchAll(/"((?:\.\.?\/)[^"]+)"/g)].map((m) => m[1]!))
      .map((target) => resolve(at("packages/desktop"), target));
    expect(new Set(targets)).toEqual(new Set(SDK_ENTRY_POINTS.map((entry) => at(entry))));
  });

  test("the submodule sits where the manifests say it does", () => {
    expect(VENDOR_MANIFEST.startsWith(`${VENDOR_DIR}/`)).toBe(true);
    expect(existsSync(at(DESKTOP_MANIFEST))).toBe(true);
  });
});

/* Informational by design. It reports how a locally projected .hutch/devkit differs from the same
   release's sources, and must never be able to fail a run. With no projection there is nothing to
   compare and the answer is empty rather than an error. */
test("the devkit drift report says nothing when there is no projection", () => {
  expect(devkitDrift(resolve(import.meta.dir, "../packages/schema"))).toEqual([]);
});
