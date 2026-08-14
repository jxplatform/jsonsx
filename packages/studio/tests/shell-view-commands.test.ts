/**
 * The shell's `view.*` verbs — the setters that retire `view.toggleActivity`.
 *
 * Plan §13.3 clause 3 is what this file tests: a setter means the same thing twice in a row and
 * from any starting state, and an undeclared panel id is a REFUSAL whose message names the declared
 * set. The drift guard at the bottom is the other half — the `args` enum is only worth having if it
 * is the same list the rail and the Inspector actually render.
 */
import { resetWorkspaceWithTab } from "./harness";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { checkPlacements } from "../src/commands/levels";
import {
  applyChromeTheme,
  CHROME_THEMES,
  INSPECTOR_TAB_IDS,
  mountShell,
  NAVIGATOR_PANEL_IDS,
  registerShellViewCommands,
  setChromeTheme,
  shell,
  shellViewCommands,
  unmountShell,
} from "../src/shell";
import type { CommandContext } from "../src/commands/context";
import type { CommandRegistry } from "../src/commands/registry";
import type { InspectorTabId } from "../src/shell";

const setInspectorTab = mock((_tab: InspectorTabId) => {});

/** What the Inspector currently shows, as `view.setAssistant { open: false }` reads it. */
let currentTab: InspectorTabId = "properties";
const deps = {
  inspectorTab: () => currentTab,
  setInspectorTab,
};

let ctx: CommandContext = makeContext();
let registry: CommandRegistry;

function build(patch: Parameters<typeof makeContext>[0] = {}): CommandRegistry {
  ctx = makeContext({ document: { open: true }, project: { open: true }, ...patch });
  const built = createCommandRegistry({ getContext: () => ctx });
  registerShellViewCommands(built, deps);
  return built;
}

beforeEach(() => {
  setInspectorTab.mockClear();
  currentTab = "properties";
  localStorage.clear();
  document.body.textContent = "";
  const app = document.createElement("div");
  app.id = "app";
  document.body.append(app);
  shell.leftTab = "layers";
  shell.theme = "dark";
  shell.docks.left.collapsed = false;
  shell.docks.right.collapsed = false;
  registry = build();
});

describe("the records themselves", () => {
  test("every one satisfies the level × placement matrix", () => {
    expect(checkPlacements(shellViewCommands(deps))).toEqual([]);
  });

  test("every id registers, and the only toggle is the one with a setter beside it", () => {
    const ids = registry.list().map((c) => c.id);
    expect(ids).toEqual([
      "view.setActivity",
      "view.setRightTab",
      "view.setNavigator",
      "view.setRightPanel",
      "view.setBottomDock",
      "view.toggleBottomDock",
      "view.setBottomTab",
      "view.setAssistant",
      "view.setLayout",
      "view.saveLayout",
      "view.renameLayout",
      "view.deleteLayout",
      "view.resetLayout",
      "view.setTheme",
    ]);
    // ⌘J is the one toggle this module declares, and it is here rather than in
    // `commands/defaults.ts` because the dock it flips is on THIS record. §13.3 clause 3's bargain
    // Is a setter beside it, which is `view.setBottomDock` two rows up.
    expect(ids.filter((id) => /\.toggle[A-Z]/.test(id))).toEqual(["view.toggleBottomDock"]);
  });

  test("every record that takes arguments declares a schema for them", () => {
    // The palette prompt and the AI parameter list are both projections of `args`, so a verb with
    // Parameters must declare them — and `view.resetLayout`, which has none, must NOT declare an
    // Empty schema that would have the palette prompt for nothing.
    const undeclared = registry
      .list()
      .filter((command) => !command.args)
      .map((command) => command.id);
    expect(undeclared).toEqual(["view.toggleBottomDock", "view.resetLayout"]);
  });
});

describe("view.setActivity", () => {
  test("shows the panel and opens the Navigator dock", () => {
    shell.docks.left.collapsed = true;
    void registry.run("view.setActivity", { tab: "git" });
    expect(shell.leftTab).toBe("git");
    expect(shell.docks.left.collapsed).toBe(false);
  });

  test("is idempotent — running it twice does not collapse the dock", () => {
    void registry.run("view.setActivity", { tab: "data" });
    void registry.run("view.setActivity", { tab: "data" });
    expect(shell.leftTab).toBe("data");
    expect(shell.docks.left.collapsed).toBe(false);
  });

  test("refuses an undeclared panel id, naming every declared one", () => {
    // "head" is one of the three ids this phase renamed, so it is exactly the kind of value a
    // Stale script or an older session still carries.
    expect(() => registry.run("view.setActivity", { tab: "head" })).toThrow(
      'command "view.setActivity" argument "tab": "head" is not declared — declared: ' +
        "files, search, git, layers, page, data, packages, insert",
    );
    expect(shell.leftTab).toBe("layers");
  });

  test('refuses "problems", which is a Bottom dock tab and not a Navigator panel (§7.2)', () => {
    // Not a rename — a MOVE. `view.setBottomTab { tab: "problems" }` is the verb that shows it,
    // And this enum naming it too would be a second door onto a surface with one host.
    expect(() => registry.run("view.setActivity", { tab: "problems" })).toThrow(
      'argument "tab": "problems" is not declared',
    );
    expect(shell.leftTab).toBe("layers");
  });

  test("its enum is exactly the declared panel set", () => {
    const schema = registry.get("view.setActivity")?.args as {
      properties: { tab: { enum: string[] } };
    };
    expect(schema.properties.tab.enum).toEqual([...NAVIGATOR_PANEL_IDS]);
  });

  test("needs an open project", () => {
    const closed = createCommandRegistry({ getContext: () => makeContext() });
    registerShellViewCommands(closed, deps);
    expect(closed.isVisible("view.setActivity")).toBe(false);
  });
});

describe("view.setRightTab", () => {
  test("hands the declared tab to the Inspector", () => {
    void registry.run("view.setRightTab", { tab: "style" });
    expect(setInspectorTab).toHaveBeenCalledWith("style");
  });

  test('accepts "assistant" — it is the dock\'s fourth tab, not another dock', () => {
    void registry.run("view.setRightTab", { tab: "assistant" });
    expect(setInspectorTab).toHaveBeenCalledWith("assistant");
  });

  test("refuses an undeclared tab, naming the four that exist", () => {
    expect(() => registry.run("view.setRightTab", { tab: "content" })).toThrow(
      "declared: properties, style, events, assistant",
    );
    expect(setInspectorTab).not.toHaveBeenCalled();
  });

  test("is hidden with no document open", () => {
    const closed = createCommandRegistry({ getContext: () => makeContext({ project: {} }) });
    registerShellViewCommands(closed, deps);
    expect(closed.isVisible("view.setRightTab")).toBe(false);
  });
});

describe("the Bottom dock's three verbs", () => {
  test("setBottomDock means the same thing twice, from either starting state", () => {
    void registry.run("view.setBottomDock", { open: true });
    expect(shell.docks.bottom.collapsed).toBe(false);
    void registry.run("view.setBottomDock", { open: true });
    expect(shell.docks.bottom.collapsed).toBe(false);
    void registry.run("view.setBottomDock", { open: false });
    expect(shell.docks.bottom.collapsed).toBe(true);
  });

  test("⌘J's toggle flips it, and the setter is what a script uses instead", () => {
    shell.docks.bottom.collapsed = true;
    void registry.run("view.toggleBottomDock", {});
    expect(shell.docks.bottom.collapsed).toBe(false);
    void registry.run("view.toggleBottomDock", {});
    expect(shell.docks.bottom.collapsed).toBe(true);
  });

  test("setBottomTab selects a tab and opens the dock that hosts it", () => {
    shell.docks.bottom.collapsed = true;
    void registry.run("view.setBottomTab", { tab: "activity" });
    expect(shell.bottomTab).toBe("activity");
    expect(shell.docks.bottom.collapsed).toBe(false);
  });

  test("an undeclared tab is a refusal naming the declared set", () => {
    expect(() => registry.get("view.setBottomTab")!.run(ctx, { tab: "deploy" } as never)).toThrow(
      /problems/,
    );
    expect(shell.bottomTab).not.toBe("deploy");
  });
});

describe("view.setNavigator / view.setRightPanel / view.setAssistant", () => {
  test("setNavigator closes the dock without needing to know it was open", () => {
    void registry.run("view.setNavigator", { open: false });
    expect(shell.docks.left.collapsed).toBe(true);
    void registry.run("view.setNavigator", { open: false });
    expect(shell.docks.left.collapsed).toBe(true);
    void registry.run("view.setNavigator", { open: true });
    expect(shell.docks.left.collapsed).toBe(false);
  });

  test("false closes and true opens, in either order", () => {
    void registry.run("view.setRightPanel", { open: false });
    expect(shell.docks.right.collapsed).toBe(true);
    void registry.run("view.setRightPanel", { open: false });
    expect(shell.docks.right.collapsed).toBe(true);
    void registry.run("view.setRightPanel", { open: true });
    expect(shell.docks.right.collapsed).toBe(false);
  });

  test("the assistant selects its tab and opens the dock that hosts it", () => {
    shell.docks.right.collapsed = true;
    void registry.run("view.setAssistant", { open: true });
    expect(setInspectorTab).toHaveBeenLastCalledWith("assistant");
    expect(shell.docks.right.collapsed).toBe(false);
    // Idempotent: saying it twice means what it meant once.
    void registry.run("view.setAssistant", { open: true });
    expect(shell.docks.right.collapsed).toBe(false);
  });

  test("closing it steps off the Assistant tab and leaves the dock open", () => {
    currentTab = "assistant";
    void registry.run("view.setAssistant", { open: false });
    expect(setInspectorTab).toHaveBeenLastCalledWith("properties");
    expect(shell.docks.right.collapsed).toBe(false);
  });

  test("closing it does NOT disturb a tab that is not the assistant", () => {
    // The whole reason the verb reads the current tab: a shot that closes the assistant must not
    // Also lose the Style tab the next step was about to photograph.
    currentTab = "style";
    void registry.run("view.setAssistant", { open: false });
    expect(setInspectorTab).not.toHaveBeenCalled();
  });

  test("a missing `open` is a refusal, not a toggle", () => {
    expect(() => registry.run("view.setAssistant", {})).toThrow(
      'command "view.setAssistant" argument "open": expected a boolean, got missing',
    );
  });
});

describe("view.setTheme", () => {
  test("writes the record, persists it and paints <sp-theme>", () => {
    const theme = document.createElement("sp-theme");
    theme.setAttribute("color", "dark");
    document.body.append(theme);
    mountShell();

    void registry.run("view.setTheme", { color: "light" });
    expect(shell.theme).toBe("light");
    expect(theme.getAttribute("color")).toBe("light");
    expect(localStorage.getItem("jx-studio-theme")).toBe("light");
    unmountShell();
  });

  test("applies without an <sp-theme> present rather than throwing", () => {
    setChromeTheme("light");
    expect(() => applyChromeTheme()).not.toThrow();
  });

  test("setting the theme it already has is a no-op that still persists nothing new", () => {
    setChromeTheme("dark");
    expect(localStorage.getItem("jx-studio-theme")).toBeNull();
  });

  test("refuses an undeclared colour", () => {
    expect(() => registry.run("view.setTheme", { color: "darkest" })).toThrow(
      `declared: ${CHROME_THEMES.join(", ")}`,
    );
  });

  test("survives storage that refuses to write", () => {
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    try {
      expect(() => setChromeTheme("light")).not.toThrow();
      expect(shell.theme).toBe("light");
    } finally {
      localStorage.setItem = original;
    }
  });
});

describe("the enums do not drift from what the shell renders", () => {
  /** The `value:` literals a panel module declares, in source order. */
  function declaredValues(file: string): string[] {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    return [...source.matchAll(/value:\s*"([\w-]+)"/g)].map((m) => m[1] as string);
  }

  test("the rail renders exactly NAVIGATOR_PANEL_IDS", () => {
    // The rail no longer declares any ids — it renders `railGroups()`. The guard is now that the
    // Registry and this enum agree, which is asserted in `tests/panel-registry.test.ts`; here we
    // Only check that the rail really has stopped keeping its own list.
    expect(declaredValues("../src/panels/activity-bar.ts")).toEqual([]);
    expect(NAVIGATOR_PANEL_IDS.length).toBe(8);
  });

  test("the Inspector renders exactly INSPECTOR_TAB_IDS", () => {
    // The Inspector no longer declares any ids either — it renders `commands/defaults.ts`'s
    // `INSPECTOR_TABS`, and `tests/right-panel.test.ts` asserts that list and this enum agree.
    expect(declaredValues("../src/panels/right-panel.ts")).toEqual([]);
    expect(INSPECTOR_TAB_IDS).toEqual(["properties", "style", "events", "assistant"]);
  });
});

describe("the workspace still behaves", () => {
  test("a tab can be opened alongside — the records touch no document state", () => {
    const tab = resetWorkspaceWithTab();
    void registry.run("view.setActivity", { tab: "layers" });
    expect(tab.session.selection).toEqual([]);
  });
});

describe("a dock selector composes the panel's own `when`", () => {
  /*
   * `panel.focus.<id>` declares `when: ctx.project.open && (panel.when?.(ctx) ?? true)`; its two
   * enum peers declared only `projectOpen` and no `when` at all. So one surface answered two ways:
   * `panel.focus.search` was permanently unavailable — no palette row, no chord — while
   * `view.setActivity { tab: "search" }` succeeded from the palette, `__jxAutomation` and the
   * `show_navigator_panel` AI tool, wrote `shell.leftTab = "search"`, un-collapsed the dock and
   * PERSISTED it. The Navigator then drew "No Navigator panel is registered as 'search'" — a
   * sentence that is false; the panel is registered, it is gated off.
   *
   * `enablement` cannot see an argument, so the refusal is on the ARG, the shape `pane.derive`
   * already uses for a preset the document cannot support.
   */
  const gated = (id: string) => id === "search" || id === "logic";
  const withGate = () => {
    ctx = makeContext({ document: { open: true }, project: { open: true } });
    const built = createCommandRegistry({ getContext: () => ctx });
    registerShellViewCommands(built, { ...deps, panelAvailable: (id) => !gated(id) });
    return built;
  };

  test("a gated-off Navigator panel is refused, and nothing is persisted", async () => {
    const built = withGate();
    const before = shell.leftTab;
    // Thrown SYNCHRONOUSLY: this record's `run` is not async, and `registry.run` returns
    // `void | Promise<void>` — so the refusal arrives as a throw, not a rejection.
    expect(() => built.run("view.setActivity", { tab: "search" })).toThrow(
      /registered but not available/,
    );
    expect(shell.leftTab).toBe(before);
  });

  test("a gated-off Bottom tab is refused the same way", async () => {
    const built = withGate();
    const before = shell.bottomTab;
    expect(() => built.run("view.setBottomTab", { tab: "logic" })).toThrow(
      /registered but not available/,
    );
    expect(shell.bottomTab).toBe(before);
  });

  test("an available panel still shows, and an absent probe changes nothing", async () => {
    const built = withGate();
    await built.run("view.setActivity", { tab: "files" });
    expect(shell.leftTab).toBe("files");
    // No probe injected (the CI projection builds the set without one) — unchanged behaviour.
    const bare = build();
    await bare.run("view.setActivity", { tab: "search" });
    expect(shell.leftTab).toBe("search");
  });
});
