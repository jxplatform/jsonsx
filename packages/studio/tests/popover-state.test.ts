import "./with-dom.js";
import { describe, expect, mock, test } from "bun:test";

import { ancestorPopoverPath, popoverPathFor } from "../src/canvas/popover-path";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** A document whose only child is a popover holding a link. */
const DOC = {
  children: [
    { attributes: { id: "trigger", popovertarget: "menu" }, tagName: "button" },
    {
      attributes: { id: "menu", popover: "auto" },
      children: [{ attributes: { href: "/a" }, tagName: "a" }],
      tagName: "nav",
    },
  ],
  tagName: "div",
} as unknown as JxMutableNode;

describe("ancestorPopoverPath", () => {
  test("a popover is its own answer", () => {
    expect(ancestorPopoverPath(DOC, ["children", 1])).toEqual(["children", 1]);
  });

  test("a node INSIDE one answers with the panel, which is what open-on-selection needs", () => {
    expect(ancestorPopoverPath(DOC, ["children", 1, "children", 0])).toEqual(["children", 1]);
  });

  test("a node outside every popover answers null", () => {
    expect(ancestorPopoverPath(DOC, ["children", 0])).toBeNull();
    expect(ancestorPopoverPath(DOC, [])).toBeNull();
  });

  test("it walks prefixes, so a `map` or `cases` hop needs no special case", () => {
    const doc = {
      children: [
        {
          $switch: "#/state/x",
          cases: {
            one: {
              attributes: { popover: "auto" },
              children: [{ tagName: "p", textContent: "in a case" }],
              tagName: "nav",
            },
          },
          tagName: "div",
        },
        {
          $prototype: "Array",
          items: [],
          map: {
            attributes: { popover: "auto" },
            children: [{ tagName: "li" }],
            tagName: "nav",
          },
          tagName: "div",
        },
      ],
      tagName: "div",
    } as unknown as JxMutableNode;
    expect(ancestorPopoverPath(doc, ["children", 0, "cases", "one", "children", 0])).toEqual([
      "children",
      0,
      "cases",
      "one",
    ]);
    expect(ancestorPopoverPath(doc, ["children", 1, "map", "children", 0])).toEqual([
      "children",
      1,
      "map",
    ]);
  });

  test("the NEAREST popover wins when they nest", () => {
    const doc = {
      attributes: { popover: "auto" },
      children: [{ attributes: { popover: "auto" }, children: [{ tagName: "p" }], tagName: "nav" }],
      tagName: "nav",
    } as unknown as JxMutableNode;
    expect(ancestorPopoverPath(doc, ["children", 0, "children", 0])).toEqual(["children", 0]);
  });

  test("a missing document or path answers null rather than throwing", () => {
    expect(ancestorPopoverPath(null, ["children", 0])).toBeNull();
    expect(ancestorPopoverPath(DOC, null)).toBeNull();
  });

  test("a path that runs off the tree answers null", () => {
    expect(ancestorPopoverPath(DOC, ["children", 9, "children", 3])).toBeNull();
  });
});

describe("popoverPathFor", () => {
  /** A tab-shaped double carrying the document and a selection. */
  function tabWith(selection: (string | number)[][]) {
    return { doc: { document: DOC }, id: "t1", session: { selection, ui: {} } } as never;
  }

  test("popoverPathFor takes an explicit path at its word, but checks it", () => {
    const tab = tabWith([]);
    expect(popoverPathFor(tab, ["children", 1])).toEqual(["children", 1]);
    // Not a popover — refused, so the command can say so rather than opening nothing.
    expect(popoverPathFor(tab, ["children", 0])).toBeNull();
    expect(popoverPathFor(tab, ["children", 9])).toBeNull();
  });

  test("with no explicit path it falls back to the selection", () => {
    expect(popoverPathFor(tabWith([["children", 1, "children", 0]]))).toEqual(["children", 1]);
    expect(popoverPathFor(tabWith([]))).toBeNull();
  });

  test("a tab with no document answers null", () => {
    const tab = { doc: {}, id: "t", session: { selection: [], ui: {} } } as never;
    expect(popoverPathFor(tab)).toBeNull();
  });
});

describe("the reveal rule", () => {
  /**
   * Load the module with its two collaborators doubled.
   *
   * `mock.module` before the import, per the coverage policy: `popover-state` reaches `iframe-host`
   * at module scope, and a real one would try to post into frames that do not exist here.
   */
  async function loadWithDoubles() {
    const posted: { path: unknown }[] = [];
    const revealed: unknown[] = [];
    mock.module("../src/canvas/iframe-host", () => ({
      postPopoverOpen: (_tab: unknown, path: unknown) => {
        posted.push({ path });
      },
      revealCanvasPath: (path: unknown) => {
        revealed.push(path);
        return Promise.resolve();
      },
    }));
    const mod = await import("../src/canvas/popover-state");
    return { mod, posted, revealed };
  }

  /** A tab-shaped double: the document, a selection and the `ui` slot the rule writes. */
  function fakeTab(selection: (string | number)[][], openPopover: unknown = null) {
    return {
      doc: { document: DOC },
      id: "t1",
      session: { selection, ui: { openPopover } },
    } as never;
  }

  test("selecting inside a popover opens it, and tells the frames once", async () => {
    const { mod, posted } = await loadWithDoubles();
    const tab = fakeTab([["children", 1, "children", 0]]);
    mod.reconcileOpenPopover(tab);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toEqual(["children", 1]);
  });

  test("selecting OUTSIDE every popover leaves the open one alone", async () => {
    // The asymmetry is the point: closing on any stray selection would make a popover impossible to
    // Style, because reaching a control in the Inspector is a selection change.
    const { mod, posted } = await loadWithDoubles();
    mod.reconcileOpenPopover(fakeTab([["children", 0]], ["children", 1]));
    expect(posted).toHaveLength(0);
  });

  test("re-selecting inside the panel that is already open posts nothing", async () => {
    const { mod, posted } = await loadWithDoubles();
    const tab = fakeTab([["children", 1, "children", 0]], ["children", 1]);
    mod.reconcileOpenPopover(tab);
    expect(posted).toHaveLength(0);
  });

  test("no tab is not an error", async () => {
    const { mod, posted } = await loadWithDoubles();
    mod.reconcileOpenPopover(null);
    expect(posted).toHaveLength(0);
  });

  test("setOpenPopover is the single writer: it writes the model AND posts", async () => {
    const { mod, posted } = await loadWithDoubles();
    const tab = fakeTab([]);
    mod.setOpenPopover(tab, ["children", 1]);
    expect(
      (tab as unknown as { session: { ui: { openPopover: unknown } } }).session.ui.openPopover,
    ).toEqual(["children", 1]);
    expect(posted[0]!.path).toEqual(["children", 1]);
  });

  test("the watch is idempotent and stops cleanly", async () => {
    const { mod } = await loadWithDoubles();
    const stopA = mod.ensurePopoverRevealWatch();
    const stopB = mod.ensurePopoverRevealWatch();
    expect(() => {
      stopA();
      stopB();
    }).not.toThrow();
  });
});
