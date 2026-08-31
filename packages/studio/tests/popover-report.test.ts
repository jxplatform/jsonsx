/**
 * The popover report: what it files, and the three repairs it hands the author.
 *
 * Every fixture is reduced from something that shipped — the base-`display` drawer is Elite's and
 * Burntrock's, the `<a popovertarget>` is jxsuite.com's.
 */

import { resetWorkspaceWithTab } from "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import {
  POPOVER_PROBLEM_SOURCE,
  popoverCommands,
  reportPopoverProblems,
} from "../src/services/popover-report";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { problems, resetNotifications } from "../src/services/notify";
import { activeTab } from "../src/workspace/workspace";
import type { JxElement, JxMutableNode } from "@jxsuite/schema/types";

/** A trigger plus a panel, with the panel's style under the test's control. */
function docWith(
  style: Record<string, unknown>,
  panelAttrs: Record<string, unknown> = {},
): JxElement {
  return {
    children: [
      { attributes: { popovertarget: "menu", type: "button" }, tagName: "button" },
      {
        attributes: { id: "menu", popover: "auto", ...panelAttrs },
        children: [{ attributes: { href: "/a" }, tagName: "a" }],
        style,
        tagName: "nav",
      },
    ],
    tagName: "div",
  } as JxElement;
}

/** The conforming shape, so a test perturbs one thing and sees one finding. */
const GOOD = {
  ":popover-open": { display: "flex" },
  inset: "0 0 0 auto",
  transition: "transform 0.3s, display 0.3s allow-discrete, overlay 0.3s allow-discrete",
};

/** Open a tab on `doc` so the commands have something to act on. */
function openTab(doc: JxElement) {
  return resetWorkspaceWithTab(doc as unknown as JxMutableNode, {
    documentPath: "components/header.json",
  });
}

/** The panel node as it stands in the live document. */
function panelNow(): JxMutableNode {
  return (activeTab.value!.doc.document.children as JxMutableNode[])[1]!;
}

/** Run one command by id against the live registry. */
function run(id: string, args?: Record<string, unknown>) {
  const registry = createCommandRegistry({
    getContext: () => makeContext({ document: { open: true } }),
  });
  registry.registerAll(popoverCommands());
  return registry.run(id, args);
}

/** The problem records this source filed. */
const filed = () => problems.filter((p) => p.source === POPOVER_PROBLEM_SOURCE);

/** Those whose key names a given rule — `key` is optional on the record, so it is read safely. */
const forRule = (rule: string) =>
  filed().filter((p) => (p.key ?? "").startsWith(`popover.${rule}`));

afterEach(() => {
  resetNotifications();
});

describe("reportPopoverProblems", () => {
  test("a conforming document files nothing", () => {
    expect(reportPopoverProblems(docWith(GOOD))).toBe(0);
    expect(filed()).toHaveLength(0);
  });

  test("a base-rule display files an error carrying the repair command", () => {
    reportPopoverProblems(docWith({ ...GOOD, display: "flex" }), "components/header.json");
    const [rec] = forRule("base-display");
    expect(rec?.severity).toBe("error");
    expect(rec?.action).toBe("document.repairPopoverDisplay");
    expect(rec?.actionArgs).toEqual({ path: ["children", 1] });
    expect(rec?.path).toBe("components/header.json");
  });

  test("a finding with no mechanical fix carries no button", () => {
    // Which panel an invoker should point at is the author's decision, so the finding is a
    // Sentence. A button that does not do what it says is worse than no button (ATAG B.3.2).
    const doc = docWith(GOOD);
    (doc.children as JxElement[])[0]!.attributes!.popovertarget = "gone";
    reportPopoverProblems(doc);
    const [rec] = forRule("target-missing");
    expect(rec).toBeDefined();
    expect(rec?.action).toBeUndefined();
  });

  test("two popovers with the same defect file two records, not one", () => {
    // Keyed by rule AND path. A key that collapsed them would report one and drop the other.
    const doc = docWith({ ...GOOD, display: "flex" });
    (doc.children as JxElement[]).push({
      attributes: { id: "second", popover: "auto" },
      style: { ...GOOD, display: "block" },
      tagName: "nav",
    } as JxElement);
    reportPopoverProblems(doc);
    expect(forRule("base-display")).toHaveLength(2);
  });

  test("a re-run replaces what it filed before rather than accumulating", () => {
    reportPopoverProblems(docWith({ ...GOOD, display: "flex" }));
    expect(filed().length).toBeGreaterThan(0);
    reportPopoverProblems(docWith(GOOD));
    expect(filed()).toHaveLength(0);
  });
});

describe("document.repairPopoverDisplay", () => {
  test("moves the base display into :popover-open, in ONE undo entry", () => {
    const tab = openTab(docWith({ inset: "0", transition: "x", display: "flex" }));
    const before = tab.history.snapshots.length;
    void run("document.repairPopoverDisplay", { path: ["children", 1] });
    const style = panelNow().style as Record<string, Record<string, string>>;
    expect(style.display).toBeUndefined();
    expect(style[":popover-open"]!.display).toBe("flex");
    expect(tab.history.snapshots.length - before).toBe(1);
  });

  test("keeps an existing open display and just deletes the base one", () => {
    // The open state is the author's intent; the base rule is the accident.
    openTab(docWith({ ":popover-open": { display: "grid" }, display: "flex" }));
    void run("document.repairPopoverDisplay", { path: ["children", 1] });
    const style = panelNow().style as Record<string, Record<string, string>>;
    expect(style.display).toBeUndefined();
    expect(style[":popover-open"]!.display).toBe("grid");
  });

  test("takes visibility with it — the ad-hoc second hiding mechanism", () => {
    openTab(docWith({ ...GOOD, display: "flex", visibility: "hidden" }));
    void run("document.repairPopoverDisplay", { path: ["children", 1] });
    expect((panelNow().style as Record<string, unknown>).visibility).toBeUndefined();
  });

  test("clears a breakpoint-scoped display without deleting the breakpoint block", () => {
    openTab(docWith({ ...GOOD, "@--md": { display: "flex", gap: "1rem" } }));
    void run("document.repairPopoverDisplay", { path: ["children", 1] });
    const md = (panelNow().style as Record<string, Record<string, string>>)["@--md"]!;
    expect(md.display).toBeUndefined();
    expect(md.gap).toBe("1rem");
  });

  test("refuses a popover with nothing to move", () => {
    openTab(docWith(GOOD));
    expect(() => run("document.repairPopoverDisplay", { path: ["children", 1] })).toThrow(
      RangeError,
    );
  });

  test("refuses a call with no path", () => {
    openTab(docWith(GOOD));
    expect(() => run("document.repairPopoverDisplay", {})).toThrow(RangeError);
  });
});

describe("document.repairPopoverInvoker", () => {
  test("removes both attributes, which did nothing where they were", () => {
    // Not a conversion to <button>: the attributes are inert, so removing them changes no
    // Behaviour and tells the truth. Turning a link into a button changes the page.
    const doc = docWith(GOOD);
    const link = (doc.children as JxElement[])[1]!.children as JxElement[];
    link[0]!.attributes = { href: "/a", popovertarget: "menu", popovertargetaction: "hide" };
    openTab(doc);
    void run("document.repairPopoverInvoker", { path: ["children", 1, "children", 0] });
    const attrs = (panelNow().children as JxMutableNode[])[0]!.attributes!;
    expect(attrs.popovertarget).toBeUndefined();
    expect(attrs.popovertargetaction).toBeUndefined();
    expect(attrs.href).toBe("/a");
  });
});

describe("document.repairPopoverMode", () => {
  test("writes the house spelling over a boolean or a bad keyword", () => {
    for (const bad of [true, "modal"]) {
      openTab(docWith(GOOD, { popover: bad }));
      void run("document.repairPopoverMode", { path: ["children", 1] });
      expect(panelNow().attributes!.popover).toBe("auto");
    }
  });
});

describe("document.checkPopovers", () => {
  test("files the defects of the open document", () => {
    openTab(docWith({ ...GOOD, display: "flex" }));
    void run("document.checkPopovers");
    expect(forRule("base-display").length > 0).toBe(true);
  });

  test("says so when there are none", () => {
    openTab(docWith(GOOD));
    void run("document.checkPopovers");
    expect(filed()).toHaveLength(0);
  });
});
