/**
 * Patch-based history: forward/inverse doc-op replay, checkpoints, and undo/redo equivalence. The
 * core invariant — undoing everything reproduces the initial document exactly, redoing everything
 * reproduces the final document — is exercised over randomized op sequences.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { toRaw } from "../src/reactivity";
import { jsonClone } from "../src/utils/studio-utils";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import {
  mutateDuplicateNode,
  mutateInsertNode,
  mutateMoveNode,
  mutateRemoveNode,
  mutateUpdateAttribute,
  mutateUpdateProperty,
  mutateUpdateStyle,
  mutateWrapNode,
  redo,
  transactDoc,
  undo,
} from "../src/tabs/transact";

import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";

let tabCount = 0;

function makeTab(): Tab {
  tabCount += 1;
  return openTab({
    document: {
      children: [
        { style: { color: "red" }, tagName: "p", textContent: "one" },
        { tagName: "span", textContent: "two" },
        { children: [{ tagName: "em", textContent: "deep" }], tagName: "div" },
      ],
      tagName: "div",
    },
    id: `history-test-${tabCount}`,
  }) as Tab;
}

function docJson(tab: Tab): string {
  return JSON.stringify(jsonClone(toRaw(tab.doc.document)));
}

afterEach(() => {
  closeAllTabs();
});

describe("patch-based history entries", () => {
  test("simple edits store ops instead of document snapshots", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
    const [, entry] = tab.history.snapshots;
    expect(entry.document).toBeNull();
    expect(entry.forwardOps).toHaveLength(1);
    expect(entry.inverseOps).toHaveLength(1);
  });

  test("un-instrumented transactions store a full snapshot", () => {
    const tab = makeTab();
    transactDoc(tab, (t) => {
      (t.doc.document as Record<string, unknown>).className = "custom";
    });
    const [, entry] = tab.history.snapshots;
    expect(entry.document).not.toBeNull();
    expect(entry.forwardOps).toBeNull();
  });

  test("undo/redo round-trips a style edit surgically", () => {
    const tab = makeTab();
    const before = docJson(tab);
    transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
    const after = docJson(tab);

    undo(tab);
    expect(docJson(tab)).toBe(before);
    expect(tab.history.index).toBe(0);
    redo(tab);
    expect(docJson(tab)).toBe(after);
    expect(tab.history.index).toBe(1);
  });

  test("undo of a compound transaction reverses ops in reverse order", () => {
    const tab = makeTab();
    const before = docJson(tab);
    transactDoc(tab, (t) => {
      mutateUpdateProperty(t, ["children", 0], "textContent", "edited");
      mutateInsertNode(t, [], 1, { tagName: "h1", textContent: "title" });
      mutateRemoveNode(t, ["children", 2]);
    });
    const after = docJson(tab);

    undo(tab);
    expect(docJson(tab)).toBe(before);
    redo(tab);
    expect(docJson(tab)).toBe(after);
  });

  test("undo of a move into a later sibling container (prefix-interacting paths)", () => {
    const tab = makeTab();
    const before = docJson(tab);
    // Move p (root index 0) into the div, whose path shifts from ["children",2] to
    // ["children",1] once p is removed — the inverse op must use post-move coordinates.
    transactDoc(tab, (t) => mutateMoveNode(t, ["children", 0], ["children", 2], 0));
    const after = docJson(tab);

    undo(tab);
    expect(docJson(tab)).toBe(before);
    redo(tab);
    expect(docJson(tab)).toBe(after);
  });

  test("undo of a move out of a nested container to an earlier root index", () => {
    const tab = makeTab();
    const before = docJson(tab);
    // Move em out of the div to root index 0 — the div's own path shifts +1 on insertion.
    transactDoc(tab, (t) => mutateMoveNode(t, ["children", 2, "children", 0], [], 0));
    const after = docJson(tab);

    undo(tab);
    expect(docJson(tab)).toBe(before);
    redo(tab);
    expect(docJson(tab)).toBe(after);
  });

  test("legacy flag forces snapshot-per-edit", () => {
    localStorage.setItem("jx-legacy-history", "1");
    try {
      const tab = makeTab();
      const before = docJson(tab);
      transactDoc(tab, (t) => mutateUpdateStyle(t, ["children", 0], "color", "blue"));
      expect(tab.history.snapshots[1].document).not.toBeNull();
      undo(tab);
      expect(docJson(tab)).toBe(before);
    } finally {
      localStorage.removeItem("jx-legacy-history");
    }
  });
});

describe("randomized undo/redo equivalence", () => {
  // Deterministic Park–Miller PRNG so failures are reproducible
  function prng(seed: number) {
    let a = seed % 2_147_483_647 || 1;
    return () => {
      a = (a * 16_807) % 2_147_483_647;
      return a / 2_147_483_647;
    };
  }

  function randomEdit(tab: Tab, rand: () => number) {
    const doc = toRaw(tab.doc.document) as JxMutableNode;
    const children = doc.children as JxMutableNode[];
    const n = children.length;
    const pick = Math.floor(rand() * 7);
    switch (pick) {
      case 0: {
        const i = Math.floor(rand() * (n + 1));
        transactDoc(tab, (t) =>
          mutateInsertNode(t, [], i, { tagName: "p", textContent: `n${Math.floor(rand() * 100)}` }),
        );
        return;
      }
      case 1: {
        if (n <= 1) {
          return;
        }
        const i = Math.floor(rand() * n);
        transactDoc(tab, (t) => mutateRemoveNode(t, ["children", i]));
        return;
      }
      case 2: {
        if (n === 0) {
          return;
        }
        const from = Math.floor(rand() * n);
        const to = Math.floor(rand() * (n + 1));
        transactDoc(tab, (t) => mutateMoveNode(t, ["children", from], [], to));
        return;
      }
      case 3: {
        if (n === 0) {
          return;
        }
        const i = Math.floor(rand() * n);
        transactDoc(tab, (t) =>
          mutateUpdateStyle(t, ["children", i], "margin", `${Math.floor(rand() * 40)}px`),
        );
        return;
      }
      case 4: {
        if (n === 0) {
          return;
        }
        const i = Math.floor(rand() * n);
        transactDoc(tab, (t) =>
          mutateUpdateProperty(t, ["children", i], "textContent", `t${Math.floor(rand() * 100)}`),
        );
        return;
      }
      case 5: {
        if (n === 0) {
          return;
        }
        const i = Math.floor(rand() * n);
        transactDoc(tab, (t) => mutateDuplicateNode(t, ["children", i]));
        return;
      }
      default: {
        if (n === 0) {
          return;
        }
        const i = Math.floor(rand() * n);
        if (rand() < 0.5) {
          transactDoc(tab, (t) => mutateWrapNode(t, ["children", i], "section"));
        } else {
          transactDoc(tab, (t) =>
            mutateUpdateAttribute(t, ["children", i], "title", `a${Math.floor(rand() * 100)}`),
          );
        }
      }
    }
  }

  for (const seed of [1, 42, 1337]) {
    test(`seed ${seed}: undo-all equals initial, redo-all equals final (40 edits, spans checkpoints)`, () => {
      const tab = makeTab();
      const rand = prng(seed);
      const states = [docJson(tab)];

      for (let i = 0; i < 40; i++) {
        randomEdit(tab, rand);
        // Guarded edits may not have produced a transaction — only record real history entries
        if (tab.history.index === states.length) {
          states.push(docJson(tab));
        }
      }
      expect(tab.history.index).toBe(tab.history.snapshots.length - 1);
      expect(states.length).toBe(tab.history.snapshots.length);

      // Walk all the way back, checking every intermediate state
      for (let i = tab.history.index; i > 0; i--) {
        undo(tab);
        expect(docJson(tab)).toBe(states[i - 1]);
      }
      expect(tab.history.index).toBe(0);

      // And all the way forward again
      for (let i = 1; i < tab.history.snapshots.length; i++) {
        redo(tab);
        expect(docJson(tab)).toBe(states[i]);
      }
    });
  }

  test("history truncation past the limit keeps states recoverable", () => {
    const tab = makeTab();
    const rand = prng(7);
    for (let i = 0; i < 120; i++) {
      randomEdit(tab, rand);
    }
    expect(tab.history.snapshots.length).toBeLessThanOrEqual(100);
    const finalState = docJson(tab);

    while (tab.history.index > 0) {
      undo(tab);
    }
    while (tab.history.index < tab.history.snapshots.length - 1) {
      redo(tab);
    }
    expect(docJson(tab)).toBe(finalState);
  });
});
