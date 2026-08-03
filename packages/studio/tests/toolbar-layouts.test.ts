/**
 * The Command Bar's layout tabs — region ①b.
 *
 * A separate file from `toolbar.test.ts` because the tabs need two things that suite deliberately
 * does without: the shell's own `view.*` records (its registry is built from `defaults.ts` alone),
 * and a stubbed prompt dialog for the `+` and the double-click rename.
 *
 * What the cases defend: the tabs are a RENDERING of `shell.layouts` (not a hand-kept list), every
 * gesture goes through a command, and applying a layout never removes a surface.
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/** What the next prompt resolves to. `null` is the user cancelling. */
let promptResult: string | null = null;

const promptHeadlines: string[] = [];
const showPromptDialog = mock((headline: string) => {
  promptHeadlines.push(headline);
  return Promise.resolve(promptResult);
});

const realLayers = await import("../src/ui/layers");
void mock.module("../src/ui/layers.js", () => ({ ...realLayers, showPromptDialog }));

const toolbar = await import("../src/panels/toolbar");
const { applyLayout, registerShellViewCommands, resetProjectShell, shell, syncProjectLayouts } =
  await import("../src/shell");
const { setInspectorTab } = await import("../src/panels/right-panel");
const { setWorkspaceProject } = await import("../src/workspace/workspace");
const { createCommandRegistry } = await import("../src/commands/registry");
const { makeContext } = await import("../src/commands/context");
const { setActiveRegistry } = await import("../src/commands/active-registry");

let projectOpen = true;

function installRegistry() {
  const registry = createCommandRegistry({
    getContext: () => makeContext({ document: { open: true }, project: { open: projectOpen } }),
    mac: true,
  });
  registerShellViewCommands(registry, {
    inspectorTab: () => "properties",
    setInspectorTab,
  });
  setActiveRegistry(registry);
}

function tabs(): HTMLElement[] {
  return [...root.querySelectorAll(".tb-layout")] as HTMLElement[];
}

function tabNamed(name: string): HTMLElement {
  const match = tabs().find((el) => el.textContent?.trim() === name);
  if (!match) {
    throw new Error(`no layout tab "${name}"`);
  }
  return match;
}

function click(el: Element, type = "click"): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
}

let root: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  projectOpen = true;
  promptResult = null;
  promptHeadlines.length = 0;
  showPromptDialog.mockClear();
  setWorkspaceProject(null);
  resetProjectShell();
  syncProjectLayouts(null);
  setInspectorTab("properties");
  shell.leftTab = "layers";
  shell.docks.left = { collapsed: false, width: 240 };
  shell.docks.right = { collapsed: false, width: 280 };
  installMockPlatform();
  installRegistry();
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  toolbar.unmount();
  root.remove();
  setActiveRegistry(null);
  setWorkspaceProject(null);
  delete (globalThis as Record<string, unknown>).__jxPlatform;
});

describe("the tabs", () => {
  test("render the project's layouts as plain text, with the active one marked", async () => {
    toolbar.mount(root);
    await flush();
    expect(tabs().map((el) => el.textContent?.trim())).toEqual([
      "Write",
      "Design",
      "Build",
      "Ship",
    ]);
    expect(tabNamed("Design").getAttribute("aria-selected")).toBe("true");
    expect(tabNamed("Write").getAttribute("aria-selected")).toBe("false");
  });

  test("are a rendering of the record — a saved layout appears without a second list", async () => {
    toolbar.mount(root);
    await flush();
    shell.layouts.push({
      docks: { left: { collapsed: false, width: 200 }, right: { collapsed: false, width: 200 } },
      id: "proofread",
      inspectorTab: "properties",
      name: "Proofread",
      navigatorPanel: "files",
    });
    await flush();
    expect(tabs().map((el) => el.textContent?.trim())).toContain("Proofread");
  });

  test("clicking one adopts it, and the band repaints from the shell record", async () => {
    toolbar.mount(root);
    await flush();
    click(tabNamed("Ship"));
    await flush();
    expect(shell.layout).toBe("ship");
    expect(shell.leftTab).toBe("git");
    expect(tabNamed("Ship").getAttribute("aria-selected")).toBe("true");
  });

  test("applying a layout reconfigures without removing — the tabs all stay", async () => {
    toolbar.mount(root);
    await flush();
    click(tabNamed("Ship"));
    await flush();
    // Ship collapses the Inspector; nothing has left the bar, and nothing has left the record.
    expect(shell.docks.right.collapsed).toBe(true);
    expect(tabs()).toHaveLength(4);
  });

  test("the whole cluster is absent with no project open — a layout is a project's own", async () => {
    projectOpen = false;
    toolbar.mount(root);
    await flush();
    expect(root.querySelector(".tb-layouts")).toBeNull();
  });
});

describe("+ saves the current arrangement", () => {
  test("prompts, then runs view.saveLayout with the answer", async () => {
    shell.leftTab = "problems";
    promptResult = "Triage";
    toolbar.mount(root);
    await flush();

    click(root.querySelector(".tb-layout-add")!);
    await flush();
    await flush();
    expect(promptHeadlines).toEqual(["Save layout"]);
    expect(shell.layouts.at(-1)?.name).toBe("Triage");
    expect(shell.layouts.at(-1)?.navigatorPanel).toBe("problems");
    expect(shell.layout).toBe("triage");
  });

  test("cancelling saves nothing", async () => {
    promptResult = null;
    toolbar.mount(root);
    await flush();
    click(root.querySelector(".tb-layout-add")!);
    await flush();
    await flush();
    expect(shell.layouts).toHaveLength(4);
  });
});

describe("double-click renames", () => {
  test("prompts with the current name and runs view.renameLayout", async () => {
    promptResult = "Draft";
    toolbar.mount(root);
    await flush();

    click(tabNamed("Write"), "dblclick");
    await flush();
    await flush();
    expect(promptHeadlines).toEqual(["Rename layout"]);
    expect(shell.layouts[0]!.name).toBe("Draft");
    expect(shell.layouts[0]!.id).toBe("write");
  });

  test("cancelling leaves the name alone", async () => {
    promptResult = null;
    toolbar.mount(root);
    await flush();
    click(tabNamed("Build"), "dblclick");
    await flush();
    await flush();
    expect(shell.layouts[2]!.name).toBe("Build");
  });
});

describe("the prompt helpers are the gesture's one implementation", () => {
  test("saveLayoutPrompt and renameLayoutPrompt route through the registry", async () => {
    const registry = createCommandRegistry({
      getContext: () => makeContext({ project: { open: true } }),
    });
    registerShellViewCommands(registry, {
      inspectorTab: () => "style",
      setInspectorTab,
    });
    applyLayout("write", { inspectorTab: () => "style", setInspectorTab });

    promptResult = "Saved";
    await toolbar.saveLayoutPrompt(registry);
    expect(shell.layouts.at(-1)?.name).toBe("Saved");

    promptResult = "Renamed";
    await toolbar.renameLayoutPrompt(registry, "saved", "Saved");
    expect(shell.layouts.at(-1)?.name).toBe("Renamed");
  });
});
