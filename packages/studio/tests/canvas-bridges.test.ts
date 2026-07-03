/**
 * Parent-realm adapters for canvas-iframe-originated UI: the slash-menu bridge handler
 * (src/editor/canvas-slash-bridge.ts) and the context-menu handler
 * (src/editor/canvas-context-menu.ts). Both are the DI implementations studio.ts registers with the
 * iframe host; exercised here against the real slash/context menus.
 */
import { flush, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canvasSlashHandler } from "../src/editor/canvas-slash-bridge";
import { makeCanvasContextMenuHandler } from "../src/editor/canvas-context-menu";
import { dismissSlashMenu, isSlashMenuOpen } from "../src/editor/slash-menu";
import { dismissContextMenu } from "../src/editor/context-menu";
import { componentRegistry } from "../src/files/components";
import { initLayers } from "../src/ui/layers";
import { activeTab } from "../src/workspace/workspace";
import type { SlashCommand } from "../src/editor/inline-edit";

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

const RECT = { bottom: 60, height: 20, left: 30, top: 40, width: 120 };

const menuItems = () =>
  [...document.querySelectorAll("#layer-popover sp-menu-item")] as HTMLElement[];

beforeEach(() => {
  resetWorkspaceWithTab({
    children: [
      { children: [{ tagName: "strong", textContent: "bold" }], tagName: "p" },
      { tagName: "x-widget" },
    ],
    tagName: "div",
  });
});

afterEach(async () => {
  dismissSlashMenu();
  dismissContextMenu();
  componentRegistry.length = 0;
  await flush();
});

describe("canvasSlashHandler", () => {
  test("show opens the real slash menu at the given rect; select round-trips the command", async () => {
    const picked: SlashCommand[] = [];
    let dismissed = 0;
    canvasSlashHandler.show({
      filter: "",
      onDismiss: () => {
        dismissed += 1;
      },
      onSelect: (cmd) => picked.push(cmd),
      rect: RECT,
    });
    await flush();
    expect(isSlashMenuOpen()).toBe(true);
    const popover = document.querySelector("#layer-popover sp-popover") as HTMLElement;
    expect(popover.getAttribute("style")).toContain(`left:${RECT.left}px`);
    expect(popover.getAttribute("style")).toContain(`top:${RECT.bottom + 4}px`);

    // Enter selects the focused (first) item — dismiss (→ onDismiss) fires BEFORE onSelect.
    canvasSlashHandler.nav("Enter");
    expect(picked).toHaveLength(1);
    expect(dismissed).toBe(1);
    expect(isSlashMenuOpen()).toBe(false);
  });

  test("nav ArrowDown/ArrowUp moves the focused item; Escape dismisses with onDismiss", async () => {
    let dismissed = 0;
    canvasSlashHandler.show({
      filter: "",
      onDismiss: () => {
        dismissed += 1;
      },
      onSelect: () => {},
      rect: RECT,
    });
    await flush();
    canvasSlashHandler.nav("ArrowDown");
    expect(menuItems()[1]!.hasAttribute("focused")).toBe(true);
    canvasSlashHandler.nav("ArrowUp");
    expect(menuItems()[0]!.hasAttribute("focused")).toBe(true);
    canvasSlashHandler.nav("Escape");
    expect(isSlashMenuOpen()).toBe(false);
    expect(dismissed).toBe(1);
  });

  test("a filter with no matches never opens (immediate dismiss)", () => {
    let dismissed = 0;
    canvasSlashHandler.show({
      filter: "zzzz-no-such",
      onDismiss: () => {
        dismissed += 1;
      },
      onSelect: () => {},
      rect: RECT,
    });
    expect(isSlashMenuOpen()).toBe(false);
    // The no-match path dismisses before the menu ever registered as open — no callback leak.
    expect(dismissed).toBe(0);
  });

  test("dismiss closes an open menu", async () => {
    canvasSlashHandler.show({
      filter: "",
      onDismiss: () => {},
      onSelect: () => {},
      rect: RECT,
    });
    await flush();
    canvasSlashHandler.dismiss();
    expect(isSlashMenuOpen()).toBe(false);
  });
});

describe("makeCanvasContextMenuHandler", () => {
  test("show bubbles an inline path to its block and opens the menu at the coords", async () => {
    const handler = makeCanvasContextMenuHandler({ navigateToComponent: () => {} });
    // Right-click resolved to the <strong> INSIDE the <p> — the menu must act on the <p>.
    handler.show({ clientX: 77, clientY: 88, path: ["children", 0, "children", 0] });
    await flush();
    expect(activeTab.value!.session.selection).toEqual(["children", 0]);
    const popover = document.querySelector("#layer-popover sp-popover") as HTMLElement;
    expect(popover).toBeTruthy();
    expect(popover.getAttribute("style")).toContain("left: 77px");
    expect(popover.getAttribute("style")).toContain("top: 88px");
  });

  test("a null path (empty canvas area) is a no-op", async () => {
    const handler = makeCanvasContextMenuHandler({ navigateToComponent: () => {} });
    handler.show({ clientX: 5, clientY: 5, path: null });
    await flush();
    expect(document.querySelector("#layer-popover sp-popover")).toBeNull();
  });

  test("Edit Component routes through navigateToComponent; dismiss closes the menu", async () => {
    const visited: string[] = [];
    componentRegistry.push({ path: "components/widget.json", tagName: "x-widget" } as never);
    const handler = makeCanvasContextMenuHandler({
      navigateToComponent: (p) => {
        visited.push(p);
      },
    });
    handler.show({ clientX: 10, clientY: 10, path: ["children", 1] });
    await flush();
    const edit = menuItems().find((el) => el.textContent!.includes("Edit Component"));
    expect(edit).toBeTruthy();
    edit!.click();
    expect(visited).toEqual(["components/widget.json"]);

    handler.show({ clientX: 10, clientY: 10, path: ["children", 0] });
    await flush();
    expect(document.querySelector("#layer-popover sp-popover")).toBeTruthy();
    handler.dismiss();
    expect(document.querySelector("#layer-popover sp-popover")).toBeNull();
  });
});
