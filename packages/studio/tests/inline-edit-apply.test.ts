/**
 * Inline-edit apply logic — the serializable commit/split/insert results turned into transactDoc
 * mutations. Shared by the legacy in-realm editor and the iframe host, so tested directly against a
 * workspace doc.
 */
import { resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyBlockMerge,
  applyInlineCommit,
  applyInlineInsert,
  applyInlinePropCommit,
  applyInlineSplit,
  isEmptyContent,
} from "../src/editor/inline-edit-apply";
import { undo } from "../src/tabs/transact";
import type { SlashCommand } from "../src/editor/inline-edit";
import type { Tab } from "../src/tabs/tab";

let tab: Tab;
const freshDoc = () => ({ children: [{ tagName: "p", textContent: "Hello" }], tagName: "div" });
const kids = () => tab.doc.document.children as Record<string, unknown>[];

beforeEach(() => {
  resetStudioState();
  tab = resetWorkspaceWithTab(freshDoc());
});

describe("isEmptyContent", () => {
  test("treats blank text / empty or whitespace children / a lone <br> as empty", () => {
    expect(isEmptyContent()).toBe(true);
    expect(isEmptyContent({ textContent: "   " })).toBe(true);
    expect(isEmptyContent({ children: [] })).toBe(true);
    expect(isEmptyContent({ children: ["  "] })).toBe(true);
    expect(isEmptyContent({ children: [{ tagName: "br" }] })).toBe(true);
  });

  test("treats real content as non-empty", () => {
    expect(isEmptyContent({ textContent: "x" })).toBe(false);
    expect(isEmptyContent({ children: ["a", "b"] })).toBe(false);
    expect(isEmptyContent({ children: [{ tagName: "strong", textContent: "b" }] })).toBe(false);
  });
});

describe("applyInlineCommit", () => {
  test("commits plain textContent (clearing children)", () => {
    applyInlineCommit(tab, ["children", 0], null, "Updated");
    expect(kids()[0]!.textContent).toBe("Updated");
    expect(kids()[0]!.children).toBeUndefined();
  });

  test("commits rich children (clearing textContent)", () => {
    const rich = ["a ", { tagName: "strong", textContent: "b" }];
    applyInlineCommit(tab, ["children", 0], rich, null);
    expect(kids()[0]!.children).toEqual(rich);
    expect(kids()[0]!.textContent).toBeUndefined();
  });

  test("is a no-op when the text is unchanged", () => {
    applyInlineCommit(tab, ["children", 0], null, "Hello");
    expect(kids()[0]!.textContent).toBe("Hello");
  });
});

describe("applyBlockMerge", () => {
  /** Two plain paragraphs, plus a list whose single item follows them. */
  const twoParas = () => ({
    children: [
      { tagName: "p", textContent: "First" },
      { tagName: "p", textContent: "Second" },
    ],
    tagName: "div",
  });

  test("joins the second block onto the first and returns the seam", () => {
    tab = resetWorkspaceWithTab(twoParas());
    const seam = applyBlockMerge(tab, ["children", 1], ["children", 0]);

    expect(kids()).toHaveLength(1);
    expect(kids()[0]!.textContent).toBe("FirstSecond");
    // The caret belongs where the two blocks met — not at the end of the joined text.
    expect(seam).toEqual({ offset: 5, path: ["children", 0] });
  });

  test("merging an EMPTY block just removes it, leaving the caret at the previous end", () => {
    tab = resetWorkspaceWithTab({
      children: [
        { tagName: "p", textContent: "Kept" },
        { tagName: "p", textContent: "" },
      ],
      tagName: "div",
    });
    const seam = applyBlockMerge(tab, ["children", 1], ["children", 0]);
    expect(kids()).toHaveLength(1);
    expect(kids()[0]!.textContent).toBe("Kept");
    expect(seam).toEqual({ offset: 4, path: ["children", 0] });
  });

  test("merging INTO an empty block keeps the survivor's tag", () => {
    // Backspace at the start of a paragraph that follows an empty heading: the heading survives.
    tab = resetWorkspaceWithTab({
      children: [
        { tagName: "h2", textContent: "" },
        { tagName: "p", textContent: "Body" },
      ],
      tagName: "div",
    });
    const seam = applyBlockMerge(tab, ["children", 1], ["children", 0]);
    expect(kids()).toHaveLength(1);
    expect(kids()[0]).toMatchObject({ tagName: "h2", textContent: "Body" });
    expect(seam).toEqual({ offset: 0, path: ["children", 0] });
  });

  test("concatenates rich children, preserving inline markup from both sides", () => {
    tab = resetWorkspaceWithTab({
      children: [
        { children: ["a ", { tagName: "strong", textContent: "bold" }], tagName: "p" },
        { children: [{ tagName: "em", textContent: "it" }, " c"], tagName: "p" },
      ],
      tagName: "div",
    });
    const seam = applyBlockMerge(tab, ["children", 1], ["children", 0]);
    expect(kids()).toHaveLength(1);
    expect(kids()[0]!.children).toEqual([
      "a ",
      { tagName: "strong", textContent: "bold" },
      { tagName: "em", textContent: "it" },
      " c",
    ]);
    // The seam is the rendered length of the FIRST block: "a " + "bold".
    expect(seam).toEqual({ offset: 6, path: ["children", 0] });
  });

  test("a plain block merging a rich one becomes rich", () => {
    tab = resetWorkspaceWithTab({
      children: [
        { tagName: "p", textContent: "plain " },
        { children: [{ tagName: "strong", textContent: "rich" }], tagName: "p" },
      ],
      tagName: "div",
    });
    applyBlockMerge(tab, ["children", 1], ["children", 0]);
    expect(kids()[0]!.children).toEqual(["plain ", { tagName: "strong", textContent: "rich" }]);
    expect(kids()[0]!.textContent).toBeUndefined();
  });

  test("prunes the container a removal empties", () => {
    // Backspacing the only item out of a list must not leave an invisible <ul> behind.
    tab = resetWorkspaceWithTab({
      children: [
        { tagName: "p", textContent: "Intro" },
        { children: [{ tagName: "li", textContent: "only" }], tagName: "ul" },
      ],
      tagName: "div",
    });
    applyBlockMerge(tab, ["children", 1, "children", 0], ["children", 0]);
    expect(kids()).toHaveLength(1);
    expect(kids()[0]!.textContent).toBe("Introonly");
  });

  test("refuses a merge between a block and its own ancestor", () => {
    // A loose list item and the paragraph inside it are adjacent in document order, but joining
    // Them would mean a node absorbing its own parent.
    tab = resetWorkspaceWithTab({
      children: [{ children: [{ tagName: "p", textContent: "inner" }], tagName: "li" }],
      tagName: "div",
    });
    expect(applyBlockMerge(tab, ["children", 0, "children", 0], ["children", 0])).toBeNull();
    expect(kids()).toHaveLength(1);
  });

  test("refuses when a path does not resolve, and no-ops without a tab", () => {
    tab = resetWorkspaceWithTab(twoParas());
    expect(applyBlockMerge(tab, ["children", 9], ["children", 0])).toBeNull();
    expect(applyBlockMerge(tab, ["children", 1], ["children", 9])).toBeNull();
    expect(applyBlockMerge(null, ["children", 1], ["children", 0])).toBeNull();
    expect(kids()).toHaveLength(2);
  });

  test("the whole merge undoes as one step", () => {
    tab = resetWorkspaceWithTab(twoParas());
    applyBlockMerge(tab, ["children", 1], ["children", 0]);
    expect(kids()).toHaveLength(1);

    undo(tab);
    expect(kids()).toHaveLength(2);
    expect(kids()[0]!.textContent).toBe("First");
    expect(kids()[1]!.textContent).toBe("Second");
  });
});

describe("applyInlineSplit", () => {
  test("keeps the before-content, inserts a new <p> with the after-content, returns its path", () => {
    const newPath = applyInlineSplit(
      tab,
      ["children", 0],
      { textContent: "Hel" },
      { textContent: "lo" },
    );
    expect(newPath).toEqual(["children", 1]);
    expect(kids()[0]!.textContent).toBe("Hel");
    expect(kids()[1]).toMatchObject({ tagName: "p", textContent: "lo" });
    expect(tab.session.selection).toEqual(["children", 1]);
  });
});

describe("applyInlineInsert", () => {
  const h2: SlashCommand = { tag: "h2" } as unknown as SlashCommand;

  test("swaps the tag in place when the node is empty (returns the same path)", () => {
    applyInlineCommit(tab, ["children", 0], null, ""); // Make it empty first.
    const path = applyInlineInsert(tab, ["children", 0], h2, { textContent: "" });
    expect(path).toEqual(["children", 0]);
    expect(kids()[0]!.tagName).toBe("h2");
  });

  test("inserts a new element after when the node has content (returns the new path)", () => {
    const path = applyInlineInsert(tab, ["children", 0], h2, { textContent: "Hello" });
    expect(path).toEqual(["children", 1]);
    expect(kids()[0]!.textContent).toBe("Hello");
    expect(kids()[1]!.tagName).toBe("h2");
  });
});

describe("applyInlinePropCommit", () => {
  const instanceDoc = () => ({
    children: [
      { tagName: "p", textContent: "Hello" },
      { $props: { title: "Local" }, tagName: "x-card" },
    ],
    tagName: "div",
  });

  beforeEach(() => {
    tab = resetWorkspaceWithTab(instanceDoc());
  });

  test("writes the value into the instance's $props", () => {
    applyInlinePropCommit(tab, ["children", 1], "title", "Regional");
    expect((kids()[1]!.$props as { title?: string }).title).toBe("Regional");
    expect(tab.doc.dirty).toBe(true);
  });

  test("adds an unset prop (overriding the definition default)", () => {
    applyInlinePropCommit(tab, ["children", 1], "description", "Body text");
    expect((kids()[1]!.$props as { description?: string }).description).toBe("Body text");
  });

  test("deletes the prop on an empty value (reverting to the definition default)", () => {
    applyInlinePropCommit(tab, ["children", 1], "title", "");
    expect((kids()[1]!.$props as { title?: string } | undefined)?.title).toBeUndefined();
  });

  test("no-ops when the value is unchanged (load-bearing: Escape/disturb re-commits)", () => {
    const rootBefore = tab.doc.document;
    applyInlinePropCommit(tab, ["children", 1], "title", "Local");
    // TransactDoc swaps the root reference on every real transaction — same ref means no-op.
    expect(tab.doc.document).toBe(rootBefore);
    expect(tab.doc.dirty).toBeFalsy();
  });

  test("treats an unset prop and an empty value as unchanged", () => {
    const rootBefore = tab.doc.document;
    applyInlinePropCommit(tab, ["children", 1], "description", "");
    expect(tab.doc.document).toBe(rootBefore);
  });

  test("no-ops on a null tab or a missing node", () => {
    applyInlinePropCommit(null, ["children", 1], "title", "ghost");
    applyInlinePropCommit(tab, ["children", 9], "title", "ghost");
    expect((kids()[1]!.$props as { title?: string }).title).toBe("Local");
  });
});

// ─── Tab routing (the cross-document-bleed fix) ─────────────────────────────────

describe("explicit-tab routing", () => {
  test("a null tab is a no-op for all three appliers (paths still computed)", () => {
    applyInlineCommit(null, ["children", 0], null, "ghost");
    expect(kids()[0]!.textContent).toBe("Hello");

    const splitPath = applyInlineSplit(
      null,
      ["children", 0],
      { textContent: "He" },
      {
        textContent: "llo",
      },
    );
    expect(splitPath).toEqual(["children", 1]);
    expect(kids()).toHaveLength(1);

    const insertPath = applyInlineInsert(
      null,
      ["children", 0],
      { tag: "h2" } as unknown as SlashCommand,
      { textContent: "Hello" },
    );
    expect(insertPath).toEqual(["children", 1]);
    expect(kids()).toHaveLength(1);
    // The empty-content branch also no-ops on a null tab.
    expect(
      applyInlineInsert(null, ["children", 0], { tag: "h2" } as unknown as SlashCommand, {
        textContent: "",
      }),
    ).toEqual(["children", 0]);
    expect(kids()[0]!.tagName).toBe("p");
  });

  test("a commit against an INACTIVE tab mutates that tab without touching its selection", async () => {
    const { openTab, workspace } = await import("../src/workspace/workspace");
    const original = tab;
    original.session.selection = ["children", 0];
    openTab({ document: { tagName: "div" }, id: "front-tab" });
    expect(workspace.activeTabId).toBe("front-tab");

    // The background tab still receives its late split — but its selection stays as the user
    // Left it (only the visible tab's selection follows edits).
    const newPath = applyInlineSplit(
      original,
      ["children", 0],
      { textContent: "He" },
      { textContent: "llo" },
    );
    const originalKids = original.doc.document.children as Record<string, unknown>[];
    expect(newPath).toEqual(["children", 1]);
    expect(originalKids).toHaveLength(2);
    expect(original.session.selection).toEqual(["children", 0]);
  });
});

// ─── Minimal op recording (no spurious counterpart clears) ──────────────────────

describe("commit op recording", () => {
  test("a plain-text commit on a childless node records ONLY set-text; rich adds no text clear when absent", async () => {
    const { setPatchConsumer } = await import("../src/tabs/patch-ops");
    const batches: string[][] = [];
    setPatchConsumer({
      apply: () => {},
      classify: (_t, ops) => {
        batches.push(ops.map((o) => o.op + ("key" in o ? `:${o.key}` : "")));
        return { patchable: false, reason: "spy" };
      },
      escalate: () => {},
      markConsumed: () => {},
    });
    try {
      // Plain text on a node with no children → a spurious `set-prop:children` would demote the
      // Cheap in-place text patch to a subtree re-render.
      applyInlineCommit(tab, ["children", 0], null, "Updated");
      expect(batches.at(-1)).toEqual(["set-text"]);
      // Rich commit on a node whose textContent was already cleared → no spurious set-text.
      applyInlineCommit(
        tab,
        ["children", 0],
        ["a ", { tagName: "strong", textContent: "b" }],
        null,
      );
      expect(batches.at(-1)).toEqual(["set-text", "set-prop:children"]); // Text present → cleared.
      applyInlineCommit(tab, ["children", 0], ["c ", { tagName: "em", textContent: "d" }], null);
      expect(batches.at(-1)).toEqual(["set-prop:children"]); // Already rich → children only.
      // Plain commit on the now-rich node clears children (real op, kept).
      applyInlineCommit(tab, ["children", 0], null, "flat");
      expect(batches.at(-1)).toEqual(["set-prop:children", "set-text"]);
    } finally {
      setPatchConsumer(null);
    }
  });
});
