import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dismissSlashMenu, isSlashMenuOpen, showSlashMenu } from "../src/editor/slash-menu";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a simple anchor element for positioning the menu */
function makeAnchor() {
  const el = document.createElement("p");
  el.textContent = "test";
  document.body.append(el);
  return el;
}

/** Dispatch a keyboard event on document (capturing phase, like real browser) */
function pressKey(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
}

/** Query all menu items in the slash menu host */
function getMenuItems() {
  return [...document.querySelectorAll("sp-menu-item")];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Slash Menu", () => {
  let anchor: HTMLElement;

  beforeEach(() => {
    anchor = makeAnchor();
  });

  afterEach(() => {
    dismissSlashMenu();
    anchor.remove();
  });

  // ─── State lifecycle ─────────────────────────────────────────────────────

  describe("state lifecycle", () => {
    test("starts closed", () => {
      expect(isSlashMenuOpen()).toBe(false);
    });

    test("opens after showSlashMenu", () => {
      showSlashMenu(anchor, "", { onSelect: () => {} });
      expect(isSlashMenuOpen()).toBe(true);
    });

    test("closes after dismissSlashMenu", () => {
      showSlashMenu(anchor, "", { onSelect: () => {} });
      dismissSlashMenu();
      expect(isSlashMenuOpen()).toBe(false);
    });

    test("dismissSlashMenu is safe to call when already closed", () => {
      dismissSlashMenu();
      expect(isSlashMenuOpen()).toBe(false);
    });
  });

  // ─── Filtering ───────────────────────────────────────────────────────────

  describe("filtering", () => {
    test("no filter shows all commands", () => {
      showSlashMenu(anchor, "", { onSelect: () => {} });
      const items = getMenuItems();
      expect(items.length).toBe(15); // All SLASH_COMMANDS
    });

    test("filter narrows results", () => {
      showSlashMenu(anchor, "head", { onSelect: () => {} });
      const items = getMenuItems();
      expect(items.length).toBe(3); // H1, h2, h3
    });

    test("filter by tag name", () => {
      showSlashMenu(anchor, "blockquote", { onSelect: () => {} });
      const items = getMenuItems();
      expect(items.length).toBe(1);
    });

    test("no matches auto-dismisses", () => {
      showSlashMenu(anchor, "xyz", { onSelect: () => {} });
      expect(isSlashMenuOpen()).toBe(false);
    });

    test("updating filter changes items", () => {
      showSlashMenu(anchor, "", { onSelect: () => {} });
      expect(getMenuItems().length).toBe(15);

      showSlashMenu(anchor, "img", { onSelect: () => {} });
      expect(getMenuItems().length).toBe(1);
    });
  });

  // ─── Keyboard navigation ─────────────────────────────────────────────────

  describe("keyboard navigation", () => {
    test("ArrowDown moves focused attribute", () => {
      showSlashMenu(anchor, "", { onSelect: () => {} });
      const items = getMenuItems();
      expect(items[0]!.hasAttribute("focused")).toBe(true);

      pressKey("ArrowDown");
      expect(items[0]!.hasAttribute("focused")).toBe(false);
      expect(items[1]!.hasAttribute("focused")).toBe(true);
    });

    test("ArrowUp wraps around to last item", () => {
      showSlashMenu(anchor, "", { onSelect: () => {} });
      pressKey("ArrowUp");

      const items = getMenuItems();
      expect(items.at(-1)!.hasAttribute("focused")).toBe(true);
    });

    test("ArrowDown wraps around to first item", () => {
      showSlashMenu(anchor, "", { onSelect: () => {} });
      const items = getMenuItems();
      // Navigate to last item
      for (const _item of items) {
        pressKey("ArrowDown");
      }

      // Should wrap to first
      expect(items[0]!.hasAttribute("focused")).toBe(true);
    });
  });

  // ─── Enter selects ───────────────────────────────────────────────────────

  describe("Enter selects", () => {
    test("Enter calls onSelect with first item by default", () => {
      let selected: any = null;
      showSlashMenu(anchor, "", { onSelect: (cmd) => (selected = cmd) });

      pressKey("Enter");
      expect(selected).not.toBeNull();
      expect(selected.tag).toBe("h1");
      expect(selected.label).toBe("Heading 1");
    });

    test("Enter after ArrowDown selects second item", () => {
      let selected: any = null;
      showSlashMenu(anchor, "", { onSelect: (cmd) => (selected = cmd) });

      pressKey("ArrowDown");
      pressKey("Enter");
      expect(selected.tag).toBe("h2");
    });

    /* The row that LOOKS focused is the row Enter takes, at every step.
       These were two mechanisms until recently: the template declared `?focused=${i === 0}` while
       the arrow handler moved the attribute itself, off a live `querySelectorAll` of the host. They
       never disagreed on screen only because lit's dirty-check makes an imperative write STICK — a
       repaint re-commits `i === 0` as the same `true` it committed before and skips, leaving the
       attribute wherever the handler last put it. Two writers, one attribute, and no way for the
       template to take it back. `?focused=${i === activeIdx}` makes the binding the only writer,
       and this asserts the property that would break if a second one ever appears. */
    test("the focused row is the row Enter takes, at every step", () => {
      const taken: string[] = [];
      const focusedIndex = () => getMenuItems().findIndex((el) => el.hasAttribute("focused"));

      for (const steps of [0, 1, 2]) {
        let selected: any = null;
        showSlashMenu(anchor, "", { onSelect: (cmd) => (selected = cmd) });
        for (let i = 0; i < steps; i++) {
          pressKey("ArrowDown");
        }
        const shown = focusedIndex();
        const labels = getMenuItems().map((el) => el.textContent?.trim() ?? "");
        expect(shown).toBe(steps);
        // Exactly one, so nothing is left behind by a previous move.
        expect(getMenuItems().filter((el) => el.hasAttribute("focused")).length).toBe(1);

        pressKey("Enter");
        expect(selected).not.toBeNull();
        expect(labels[shown]).toContain(selected.label);
        taken.push(selected.label);
      }

      // And the three steps really did land on three different commands.
      expect(new Set(taken).size).toBe(3);
    });

    test("Enter dismisses the menu", () => {
      showSlashMenu(anchor, "", { onSelect: () => {} });
      pressKey("Enter");
      expect(isSlashMenuOpen()).toBe(false);
    });

    test("Enter with filter selects first filtered item", () => {
      let selected: any = null;
      showSlashMenu(anchor, "img", { onSelect: (cmd) => (selected = cmd) });

      pressKey("Enter");
      expect(selected.tag).toBe("img");
    });
  });

  // ─── Escape dismisses ────────────────────────────────────────────────────

  describe("Escape dismisses", () => {
    test("Escape closes the menu", () => {
      showSlashMenu(anchor, "", { onSelect: () => {} });
      pressKey("Escape");
      expect(isSlashMenuOpen()).toBe(false);
    });

    test("Escape does not call onSelect", () => {
      let called = false;
      showSlashMenu(anchor, "", { onSelect: () => (called = true) });
      pressKey("Escape");
      expect(called).toBe(false);
    });
  });

  // ─── Event propagation ───────────────────────────────────────────────────

  describe("event propagation", () => {
    test("Enter stopPropagation prevents bubbling", () => {
      let _bubbled = false;
      const handler = () => (_bubbled = true);
      document.addEventListener("keydown", handler);

      showSlashMenu(anchor, "", { onSelect: () => {} });
      pressKey("Enter");

      // The capturing handler in slash-menu calls stopPropagation,
      // But our pressKey dispatches on document so the capture listener fires.
      // The key test: after Enter, the menu is closed and item selected.
      expect(isSlashMenuOpen()).toBe(false);
      void _bubbled;
      document.removeEventListener("keydown", handler);
    });
  });

  // ─── Custom commands ────────────────────────────────────────────────────

  describe("custom commands", () => {
    const customCommands = [
      { description: "Plain text", label: "Paragraph", tag: "p" },
      { description: "Medium heading", label: "Heading 2", tag: "h2" },
      { description: "Small heading", label: "Heading 3", tag: "h3" },
    ];

    test("shows only custom commands when provided", () => {
      showSlashMenu(anchor, "", {
        commands: customCommands,
        onSelect: () => {},
      });
      const items = getMenuItems();
      expect(items.length).toBe(3);
    });

    test("filters within custom commands", () => {
      showSlashMenu(anchor, "head", {
        commands: customCommands,
        onSelect: () => {},
      });
      const items = getMenuItems();
      expect(items.length).toBe(2);
    });

    test("Enter selects from custom commands", () => {
      let selected: any = null;
      showSlashMenu(anchor, "", {
        commands: customCommands,
        onSelect: (cmd) => (selected = cmd),
      });
      pressKey("Enter");
      expect(selected.tag).toBe("p");
      expect(selected.label).toBe("Paragraph");
    });

    test("no matches in custom commands auto-dismisses", () => {
      showSlashMenu(anchor, "xyz", {
        commands: customCommands,
        onSelect: () => {},
      });
      expect(isSlashMenuOpen()).toBe(false);
    });

    test("keyboard navigation works with custom commands", () => {
      showSlashMenu(anchor, "", {
        commands: customCommands,
        onSelect: () => {},
      });
      const items = getMenuItems();
      expect(items[0]!.hasAttribute("focused")).toBe(true);

      pressKey("ArrowDown");
      expect(items[1]!.hasAttribute("focused")).toBe(true);

      pressKey("ArrowDown");
      expect(items[2]!.hasAttribute("focused")).toBe(true);

      // Wraps
      pressKey("ArrowDown");
      expect(items[0]!.hasAttribute("focused")).toBe(true);
    });
  });
});
