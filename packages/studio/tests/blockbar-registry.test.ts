/**
 * The block action bar as a RENDERING of the command registry (plan §3.2 ⑩, §5.5).
 *
 * `tests/block-action-bar.test.ts` covers the bar's own machinery — positioning, the format group,
 * the link popover, the bridge. This file covers what the registry decides for it: which verbs are
 * placed, where the cap falls, what the `⋮` menu carries, how a disabled control explains itself,
 * and the keyboard model that made the bar reachable without a mouse.
 */
import { flush, resetWorkspaceWithTab } from "./harness";
import { render as litRender } from "lit-html";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { componentRegistry } from "../src/files/components";
import { initLayers } from "../src/ui/layers";
import { view } from "../src/view";
import { activeTab } from "../src/workspace/workspace";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { checkPlacements } from "../src/commands/levels";

import type { AnyCommand, CommandRegistry } from "../src/commands/registry";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../src/state";

// ─── Seams (both must precede the module-under-test import) ──────────────────

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: () => () => {},
}));

const anchor = { height: 20, left: 30, top: 200, width: 100 };
void mock.module("../src/canvas/iframe-host", () => ({
  getEditBarAnchorRect: () => anchor,
  getEditSnapshot: () => ({ editing: false, editingProp: null, snapshot: null }),
  postApplyFormat: () => {},
  requestCanvasEval: () => Promise.resolve(null),
}));

const {
  BLOCKBAR_MAX_ITEMS,
  commandIcon,
  commandTooltip,
  commandTargetPath,
  dismissBlockActionBar,
  dismissBlockBarOverflow,
  handleBlockBarEntryKey,
  initBlockActionBar,
  registerSelectionCommands,
  renderBlockActionBar,
  runCommand,
  selectionCommandContext,
  selectionCommandRegistry,
  useCommandRegistry,
  withCommandTarget,
} = await import("../src/panels/block-action-bar");

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
}
initLayers();

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TWO_PARAGRAPHS: JxMutableNode = {
  children: [
    { tagName: "p", textContent: "A" },
    { tagName: "p", textContent: "B" },
  ],
  tagName: "div",
};

function setup(node: JxMutableNode = TWO_PARAGRAPHS, selection: JxPath = ["children", 1]) {
  const tab = resetWorkspaceWithTab(structuredClone(node));
  tab.session.selection = selection ? [selection] : [];
  return tab;
}

function bar(): HTMLElement {
  const el = view.blockActionBarEl?.querySelector(".block-action-bar") as HTMLElement | null;
  if (!el) {
    throw new Error("the bar did not render");
  }
  return el;
}

function items(): HTMLElement[] {
  return [...bar().querySelectorAll<HTMLElement>("[data-toolbar-item]")];
}

/** A minimal selection-level record, so a test can decide exactly what the bar is asked to draw. */
function record(id: string, over: Partial<AnyCommand> = {}): AnyCommand {
  return {
    category: "Selection",
    group: "5_test",
    id,
    level: "selection",
    menus: ["blockbar"],
    run: () => {},
    title: id.split(".")[1] ?? id,
    ...over,
  } as AnyCommand;
}

/** Inject a registry holding exactly `commands`, evaluated against an always-true context. */
function injectRegistry(commands: readonly AnyCommand[]): CommandRegistry {
  const registry = createCommandRegistry({
    getContext: () => makeContext({ document: { open: true }, selection: { count: 1 } }),
    mac: true,
  });
  registry.registerAll(commands);
  useCommandRegistry(registry);
  return registry;
}

beforeAll(() => {
  initBlockActionBar({ getCanvasMode: () => "design", navigateToComponent: () => {} });
});

beforeEach(() => {
  componentRegistry.length = 0;
  useCommandRegistry(null);
});

afterEach(() => {
  dismissBlockBarOverflow();
  dismissBlockActionBar();
  useCommandRegistry(null);
  if (view.selDragCleanup) {
    view.selDragCleanup();
    view.selDragCleanup = null;
  }
});

// ─── The records themselves ──────────────────────────────────────────────────

describe("the selection command records", () => {
  test("every placement they declare is admitted by the level × placement matrix", () => {
    // `scripts/check-command-levels.ts` reads `commands/defaults.ts`; these records are defined
    // Next to their implementation, so they are checked here against the same matrix.
    const registry = createCommandRegistry({ getContext: selectionCommandContext });
    registerSelectionCommands(registry, {
      convertToComponent: () => {},
      navigateToComponent: () => {},
    });
    expect(checkPlacements(registry.list())).toEqual([]);
    expect(registry.list().map((c) => c.id)).toEqual([
      "selection.moveUp",
      "selection.moveDown",
      "selection.moveIn",
      "selection.moveOut",
      "selection.convertToComponent",
      "selection.editComponent",
    ]);
  });

  test("Convert to Component STARTS the flow — it does not await the name dialog", async () => {
    // `convertToComponent()` resolves when a human answers the prompt. Returning that promise from
    // `run()` made the command uncallable by anything automated: `__jxAutomation.run` awaits it, so
    // The screenshot step that opens this dialog hung until the CDP protocol timeout fired.
    let started = 0;
    let settled = false;
    const registry = createCommandRegistry({ getContext: selectionCommandContext });
    registerSelectionCommands(registry, {
      convertToComponent: async () => {
        started += 1;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        settled = true;
      },
      navigateToComponent: () => {},
    });
    setup();
    await registry.run("selection.convertToComponent");
    expect(started).toBe(1);
    expect(settled).toBe(false);
  });

  test("Convert and Edit Component are one slot with two states, never both", () => {
    setup();
    const registry = selectionCommandRegistry();
    expect(registry.isVisible("selection.convertToComponent")).toBe(true);
    expect(registry.isVisible("selection.editComponent")).toBe(false);

    componentRegistry.push({ path: "components/card.json", tagName: "x-card" } as never);
    setup({ children: [{ tagName: "x-card" }], tagName: "div" }, ["children", 0]);
    expect(registry.isVisible("selection.convertToComponent")).toBe(false);
    expect(registry.isVisible("selection.editComponent")).toBe(true);
  });

  test("the context reports the TARGET, so a row's verbs are not the selection's", () => {
    setup(TWO_PARAGRAPHS, ["children", 0]);
    expect(selectionCommandContext().selection).toMatchObject({
      count: 1,
      isComponentInstance: false,
      isRoot: false,
      kind: "p",
    });
    expect(commandTargetPath()).toEqual(["children", 0]);

    withCommandTarget([], () => {
      expect(commandTargetPath()).toEqual([]);
      expect(selectionCommandContext().selection.isRoot).toBe(true);
    });
    // The target never outlives the call.
    expect(commandTargetPath()).toEqual(["children", 0]);
  });

  test("a cold registry reports no selection at all", () => {
    resetWorkspaceWithTab();
    activeTab.value!.session.selection = [];
    const ctx = selectionCommandContext();
    expect(ctx.selection.count).toBe(0);
    expect(ctx.document.open).toBe(true);
  });
});

// ─── Placement, the cap and the ⋮ overflow ───────────────────────────────────

describe("the verb cluster", () => {
  test("renders the blockbar placement in group order and caps at BLOCKBAR_MAX_ITEMS", async () => {
    injectRegistry([
      record("test.one", { group: "1_a" }),
      record("test.two", { group: "1_b" }),
      record("test.three", { group: "1_c" }),
      record("test.four", { group: "1_d" }),
      record("test.five", { group: "1_e" }),
      record("test.six", { group: "1_f" }),
      record("test.seven", { group: "1_g" }),
    ]);
    setup();
    renderBlockActionBar();
    await flush();

    const shown = [...bar().querySelectorAll<HTMLElement>("[data-command]")].map(
      (b) => b.dataset.command,
    );
    expect(shown).toEqual(["test.one", "test.two", "test.three", "test.four", "test.five"]);
    expect(shown.length).toBe(BLOCKBAR_MAX_ITEMS);
    expect(bar().querySelector(".bar-overflow")).not.toBeNull();
  });

  test("the ⋮ menu carries the remainder with their names, chords and refusals", async () => {
    injectRegistry([
      record("test.one", { group: "1_a" }),
      record("test.two", { group: "1_b" }),
      record("test.three", { group: "1_c" }),
      record("test.four", { group: "1_d" }),
      record("test.five", { group: "1_e" }),
      record("test.six", { group: "1_f", keybinding: "mod+shift+6", title: "Sixth" }),
      record("test.seven", {
        destructive: true,
        enablement: () => false,
        group: "1_g",
        requires: "something that is not true",
        title: "Seventh",
      }),
    ]);
    setup();
    renderBlockActionBar();
    (bar().querySelector(".bar-overflow") as HTMLElement).click();
    await flush();

    const rows = [...document.querySelectorAll("#layer-popover sp-menu-item")];
    expect(rows.map((r) => (r as HTMLElement).dataset.command)).toEqual(["test.six", "test.seven"]);
    // Whatever the keymap formats — the surface prints it and does not restyle it.
    expect(rows[0]!.querySelector("kbd.cmd-chord")!.textContent).toBe("⌘⇧6");
    expect(rows[1]!.hasAttribute("disabled")).toBe(true);
    expect(rows[1]!.getAttribute("title")).toBe("Seventh — requires something that is not true");
    expect(rows[1]!.getAttribute("style")).toContain("var(--danger)");
  });

  test("a ⋮ row runs its command, and the menu closes behind it", async () => {
    const ran: string[] = [];
    injectRegistry([
      ...["a", "b", "c", "d", "e"].map((k) => record(`test.${k}`, { group: `1_${k}` })),
      record("test.last", {
        group: "9_z",
        run: () => {
          ran.push("last");
        },
      }),
    ]);
    setup();
    renderBlockActionBar();
    (bar().querySelector(".bar-overflow") as HTMLElement).click();
    await flush();
    (document.querySelector("#layer-popover sp-menu-item") as HTMLElement).click();
    expect(ran).toEqual(["last"]);
    expect(document.querySelector("#layer-popover sp-menu-item")).toBeNull();
  });

  test("opening the menu twice does not stack two of them", async () => {
    injectRegistry([
      ...["a", "b", "c", "d", "e"].map((k) => record(`test.${k}`, { group: `1_${k}` })),
      record("test.last", { group: "9_z" }),
    ]);
    setup();
    renderBlockActionBar();
    const overflow = bar().querySelector(".bar-overflow") as HTMLElement;
    overflow.click();
    overflow.click();
    await flush();
    expect(document.querySelectorAll("#layer-popover sp-menu-item")).toHaveLength(1);
  });
});

// ─── What a control says about itself ────────────────────────────────────────

describe("names, chords and refusals", () => {
  test("the tooltip is the chord when the verb can act and the reason when it cannot", () => {
    const registry = injectRegistry([
      record("test.ok", { keybinding: "mod+d", title: "Duplicate" }),
      record("test.no", {
        enablement: () => false,
        requires: "an element selection",
        title: "Delete",
      }),
    ]);
    expect(commandTooltip(registry, registry.get("test.ok")!)).toBe("Duplicate (⌘D)");
    expect(commandTooltip(registry, registry.get("test.no")!)).toBe(
      "Delete — requires an element selection",
    );
  });

  test("a chordless verb's tooltip is just its name", () => {
    const registry = injectRegistry([record("test.plain", { title: "Move Up" })]);
    expect(commandTooltip(registry, registry.get("test.plain")!)).toBe("Move Up");
  });

  test("the accessible name is the record's title, never the tooltip", async () => {
    injectRegistry([
      record("test.no", {
        enablement: () => false,
        requires: "an element selection",
        title: "Delete",
      }),
    ]);
    setup();
    renderBlockActionBar();
    await flush();
    const btn = bar().querySelector('[data-command="test.no"]')!;
    expect(btn.getAttribute("aria-label")).toBe("Delete");
    expect(btn.getAttribute("title")).toBe("Delete — requires an element selection");
  });

  test("a record with no icon draws its title rather than an empty button", () => {
    const registry = injectRegistry([
      record("test.plain", { title: "Duplicate" }),
      record("test.iconed", { icon: "sp-icon-delete", title: "Delete" }),
    ]);
    const container = document.createElement("div");
    litRender(commandIcon(registry.get("test.plain")!), container);
    expect(container.querySelector(".cmd-label")!.textContent).toBe("Duplicate");
    litRender(commandIcon(registry.get("test.iconed")!), container);
    expect(container.querySelector("sp-icon-delete")).not.toBeNull();
  });

  test("runCommand refuses a disabled verb rather than throwing at the surface", () => {
    let ran = 0;
    const registry = injectRegistry([
      record("test.no", {
        enablement: () => false,
        run: () => {
          ran += 1;
        },
      }),
      record("test.yes", {
        run: () => {
          ran += 1;
        },
      }),
    ]);
    runCommand(registry, "test.no");
    expect(ran).toBe(0);
    runCommand(registry, "test.yes");
    expect(ran).toBe(1);
  });

  test("runCommand with a target evaluates the record against that node", () => {
    setup(TWO_PARAGRAPHS, ["children", 1]);
    const seen: (JxPath | null)[] = [];
    const registry = injectRegistry([
      record("test.probe", {
        run: () => {
          seen.push(commandTargetPath());
        },
      }),
    ]);
    runCommand(registry, "test.probe", ["children", 0]);
    runCommand(registry, "test.probe");
    expect(seen).toEqual([
      ["children", 0],
      ["children", 1],
    ]);
  });
});

// ─── The keyboard model ──────────────────────────────────────────────────────

describe("role=toolbar and the roving tabindex", () => {
  beforeEach(async () => {
    setup();
    renderBlockActionBar();
    await flush();
  });

  test("the bar declares itself a toolbar", () => {
    expect(bar().getAttribute("role")).toBe("toolbar");
    expect(bar().getAttribute("aria-label")).toBe("Block actions");
    expect(bar().getAttribute("aria-orientation")).toBe("horizontal");
  });

  test("exactly one control is in the tab order", () => {
    const tabbable = items().filter((el) => el.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(items().length).toBeGreaterThan(3);
  });

  test("⌥↑ enters the bar from the canvas", () => {
    const e = new KeyboardEvent("keydown", { altKey: true, cancelable: true, key: "ArrowUp" });
    handleBlockBarEntryKey(e);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items()[0]!);
  });

  test("⌥↑ with another modifier, or on another key, is not the entry chord", () => {
    for (const init of [
      { altKey: true, key: "ArrowDown" },
      { altKey: true, key: "ArrowUp", shiftKey: true },
      { key: "ArrowUp" },
    ]) {
      const e = new KeyboardEvent("keydown", { cancelable: true, ...init });
      handleBlockBarEntryKey(e);
      expect(e.defaultPrevented).toBe(false);
    }
  });

  test("⌥↑ is refused while a modal owns the keyboard, and when there is no bar", () => {
    const slot = document.createElement("div");
    slot.innerHTML = "<sp-dialog-wrapper open></sp-dialog-wrapper>";
    document.querySelector("#layer-dialog")!.append(slot);
    const blocked = new KeyboardEvent("keydown", {
      altKey: true,
      cancelable: true,
      key: "ArrowUp",
    });
    handleBlockBarEntryKey(blocked);
    expect(blocked.defaultPrevented).toBe(false);
    slot.remove();

    dismissBlockActionBar();
    const gone = new KeyboardEvent("keydown", { altKey: true, cancelable: true, key: "ArrowUp" });
    handleBlockBarEntryKey(gone);
    expect(gone.defaultPrevented).toBe(false);
  });

  test("← and → walk the controls and wrap; Home and End go to the ends", () => {
    const key = (k: string) =>
      bar().dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: k }),
      );
    handleBlockBarEntryKey(
      new KeyboardEvent("keydown", { altKey: true, cancelable: true, key: "ArrowUp" }),
    );
    const all = items().filter((el) => !el.hasAttribute("disabled"));

    key("ArrowRight");
    expect(document.activeElement).toBe(all[1]!);
    key("ArrowLeft");
    key("ArrowLeft"); // Wraps backwards off the front.
    expect(document.activeElement).toBe(all.at(-1)!);
    key("Home");
    expect(document.activeElement).toBe(all[0]!);
    key("End");
    expect(document.activeElement).toBe(all.at(-1)!);
    // The focused control is the one in the tab order — the toolbar does not reset to its first.
    expect(all.at(-1)!.tabIndex).toBe(0);
    expect(all[0]!.tabIndex).toBe(-1);
  });

  test("Escape closes the ⋮ menu and hands the keyboard back", async () => {
    useCommandRegistry(null);
    injectRegistry([
      ...["a", "b", "c", "d", "e"].map((k) => record(`test.${k}`, { group: `1_${k}` })),
      record("test.last", { group: "9_z" }),
    ]);
    renderBlockActionBar();
    (bar().querySelector(".bar-overflow") as HTMLElement).click();
    await flush();
    expect(document.querySelector("#layer-popover sp-menu-item")).not.toBeNull();

    bar().dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
    );
    expect(document.querySelector("#layer-popover sp-menu-item")).toBeNull();
  });

  test("a disabled control is skipped by the arrows but still rendered", () => {
    // ONE shape: the control keeps its slot, so nothing moves under the cursor — but the keyboard
    // Does not stop on something that cannot act.
    const disabled = items().filter((el) => el.hasAttribute("disabled"));
    expect(disabled.length).toBeGreaterThan(0);
    handleBlockBarEntryKey(
      new KeyboardEvent("keydown", { altKey: true, cancelable: true, key: "ArrowUp" }),
    );
    for (let i = 0; i < items().length + 2; i++) {
      bar().dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
      );
      expect(disabled).not.toContain(document.activeElement as HTMLElement);
    }
  });
});

describe("a non-canvas editor refuses the movers, as it already refused Delete", () => {
  /*
   * The Outline renders whatever `activeTab.value.doc.document` is, and with Project Settings open
   * that is the project CONFIGURATION drawn as a layer tree. `hasSelection` carries
   * `editor.kind === "canvas"` for exactly this reason and Delete/Duplicate were gated by it — but
   * the four movers gate on `structuralTarget()`, which asked only about the path, and Convert to
   * Component asked only about the selection kind. So the row menu dropped Delete and Duplicate and
   * still rendered Move Up / Move Down / Move Into Previous / Move Out of Parent, each of which
   * `transactDoc`s an element splice straight into `project.json` and saves it.
   */
  function registryOverMode(mode: string): CommandRegistry {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p" }, { tagName: "p" }],
      tagName: "div",
    } as never);
    tab.session.selection = [["children", 1]] as never;
    tab.session.ui.canvasMode = mode;
    const registry = createCommandRegistry({ getContext: selectionCommandContext });
    registerSelectionCommands(registry, {
      convertToComponent: () => {},
      navigateToComponent: () => {},
    });
    return registry;
  }

  const MOVERS = ["selection.moveUp", "selection.moveIn", "selection.moveOut"];

  test("on the canvas they are live — the selection really is movable", () => {
    const registry = registryOverMode("design");
    expect(registry.isEnabled("selection.moveUp")).toBe(true);
    expect(registry.isEnabled("selection.convertToComponent")).toBe(true);
  });

  test("with Project Settings open every one of them is refused", () => {
    // `settings` → `editorKindForMode` = "config", the state in which the Outline is drawing the
    // Project configuration object.
    const registry = registryOverMode("settings");
    for (const id of [...MOVERS, "selection.convertToComponent"]) {
      expect([id, registry.isEnabled(id)]).toEqual([id, false]);
    }
  });

  test("…and in the source editor too, which is the same non-canvas case", () => {
    const registry = registryOverMode("source");
    for (const id of MOVERS) {
      expect([id, registry.isEnabled(id)]).toEqual([id, false]);
    }
  });
});
