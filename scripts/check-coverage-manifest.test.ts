/**
 * The manifest gate reads an ABSENCE and has to say what it means.
 *
 * "This file is not in the lcov" has two causes with opposite verdicts: nobody wrote a test (the
 * Regression the gate exists to catch) and Bun lost a record for a file the suite really ran (a
 * Coverage-collection defect — see the note at the top of check-coverage-manifest.ts). These tests
 * Pin that the re-run tells them apart, and — the part that matters most — that the rescue path
 * Cannot be reached by a file no test loads, however many tests happen to mention it by name.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  adjudicate,
  clears,
  coverageThreshold,
  coveredFiles,
  fileTotals,
  sourceFiles,
  totalsFor,
  testsNaming,
} from "./check-coverage-manifest";

/** A throwaway workspace: `src/` files plus `tests/` files, written verbatim. */
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), "jx-manifest-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function withWorkspace<T>(files: Record<string, string>, body: (root: string) => T): T {
  const root = workspace(files);
  try {
    return body(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

const BUNFIG = (lines: number, functions: number) =>
  `[test]\ncoverageSkipTestFiles = true\ncoverageThreshold = { lines = ${lines}, functions = ${functions} }\n`;

// ─── Reading the report ───────────────────────────────────────────────────────

describe("which lcov records this job owns", () => {
  test("relative and absolute spellings of the same file both count", () => {
    const covered = coveredFiles("SF:src/a.ts\nSF:/pkg/src/b.ts\n", "/pkg");
    expect([...covered].toSorted()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("synthetic modules and a sibling package's files do not", () => {
    const covered = coveredFiles(
      "SF:data:text/javascript,export{}\nSF:../protocol/src/routes.ts\nSF:src/a.ts\n",
      "/pkg",
    );
    expect([...covered]).toEqual(["src/a.ts"]);
  });
});

describe("per-file totals", () => {
  const lcov = [
    "SF:src/a.ts",
    "FNF:4",
    "FNH:3",
    "LF:10",
    "LH:9",
    "end_of_record",
    "SF:src/b.ts",
    "FNF:2",
    "FNH:0",
    "LF:8",
    "LH:0",
    "end_of_record",
    "",
  ].join("\n");

  test("are read from the named file's record and no other", () => {
    expect(fileTotals(lcov, "/pkg", "src/a.ts")).toEqual({
      functionsFound: 4,
      functionsHit: 3,
      linesFound: 10,
      linesHit: 9,
    });
    expect(fileTotals(lcov, "/pkg", "src/b.ts")?.linesHit).toBe(0);
  });

  test("are undefined for a file with no record at all", () => {
    expect(fileTotals(lcov, "/pkg", "src/missing.ts")).toBeUndefined();
  });
});

// ─── Which files the rule covers ──────────────────────────────────────────────

describe("the source set", () => {
  test("skips type declarations and the allowlisted type-only modules", () => {
    withWorkspace(
      {
        "src/real.ts": "export const a = 1;\n",
        "src/shims.d.ts": "declare const x: number;\n",
        "src/types.ts": "export type A = string;\n",
      },
      (root) => expect(sourceFiles(root)).toEqual(["src/real.ts"]),
    );
  });

  test("falls back to the package root for a workspace with no src/", () => {
    withWorkspace({ "generate.ts": "export const a = 1;\n" }, (root) =>
      expect(sourceFiles(root)).toEqual(["generate.ts"]),
    );
  });
});

describe("finding the tests that name a module", () => {
  test("matches the specifier an import would carry, at any relative depth", () => {
    withWorkspace(
      {
        "src/editor/convert.ts": "export const a = 1;\n",
        "tests/deep/nested.test.ts": 'import "../../src/editor/convert.js";\n',
        "tests/direct.test.ts": 'import "../src/editor/convert";\n',
        "tests/unrelated.test.ts": 'import "../src/other";\n',
      },
      (root) =>
        expect(testsNaming(root, "src/editor/convert.ts")).toEqual([
          "tests/deep/nested.test.ts",
          "tests/direct.test.ts",
        ]),
    );
  });

  test("a common basename does not drag in the whole suite", () => {
    withWorkspace(
      {
        "src/grid/index.ts": "export const a = 1;\n",
        "tests/grid.test.ts": 'import "../src/grid/index";\n',
        "tests/other.test.ts": 'import "../src/panels/index";\n',
      },
      (root) => expect(testsNaming(root, "src/grid/index.ts")).toEqual(["tests/grid.test.ts"]),
    );
  });
});

describe("the workspace's own bar", () => {
  test("is read from its bunfig, in both the table and scalar spellings", () => {
    withWorkspace({ "bunfig.toml": BUNFIG(0.95, 0.94) }, (root) =>
      expect(coverageThreshold(root)).toEqual({ functions: 0.94, lines: 0.95 }),
    );
    withWorkspace({ "bunfig.toml": "[test]\ncoverageThreshold = 0.9\n" }, (root) =>
      expect(coverageThreshold(root)).toEqual({ functions: 0.9, lines: 0.9 }),
    );
  });

  test("is empty — never a failure — when there is no bunfig to read", () => {
    withWorkspace({ "src/a.ts": "export const a = 1;\n" }, (root) =>
      expect(coverageThreshold(root)).toEqual({}),
    );
  });

  test("clears() requires every declared bar, and ignores the ones not declared", () => {
    expect(clears({ functions: 1, lines: 0.96 }, { functions: 0.94, lines: 0.95 })).toBe(true);
    expect(clears({ functions: 1, lines: 0.5 }, { functions: 0.94, lines: 0.95 })).toBe(false);
    expect(clears({ functions: 0.1, lines: 0.1 }, {})).toBe(true);
  });
});

// ─── The verdict, end to end ──────────────────────────────────────────────────
//
// These spawn a real `bun test --coverage` in the fixture, because the whole point of the re-run is
// That it asks Bun rather than reasoning about the source.

describe("asking one set of tests whether they load a file", () => {
  test("answers with counts when they do, and with nothing when they only name it", async () => {
    const root = workspace({
      "bunfig.toml": BUNFIG(0.95, 0.94),
      "src/subject.ts": "export const twice = (n: number) => n * 2;\n",
      "tests/loads.test.ts":
        'import { test, expect } from "bun:test";\n' +
        'import { twice } from "../src/subject";\n' +
        'test("loads", () => {\n  expect(twice(2)).toBe(4);\n});\n',
      "tests/names.test.ts":
        'import { test, expect, mock } from "bun:test";\n' +
        'void mock.module("../src/subject", () => ({ twice: () => 0 }));\n' +
        'test("names src/subject only", () => {\n  expect(1).toBe(1);\n});\n',
    });
    try {
      expect(await totalsFor(root, ["tests/loads.test.ts"], "src/subject.ts")).toMatchObject({
        linesHit: expect.any(Number),
      });
      expect(await totalsFor(root, ["tests/names.test.ts"], "src/subject.ts")).toBeUndefined();
      // No tests at all is the same answer, without spawning anything.
      expect(await totalsFor(root, [], "src/subject.ts")).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("what a file missing from the main report turns out to be", () => {
  test("a file no test loads is ABSENT — even when tests name it in a comment or a mock", async () => {
    const root = workspace({
      "bunfig.toml": BUNFIG(0.95, 0.94),
      "src/orphan.ts": "export function orphan() {\n  return 1;\n}\n",
      // Both of these NAME src/orphan without ever importing it, which is precisely the shape that
      // Must not be allowed to rescue a file: mentioning is not loading.
      "tests/mentions.test.ts":
        'import { test, expect, mock } from "bun:test";\n' +
        'void mock.module("../src/orphan", () => ({ orphan: () => 0 }));\n' +
        'test("mentions src/orphan only", () => {\n  expect(1).toBe(1);\n});\n',
    });
    try {
      expect(await adjudicate(root, "src/orphan.ts")).toEqual({
        file: "src/orphan.ts",
        kind: "absent",
        tests: ["tests/mentions.test.ts"],
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a file with no test at all is ABSENT, and says so with an empty test list", async () => {
    const root = workspace({
      "bunfig.toml": BUNFIG(0.95, 0.94),
      "src/orphan.ts": "export const orphan = () => 1;\n",
    });
    try {
      expect(await adjudicate(root, "src/orphan.ts")).toEqual({
        file: "src/orphan.ts",
        kind: "absent",
        tests: [],
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a fully exercised file is RESCUED, with the counts that prove it", async () => {
    const root = workspace({
      "bunfig.toml": BUNFIG(0.95, 0.94),
      "src/subject.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      "tests/subject.test.ts":
        'import { test, expect } from "bun:test";\n' +
        'import { add } from "../src/subject";\n' +
        'test("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
    });
    try {
      const verdict = await adjudicate(root, "src/subject.ts");
      expect(verdict.kind).toBe("rescued");
      expect(verdict.tests).toEqual(["tests/subject.test.ts"]);
      expect(verdict.kind === "rescued" && verdict.ratios.lines).toBe(1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a file the tests barely touch is BELOW the bar, which is still a failure", async () => {
    const root = workspace({
      "bunfig.toml": BUNFIG(0.95, 0.94),
      // Ten functions, one of them called: 10% of functions, far under the 94% bar.
      "src/thin.ts": `export function used() {\n  return 1;\n}\n${Array.from(
        { length: 9 },
        (_, i) => `export function spare${i}() {\n  return ${i};\n}\n`,
      ).join("")}`,
      "tests/thin.test.ts":
        'import { test, expect } from "bun:test";\n' +
        'import { used } from "../src/thin";\n' +
        'test("uses one of ten", () => {\n  expect(used()).toBe(1);\n});\n',
    });
    try {
      const verdict = await adjudicate(root, "src/thin.ts");
      expect(verdict.kind).toBe("below");
      expect(verdict.kind === "below" && verdict.ratios.functions).toBeLessThan(0.94);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
