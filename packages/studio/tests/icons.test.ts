/**
 * Every `sp-icon-*` a template names must be an element the browser knows.
 *
 * An unregistered custom element is not an error. It is an `HTMLUnknownElement` with no shadow
 * root, no content and no warning — an empty box the size of the missing icon. The type checker
 * sees a string in a template, the linter sees nothing, and happy-dom renders the absence as
 * happily as Chrome does. Eleven shipped this way; two were reported by a person looking at the
 * app, and the other nine had never been mentioned.
 *
 * Three of the eleven named icons Spectrum does not ship at all. `sp-icon-rail-left-open` and
 * `sp-icon-rail-left-close` were written by symmetry with `rail-right-open`/`close`, which exist —
 * the workflow set has only a plain `IconRailLeft` — so the Navigator's dock toggle could never
 * have rendered. That is why the check has a second half: a registry that lists a module nobody
 * ships is as blind as a template naming a tag nobody registered.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  checkIcons,
  elementNameFor,
  iconImports,
  iconProblems,
  iconTagsUsed,
  report,
} from "../scripts/check-icons";

describe("check-icons", () => {
  test("the shipped tree has no unregistered or unshipped icon", () => {
    expect(checkIcons().problems).toEqual([]);
  });

  test("maps a tag to the module Spectrum names it by", () => {
    expect(elementNameFor("sp-icon-alert")).toBe("IconAlert");
    expect(elementNameFor("sp-icon-rail-right-open")).toBe("IconRailRightOpen");
    // Digits stay attached to the word they belong to — `IconBranch1`, not `IconBranch-1`.
    expect(elementNameFor("sp-icon-branch-1")).toBe("IconBranch1");
  });

  test("reads the specifier from the import, because the icons come from TWO packages", () => {
    // `IconChevron100` is `icons-ui`, everything else is `icons-workflow`. A check that assumed
    // One package would report the other's icons as missing — a false alarm about a working icon,
    // Which is the failure that makes a gate get ignored.
    const source = `
      import { IconAlert } from "@spectrum-web-components/icons-workflow/src/elements/IconAlert.js";
      import { IconChevron100 } from "@spectrum-web-components/icons-ui/src/elements/IconChevron100.js";
    `;
    const from = iconImports(source);
    expect(from.get("IconAlert")).toContain("icons-workflow");
    expect(from.get("IconChevron100")).toContain("icons-ui");
  });

  test("finds tags in both shapes a surface can name one", () => {
    // `<sp-icon-x>` in a template, and `icon: "sp-icon-x"` on a panel or command record — the
    // Second is the form the Problems rail button used, and the reason a template-only scan
    // Would have walked past it.
    const used = iconTagsUsed(new URL("../src", import.meta.url).pathname);
    expect(used.get("sp-icon-alert")).toEqual(["panels/problems-panel.ts"]);
    expect(used.has("sp-icon-rail-right-open")).toBe(true);
  });

  /*
   * The rule, driven with a registry that is WRONG.
   *
   * The shipped tree is correct by construction, so a check that only ever reads the real files
   * cannot reach the branch that reports a problem — and that branch is the entire product. These
   * four cases are the four ways an icon fails to appear.
   */
  describe("the two rules, over stated inputs", () => {
    const installed = (s: string) => s.includes("real");

    test("a tag a template names and the registry does not carry", () => {
      const problems = iconProblems(
        new Map([["sp-icon-ghost", ["panels/x.ts"]]]),
        new Set(),
        new Map(),
        installed,
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("panels/x.ts");
      expect(problems[0]).toContain("empty box");
    });

    test("a tag the registry carries with no import behind it", () => {
      const problems = iconProblems(new Map(), new Set(["sp-icon-ghost"]), new Map(), installed);
      expect(problems).toEqual([
        "sp-icon-ghost maps to IconGhost, which ui/spectrum.ts never imports",
      ]);
    });

    test("an import of a module the package does not ship — the rail-left case", () => {
      const problems = iconProblems(
        new Map(),
        new Set(["sp-icon-rail-left-open"]),
        new Map([
          ["IconRailLeftOpen", "@spectrum-web-components/icons-workflow/IconRailLeftOpen.js"],
        ]),
        installed,
      );
      expect(problems).toEqual([
        "sp-icon-rail-left-open imports " +
          "@spectrum-web-components/icons-workflow/IconRailLeftOpen.js, which is not installed",
      ]);
    });

    test("a registered, imported, installed icon is silent", () => {
      const problems = iconProblems(
        new Map([["sp-icon-alert", ["panels/problems-panel.ts"]]]),
        new Set(["sp-icon-alert"]),
        new Map([["IconAlert", "real/IconAlert.js"]]),
        installed,
      );
      expect(problems).toEqual([]);
    });
  });

  describe("report", () => {
    test("returns 1 and names every problem, 0 when there are none", () => {
      const errors: unknown[][] = [];
      const logs: unknown[][] = [];
      const realError = console.error;
      const realLog = console.log;
      console.error = (...a: unknown[]) => errors.push(a);
      console.log = (...a: unknown[]) => logs.push(a);
      try {
        expect(report(["sp-icon-ghost is used by x and is not registered"], 3)).toBe(1);
        expect(report([], 83)).toBe(0);
      } finally {
        console.error = realError;
        console.log = realLog;
      }
      expect(errors.flat().join(" ")).toContain("sp-icon-ghost");
      // The refusal names the fix AND the trap that produced it, because "register it" alone sends
      // The next reader to add a row for an element Spectrum does not have.
      expect(errors.flat().join(" ")).toContain("rail-right-open");
      expect(logs.flat().join(" ")).toContain("83 icon(s)");
    });
  });
});
