/**
 * Tests for scripts/check-icons.ts — the two key spaces, and the reason they are two.
 *
 * The first version of this checker treated a record's `icon:` string as a custom-element tag. It
 * is not: it is a key into a resolver map. That single conflation passed the gate on a Source
 * Control rail button rendering a 20px hole, so most of what is asserted here is the DISTINCTION.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkIcons,
  elementNameFor,
  iconImports,
  iconKeysDeclared,
  iconProblems,
  iconTagsRegistered,
  iconTagsUsed,
  report,
  resolverKeys,
} from "../scripts/check-icons";

const STUDIO = new URL("..", import.meta.url).pathname;

describe("check-icons", () => {
  test("the shipped tree is clean", () => {
    expect(checkIcons().problems).toEqual([]);
  });

  test("a tag becomes the module name Spectrum files it under", () => {
    expect(elementNameFor("sp-icon-rail-right-open")).toBe("IconRailRightOpen");
    expect(elementNameFor("sp-icon-alert")).toBe("IconAlert");
  });

  test("the specifier is READ, because the icons come from two packages", () => {
    const from = iconImports(
      'import { IconAlert } from "@spectrum-web-components/icons-workflow/src/elements/IconAlert.js";\n' +
        'import { IconChevron100 } from "@spectrum-web-components/icons-ui/src/elements/IconChevron100.js";\n',
    );
    expect(from.get("IconAlert")).toContain("icons-workflow");
    expect(from.get("IconChevron100")).toContain("icons-ui");
  });

  /*
   * The distinction, stated three ways. `<sp-icon-x>` is a tag; `"sp-icon-x"` is a key; and the two
   * are spelled alike, which is the whole trap.
   */
  describe("a tag is not a key", () => {
    test("only the angle-bracket shape counts as a tag", () => {
      const src = join(STUDIO, "src");
      const tags = iconTagsUsed(src);
      // `sp-icon-git-branch` is a KEY bound to a hand-drawn inline <svg>; the only place the tag
      // Shape appears is nowhere, because Spectrum ships no Git family.
      expect(tags.has("sp-icon-git-branch")).toBe(false);
      expect(resolverKeys(readActivityBar())).toContain("sp-icon-git-branch");
    });

    test("every panel key has a row, and every row has a panel", () => {
      const keys = new Set(iconKeysDeclared(join(STUDIO, "src")).keys());
      const rows = resolverKeys(readActivityBar());
      expect([...keys].filter((k) => !rows.has(k))).toEqual([]);
      expect([...rows].filter((r) => !keys.has(r))).toEqual([]);
    });

    test("only registerPanel keys are collected — a command's icon has a visible fallback", () => {
      const keys = iconKeysDeclared(join(STUDIO, "src"));
      expect(keys.has("sp-icon-git-branch")).toBe(true);
      // Declared on a settings SECTION, whose icon is documented as reserved and read by nobody,
      // And on command records, which fall back to the title. Sweeping those in is what let the
      // First version report 83 icons "all registered" with three rail buttons drawing nothing.
      expect(keys.has("sp-icon-plug")).toBe(false);
      expect(keys.has("sp-icon-arrow-up")).toBe(false);
    });
  });

  describe("the rules, over stated inputs", () => {
    const base = {
      imported: new Map([["IconGhost", "real/IconGhost.js"]]),
      installed: (s: string) => s.startsWith("real/"),
      keys: new Map<string, string>(),
      registered: new Set<string>(),
      rows: new Set<string>(),
      tags: new Map<string, string[]>(),
    };

    test("a tag no element registers", () => {
      const [problem] = iconProblems({ ...base, tags: new Map([["sp-icon-x", ["panels/a.ts"]]]) });
      expect(problem).toContain("panels/a.ts");
      expect(problem).toContain("empty box");
    });

    test("a registered tag with no import behind it", () => {
      expect(
        iconProblems({
          ...base,
          registered: new Set(["sp-icon-nope"]),
          tags: new Map([["sp-icon-nope", ["a.ts"]]]),
        }),
      ).toEqual(["sp-icon-nope maps to IconNope, which ui/spectrum.ts never imports"]);
    });

    test("an import of a module the package does not ship — the rail-left case", () => {
      expect(
        iconProblems({
          ...base,
          imported: new Map([["IconGhost", "ghost/IconRailLeftOpen.js"]]),
          registered: new Set(["sp-icon-ghost"]),
          tags: new Map([["sp-icon-ghost", ["a.ts"]]]),
        }),
      ).toEqual(["sp-icon-ghost imports ghost/IconRailLeftOpen.js, which is not installed"]);
    });

    test("THE REGRESSION: a panel key with no row says registering will not help", () => {
      const [problem] = iconProblems({
        ...base,
        // Registered, imported and installed — which is exactly why the first checker passed.
        imported: new Map([["IconBranch1", "real/IconBranch1.js"]]),
        keys: new Map([["sp-icon-branch-1", "panels/git-panel.ts:995"]]),
        registered: new Set(["sp-icon-branch-1"]),
        rows: new Set(["sp-icon-git-branch"]),
        tags: new Map([["sp-icon-branch-1", ["ui/spectrum.ts"]]]),
      });
      expect(problem).toContain("panels/git-panel.ts:995");
      expect(problem).toContain("renders NOTHING");
      expect(problem).toContain("registering the element does not help");
    });

    test("…and the orphaned row it leaves behind is reported too", () => {
      const problems = iconProblems({
        ...base,
        imported: new Map([["IconBranch1", "real/IconBranch1.js"]]),
        keys: new Map([["sp-icon-branch-1", "panels/git-panel.ts:995"]]),
        registered: new Set(["sp-icon-branch-1"]),
        rows: new Set(["sp-icon-git-branch"]),
        tags: new Map([["sp-icon-branch-1", ["ui/spectrum.ts"]]]),
      });
      expect(problems).toHaveLength(2);
      expect(problems[1]).toContain("sp-icon-git-branch");
      expect(problems[1]).toContain("dead row");
    });

    test("an allow-listed orphan registration is silent; the imports still must resolve", () => {
      // `sp-icon-chevron100` is registered for `sp-picker`'s OWN shadow DOM, so "no template writes
      // It" is not evidence it can be deleted.
      expect(
        iconProblems({
          ...base,
          imported: new Map([["IconChevron100", "real/IconChevron100.js"]]),
          registered: new Set(["sp-icon-chevron100"]),
        }),
      ).toEqual([]);
    });

    test("a fully wired icon is silent", () => {
      expect(
        iconProblems({
          ...base,
          keys: new Map([["sp-icon-ghost", "panels/a.ts:1"]]),
          registered: new Set(["sp-icon-ghost"]),
          rows: new Set(["sp-icon-ghost"]),
          tags: new Map([["sp-icon-ghost", ["panels/activity-bar.ts"]]]),
        }),
      ).toEqual([]);
    });
  });

  test("resolverKeys refuses to guess if tabIcon is renamed", () => {
    expect(() => resolverKeys("export function somethingElse() {}\n")).toThrow(/tabIcon/);
  });

  test("registered tags are read from the registry rows, not from prose", () => {
    expect([
      ...iconTagsRegistered('// mentions "sp-icon-prose"\n  ["sp-icon-real", IconReal],\n'),
    ]).toEqual(["sp-icon-real"]);
  });

  describe("report", () => {
    test("returns 1 and names both fixes, 0 with both counts", () => {
      const errors: unknown[][] = [];
      const logs: unknown[][] = [];
      const realError = console.error;
      const realLog = console.log;
      console.error = (...a: unknown[]) => errors.push(a);
      console.log = (...a: unknown[]) => logs.push(a);
      try {
        expect(report(['git-panel.ts:995 declares icon "sp-icon-branch-1"'], 3, 2)).toBe(1);
        expect(report([], 74, 11)).toBe(0);
      } finally {
        console.error = realError;
        console.log = realLog;
      }
      const said = errors.flat().join(" ");
      expect(said).toContain("sp-icon-branch-1");
      // The refusal has to name the RIGHT fix for each space, because "register it" is the wrong
      // Advice for a key and following it is what produced the regression.
      expect(said).toContain("src/ui/spectrum.ts");
      expect(said).toContain("tabIcon()");
      expect(logs.flat().join(" ")).toContain("74 tag(s)");
      expect(logs.flat().join(" ")).toContain("11 panel key(s)");
    });
  });
});

function readActivityBar(): string {
  return readFileSync(join(STUDIO, "src/panels/activity-bar.ts"), "utf8");
}
