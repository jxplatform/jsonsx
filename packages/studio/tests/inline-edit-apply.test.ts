/**
 * Inline-edit apply logic — the serializable commit/split/insert results turned into transactDoc
 * mutations. Shared by the legacy in-realm editor and the iframe host, so tested directly against a
 * workspace doc.
 */
import { resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyInlineCommit,
  applyInlineInsert,
  applyInlineSplit,
  isEmptyContent,
} from "../src/editor/inline-edit-apply";
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
    applyInlineCommit(["children", 0], null, "Updated");
    expect(kids()[0]!.textContent).toBe("Updated");
    expect(kids()[0]!.children).toBeUndefined();
  });

  test("commits rich children (clearing textContent)", () => {
    const rich = ["a ", { tagName: "strong", textContent: "b" }];
    applyInlineCommit(["children", 0], rich, null);
    expect(kids()[0]!.children).toEqual(rich);
    expect(kids()[0]!.textContent).toBeUndefined();
  });

  test("is a no-op when the text is unchanged", () => {
    applyInlineCommit(["children", 0], null, "Hello");
    expect(kids()[0]!.textContent).toBe("Hello");
  });
});

describe("applyInlineSplit", () => {
  test("keeps the before-content, inserts a new <p> with the after-content, returns its path", () => {
    const newPath = applyInlineSplit(
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
    applyInlineCommit(["children", 0], null, ""); // Make it empty first.
    const path = applyInlineInsert(["children", 0], h2, { textContent: "" });
    expect(path).toEqual(["children", 0]);
    expect(kids()[0]!.tagName).toBe("h2");
  });

  test("inserts a new element after when the node has content (returns the new path)", () => {
    const path = applyInlineInsert(["children", 0], h2, { textContent: "Hello" });
    expect(path).toEqual(["children", 1]);
    expect(kids()[0]!.textContent).toBe("Hello");
    expect(kids()[1]!.tagName).toBe("h2");
  });
});
