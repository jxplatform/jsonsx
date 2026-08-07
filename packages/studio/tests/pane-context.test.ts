/**
 * The pane's chrome — the context bar (region ⑦) and the floating zoom pod (region ⑩).
 *
 * These cases are the old `tab-bar` suite re-aimed at what replaced it. The claims that changed:
 *
 * - **Three labelled axes, not five unlabelled controls.** Every axis renders under its own name, and
 *   the tests assert the names, because the label is the whole point of the restructure.
 * - **Preview is a value, not a toggle.** `Edit │ Design │ Preview` is one radio group; there is no
 *   `toggles` button anywhere in the bar for it to compose with.
 * - **The rendering context only selects.** Its popover ends in "Manage contexts…", which runs
 *   `settings.open` — the definition site — rather than defining anything itself.
 * - **The pod floats.** Zoom left the band; the fit picker writes the declared {@link FitMode}.
 * - **The band is where a standing statement goes.** `collab/presence-chips.ts` wrote the read-only
 *   banner (§7.4) and nothing rendered it; this is the surface that owes it a home, because it is
 *   the per-document chrome directly above the editing surface.
 */
import {
  flush,
  installMockPlatform,
  pointer,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Tab } from "../src/tabs/tab";

const paneContext = await import("../src/panels/pane-context");
const { activeTab, closeAllTabs } = await import("../src/workspace/workspace");
const { getFit, hasDeclaredFit, resetFits } = await import("../src/canvas/canvas-utils");
const { createCommandRegistry } = await import("../src/commands/registry");
const { makeContext } = await import("../src/commands/context");
const { setActiveRegistry } = await import("../src/commands/active-registry");
const { collabState } = await import("../src/collab/collab-state");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type Ctx = Parameters<typeof paneContext.mount>[1];

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    exportFile: mock(() => {}),
    getCanvasMode: mock(() => "edit"),
    parseMediaEntries: mock(() => ({
      baseWidth: 1200,
      featureQueries: [] as { name: string; query: string }[],
      sizeBreakpoints: [] as { name: string; query: string; width: number; type: string }[],
    })),
    setCanvasMode: mock((_mode: string) => {}),
    ...overrides,
  } as Ctx;
}

/**
 * A ctx in `mode`, with the focused pane's tab put into it too.
 *
 * Both, because both are now read. The zoom pod asks `canvasModeOfPane` — THIS pane's effective
 * mode — rather than `ctx.getCanvasMode()`, which answers for whichever pane has focus and so drew
 * an `editZoom` control over a stage rendering Design the moment two panes existed. A fixture that
 * set only the ctx was describing a state the app cannot be in.
 */
function ctxInMode(mode: string, overrides: Partial<Ctx> = {}): Ctx {
  const tab = activeTab.value;
  if (tab) {
    tab.session.ui.canvasMode = mode;
    tab.session.ui.preview = false;
  }
  return makeCtx({ getCanvasMode: mock(() => mode), ...overrides });
}

function openTestTab(): Tab {
  const tab = resetWorkspaceWithTab(
    { children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" },
    { documentPath: "/project/index.json", id: "pane-context-tab" },
  );
  tab.capabilities.modes = ["edit", "design", "preview", "source"];
  return tab;
}

/** Every button in the chrome, by trimmed text. */
function buttons(): HTMLElement[] {
  return [...root.querySelectorAll("sp-action-button")] as HTMLElement[];
}

function btn(label: string): HTMLElement {
  const match = buttons().find((b) => (b.textContent || "").trim() === label);
  if (!match) {
    throw new Error(`no button labelled "${label}" — have: ${labels().join(", ")}`);
  }
  return match;
}

function labels(): string[] {
  return buttons().map((b) => (b.textContent || "").trim());
}

function hasBtn(label: string): boolean {
  return buttons().some((b) => (b.textContent || "").trim() === label);
}

/** The axis labels the bar prints, in order — the assertion the restructure exists for. */
function axes(): string[] {
  return [...root.querySelectorAll(".pc-axis-label")].map((el) => el.textContent?.trim() ?? "");
}

/** A registry holding only what the chrome reaches for, so a click is observable. */
function installRegistry(ran: string[]) {
  const registry = createCommandRegistry({ getContext: () => makeContext(), mac: true });
  registry.register({
    category: "Project",
    group: "7_settings",
    id: "settings.open",
    level: "project",
    menus: ["palette"],
    run: (_ctx, args) =>
      void ran.push(`settings.open:${String((args as { section?: string }).section)}`),
    title: "Open Settings",
  });
  setActiveRegistry(registry);
}

let root: HTMLElement;

beforeEach(() => {
  closeAllTabs();
  resetStudioState();
  installMockPlatform();
  resetFits();
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  paneContext.unmount();
  setActiveRegistry(null);
  root.remove();
});

// ─── The band itself ──────────────────────────────────────────────────────────

describe("the bar", () => {
  test("renders the three labelled axes for an ordinary editor tab", async () => {
    openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();
    expect(root.querySelector(".pane-context")).not.toBeNull();
    expect(axes()).toEqual(["Editor", "View", "Context"]);
  });

  test("renders nothing — and no stage offset — when there is no active tab", async () => {
    paneContext.mount(root, makeCtx());
    await flush();
    expect(root.querySelector(".pane-context")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--pane-context-h")).toBe("0px");
  });

  test("offsets the stage by the bar's height while a bar is on screen", async () => {
    openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();
    expect(document.documentElement.style.getPropertyValue("--pane-context-h")).toBe("28px");
    paneContext.unmount();
    expect(document.documentElement.style.getPropertyValue("--pane-context-h")).toBe("0px");
  });

  test("render() is inert before mount and after unmount", async () => {
    openTestTab();
    paneContext.render();
    expect(root.childElementCount).toBe(0);
    paneContext.mount(root, makeCtx());
    await flush();
    paneContext.unmount();
    paneContext.render();
    expect(root.querySelector(".pane-context")).not.toBeNull();
  });

  test("no read-only banner while the document has no collaboration to report", async () => {
    openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();
    expect(root.querySelector(".jx-collab-banner")).toBeNull();
  });

  test("a read-only collaborator gets the banner, above the stage, before the first keystroke", async () => {
    const tab = openTestTab();
    paneContext.mount(root, makeCtx());
    const state = collabState(tab);
    state.active = true;
    state.readOnly = true;
    await flush();
    const banner = root.querySelector<HTMLElement>('.jx-collab-banner[data-kind="read-only"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("not published to the other people");
    expect(banner?.getAttribute("role")).toBe("status");
    // Inside the band the stage is offset by, so it pushes the document down rather than over it.
    expect(root.querySelector(".pc-band")?.contains(banner!)).toBe(true);
  });

  test("the banner appears and disappears with the permission, without another edit", async () => {
    const tab = openTestTab();
    paneContext.mount(root, makeCtx());
    const state = collabState(tab);
    state.active = true;
    await flush();
    expect(root.querySelector(".jx-collab-banner")).toBeNull();

    state.readOnly = true;
    await flush();
    expect(root.querySelector(".jx-collab-banner")).not.toBeNull();

    state.readOnly = false;
    await flush();
    expect(root.querySelector(".jx-collab-banner")).toBeNull();
  });

  test("a logic editor keeps the banner — a frozen guest is still a guest", async () => {
    const tab = openTestTab();
    paneContext.mount(root, makeCtx());
    const state = collabState(tab);
    state.active = true;
    state.readOnly = true;
    tab.session.ui.editingFunction = { defName: "greet", type: "def" };
    await flush();
    expect(root.querySelector(".jx-collab-banner")).not.toBeNull();
  });
});

// ─── There is no takeover ─────────────────────────────────────────────────────

describe("a logic editor open in the dock", () => {
  // The bar used to blank itself the moment `editingFunction` or `editingFormula` was set, on the
  // Grounds that a full-screen sub-editor owned the stage. P8 put both in the Bottom dock's Logic
  // Tab and left the page rendering underneath, so the axes describe the document that is still on
  // Screen and the pod still has something to zoom. Suppressing them removed the controls for the
  // Document the reader could see.
  test("leaves all three axes and the zoom pod exactly where they were", async () => {
    const tab = openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();
    const before = axes();
    expect(before).toEqual(["Editor", "View", "Context"]);

    tab.session.ui.editingFunction = { defName: "greet", type: "def" };
    await flush();
    expect(axes()).toEqual(before);
    expect(root.querySelector(".pane-zoom")).not.toBeNull();

    tab.session.ui.editingFunction = null;
    tab.session.ui.editingFormula = { defName: "total", type: "def" };
    await flush();
    expect(axes()).toEqual(before);
    expect(root.querySelector(".pane-zoom")).not.toBeNull();
  });

  test("draws no Back and no breadcrumb — the dock header and the jump bar own both", async () => {
    // Two exits and two trails, side by side, for one sub-document. The Logic tab's header carries
    // The real Close (P8.5) and ⑥ carries the address; this bar drew a second of each.
    const tab = openTestTab();
    paneContext.mount(root, makeCtx());
    tab.session.ui.editingFunction = { defName: "greet", type: "def" };
    await flush();
    expect(root.querySelector(".breadcrumb")).toBeNull();
    expect(hasBtn("Back")).toBe(false);
  });

  test("the Export control survives too, in the view that owns it", async () => {
    const tab = openTestTab();
    paneContext.mount(root, ctxInMode("source"));
    tab.session.ui.editingFormula = { eventKey: "onclick", type: "event" };
    await flush();
    expect(hasBtn("Export")).toBe(true);
  });
});

// ─── Axis 1 · Editor kind ─────────────────────────────────────────────────────

describe("editor kind", () => {
  test("a document with several kinds gets a dropdown listing only those kinds", async () => {
    openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();
    const picker = root.querySelector("sp-picker.pc-editor-kind") as HTMLElement & {
      value: string;
    };
    expect(picker).not.toBeNull();
    const options = [...picker.querySelectorAll("sp-menu-item")].map((o) => o.textContent?.trim());
    // Edit/design/preview all name the Canvas; source names Code. No dead entry for grid or diff.
    expect(options).toEqual(["Canvas", "Code"]);
    expect(picker.getAttribute("value")).toBe("canvas");
  });

  test("a document with one kind prints its name instead of an immovable dropdown", async () => {
    const tab = openTestTab();
    tab.capabilities.modes = ["edit", "design", "preview"];
    paneContext.mount(root, makeCtx());
    await flush();
    expect(root.querySelector("sp-picker.pc-editor-kind")).toBeNull();
    expect(root.querySelector(".pc-static")?.textContent?.trim()).toBe("Canvas");
  });

  test("choosing a kind lands on that kind's first mode and clears preview", async () => {
    const tab = openTestTab();
    tab.session.ui.preview = true;
    const ctx = makeCtx();
    paneContext.mount(root, ctx);
    await flush();

    const picker = root.querySelector("sp-picker.pc-editor-kind") as HTMLElement & {
      value: string;
    };
    picker.value = "code";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(ctx.setCanvasMode).toHaveBeenCalledWith("source");
    expect(tab.session.ui.preview).toBe(false);
  });

  test("a kind this document does not support is refused rather than half-applied", async () => {
    const tab = openTestTab();
    const ctx = makeCtx();
    paneContext.mount(root, ctx);
    await flush();

    const picker = root.querySelector("sp-picker.pc-editor-kind") as HTMLElement & {
      value: string;
    };
    picker.value = "library";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(ctx.setCanvasMode).not.toHaveBeenCalled();
    expect(tab.session.ui.canvasMode).toBe("edit");
  });
});

// ─── Axis 2 · Canvas view ─────────────────────────────────────────────────────

describe("canvas view", () => {
  test("is one radio group of three values, with the effective one checked", async () => {
    const tab = openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();

    const group = root.querySelector(".pc-view") as HTMLElement;
    const segs = [...group.querySelectorAll("sp-action-button")];
    expect(segs.map((s) => s.textContent?.trim())).toEqual(["Edit", "Design", "Preview"]);
    expect(segs.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    // Nothing in the axis is a toggle: a value cannot silently compose with another value.
    expect(group.querySelector("sp-action-button[toggles]")).toBeNull();

    tab.session.ui.preview = true;
    await flush();
    const after = [...root.querySelectorAll(".pc-view sp-action-button")];
    expect(after.map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
  });

  test("Preview sets the flag; Design clears it on the way past", async () => {
    const tab = openTestTab();
    const ctx = makeCtx();
    paneContext.mount(root, ctx);
    await flush();

    pointer(btn("Preview"), "click");
    await flush();
    expect(tab.session.ui.preview).toBe(true);

    pointer(btn("Design"), "click");
    await flush();
    expect(tab.session.ui.preview).toBe(false);
    expect(ctx.setCanvasMode).toHaveBeenCalledWith("design");
  });

  test("offers only the views the document declares", async () => {
    const tab = openTestTab();
    tab.capabilities.modes = ["edit", "source"];
    paneContext.mount(root, makeCtx());
    await flush();
    expect(
      [...root.querySelectorAll(".pc-view sp-action-button")].map((s) => s.textContent?.trim()),
    ).toEqual(["Edit"]);
  });

  test("is absent entirely when the editor is not the Canvas", async () => {
    const tab = openTestTab();
    tab.session.ui.canvasMode = "source";
    paneContext.mount(root, ctxInMode("source"));
    await flush();
    expect(root.querySelector(".pc-view")).toBeNull();
    expect(axes()).toEqual(["Editor", "Context"]);
  });

  test("a document whose modes name no Canvas view renders no view axis", async () => {
    const tab = openTestTab();
    tab.capabilities.modes = ["source"];
    tab.session.ui.canvasMode = "edit";
    paneContext.mount(root, makeCtx());
    await flush();
    expect(root.querySelector(".pc-view")).toBeNull();
  });
});

// ─── Axis 3 · Rendering context ───────────────────────────────────────────────

describe("rendering context", () => {
  const withScheme = () =>
    makeCtx({
      parseMediaEntries: mock(() => ({
        baseWidth: 1200,
        featureQueries: [
          { name: "--dark-mode", query: "(prefers-color-scheme: dark)" },
          { name: "--reduced-motion", query: "(prefers-reduced-motion: reduce)" },
        ],
        sizeBreakpoints: [{ name: "md", query: "(min-width: 768px)", type: "min", width: 768 }],
      })),
    });

  test("summarises size and scheme on the trigger", async () => {
    const tab = openTestTab();
    paneContext.mount(root, withScheme());
    await flush();
    expect(root.querySelector(".pc-context-trigger")?.textContent?.trim()).toBe("Base · Auto ⌄");

    tab.session.ui.activeMedia = "md";
    tab.session.ui.previewColorScheme = "dark";
    await flush();
    expect(root.querySelector(".pc-context-trigger")?.textContent?.trim()).toBe("Md · Dark ⌄");
  });

  test("omits the scheme from the summary when the project declares no scheme query", async () => {
    openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();
    expect(root.querySelector(".pc-context-trigger")?.textContent?.trim()).toBe("Base ⌄");
  });

  test("the size segment writes activeMedia — the field a panel header writes", async () => {
    const tab = openTestTab();
    paneContext.mount(root, withScheme());
    await flush();

    const sizes = [...root.querySelectorAll(".pc-sizes sp-action-button")];
    expect(sizes.map((s) => s.textContent?.trim())).toEqual(["Base", "Md"]);
    pointer(sizes[1]!, "click");
    await flush();
    expect(tab.session.ui.activeMedia).toBe("md");

    pointer([...root.querySelectorAll(".pc-sizes sp-action-button")][0]!, "click");
    await flush();
    expect(tab.session.ui.activeMedia).toBeNull();
  });

  test("the scheme segment replaces the old bar-level Auto/Light/Dark control", async () => {
    const tab = openTestTab();
    paneContext.mount(root, withScheme());
    await flush();

    pointer(btn("Dark"), "click");
    await flush();
    expect(tab.session.ui.previewColorScheme).toBe("dark");
    expect(btn("Dark").hasAttribute("selected")).toBe(true);

    pointer(btn("Auto"), "click");
    await flush();
    expect(tab.session.ui.previewColorScheme).toBe("auto");
  });

  test("non-scheme feature queries keep their toggles, inside the popover", async () => {
    const tab = openTestTab();
    paneContext.mount(root, withScheme());
    await flush();

    const toggle = root.querySelector(
      "sp-action-button[title='(prefers-reduced-motion: reduce)']",
    ) as HTMLElement;
    expect(toggle.textContent).toContain("Reduced Motion");
    pointer(toggle, "click");
    await flush();
    expect(tab.session.ui.featureToggles["--reduced-motion"]).toBe(true);
  });

  test("groups a document declares nothing for are absent", async () => {
    openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();
    const groups = [...root.querySelectorAll(".pc-ctx-label")].map((el) => el.textContent?.trim());
    expect(groups).toEqual(["Size"]);
  });

  test("the layout switch shows for a site page with a layout and flips showLayout", async () => {
    resetStudioState({ isSiteProject: true });
    const tab = resetWorkspaceWithTab(
      { $layout: "./layouts/base.json", children: [], tagName: "div" } as never,
      { documentPath: "pages/about.json", id: "layout-tab" },
    );
    paneContext.mount(root, makeCtx());
    await flush();

    const toggle = root.querySelector(".pc-layout-switch") as HTMLElement;
    expect(toggle.hasAttribute("checked")).toBe(true);
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(tab.session.ui.showLayout).toBe(false);

    (root.querySelector(".pc-layout-switch") as HTMLElement).dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    await flush();
    expect(tab.session.ui.showLayout).toBe(true);
  });

  test("no layout switch for a page without one", async () => {
    resetStudioState({ isSiteProject: true });
    resetWorkspaceWithTab({ children: [], tagName: "div" }, { documentPath: "pages/plain.json" });
    paneContext.mount(root, makeCtx());
    await flush();
    expect(root.querySelector(".pc-layout-switch")).toBeNull();
  });

  test("Manage contexts… routes to the definition site instead of defining anything", async () => {
    const ran: string[] = [];
    installRegistry(ran);
    openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();

    pointer(root.querySelector(".pc-ctx-manage") as HTMLElement, "click");
    await flush();
    expect(ran).toEqual(["settings.open:contexts"]);
  });

  test("Manage contexts… is inert, not fatal, before a registry is published", async () => {
    openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();
    expect(() =>
      pointer(root.querySelector(".pc-ctx-manage") as HTMLElement, "click"),
    ).not.toThrow();
  });
});

// ─── "Resolving with…" ────────────────────────────────────────────────────────

describe("resolving with", () => {
  test("a page renders one picker per route param and auto-selects the first value", async () => {
    resetStudioState({ isSiteProject: true });
    const tab = resetWorkspaceWithTab(
      {
        $paths: { param: "sku", values: ["alpha", "beta"] },
        children: [],
        tagName: "div",
      } as never,
      { documentPath: "pages/products/[sku].json", id: "param-tab" },
    );
    paneContext.mount(root, makeCtx());
    await flush();

    const picker = root.querySelector("sp-picker.pc-param") as HTMLElement & { value: string };
    expect(picker).not.toBeNull();
    expect([...picker.querySelectorAll("sp-menu-item")].map((o) => o.textContent?.trim())).toEqual([
      "alpha",
      "beta",
    ]);
    expect(tab.session.ui.previewParams).toEqual({ sku: "alpha" });

    picker.value = "beta";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(tab.session.ui.previewParams).toEqual({ sku: "beta" });
  });

  test("the values sit on the bar, not behind a click, and say what they are", async () => {
    resetStudioState({ isSiteProject: true });
    resetWorkspaceWithTab(
      { $paths: { param: "sku", values: ["alpha"] }, children: [], tagName: "div" } as never,
      { documentPath: "pages/products/[sku].json", id: "inline-param" },
    );
    paneContext.mount(root, makeCtx());
    await flush();

    const picker = root.querySelector("sp-picker.pc-param") as HTMLElement;
    expect(picker.closest(".pane-context")).not.toBeNull();
    // Not inside the popover: reaching it must not cost a gesture. The screenshot manifest types
    // Into `pane.primary/prop:count` in one step, and its input budget only ratchets down.
    expect(picker.closest("sp-popover")).toBeNull();
    expect(root.querySelector(".pc-resolving-label")?.textContent?.trim()).toBe("resolving with");
  });

  test("no pickers for a page without params", async () => {
    resetStudioState({ isSiteProject: true });
    resetWorkspaceWithTab({ children: [], tagName: "div" }, { documentPath: "pages/simple.json" });
    paneContext.mount(root, makeCtx());
    await flush();
    expect(root.querySelector("sp-picker.pc-param")).toBeNull();
  });

  test("a component renders one test-prop field per prop, keeping its region id", async () => {
    const tab = resetWorkspaceWithTab(
      {
        children: [{ tagName: "h3", textContent: "${state.title}" }],
        state: {
          count: { default: 3, type: "number" },
          greet: { $prototype: "Function", body: "" },
          title: "Hello",
        },
        tagName: "x-card",
      } as never,
      { documentPath: "components/x-card.json", id: "comp-tab" },
    );
    paneContext.mount(root, makeCtx());
    await flush();

    const fields = [...root.querySelectorAll("sp-textfield.pc-prop")] as (HTMLElement & {
      value: string;
    })[];
    expect(fields.map((f) => f.getAttribute("placeholder"))).toEqual(["count", "title"]);
    // The screenshot manifest addresses this field by region; the id survives the move.
    expect(fields[0]!.dataset.jxRegion).toBe("pane.primary/prop:count");

    fields[1]!.value = "Test drive";
    fields[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(tab.session.ui.previewProps).toEqual({ title: "Test drive" });

    fields[0]!.value = "7";
    fields[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(tab.session.ui.previewProps).toEqual({ count: 7, title: "Test drive" });
  });

  test("clearing the last prop field resets previewProps to null", async () => {
    const tab = resetWorkspaceWithTab(
      { children: [], state: { title: "Hello" }, tagName: "x-card" } as never,
      { documentPath: "components/x-card.json", id: "comp-clear" },
    );
    tab.session.ui.previewProps = { title: "Test drive" };
    paneContext.mount(root, makeCtx());
    await flush();

    const field = root.querySelector("sp-textfield.pc-prop") as HTMLElement & { value: string };
    expect(field.value).toBe("Test drive");
    field.value = "";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(tab.session.ui.previewProps).toBeNull();
  });

  test("no prop fields for a component whose state holds no plain data", async () => {
    resetWorkspaceWithTab(
      { children: [], state: { fn: { $prototype: "Function", body: "" } }, tagName: "x-bare" },
      { documentPath: "components/x-bare.json" },
    );
    paneContext.mount(root, makeCtx());
    await flush();
    expect(root.querySelector("sp-textfield.pc-prop")).toBeNull();
  });
});

// ─── ⑩ The floating zoom pod ──────────────────────────────────────────────────

describe("zoom pod", () => {
  test("floats outside the bar, and shows the edit-mode content zoom", async () => {
    const tab = openTestTab();
    tab.session.ui.editZoom = 1.5;
    paneContext.mount(root, makeCtx());
    await flush();

    const pod = root.querySelector(".pane-zoom") as HTMLElement;
    expect(pod).not.toBeNull();
    expect(pod.closest(".pane-context")).toBeNull();
    expect(pod.dataset.jxRegion).toBe("pane.primary/zoom");
    expect(pod.querySelector(".pc-zoom-label")?.textContent?.trim()).toBe("150%");
    // Edit mode has no artboard, so it has no fit.
    expect(root.querySelector(".pc-fit")).toBeNull();
  });

  test("− / + step the edit zoom and the label tracks reactively", async () => {
    const tab = openTestTab();
    paneContext.mount(root, makeCtx());
    await flush();

    pointer(btn("+"), "click");
    await flush();
    expect(tab.session.ui.editZoom).toBeCloseTo(1.2);
    expect(root.querySelector(".pc-zoom-label")?.textContent?.trim()).toBe("120%");

    pointer(btn("−"), "click");
    await flush();
    expect(tab.session.ui.editZoom).toBeCloseTo(1);

    pointer(root.querySelector(".pc-zoom-label") as HTMLElement, "click");
    await flush();
    expect(tab.session.ui.editZoom).toBe(1);
  });

  test("design mode drives ui.zoom and declares each step as the document's fit", async () => {
    const tab = openTestTab();
    tab.session.ui.zoom = 2;
    paneContext.mount(root, ctxInMode("design"));
    await flush();
    expect(root.querySelector(".pc-zoom-label")?.textContent?.trim()).toBe("200%");
    expect(hasDeclaredFit()).toBe(false);

    pointer(btn("+"), "click");
    await flush();
    expect(tab.session.ui.zoom).toBeCloseTo(2.4);
    expect(tab.session.ui.editZoom).toBe(1);
    expect(getFit()).toBeCloseTo(2.4, 5);

    pointer(btn("−"), "click");
    await flush();
    expect(tab.session.ui.zoom).toBeCloseTo(2);
  });

  test("the fit picker writes the declared fit, and 100% declares the number 1", async () => {
    openTestTab();
    paneContext.mount(root, ctxInMode("design"));
    await flush();

    const fit = root.querySelector("sp-picker.pc-fit") as HTMLElement & { value: string };
    expect([...fit.querySelectorAll("sp-menu-item")].map((o) => o.textContent?.trim())).toEqual([
      "Fit page",
      "Fit width",
      "Actual size",
      "No fit",
    ]);

    fit.value = "width";
    fit.dispatchEvent(new Event("change", { bubbles: true }));
    expect(getFit()).toBe("width");

    fit.value = "page";
    fit.dispatchEvent(new Event("change", { bubbles: true }));
    expect(getFit()).toBe("page");

    fit.value = "none";
    fit.dispatchEvent(new Event("change", { bubbles: true }));
    expect(getFit()).toBe("none");

    fit.value = "actual";
    fit.dispatchEvent(new Event("change", { bubbles: true }));
    expect(getFit()).toBe(1);

    // An unknown value is ignored rather than clearing the declared fit.
    fit.value = "nonsense";
    fit.dispatchEvent(new Event("change", { bubbles: true }));
    expect(getFit()).toBe(1);

    resetFits();
    pointer(root.querySelector(".pc-zoom-label") as HTMLElement, "click");
    expect(getFit()).toBe(1);
  });

  test("the picker shows an author-chosen zoom as no named fit", async () => {
    const tab = openTestTab();
    tab.session.ui.zoom = 2;
    paneContext.mount(root, ctxInMode("design"));
    await flush();
    pointer(btn("+"), "click");
    await flush();
    expect(root.querySelector("sp-picker.pc-fit")?.getAttribute("value")).toBe("");
  });

  test("stylebook is on the panzoom surface; preview and source have no pod", async () => {
    openTestTab();
    paneContext.mount(root, ctxInMode("stylebook"));
    await flush();
    expect(root.querySelector(".pane-zoom")).not.toBeNull();

    paneContext.unmount();
    paneContext.mount(root, ctxInMode("preview"));
    await flush();
    expect(root.querySelector(".pane-zoom")).toBeNull();

    paneContext.unmount();
    paneContext.mount(root, ctxInMode("source"));
    await flush();
    expect(root.querySelector(".pane-zoom")).toBeNull();
  });
});

// ─── The mode action ──────────────────────────────────────────────────────────

describe("export", () => {
  test("shows in the Code view only, and invokes ctx.exportFile", async () => {
    openTestTab();
    const ctx = ctxInMode("source");
    paneContext.mount(root, ctx);
    await flush();
    pointer(btn("Export"), "click");
    expect(ctx.exportFile).toHaveBeenCalledTimes(1);

    paneContext.unmount();
    paneContext.mount(root, ctxInMode("design"));
    await flush();
    expect(hasBtn("Export")).toBe(false);
  });
});
