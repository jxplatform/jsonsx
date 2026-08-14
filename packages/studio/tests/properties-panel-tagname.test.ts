/**
 * The Tag row's WRITE path — the two callbacks `src/panels/properties-panel.ts` hands the shared
 * Value Source slot for an element's `tagName`.
 *
 * `tests/properties-panel.test.ts` proves what the row DRAWS at each rung. What it never exercises
 * is the moment the rung changes: the position-specific `seedFor`, and the `onChange` that commits
 * whatever the slot produced.
 *
 * The seed is the whole point of the pair. The generic expression seed is `{ operator: "??" }`, and
 * a `TagExpression` is `?:` or `switch` and nothing else — so a generic seed would drop a document
 * that fails its own validator the instant the chip is clicked. These tests assert the shape that
 * actually lands, not merely that something did.
 */
import {
  installMockPlatform,
  pointer,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  invalidatePageRouteCache,
  renderPropertiesPanelTemplate,
} from "../src/panels/properties-panel";
import { componentRegistry } from "../src/files/components";
import { resetSlotModeMemory } from "../src/ui/dynamic-slot";
import { activeTab } from "../src/workspace/workspace";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── Local helpers (same shape as tests/properties-panel.test.ts) ─────────────

const ctx = { navigateToComponent: () => {} };

async function renderPanel(): Promise<HTMLElement> {
  return await renderInto(renderPropertiesPanelTemplate(ctx));
}

/** A `<x-card>` root holding one child element, with that child selected. */
function openWithChildTag(tagName: unknown) {
  const tab = resetWorkspaceWithTab({
    children: [{ children: [], tagName }],
    tagName: "x-card",
  } as unknown as JxMutableNode);
  tab.session.selection = [["children", 0]] as never;
  return tab;
}

function docNow(): JxMutableNode {
  return activeTab.value!.doc.document as JxMutableNode;
}

function selectedNode(): JxMutableNode {
  return (docNow().children as JxMutableNode[])[0]!;
}

const tagRow = (c: HTMLElement) => c.querySelector('[data-prop="tagName"]') as HTMLElement;

/** Pick a rung on the Tag row's Value Source picker — `elementTag` offers exactly these two. */
function chooseValueSource(row: Element, mode: "literal" | "expression") {
  pointer(row.querySelector(`sp-menu-item[data-mode="${mode}"]`)!, "click");
}

beforeEach(() => {
  componentRegistry.length = 0;
  invalidatePageRouteCache();
  resetSlotModeMemory();
  resetStudioState();
  installMockPlatform();
});

describe("the Tag row commits what the rung change produced", () => {
  test("choosing Formula seeds a valid TagExpression around the name it replaced", async () => {
    openWithChildTag("section");
    const c = await renderPanel();

    chooseValueSource(tagRow(c), "expression");

    /* `?:` with both arms holding the outgoing name — NOT the generic `{ operator: "??",
       target: null, value: null }`, which `TagExpression` does not admit. */
    expect(selectedNode().tagName).toEqual({
      $expression: { initial: "section", operator: "?:", target: null, value: "section" },
    } as never);
  });

  test("the write lands on the selected node, not on the document root", async () => {
    openWithChildTag("section");
    const c = await renderPanel();

    chooseValueSource(tagRow(c), "expression");

    expect(docNow().tagName).toBe("x-card");
  });

  test("the seeded formula reads back as Formula, and never as [object Object]", async () => {
    openWithChildTag("section");
    let c = await renderPanel();
    chooseValueSource(tagRow(c), "expression");

    c = await renderPanel();
    expect(tagRow(c).querySelector(".dynamic-slot-mode")!.textContent!.trim()).toBe("Formula");
    expect(tagRow(c).textContent).not.toContain("[object Object]");
  });

  test("dropping back to Fixed value writes the name the formula was seeded from", async () => {
    openWithChildTag("section");
    let c = await renderPanel();
    chooseValueSource(tagRow(c), "expression");
    expect(typeof selectedNode().tagName).toBe("object");

    c = await renderPanel();
    chooseValueSource(tagRow(c), "literal");

    expect(selectedNode().tagName).toBe("section");
  });

  test("a formula the user never seeded here clears the tag rather than seeding one", async () => {
    /* The seed is expression-only: de-escalating asks for a literal, gets `undefined`, and the
       property is removed — the row falls back to the default tag for the user to type over. A seed
       offered at this rung would write a `$expression` object while the chip says "Fixed value". */
    openWithChildTag({
      $expression: { initial: "div", operator: "?:", target: { $ref: "#/state/href" }, value: "a" },
    });
    let c = await renderPanel();
    expect(tagRow(c).querySelector(".dynamic-slot-mode")!.textContent!.trim()).toBe("Formula");

    chooseValueSource(tagRow(c), "literal");
    expect(selectedNode().tagName).toBeUndefined();

    c = await renderPanel();
    expect(tagRow(c).querySelector(".dynamic-slot-mode")!.textContent!.trim()).toBe("Fixed value");
  });
});
