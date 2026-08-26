/**
 * Rule tests for the docs-nav walk.
 *
 * Two halves, following check-standards.test.ts. The GOLDEN tests run against the committed
 * `docs/nav.json` — the manifest the site actually renders must be well-formed, and its walk must
 * reach every page exactly once. The RULE tests drive tiny in-memory manifests, one per invariant.
 *
 * The depth cases are the point. The walk this replaced was two levels deep in both consumers, so a
 * page one step deeper was not reported missing — it was simply never visited, by the bijection or
 * by the export. A well-formed manifest cannot show that, so the rule tests put the interesting
 * page at the third level.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Nav, NavSection } from "./nav.ts";
import { isUnder, navPaths, navProblems, readNav, sectionPaths } from "./nav.ts";

const NAV_PATH = resolve(import.meta.dir, "../../docs/nav.json");

/** A minimal well-formed section, with `overrides` applied on top. */
function section(overrides: Partial<NavSection> = {}): NavSection {
  return {
    path: "studio",
    label: "Studio",
    pages: [{ path: "studio", label: "Overview" }],
    groups: [
      {
        label: "Design mode",
        pages: [{ path: "studio/design/properties", label: "Properties" }],
      },
    ],
    ...overrides,
  };
}

function nav(sections: NavSection[]): Nav {
  return { id: "nav", sections };
}

// ─── Golden: the committed manifest ──────────────────────────────────────────

describe("docs/nav.json", () => {
  test("is structurally well-formed", () => {
    expect(navProblems(readNav(NAV_PATH))).toEqual([]);
  });

  test("reaches every page exactly once", () => {
    const paths = navPaths(readNav(NAV_PATH));
    expect(paths.length).toBe(new Set(paths).size);
  });

  test("reaches pages three levels deep", () => {
    // The regression this walk exists for: a two-level walk cannot see a group's pages at all.
    expect(navPaths(readNav(NAV_PATH))).toContain("studio/design/properties");
  });

  test("leaves no section able to ship JS for its sidebar", () => {
    // Restated as a golden assertion because it is the invariant most easily lost by hand-editing
    // The manifest: one empty array is one whole section's worth of pages losing zero-JS.
    for (const s of readNav(NAV_PATH).sections) {
      expect(s.pages.length).toBeGreaterThan(0);
      expect(s.groups.length).toBeGreaterThan(0);
      for (const g of s.groups) {
        expect(g.pages.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── isUnder ─────────────────────────────────────────────────────────────────

describe("isUnder", () => {
  test("accepts the prefix itself", () => {
    expect(isUnder("studio", "studio")).toBe(true);
  });

  test("accepts a descendant", () => {
    expect(isUnder("studio/design/properties", "studio")).toBe(true);
  });

  test("rejects a sibling that merely starts the same", () => {
    expect(isUnder("studio-beta/design", "studio")).toBe(false);
  });
});

// ─── sectionPaths / navPaths ─────────────────────────────────────────────────

describe("sectionPaths", () => {
  test("draws the section's own rows before its groups", () => {
    expect(
      sectionPaths(
        section({
          pages: [
            { path: "studio", label: "Overview" },
            { path: "studio/desktop", label: "The desktop app" },
          ],
        }),
      ),
    ).toEqual(["studio", "studio/desktop", "studio/design/properties"]);
  });

  test("navPaths concatenates the sections in order", () => {
    const sections = [
      section({ path: "a", pages: [{ path: "a", label: "Overview" }], groups: [] }),
      section({ path: "b", pages: [{ path: "b", label: "Overview" }], groups: [] }),
    ];
    expect(navPaths(nav(sections))).toEqual(["a", "b"]);
  });
});

// ─── navProblems ─────────────────────────────────────────────────────────────

describe("navProblems", () => {
  /** The problems one otherwise-well-formed section produces. */
  function problemsFor(overrides: Partial<NavSection> = {}): string[] {
    return navProblems(nav([section(overrides)]));
  }

  /** One problem, saying `expected`. Every rule below reports exactly one. */
  function expectOneProblem(problems: string[], expected: string): void {
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(expected);
  }

  test("passes a well-formed manifest", () => {
    expect(problemsFor()).toEqual([]);
  });

  test("reports an empty pages array", () => {
    expectOneProblem(problemsFor({ pages: [] }), "is empty");
  });

  test("reports an empty groups array", () => {
    expectOneProblem(problemsFor({ groups: [] }), "is empty");
  });

  test("reports an empty group", () => {
    expectOneProblem(problemsFor({ groups: [{ label: "Design mode", pages: [] }] }), "is empty");
  });

  test("reports a section that does not lead with its own index page", () => {
    expectOneProblem(
      problemsFor({ pages: [{ path: "studio/desktop", label: "The desktop app" }] }),
      "does not lead with its own index page",
    );
  });

  test("reports a group page outside its section", () => {
    const groups = [
      { label: "Concepts", pages: [{ path: "framework/concepts/state", label: "State" }] },
    ];
    expectOneProblem(problemsFor({ groups }), "is not under its section");
  });

  test("does not mistake a sibling prefix for containment", () => {
    const groups = [
      { label: "Design mode", pages: [{ path: "studio-beta/design", label: "Beta" }] },
    ];
    expectOneProblem(problemsFor({ groups }), "is not under its section");
  });
});
