/**
 * Structural batches — `mutateRemoveNodes` / `mutateDuplicateNodes` (§6.5, P5 item 3).
 *
 * Two properties, and a wrong answer to either corrupts a document:
 *
 * 1. **One transaction, one undo step.** A six-node delete that pushes six history entries makes ⌘Z a
 *    rebuild instead of a reversal.
 * 2. **Index safety.** Every splice renumbers its later siblings, so the batch must run
 *    last-node-first and must never splice into coordinates a contained path already invalidated.
 *
 * Plus the one that keeps the widening shippable: **a batch of one is the single mutator**, which
 * is asserted against the exact document and selection the single form produces.
 */
import "./with-dom.js";
import { createTab, disposeTab } from "../src/tabs/tab";
import {
  mutateDuplicateNode,
  mutateDuplicateNodes,
  mutateRemoveNode,
  mutateRemoveNodes,
  mutateUpdateFrontmatter,
  transactDoc,
  undo,
} from "../src/tabs/transact";
import { CommandUnavailableError, createCommandRegistry } from "../src/commands/registry";
import { defaultCommands, noopCommandDeps } from "../src/commands/defaults";
import { makeContext } from "../src/commands/context";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { describe, expect, test } from "bun:test";

/** Four labelled paragraphs, so a batch that deletes the wrong one is visible in the result. */
function makeTab() {
  const document: JxMutableNode = {
    children: [
      { tagName: "p", textContent: "A" },
      { tagName: "p", textContent: "B" },
      { tagName: "p", textContent: "C" },
      { tagName: "p", textContent: "D" },
    ],
    tagName: "div",
  };
  return createTab({ document, id: "batch" });
}

function texts(tab: ReturnType<typeof makeTab>): string[] {
  return (tab.doc.document.children as JxMutableNode[]).map((c) => String(c.textContent));
}

const at = (i: number) => ["children", i];

describe("mutateRemoveNodes", () => {
  test("one path in is exactly mutateRemoveNode — same document, same selection", () => {
    const batch = makeTab();
    batch.session.selection = [at(1)];
    transactDoc(batch, (t) => mutateRemoveNodes(t, [at(1)]));

    const single = makeTab();
    single.session.selection = [at(1)];
    transactDoc(single, (t) => mutateRemoveNode(t, at(1)));

    expect(texts(batch)).toEqual(texts(single));
    expect(batch.session.selection).toEqual(single.session.selection);
    disposeTab(batch);
    disposeTab(single);
  });

  test("removes exactly the named nodes, whatever order they arrive in", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateRemoveNodes(t, [at(0), at(2)]));
    expect(texts(tab)).toEqual(["B", "D"]);
    disposeTab(tab);
  });

  test("a forward loop would take the wrong nodes — this one does not", () => {
    const tab = makeTab();
    // Removing 0 then 1 naively would delete A and then C (which by then IS index 1).
    transactDoc(tab, (t) => mutateRemoveNodes(t, [at(0), at(1)]));
    expect(texts(tab)).toEqual(["C", "D"]);
    disposeTab(tab);
  });

  test("a batch is ONE undo step, and undo restores every node", () => {
    const tab = makeTab();
    const before = tab.history.index;
    transactDoc(tab, (t) => mutateRemoveNodes(t, [at(0), at(1), at(2)]));
    expect(texts(tab)).toEqual(["D"]);
    expect(tab.history.index).toBe(before + 1);
    undo(tab);
    expect(texts(tab)).toEqual(["A", "B", "C", "D"]);
    disposeTab(tab);
  });

  test("a node and one of its own descendants is ONE deletion", () => {
    const tab = createTab({
      document: {
        children: [{ children: [{ tagName: "em" }], tagName: "section" }, { tagName: "p" }],
        tagName: "div",
      },
      id: "nested",
    });
    transactDoc(tab, (t) => mutateRemoveNodes(t, [at(0), ["children", 0, "children", 0]]));
    expect(tab.doc.document.children).toHaveLength(1);
    expect((tab.doc.document.children as JxMutableNode[])[0]!.tagName).toBe("p");
    disposeTab(tab);
  });

  test("selection entries the deletion invalidated are dropped; the rest survive", () => {
    const tab = makeTab();
    tab.session.selection = [at(0), at(3)];
    transactDoc(tab, (t) => mutateRemoveNodes(t, [at(0)]));
    expect(tab.session.selection).toEqual([at(3)]);
    disposeTab(tab);
  });

  test("an empty batch is a no-op", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateRemoveNodes(t, []));
    expect(texts(tab)).toEqual(["A", "B", "C", "D"]);
    disposeTab(tab);
  });
});

describe("mutateDuplicateNodes", () => {
  test("one path in is exactly mutateDuplicateNode — same document, same selection", () => {
    const batch = makeTab();
    transactDoc(batch, (t) => mutateDuplicateNodes(t, [at(1)]));

    const single = makeTab();
    transactDoc(single, (t) => mutateDuplicateNode(t, at(1)));

    expect(texts(batch)).toEqual(texts(single));
    expect(batch.session.selection).toEqual(single.session.selection);
    disposeTab(batch);
    disposeTab(single);
  });

  test("each clone lands directly after its own original", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateDuplicateNodes(t, [at(0), at(2)]));
    expect(texts(tab)).toEqual(["A", "A", "B", "C", "C", "D"]);
    disposeTab(tab);
  });

  test("the clones become the selection, in document order", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateDuplicateNodes(t, [at(0), at(2)]));
    expect(tab.session.selection).toEqual([at(1), at(4)]);
    disposeTab(tab);
  });

  test("a batch is ONE undo step", () => {
    const tab = makeTab();
    const before = tab.history.index;
    transactDoc(tab, (t) => mutateDuplicateNodes(t, [at(0), at(1), at(2)]));
    expect(texts(tab)).toHaveLength(7);
    expect(tab.history.index).toBe(before + 1);
    undo(tab);
    expect(texts(tab)).toEqual(["A", "B", "C", "D"]);
    disposeTab(tab);
  });

  test("a path that addresses nothing contributes no clone and no selection entry", () => {
    const tab = makeTab();
    tab.session.selection = [at(0)];
    transactDoc(tab, (t) => mutateDuplicateNodes(t, [["children", 9]]));
    expect(texts(tab)).toEqual(["A", "B", "C", "D"]);
    expect(tab.session.selection).toEqual([at(0)]);
    disposeTab(tab);
  });

  test("the document element cannot be duplicated, alone or in a batch", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateDuplicateNodes(t, [[]]));
    expect(texts(tab)).toEqual(["A", "B", "C", "D"]);
    disposeTab(tab);
  });
});

// ─── The mixed selection ─────────────────────────────────────────────────────

/**
 * A repeater between two paragraphs — the document behind the reproduction.
 *
 * `flattenTree` gives the array pseudo-element its own row AND its `map` template a row below it,
 * so `["children", 1, "map"]` is one ctrl-click away from any ordinary element. It is not a splice
 * coordinate: `parentElementPath` of it is `["children"]`, the children ARRAY, whose `.children` is
 * `undefined`.
 */
function makeRepeaterTab() {
  const document: JxMutableNode = {
    children: [
      { tagName: "p", textContent: "A" },
      {
        $prototype: "Array",
        $src: "#/state/items",
        map: { tagName: "p", textContent: "row" },
      } as unknown as JxMutableNode,
      { tagName: "p", textContent: "C" },
    ],
    tagName: "div",
  };
  return createTab({ document, id: "repeater" });
}

/** What each child IS, so a repeater reads as "Array" instead of an undefined textContent. */
function kinds(tab: ReturnType<typeof makeRepeaterTab>): string[] {
  return (tab.doc.document.children as JxMutableNode[]).map((c) =>
    c.$prototype === "Array" ? "Array" : String(c.textContent),
  );
}

const MAP_TEMPLATE = ["children", 1, "map"];

describe("a batch over rows that are not splice coordinates", () => {
  test("delete: the paragraph goes, the template is refused, and the edit is RECORDED", () => {
    const tab = makeRepeaterTab();
    tab.session.selection = [MAP_TEMPLATE, ["children", 2]];
    const before = tab.history.index;

    transactDoc(tab, (t) => mutateRemoveNodes(t, [MAP_TEMPLATE, ["children", 2]]));

    // Before the filter this threw out of the splice AFTER removing "C": the document lost a node,
    // Gained no history entry and stayed clean — unreachable by undo, invisible to Save.
    expect(kinds(tab)).toEqual(["A", "Array"]);
    expect(tab.history.index).toBe(before + 1);
    expect(tab.doc.dirty).toBe(true);
    undo(tab);
    expect(kinds(tab)).toEqual(["A", "Array", "C"]);
    disposeTab(tab);
  });

  test("duplicate: the same, with the clone selected and the template contributing none", () => {
    const tab = makeRepeaterTab();
    tab.session.selection = [MAP_TEMPLATE, ["children", 2]];
    const before = tab.history.index;

    transactDoc(tab, (t) => mutateDuplicateNodes(t, [MAP_TEMPLATE, ["children", 2]]));

    expect(kinds(tab)).toEqual(["A", "Array", "C", "C"]);
    expect(tab.session.selection).toEqual([["children", 3]]);
    expect(tab.history.index).toBe(before + 1);
    expect(tab.doc.dirty).toBe(true);
    undo(tab);
    expect(kinds(tab)).toEqual(["A", "Array", "C"]);
    disposeTab(tab);
  });

  test("a batch of nothing but unspliceable rows leaves the document alone", () => {
    const tab = makeRepeaterTab();
    transactDoc(tab, (t) => mutateRemoveNodes(t, [MAP_TEMPLATE, ["children", 1, "cases", "warn"]]));
    expect(kinds(tab)).toEqual(["A", "Array", "C"]);
    transactDoc(tab, (t) => mutateDuplicateNodes(t, [MAP_TEMPLATE]));
    expect(kinds(tab)).toEqual(["A", "Array", "C"]);
    disposeTab(tab);
  });

  test("the single mutators refuse the same rows, so no caller can reach the splice", () => {
    const tab = makeRepeaterTab();
    transactDoc(tab, (t) => mutateRemoveNode(t, MAP_TEMPLATE));
    transactDoc(tab, (t) => mutateDuplicateNode(t, MAP_TEMPLATE));
    expect(kinds(tab)).toEqual(["A", "Array", "C"]);
    disposeTab(tab);
  });
});

// ─── All of it, or none of it ────────────────────────────────────────────────

describe("transactDoc — a mutation that throws leaves nothing half-applied", () => {
  test("the ops that landed are rolled back, and the throw still reaches the caller", () => {
    const tab = makeTab();
    tab.session.selection = [at(0)];
    const before = tab.history.index;

    expect(() =>
      transactDoc(tab, (t) => {
        mutateRemoveNode(t, at(2));
        mutateRemoveNode(t, at(0));
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(texts(tab)).toEqual(["A", "B", "C", "D"]);
    expect(tab.history.index).toBe(before);
    expect(tab.doc.dirty).toBe(false);
    // The removals pruned the selection as they went; the rollback puts back what it was.
    expect(tab.session.selection).toEqual([at(0)]);
    disposeTab(tab);
  });

  test("a rolled-back document is still a live document — the next edit works normally", () => {
    const tab = makeTab();
    expect(() =>
      transactDoc(tab, (t) => {
        mutateRemoveNode(t, at(3));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    transactDoc(tab, (t) => mutateRemoveNode(t, at(3)));
    expect(texts(tab)).toEqual(["A", "B", "C"]);
    expect(tab.history.index).toBe(1);
    undo(tab);
    expect(texts(tab)).toEqual(["A", "B", "C", "D"]);
    disposeTab(tab);
  });

  test("frontmatter written before the throw is rolled back, dirty mark included", () => {
    const tab = makeTab();
    tab.doc.content.frontmatter.title = "Before";

    expect(() =>
      transactDoc(tab, (t) => {
        mutateUpdateFrontmatter(t, "title", "After");
        mutateUpdateFrontmatter(t, "draft", true);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(tab.doc.content.frontmatter.title).toBe("Before");
    // `mutateUpdateFrontmatter` writes the key only when it is not a delete, so the absent key
    // Must come back ABSENT rather than as an explicit undefined.
    expect(Object.hasOwn(tab.doc.content.frontmatter, "draft")).toBe(false);
    // The fm mutator marks the tab dirty itself, mid-transaction; the rollback restores it.
    expect(tab.doc.dirty).toBe(false);
    disposeTab(tab);
  });

  test("a tab already dirty stays dirty — the rollback restores, it does not clear", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateRemoveNode(t, at(3)));
    expect(tab.doc.dirty).toBe(true);
    expect(() =>
      transactDoc(tab, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(tab.doc.dirty).toBe(true);
    disposeTab(tab);
  });

  test("a falsy throw is still a failure", () => {
    const tab = makeTab();
    let threw = false;
    try {
      transactDoc(tab, (t) => {
        mutateRemoveNode(t, at(0));
        // Boxed, not tested for truthiness: "did it throw" must not become "was it interesting".
        // oxlint-disable-next-line no-throw-literal -- the empty string IS the case under test
        throw "";
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(texts(tab)).toEqual(["A", "B", "C", "D"]);
    expect(tab.history.index).toBe(0);
    expect(tab.doc.dirty).toBe(false);
    disposeTab(tab);
  });
});

// ─── The command path ────────────────────────────────────────────────────────

/**
 * `selection.delete` / `selection.duplicate` end to end, wired to the real mutators.
 *
 * Two halves of one answer. The records' `enablement` refuses a selection that contains a row no
 * splice can perform, so the user is never offered a Delete that can only do part of what they
 * asked; the batch filter under it is what keeps every OTHER caller — a script, the assistant, a
 * keyboard path built later — from reaching the throw.
 */
function commandTab(tab: ReturnType<typeof makeRepeaterTab>) {
  const registry = createCommandRegistry({
    getContext: () =>
      makeContext({
        // These verbs exist on a canvas; a context that does not say so is under-specified, and
        // Under-specification is what let them run over the project configuration document.
        editor: { kind: "canvas" },
        document: { open: true },
        selection: {
          count: tab.session.selection.length,
          paths: tab.session.selection.map((p) => [...p]),
        },
      }),
    mac: true,
  });
  registry.registerAll(
    defaultCommands({
      ...noopCommandDeps(),
      deleteSelection: () =>
        transactDoc(tab, (t) => mutateRemoveNodes(t, [...t.session.selection])),
      duplicateSelection: () =>
        transactDoc(tab, (t) => mutateDuplicateNodes(t, [...t.session.selection])),
    }),
  );
  return registry;
}

describe("selection.delete / selection.duplicate over a mixed selection", () => {
  test("both are visible and REFUSED, so the half-applied edit is never offered", () => {
    const tab = makeRepeaterTab();
    tab.session.selection = [MAP_TEMPLATE, ["children", 2]];
    const registry = commandTab(tab);

    for (const id of ["selection.delete", "selection.duplicate"]) {
      expect(registry.isVisible(id)).toBe(true);
      expect(registry.isEnabled(id)).toBe(false);
      expect(() => registry.run(id)).toThrow(CommandUnavailableError);
    }

    expect(kinds(tab)).toEqual(["A", "Array", "C"]);
    expect(tab.history.index).toBe(0);
    expect(tab.doc.dirty).toBe(false);
    disposeTab(tab);
  });

  test("the refusal says which selection it wants", () => {
    const tab = makeRepeaterTab();
    tab.session.selection = [MAP_TEMPLATE];
    const registry = commandTab(tab);
    expect(registry.disabledReason("selection.delete")).toBe(
      "an element selection that is not the document root",
    );
    expect(registry.disabledReason("selection.duplicate")).toBe(
      "an element that has a sibling position",
    );
    disposeTab(tab);
  });

  test("an all-spliceable multi-selection runs, in one history entry, and marks the tab dirty", () => {
    const tab = makeRepeaterTab();
    tab.session.selection = [
      ["children", 0],
      ["children", 2],
    ];
    const registry = commandTab(tab);

    expect(registry.isEnabled("selection.delete")).toBe(true);
    void registry.run("selection.delete");

    expect(kinds(tab)).toEqual(["Array"]);
    expect(tab.history.index).toBe(1);
    expect(tab.doc.dirty).toBe(true);
    undo(tab);
    expect(kinds(tab)).toEqual(["A", "Array", "C"]);
    disposeTab(tab);
  });

  test("duplicate over a multi-selection is one entry too", () => {
    const tab = makeRepeaterTab();
    tab.session.selection = [
      ["children", 0],
      ["children", 2],
    ];
    const registry = commandTab(tab);

    expect(registry.isEnabled("selection.duplicate")).toBe(true);
    void registry.run("selection.duplicate");

    expect(kinds(tab)).toEqual(["A", "A", "Array", "C", "C"]);
    expect(tab.history.index).toBe(1);
    expect(tab.doc.dirty).toBe(true);
    disposeTab(tab);
  });
});
