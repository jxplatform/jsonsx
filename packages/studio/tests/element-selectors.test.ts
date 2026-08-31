import "./with-dom.js";
import { describe, expect, test } from "bun:test";

import { COMMON_SELECTORS } from "../src/store";
import { selectorsForNode } from "../src/utils/element-selectors";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** The selectors an element gains beyond the global set. */
function extras(node: unknown): string[] {
  return selectorsForNode(node as JxMutableNode).filter((s) => !COMMON_SELECTORS.includes(s));
}

describe("selectorsForNode", () => {
  test("the common set always comes first, and in its own order", () => {
    const out = selectorsForNode({ tagName: "p" } as JxMutableNode);
    expect(out.slice(0, COMMON_SELECTORS.length)).toEqual([...COMMON_SELECTORS]);
  });

  test("an ordinary element gains nothing — a menu of unmatchable states is a menu nobody reads", () => {
    expect(extras({ tagName: "p" })).toEqual([]);
    expect(extras({ tagName: "div" })).toEqual([]);
  });

  test("a popover gains its three states, whichever spelling declared it", () => {
    for (const popover of ["auto", "", "manual"]) {
      expect(extras({ attributes: { popover }, tagName: "nav" })).toEqual([
        ":popover-open",
        "::backdrop",
        ":popover-open::backdrop",
      ]);
    }
  });

  test("<dialog>, <details>, form fields and <a> each gain their own", () => {
    expect(extras({ tagName: "dialog" })).toEqual(["[open]", ":modal", "::backdrop"]);
    expect(extras({ tagName: "details" })).toEqual(["[open]"]);
    expect(extras({ tagName: "input" })).toEqual([
      ":checked",
      ":invalid",
      ":required",
      ":user-invalid",
    ]);
    expect(extras({ tagName: "a" })).toEqual([":visited", ":target"]);
  });

  test("a popover <dialog> gets both sets, deduped", () => {
    const out = extras({ attributes: { popover: "auto" }, tagName: "dialog" });
    expect(out.filter((s) => s === "::backdrop")).toHaveLength(1);
    expect(out).toContain(":popover-open");
    expect(out).toContain(":modal");
  });

  test("the tag is read case-insensitively, and through a tag expression", () => {
    expect(extras({ tagName: "DETAILS" })).toEqual(["[open]"]);
    const chosen = { tagName: { $expression: { cases: { a: "a" }, default: "a" } } };
    expect(extras(chosen)).toEqual([":visited", ":target"]);
  });

  test("no node at all still answers the common set", () => {
    expect(selectorsForNode(null)).toEqual([...COMMON_SELECTORS]);
    expect(selectorsForNode({ tagName: 7 } as unknown as JxMutableNode)).toEqual([
      ...COMMON_SELECTORS,
    ]);
  });
});
