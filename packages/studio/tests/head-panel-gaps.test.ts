/**
 * Gap coverage for src/panels/head-panel.ts — exercises the defensive branches inside the custom
 * $head entry "Remove" click handler: the mutation callback receives a doc that (a) has no $head at
 * all, and (b) has a $head array that does not contain the entry being removed. The main
 * head-panel.test.ts always mutates the same doc that was rendered, so these branches stay
 * uncovered there.
 */
import { installMockPlatform, renderInto, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { renderHeadTemplate } from "../src/panels/head-panel";
import { closeAllTabs } from "../src/workspace/workspace";

import type { JxHeadEntry, JxMutableNode } from "@jxsuite/schema/types";

const CUSTOM_ENTRY: JxHeadEntry = {
  attributes: { content: "noindex", name: "robots" },
  tagName: "meta",
};

/** Render a head panel whose applyMutation hands the mutation a _different_ doc than rendered. */
async function renderWithMutationTarget(mutationDoc: JxMutableNode) {
  const renderedDoc = { $head: [CUSTOM_ENTRY], tagName: "html" } as unknown as JxMutableNode;
  let leftPanelRenders = 0;
  let mutations = 0;
  const container = await renderInto(
    renderHeadTemplate({
      applyMutation: (fn) => {
        mutations += 1;
        fn(mutationDoc);
      },
      document: renderedDoc,
      renderLeftPanel: () => {
        leftPanelRenders += 1;
      },
    }),
  );
  const removeBtn = container.querySelector(
    '.import-row sp-action-button[title="Remove"]',
  ) as HTMLElement | null;
  if (!removeBtn) {
    throw new Error("custom entry remove button not rendered");
  }
  return {
    container,
    leftPanelRenders: () => leftPanelRenders,
    mutations: () => mutations,
    removeBtn,
  };
}

describe("head-panel custom tag removal (defensive branches)", () => {
  beforeEach(() => {
    closeAllTabs();
    resetStudioState();
    installMockPlatform();
  });

  test("remove click is a no-op when the mutated doc has no $head", async () => {
    const mutationDoc = { tagName: "html" } as unknown as JxMutableNode;
    const r = await renderWithMutationTarget(mutationDoc);

    r.removeBtn.click();

    expect(r.mutations()).toBe(1);
    expect(r.leftPanelRenders()).toBe(1);
    // Guard returned early: no $head was created or modified.
    expect(mutationDoc.$head).toBeUndefined();
  });

  test("remove click leaves $head untouched when the entry is not present", async () => {
    const otherEntry: JxHeadEntry = {
      attributes: { content: "abc", name: "verification" },
      tagName: "meta",
    };
    const mutationDoc = { $head: [otherEntry], tagName: "html" } as unknown as JxMutableNode;
    const r = await renderWithMutationTarget(mutationDoc);

    r.removeBtn.click();

    expect(r.mutations()).toBe(1);
    expect(r.leftPanelRenders()).toBe(1);
    // IndexOf returned -1, so nothing was spliced.
    expect(mutationDoc.$head).toHaveLength(1);
    expect(mutationDoc.$head?.[0]).toBe(otherEntry);
  });

  test("remove click splices the entry when present in the mutated doc", async () => {
    const mutationDoc = {
      $head: [CUSTOM_ENTRY],
      tagName: "html",
    } as unknown as JxMutableNode;
    const r = await renderWithMutationTarget(mutationDoc);

    r.removeBtn.click();

    expect(r.mutations()).toBe(1);
    expect(mutationDoc.$head).toHaveLength(0);
  });
});
