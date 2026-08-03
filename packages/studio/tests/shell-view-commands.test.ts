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

  test("all five ids register, and none of them is a toggle", () => {
    const ids = registry.list().map((c) => c.id);
    expect(ids).toEqual([
      "view.setActivity",
      "view.setRightTab",
      "view.setNavigator",
      "view.setRightPanel",
      "view.setAssistant",
      "view.setTheme",
    ]);
    expect(ids.filter((id) => /\.toggle[A-Z]/.test(id))).toEqual([]);
  });

  test("every record declares an args schema — the palette prompt and the AI parameters", () => {
    for (const command of registry.list()) {
      expect(command.args).toBeDefined();
    }
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
    void registry.run("view.setActivity", { tab: "state" });
    void registry.run("view.setActivity", { tab: "state" });
    expect(shell.leftTab).toBe("state");
    expect(shell.docks.left.collapsed).toBe(false);
  });

  test("refuses an undeclared panel id, naming every declared one", () => {
    // "head" is one of the three ids this phase renamed, so it is exactly the kind of value a
    // Stale script or an older session still carries.
    expect(() => registry.run("view.setActivity", { tab: "head" })).toThrow(
      'command "view.setActivity" argument "tab": "head" is not declared — declared: ' +
        "files, search, git, problems, layers, page, data, packages, insert, state",
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
    expect(NAVIGATOR_PANEL_IDS.length).toBe(10);
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
    expect(tab.session.selection).toBeNull();
  });
});
