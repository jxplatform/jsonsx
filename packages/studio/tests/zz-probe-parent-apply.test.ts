/** TEMPORARY probe — delete after use. */
import { resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, expect, test } from "bun:test";
import { applyBlockMerge, applyInlineCommit } from "../src/editor/inline-edit-apply";
import type { Tab } from "../src/tabs/tab";

let tab: Tab;

beforeEach(() => {
  resetStudioState();
});

test("three paragraphs: merge then stale commit at the old index", () => {
  tab = resetWorkspaceWithTab({
    children: [
      { tagName: "p", textContent: "First" },
      { tagName: "p", textContent: "Second" },
      { tagName: "p", textContent: "Third" },
    ],
    tagName: "div",
  });
  applyBlockMerge(tab, ["children", 1], ["children", 0]);
  console.log("after merge:", JSON.stringify(tab.doc.document.children));
  applyInlineCommit(tab, ["children", 1], null, "Second");
  console.log("after stale commit:", JSON.stringify(tab.doc.document.children));
  expect(true).toBe(true);
});

test("two paragraphs: merge then stale commit at the now-absent index", () => {
  tab = resetWorkspaceWithTab({
    children: [
      { tagName: "p", textContent: "First" },
      { tagName: "p", textContent: "Second" },
    ],
    tagName: "div",
  });
  applyBlockMerge(tab, ["children", 1], ["children", 0]);
  console.log("after merge:", JSON.stringify(tab.doc.document.children));
  let threw: unknown = null;
  try {
    applyInlineCommit(tab, ["children", 1], null, "Second");
  } catch (error) {
    threw = error;
  }
  console.log("threw:", threw === null ? "no" : String(threw));
  expect(true).toBe(true);
});
