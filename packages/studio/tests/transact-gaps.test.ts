/**
 * The defensive and rarely-walked edges of `src/tabs/transact.ts`.
 *
 * The four sibling suites (`transact`, `transact-history`, `transact-batch`, `transact-patch`)
 * cover what an editing session does. What they do not reach is the other half of each guard: the
 * storage that refuses to answer, the history whose checkpoint is gone, the mutator handed a path
 * that no longer resolves, and the delete branch of every style writer — the branch that has to
 * leave `style` absent rather than present-and-empty, because an empty object still serialises.
 *
 * Nothing here reaches through the module's back door: every case is driven through the exported
 * mutators and `transactDoc`, so a refactor that keeps the contract keeps these passing.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { toRaw } from "../src/reactivity";
import { jsonClone } from "../src/utils/studio-utils";
import { createTab, disposeTab } from "../src/tabs/tab";
import {
  beginBatch,
  endBatch,
  mutateAddSwitchCase,
  mutateDuplicateNodes,
  mutateInsertNode,
  mutateMoveNode,
  mutateRenameDef,
  mutateReplaceStyle,
  mutateUpdateDef,
  mutateUpdateMedia,
  mutateUpdateMediaNestedStyle,
  mutateUpdateMediaNestedStylePath,
  mutateUpdateMediaStyle,
  mutateUpdateNestedStyle,
  mutateUpdateNestedStylePath,
  mutateUpdateProperty,
  mutateUpdateStyle,
  mutateWrapNode,
  redo,
  transactDoc,
  undo,
} from "../src/tabs/transact";

import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";

let seq = 0;

function makeTab(doc?: JxMutableNode): Tab {
  seq += 1;
  const document = doc ?? {
    children: [{ tagName: "p", textContent: "Hello" }],
    tagName: "div",
  };
  return createTab({ document, id: `transact-gaps-${seq}` });
}

/** The document, raw — every assertion below is about what would be serialised. */
function raw(tab: Tab): JxMutableNode {
  return jsonClone(toRaw(tab.doc.document)) as JxMutableNode;
}

/** The first child, raw. */
function child(tab: Tab): Record<string, unknown> {
  const kids = raw(tab).children as JxMutableNode[];
  return kids[0] as unknown as Record<string, unknown>;
}

function docJson(tab: Tab): string {
  return JSON.stringify(jsonClone(toRaw(tab.doc.document)));
}

/**
 * Run `body` with every `localStorage` access throwing, the way a browser does when site data is
 * blocked. The property is restored even if the body throws.
 */
function withDeniedStorage<T>(body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage denied");
    },
  });
  try {
    return body();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  }
}

// ─── Storage that refuses to answer ──────────────────────────────────────────

describe("history when localStorage is unreadable", () => {
  /* Both flags this module reads — `jx-legacy-history` and `jx-canvas-debug` — are opt-INS, so a
     storage that throws must be read as "flag absent", not as a reason to fail the edit. A browser
     with site data blocked throws on the property itself, before `getItem` is ever called. */
  test("an edit still records ops when the opt-out flag cannot be read", () => {
    const tab = makeTab();

    withDeniedStorage(() => {
      transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
    });

    // Patch history stayed ON: the entry carries replayable ops rather than a full snapshot.
    const entry = tab.history.snapshots[1]!;
    expect(entry.forwardOps).not.toBeNull();
    expect(entry.inverseOps).not.toBeNull();
    expect(entry.document).toBeNull();
    disposeTab(tab);
  });

  test("undo completes when the debug-assert flag cannot be read", () => {
    const tab = makeTab();
    const before = docJson(tab);
    transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));

    withDeniedStorage(() => {
      expect(() => {
        undo(tab);
      }).not.toThrow();
    });

    expect(docJson(tab)).toBe(before);
    expect(tab.history.index).toBe(0);
    disposeTab(tab);
  });
});

// ─── Coalescing into a checkpoint entry ──────────────────────────────────────

describe("coalescing a run that began on a checkpoint", () => {
  /*
   * Every 20th entry stores a full document as well as its ops. Folding a later commit into one of
   * those has to advance the STORED DOCUMENT too — the checkpoint is what every replay after it
   * starts from, so a stale one silently rewrites history for each subsequent undo.
   */
  test("the stored document advances with the run, not just the ops", () => {
    const tab = makeTab();
    // 19 ordinary edits, so the 20th push is the one that lands on the checkpoint interval.
    for (let i = 0; i < 19; i++) {
      transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "id", `n${i}`));
    }
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "first"), {
      coalesceKey: "run",
    });

    const checkpoint = tab.history.snapshots.at(-1)!;
    expect(checkpoint.document).not.toBeNull();
    expect(tab.history.snapshots).toHaveLength(21);

    // The second commit of the same run folds into that checkpoint rather than pushing an entry.
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "second"), {
      coalesceKey: "run",
    });

    expect(tab.history.snapshots).toHaveLength(21);
    const folded = tab.history.snapshots.at(-1)!;
    const stored = jsonClone(toRaw(folded.document)) as JxMutableNode;
    expect((stored.children as JxMutableNode[])[0]!.textContent).toBe("second");

    // And the run is still ONE undoable step, back to the state before it began.
    undo(tab);
    expect(child(tab).textContent).toBe("Hello");
    disposeTab(tab);
  });
});

// ─── A history whose base checkpoint is gone ─────────────────────────────────

describe("replay with no checkpoint to start from", () => {
  /* Every entry holds either a document or forward ops, so this is unreachable in a session — it
     is the assertion that says so. A silent wrong answer here would be a document rebuilt from the
     wrong base, which is far worse than a throw. */
  test("materializing a state with no snapshot at or before it throws by name", () => {
    const tab = makeTab();
    tab.history.snapshots = [
      { coalesceKey: null, document: null, selection: [], selectionBefore: [] },
      { coalesceKey: null, document: null, selection: [], selectionBefore: [] },
    ];
    tab.history.index = 1;

    expect(() => {
      undo(tab);
    }).toThrow("history-missing-checkpoint");
    disposeTab(tab);
  });
});

// ─── The batch's own history cap ─────────────────────────────────────────────

describe("endBatch at the history limit", () => {
  /* `pushHistoryEntry` has its own trim, and this is the second one: a batch closes by pushing a
     snapshot directly, so the cap has to hold on that path too or a long session grows unbounded. */
  test("closing a batch on a full history drops the oldest entry instead of growing", () => {
    const tab = makeTab();
    // 99 edits + the initial snapshot = HISTORY_LIMIT entries.
    for (let i = 0; i < 99; i++) {
      transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "id", `n${i}`));
    }
    expect(tab.history.snapshots).toHaveLength(100);

    beginBatch(tab);
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "id", "batched"));
    endBatch();

    expect(tab.history.snapshots).toHaveLength(100);
    expect(tab.history.index).toBe(99);
    // The entry that survived is the batch's, and it is a full snapshot.
    const last = tab.history.snapshots.at(-1)!;
    const stored = jsonClone(toRaw(last.document)) as JxMutableNode;
    expect((stored.children as JxMutableNode[])[0]!.id).toBe("batched");
    disposeTab(tab);
  });
});

// ─── Legacy (snapshot-per-edit) redo ─────────────────────────────────────────

describe("redo with patch history opted out", () => {
  /* The `jx-legacy-history` escape hatch stores a document per edit and no ops, so redo cannot
     replay — it has to restore. Undo's snapshot path is exercised elsewhere; redo's was not. */
  test("redo restores the stored state when the entry carries no forward ops", () => {
    localStorage.setItem("jx-legacy-history", "1");
    try {
      const tab = makeTab();
      const before = docJson(tab);
      transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
      const after = docJson(tab);
      expect(tab.history.snapshots[1]!.forwardOps).toBeNull();

      undo(tab);
      expect(docJson(tab)).toBe(before);
      redo(tab);

      expect(docJson(tab)).toBe(after);
      expect(tab.history.index).toBe(1);
      expect(tab.doc.dirty).toBe(true);
      disposeTab(tab);
    } finally {
      localStorage.removeItem("jx-legacy-history");
    }
  });
});

// ─── Mutators handed a path that does not resolve ────────────────────────────

describe("a stale path changes nothing", () => {
  /* Deletions arrive from collaborators and from the author's own undo while a panel is open, so a
     path that no longer resolves is an ordinary state of the document, not a programming error. */
  test("mutateInsertNode returns when the parent is gone", () => {
    const tab = makeTab();
    const before = docJson(tab);

    expect(() => {
      transactDoc(tab, (t) => mutateInsertNode(t, ["children", 9], 0, { tagName: "span" }));
    }).not.toThrow();

    expect(docJson(tab)).toBe(before);
    disposeTab(tab);
  });

  test("mutateWrapNode returns on a path that cannot be spliced", () => {
    const tab = makeTab();
    const before = docJson(tab);

    // The root has no parent to splice a wrapper into.
    transactDoc(tab, (t) => mutateWrapNode(t, [], "section"));

    expect(docJson(tab)).toBe(before);
    disposeTab(tab);
  });

  test("mutateWrapNode returns when the node at a spliceable path is gone", () => {
    const tab = makeTab();
    const before = docJson(tab);

    transactDoc(tab, (t) => mutateWrapNode(t, ["children", 9], "section"));

    expect(docJson(tab)).toBe(before);
    disposeTab(tab);
  });
});

// ─── Duplicating a multi-selection inside a nested container ─────────────────

describe("mutateDuplicateNodes on nested siblings", () => {
  /* The batch runs LAST-first so the originals' coordinates stay valid, but that does not protect
     the clones already made: each new insertion sits before them and moves every one of their
     indices up by one. Translating them is the difference between "the copies are selected" and
     "two of the originals are" — and the translation only does anything when the shared parent is
     itself nested, which is the case the root-level batches never produce. */
  test("each clone lands after its own original and the clones are what stays selected", () => {
    const tab = makeTab({
      children: [
        {
          children: [
            { tagName: "em", textContent: "a" },
            { tagName: "em", textContent: "b" },
            { tagName: "em", textContent: "c" },
          ],
          tagName: "section",
        },
      ],
      tagName: "div",
    });

    transactDoc(tab, (t) =>
      mutateDuplicateNodes(t, [
        ["children", 0, "children", 0],
        ["children", 0, "children", 2],
      ]),
    );

    const section = (raw(tab).children as JxMutableNode[])[0]!;
    expect((section.children as JxMutableNode[]).map((n) => n.textContent)).toEqual([
      "a",
      "a",
      "b",
      "c",
      "c",
    ]);
    // Index 1 is the clone of "a"; index 4 is the clone of "c" AFTER "a"'s insertion pushed it up.
    expect(tab.session.selection).toEqual([
      ["children", 0, "children", 1],
      ["children", 0, "children", 4],
    ]);
    disposeTab(tab);
  });
});

// ─── Reordering inside a nested container ────────────────────────────────────

describe("mutateMoveNode reordering within one nested parent", () => {
  /* The selection follows the node it is on, and a forward move inside the SAME parent lands one
     index lower than asked: the splice that removed the node renumbered everything after it. The
     same-parent test is `fromParentPath` equalling `toParentPath` element by element, which only
     runs when both are non-empty — every other move test here crosses between a nested parent and
     the root, where the length check answers first. */
  test("a forward move keeps the selection on the moved node", () => {
    const tab = makeTab({
      children: [
        {
          children: [
            { tagName: "em", textContent: "a" },
            { tagName: "em", textContent: "b" },
            { tagName: "em", textContent: "c" },
          ],
          tagName: "section",
        },
      ],
      tagName: "div",
    });
    tab.session.selection = [["children", 0, "children", 0]];

    transactDoc(tab, (t) => mutateMoveNode(t, ["children", 0, "children", 0], ["children", 0], 2));

    const section = (raw(tab).children as JxMutableNode[])[0]!;
    const text = (section.children as JxMutableNode[]).map((n) => n.textContent);
    expect(text).toEqual(["b", "a", "c"]);
    // Index 1, not the 2 that was asked for — "a" left the array before it was re-inserted.
    expect(tab.session.selection).toEqual([["children", 0, "children", 1]]);
    disposeTab(tab);
  });

  test("a backward move needs no adjustment", () => {
    const tab = makeTab({
      children: [
        {
          children: [
            { tagName: "em", textContent: "a" },
            { tagName: "em", textContent: "b" },
            { tagName: "em", textContent: "c" },
          ],
          tagName: "section",
        },
      ],
      tagName: "div",
    });
    tab.session.selection = [["children", 0, "children", 2]];

    transactDoc(tab, (t) => mutateMoveNode(t, ["children", 0, "children", 2], ["children", 0], 0));

    const section = (raw(tab).children as JxMutableNode[])[0]!;
    expect((section.children as JxMutableNode[]).map((n) => n.textContent)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(tab.session.selection).toEqual([["children", 0, "children", 0]]);
    disposeTab(tab);
  });
});

// ─── mutateUpdateProperty's style key ────────────────────────────────────────

describe("mutateUpdateProperty writing the style key", () => {
  /* `style` is a property like any other to the writer, but the canvas patch it emits is not: a
     `set-prop` would repaint the attribute instead of restyling the node. */
  test("writes the object and survives a round trip", () => {
    const tab = makeTab();

    transactDoc(tab, (t) =>
      mutateUpdateProperty(t, ["children", 0], "style", { color: "red" } as never),
    );
    expect(child(tab).style).toEqual({ color: "red" });

    undo(tab);
    expect(child(tab).style).toBeUndefined();
    redo(tab);
    expect(child(tab).style).toEqual({ color: "red" });
    disposeTab(tab);
  });
});

// ─── Every style writer's delete branch ends with `style` ABSENT ─────────────

describe("removing the last declaration leaves no empty style object", () => {
  /* An empty `style: {}` still serialises, so it shows up in the file, in a diff, and in every
     equality check the collab layer makes. Each writer has to delete the key, not empty it. */
  test("mutateUpdateMediaStyle drops the media block and then the style", () => {
    const tab = makeTab({
      children: [{ style: { "@sm": { color: "red" } }, tagName: "p", textContent: "Hi" }],
      tagName: "div",
    });

    transactDoc(tab, (t) => mutateUpdateMediaStyle(t, ["children", 0], "sm", "color", ""));

    expect(child(tab).style).toBeUndefined();
    undo(tab);
    expect(child(tab).style).toEqual({ "@sm": { color: "red" } });
    disposeTab(tab);
  });

  test("mutateReplaceStyle with no style deletes the key", () => {
    const tab = makeTab({
      children: [{ style: { color: "red" }, tagName: "p", textContent: "Hi" }],
      tagName: "div",
    });

    // Required parameter, so the "no style" case is a binding rather than a bare literal.
    const absent: JxStyle | undefined = undefined;
    transactDoc(tab, (t) => mutateReplaceStyle(t, ["children", 0], absent));
    expect(child(tab).style).toBeUndefined();

    // An empty object is the same request, and gets the same answer.
    undo(tab);
    transactDoc(tab, (t) => mutateReplaceStyle(t, ["children", 0], {}));
    expect(child(tab).style).toBeUndefined();
    disposeTab(tab);
  });
});

// ─── Style writers reached first on a node with no style at all ─────────────

describe("the nested style writers create the style object they need", () => {
  test("mutateUpdateNestedStyle writes a selector block", () => {
    const tab = makeTab();

    transactDoc(tab, (t) => mutateUpdateNestedStyle(t, ["children", 0], "&:hover", "color", "red"));

    expect(child(tab).style).toEqual({ "&:hover": { color: "red" } });
    undo(tab);
    expect(child(tab).style).toBeUndefined();
    disposeTab(tab);
  });

  test("mutateUpdateMediaNestedStyle writes a selector block inside a media block", () => {
    const tab = makeTab();

    transactDoc(tab, (t) =>
      mutateUpdateMediaNestedStyle(t, ["children", 0], "sm", "&:hover", "color", "red"),
    );

    expect(child(tab).style).toEqual({ "@sm": { "&:hover": { color: "red" } } });
    undo(tab);
    expect(child(tab).style).toBeUndefined();
    disposeTab(tab);
  });

  test("mutateUpdateNestedStylePath writes down a path of segments", () => {
    const tab = makeTab();

    transactDoc(tab, (t) =>
      mutateUpdateNestedStylePath(t, ["children", 0], ["table", "th"], "color", "red"),
    );

    expect(child(tab).style).toEqual({ table: { th: { color: "red" } } });
    disposeTab(tab);
  });

  test("mutateUpdateMediaNestedStylePath writes a path inside a media block", () => {
    const tab = makeTab();

    transactDoc(tab, (t) =>
      mutateUpdateMediaNestedStylePath(t, ["children", 0], "sm", ["table", "th"], "color", "red"),
    );

    expect(child(tab).style).toEqual({ "@sm": { table: { th: { color: "red" } } } });
    undo(tab);
    expect(child(tab).style).toBeUndefined();
    disposeTab(tab);
  });
});

// ─── The nested cleanup walk stops at the first EMPTY parent, not the first ──

describe("mutateUpdateMediaNestedStylePath cleaning up after a delete", () => {
  /* The walk descends while each parent still has other declarations, and deletes the first one
     that is left empty. A sibling under the same segment is what keeps it descending — pruning at
     the first level instead would take that sibling out with it. */
  test("a segment with a surviving sibling is descended through, not deleted", () => {
    const tab = makeTab({
      children: [
        {
          style: {
            "@sm": { table: { td: { color: "blue" }, th: { color: "red" } } },
          },
          tagName: "p",
          textContent: "Hi",
        },
      ],
      tagName: "div",
    });

    transactDoc(tab, (t) =>
      mutateUpdateMediaNestedStylePath(t, ["children", 0], "sm", ["table", "th"], "color", ""),
    );

    // `th` emptied and went; `table` survived because `td` is still under it.
    expect(child(tab).style).toEqual({ "@sm": { table: { td: { color: "blue" } } } });
    disposeTab(tab);
  });

  test("emptying the deepest level takes every level it emptied with it", () => {
    const tab = makeTab({
      children: [
        { style: { "@sm": { table: { th: { color: "red" } } } }, tagName: "p", textContent: "Hi" },
      ],
      tagName: "div",
    });

    transactDoc(tab, (t) =>
      mutateUpdateMediaNestedStylePath(t, ["children", 0], "sm", ["table", "th"], "color", ""),
    );

    // `th`, then `table`, then the media block, then `style` — nothing empty is left behind.
    expect(child(tab).style).toBeUndefined();
    undo(tab);
    expect(child(tab).style).toEqual({ "@sm": { table: { th: { color: "red" } } } });
    disposeTab(tab);
  });

  test("writing then deleting a path a node never had leaves it with no style", () => {
    /* `ensureNestedStyle` creates the intermediates on the way in, so a write-then-delete round
       trip is the shortest route to a style the author never asked for. */
    const tab = makeTab();

    transactDoc(tab, (t) =>
      mutateUpdateMediaNestedStylePath(t, ["children", 0], "sm", ["table", "th"], "color", "red"),
    );
    transactDoc(tab, (t) =>
      mutateUpdateMediaNestedStylePath(t, ["children", 0], "sm", ["table", "th"], "color", ""),
    );

    expect(child(tab).style).toBeUndefined();
    disposeTab(tab);
  });

  test("the same walk, without a media block", () => {
    // `mutateUpdateNestedStylePath` carried the identical loop and the identical defect.
    const tab = makeTab({
      children: [{ style: { table: { th: { color: "red" } } }, tagName: "p", textContent: "Hi" }],
      tagName: "div",
    });

    transactDoc(tab, (t) =>
      mutateUpdateNestedStylePath(t, ["children", 0], ["table", "th"], "color", ""),
    );

    expect(child(tab).style).toBeUndefined();
    disposeTab(tab);
  });

  test("a level with a surviving sibling stops the ascent", () => {
    /* The prune walks up only as far as the emptying goes: `th` empties and goes, `table` still
       holds `td`, so it stays and so does everything above it. */
    const tab = makeTab({
      children: [
        {
          style: { table: { td: { color: "blue" }, th: { color: "red" } } },
          tagName: "p",
          textContent: "Hi",
        },
      ],
      tagName: "div",
    });

    transactDoc(tab, (t) =>
      mutateUpdateNestedStylePath(t, ["children", 0], ["table", "th"], "color", ""),
    );

    expect(child(tab).style).toEqual({ table: { td: { color: "blue" } } });
    disposeTab(tab);
  });

  test("a scalar declaration sharing a segment name is never pruned", () => {
    /* The prune deletes empty NESTED blocks. A scalar under the same key is a declaration, and
       `getNestedStyle` refusing it is what keeps it out of the walk. */
    const tab = makeTab({
      children: [{ style: { color: "red", table: { th: { size: "1px" } } }, tagName: "p" }],
      tagName: "div",
    });

    transactDoc(tab, (t) =>
      mutateUpdateNestedStylePath(t, ["children", 0], ["table", "th"], "size", ""),
    );

    expect(child(tab).style).toEqual({ color: "red" });
    disposeTab(tab);
  });

  test("a single-segment path does end with the style absent", () => {
    const tab = makeTab({
      children: [
        { style: { "@sm": { table: { color: "red" } } }, tagName: "p", textContent: "Hi" },
      ],
      tagName: "div",
    });

    transactDoc(tab, (t) =>
      mutateUpdateMediaNestedStylePath(t, ["children", 0], "sm", ["table"], "color", ""),
    );

    expect(child(tab).style).toBeUndefined();
    disposeTab(tab);
  });
});

// ─── Document-level defs and media ───────────────────────────────────────────

describe("document-level writers on a document that has none yet", () => {
  test("mutateUpdateDef creates the state object", () => {
    const tab = makeTab();

    transactDoc(tab, (t) => mutateUpdateDef(t, "count", { value: 1 }));

    expect(raw(tab).state).toMatchObject({ count: { value: 1 } });
    undo(tab);
    expect(raw(tab).state).toBeUndefined();
    disposeTab(tab);
  });

  test("mutateAddSwitchCase creates the cases object", () => {
    const tab = makeTab({
      children: [{ $switch: "${mode}", tagName: "div" }],
      tagName: "div",
    });

    transactDoc(tab, (t) => mutateAddSwitchCase(t, ["children", 0], "empty"));

    expect(child(tab).cases).toEqual({ empty: { tagName: "div", textContent: "empty" } });
    undo(tab);
    expect(child(tab).cases).toBeUndefined();
    disposeTab(tab);
  });

  test("mutateRenameDef on a name that is not there changes nothing", () => {
    const tab = makeTab();
    const before = docJson(tab);

    transactDoc(tab, (t) => mutateRenameDef(t, "missing", "renamed"));

    expect(docJson(tab)).toBe(before);
    disposeTab(tab);
  });
});

describe("mutateUpdateMedia removing a query", () => {
  /* Same rule as the style writers: the last removal has to leave `$media` absent rather than an
     empty object, because the document is compared and serialised as it stands. */
  test("dropping the only query removes $media entirely", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateUpdateMedia(t, "sm", "(min-width: 40rem)"));

    transactDoc(tab, (t) => mutateUpdateMedia(t, "sm"));

    expect(raw(tab).$media).toBeUndefined();
    undo(tab);
    expect(raw(tab).$media).toEqual({
      sm: "(min-width: 40rem)",
    });
    disposeTab(tab);
  });

  test("dropping one of several leaves the rest", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateUpdateMedia(t, "sm", "(min-width: 40rem)"));
    transactDoc(tab, (t) => mutateUpdateMedia(t, "lg", "(min-width: 64rem)"));

    transactDoc(tab, (t) => mutateUpdateMedia(t, "sm", ""));

    expect(raw(tab).$media).toEqual({
      lg: "(min-width: 64rem)",
    });
    disposeTab(tab);
  });
});
