/**
 * Gap tests for src/editor/slash-menu.ts — the filter-input mode (showFilter), outside-click
 * dismissal, click selection, and keyboard edge cases with an empty result list.
 */
import "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dismissSlashMenu, isSlashMenuOpen, showSlashMenu } from "../src/editor/slash-menu";

// ─── Environment ──────────────────────────────────────────────────────────────

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

async function flush(turns = 2) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

let anchor: HTMLElement;

beforeEach(() => {
  anchor = document.createElement("p");
  anchor.textContent = "anchor";
  document.body.append(anchor);
});

afterEach(() => {
  dismissSlashMenu();
  anchor.remove();
});

function menuItems() {
  return [...document.querySelectorAll("sp-menu-item")];
}

function filterInput() {
  return document.querySelector("input.slash-filter") as HTMLInputElement | null;
}

function pressKey(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
}

// ─── Filter input mode ────────────────────────────────────────────────────────

describe("showFilter mode", () => {
  test("renders a filter input and focuses it", async () => {
    showSlashMenu(anchor, "", { onSelect: () => {}, showFilter: true });
    expect(filterInput()).not.toBeNull();
    await flush();
    expect(document.activeElement).toBe(filterInput());
  });

  test("typing in the filter narrows the items", async () => {
    showSlashMenu(anchor, "", { onSelect: () => {}, showFilter: true });
    const input = filterInput()!;
    input.value = "img";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(menuItems().length).toBe(1);
    expect(menuItems()[0]!.textContent).toContain("Image");
  });

  test("clearing the filter restores the full list", () => {
    showSlashMenu(anchor, "head", { onSelect: () => {}, showFilter: true });
    expect(menuItems().length).toBe(3);
    const input = filterInput()!;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(menuItems().length).toBe(15);
  });

  test("no matches shows a disabled placeholder but stays open", () => {
    showSlashMenu(anchor, "zzz", { onSelect: () => {}, showFilter: true });
    expect(isSlashMenuOpen()).toBe(true);
    const items = menuItems();
    expect(items.length).toBe(1);
    expect(items[0]!.hasAttribute("disabled")).toBe(true);
    expect(items[0]!.textContent).toContain("No matches");
  });

  test("filter input re-focuses after each re-render", async () => {
    showSlashMenu(anchor, "", { onSelect: () => {}, showFilter: true });
    await flush();
    const input = filterInput()!;
    input.value = "h";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // The re-render replaces the input; the rAF callback refocuses the new one
    await flush();
    expect(document.activeElement).toBe(filterInput());
  });

  test("Enter with an empty result list selects nothing and stays open", () => {
    let selected: unknown = null;
    showSlashMenu(anchor, "zzz", {
      onSelect: (cmd) => {
        selected = cmd;
      },
      showFilter: true,
    });
    pressKey("Enter");
    expect(selected).toBeNull();
    expect(isSlashMenuOpen()).toBe(true);
  });

  test("arrow keys with an empty result list are inert", () => {
    showSlashMenu(anchor, "zzz", { onSelect: () => {}, showFilter: true });
    pressKey("ArrowDown");
    pressKey("ArrowUp");
    expect(isSlashMenuOpen()).toBe(true);
  });

  test("filtering within custom commands via the input", () => {
    const commands = [
      { description: "Custom A", label: "Alpha", tag: "a1" },
      { description: "Custom B", label: "Beta", tag: "b1" },
    ];
    showSlashMenu(anchor, "", { commands, onSelect: () => {}, showFilter: true });
    const input = filterInput()!;
    input.value = "bet";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(menuItems().length).toBe(1);
    expect(menuItems()[0]!.textContent).toContain("Beta");
  });
});

// ─── Outside click ────────────────────────────────────────────────────────────

describe("outside click", () => {
  test("mousedown outside the popover dismisses the menu", async () => {
    showSlashMenu(anchor, "", { onSelect: () => {} });
    await flush(); // RAF registers the outside-click listener
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(isSlashMenuOpen()).toBe(false);
  });

  test("mousedown inside the popover keeps it open", async () => {
    showSlashMenu(anchor, "", { onSelect: () => {} });
    await flush();
    const [item] = menuItems();
    item!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(isSlashMenuOpen()).toBe(true);
  });
});

// ─── Click selection ──────────────────────────────────────────────────────────

describe("click selection", () => {
  test("clicking a menu item selects its command and closes the menu", async () => {
    let selected: { tag: string } | null = null;
    showSlashMenu(anchor, "img", {
      onSelect: (cmd) => {
        selected = cmd;
      },
    });
    await flush();
    menuItems()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(selected as unknown).toEqual({
      description: "Insert image",
      label: "Image",
      tag: "img",
    });
    expect(isSlashMenuOpen()).toBe(false);
  });
});

// ─── Re-show while open ───────────────────────────────────────────────────────

describe("re-show while open", () => {
  test("updating an open menu keeps a single keydown handler", () => {
    let count = 0;
    showSlashMenu(anchor, "", {
      onSelect: () => {
        count += 1;
      },
    });
    showSlashMenu(anchor, "img", {
      onSelect: () => {
        count += 1;
      },
    });
    pressKey("Enter");
    expect(count).toBe(1);
    expect(isSlashMenuOpen()).toBe(false);
  });

  test("the popover is positioned from the anchor rect", () => {
    showSlashMenu(anchor, "", { onSelect: () => {} });
    const popover = document.querySelector("sp-popover") as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.style.position).toBe("fixed");
  });
});
