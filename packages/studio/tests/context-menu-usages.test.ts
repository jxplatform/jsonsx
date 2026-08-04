/**
 * Find Usages as a CONTEXT-MENU ROW.
 *
 * The record is defined once, in `panels/properties-panel.ts`, and pulled into the element menu's
 * own registry the same way `commands/defaults.ts`'s rows are — so the palette entry and the menu
 * row cannot drift in title or availability. Two things are asserted that a shared definition alone
 * would not give: the pull happens at all, and the capability gate reaches THIS registry's context,
 * which it did not by default because `makeContext` starts every capability at false.
 *
 * A file of its own rather than a block in `context-menu.test.ts`: `convert-to-repeater` and
 * `convert-to-component` must be mocked before the module under test is imported, and that file's
 * mock set is large enough that appending to it couples two suites' setup.
 */
import { flush, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { componentRegistry } from "../src/files/components";
import { registerPlatform } from "../src/platform";
import { initLayers } from "../src/ui/layers";
import { closeAllTabs } from "../src/workspace/workspace";
import type { ReferencesResult } from "../src/types";

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
}
initLayers();

void mock.module("../src/editor/convert-to-repeater", () => ({
  convertToRepeater: mock(async () => {}),
}));
void mock.module("../src/editor/convert-to-component", () => ({
  convertToComponent: mock(async () => {}),
}));

const { dismissContextMenu, showContextMenu } = await import("../src/editor/context-menu");

const usageResult: ReferencesResult = {
  errors: [],
  files: [{ count: 1, path: "pages/index.json", refs: [] }],
  filesReferencing: 1,
  path: "components/card.json",
  refsTotal: 1,
  tagName: "x-card",
};

function menuIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("sp-menu-item[data-command-id]")].map(
    (el) => el.dataset.commandId!,
  );
}

function titleOf(id: string): string {
  const item = [...document.querySelectorAll<HTMLElement>("sp-menu-item[data-command-id]")].find(
    (el) => el.dataset.commandId === id,
  )!;
  return [...item.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join("")
    .trim();
}

function rightClick(path: (string | number)[]): void {
  showContextMenu(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }),
    path as never,
  );
}

beforeEach(() => {
  componentRegistry.length = 0;
  componentRegistry.push({ path: "components/card.json", tagName: "x-card" } as never);
  resetWorkspaceWithTab({
    children: [
      { children: [], tagName: "x-card" },
      { children: [], tagName: "p" },
    ],
    tagName: "div",
  } as never);
  registerPlatform({ findReferences: async () => usageResult } as never);
});

afterEach(async () => {
  dismissContextMenu();
  await flush();
  closeAllTabs();
});

describe("Find Usages in the element menu", () => {
  test("appears on a component instance, under the shared record's title", () => {
    rightClick(["children", 0]);
    expect(menuIds()).toContain("selection.findUsages");
    expect(titleOf("selection.findUsages")).toBe("Find Usages");
  });

  test("does not appear on a plain element", () => {
    rightClick(["children", 1]);
    expect(menuIds()).not.toContain("selection.findUsages");
  });

  test("disappears entirely on a host that cannot count", () => {
    registerPlatform({} as never);
    rightClick(["children", 0]);
    // Hidden, not disabled: a verb whose answer would be a fabricated zero is not offered at all.
    expect(menuIds()).not.toContain("selection.findUsages");
  });
});
