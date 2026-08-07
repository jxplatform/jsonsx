/**
 * Right panel — the Inspector dock: four text-labelled tabs, one dock, one column.
 *
 * Mount/unmount lifecycle, tab routing (Content · Style · Logic · Assistant), the sp-tabs change
 * handler, the per-document vs detached tab selection, the header that names the target, and the
 * enum agreement between `shell.ts`'s `INSPECTOR_TAB_IDS` and `commands/defaults.ts`'s titles.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initShellRefs, rightPanel, updateUi } from "../src/store";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { INSPECTOR_TAB_IDS, setLayoutSelection, shell } from "../src/shell";
import { INSPECTOR_TABS } from "../src/commands/defaults";

const { inspectorTab, mount, render, setInspectorTab, unmount } =
  await import("../src/panels/right-panel");

// Panel scheduler coalesces via requestAnimationFrame; make it synchronous-ish.
const origRaf = globalThis.requestAnimationFrame;
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (
  cb: FrameRequestCallback,
) => setTimeout(() => cb(0), 0) as unknown as number;

const mountAssistant = mock((_host: HTMLElement) => {});

function makeCtx() {
  return {
    getCanvasMode: mock(() => "design"),
    mountAssistant,
    navigateToComponent: mock(() => {}),
    renderCanvas: mock(() => {}),
  };
}

/** The tab bodies that are not hidden. Exactly one, always. */
function visibleBodies(): HTMLElement[] {
  return [...rightPanel.querySelectorAll<HTMLElement>(".panel-body")].filter(
    (el) => (el as HTMLElement).style.display !== "none",
  ) as HTMLElement[];
}

beforeEach(() => {
  document.body.innerHTML = `<div id="app">
    <div id="toolbar"></div><div id="activity-bar"></div><div id="left-panel"></div>
    <div id="canvas-wrap"></div><div id="right-panel"></div>
    <div id="statusbar"></div>
  </div>`;
  initShellRefs();
  resetStudioState();
  mountAssistant.mockClear();
});

afterEach(() => {
  unmount();
  closeAllTabs();
  shell.layoutSelection = null;
});

describe("the four tabs", () => {
  test("mount + render shows four text-labelled tabs and the Content body", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    expect(rightPanel.querySelector("sp-tabs")).toBeTruthy();
    const labels = [...rightPanel.querySelectorAll("sp-tab")].map((el) => el.getAttribute("label"));
    expect(labels).toEqual(["Content", "Style", "Logic", "Assistant"]);
    expect(visibleBodies().length).toBe(1);
  });

  test("the tab ids and the tab titles are the same list, in the same order", () => {
    // Two declarations, deliberately: `shell.ts` owns the enum `view.setRightTab` validates
    // Against, and `commands/defaults.ts` owns the titles ⌘⇧1–4 and the chrome budget read —
    // Because that module has to load in a bare Bun process. This is the guard against drift, the
    // Same one `tests/navigator-panels.test.ts` runs for the rail.
    expect(INSPECTOR_TABS.map((tab) => tab.id)).toEqual([...INSPECTOR_TAB_IDS]);
  });

  test("every tab body is addressable as `inspector/tab:<id>`", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    const regions = [...rightPanel.querySelectorAll<HTMLElement>(".panel-body")].map(
      (el) => el.dataset.jxRegion,
    );
    expect(regions).toEqual(INSPECTOR_TAB_IDS.map((id) => `inspector/tab:${id}`));
  });

  test("the Assistant tab's body is handed to its owner exactly once", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    render();
    await flush(4);
    expect(mountAssistant).toHaveBeenCalledTimes(1);
    const [host] = mountAssistant.mock.calls[0] as [HTMLElement];
    expect(host.dataset.jxRegion).toBe("inspector/tab:assistant");
  });

  test("routes to Logic and Style", async () => {
    resetWorkspaceWithTab();
    const ctx = makeCtx();
    mount(ctx as never);
    for (const tabName of ["events", "style"]) {
      updateUi(activeTab.value, "rightTab", tabName);
      render();
      await flush(4);
      expect(visibleBodies().length).toBe(1);
    }
    expect(ctx.getCanvasMode).toHaveBeenCalled();
  });

  test("the assistant tab leaves its body alone — its owner paints it", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    setInspectorTab("assistant");
    await flush(4);
    const [body] = visibleBodies();
    expect(body?.dataset.jxRegion).toBe("inspector/tab:assistant");
    expect(body?.childNodes.length).toBe(0);
  });

  test("an undeclared stored tab coerces to Content", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    updateUi(activeTab.value, "rightTab", "content");
    render();
    await flush(4);
    expect(inspectorTab()).toBe("properties");
    expect(rightPanel.querySelector("sp-tabs")?.getAttribute("selected")).toBe("properties");
  });

  test("sp-tabs change handler switches the active tab", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    const tabs = rightPanel.querySelector("sp-tabs") as HTMLElement & { selected?: string };
    tabs.selected = "style";
    tabs.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(4);
    expect(activeTab.value?.session.ui.rightTab).toBe("style");
    // Re-dispatch with the same selection: the handler's sel !== tab guard skips the update.
    tabs.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(2);
    expect(activeTab.value?.session.ui.rightTab).toBe("style");
    // An id nobody declares is refused rather than selected.
    tabs.selected = "nonsense";
    tabs.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(2);
    expect(activeTab.value?.session.ui.rightTab).toBe("style");
  });
});

describe("the header names its target", () => {
  test("with a selection it names the node", async () => {
    const tab = resetWorkspaceWithTab();
    tab.session.selection = [["children", 0]];
    mount(makeCtx() as never);
    render();
    await flush(4);
    expect(rightPanel.querySelector(".panel-header-title")?.textContent).toBe("Content");
    expect(rightPanel.querySelector(".panel-header-level")?.textContent?.trim()).toBeTruthy();
  });

  test("with no selection it names the document, and with no document says so", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    const withDoc = rightPanel.querySelector(".panel-header-level")?.textContent;
    expect(withDoc).not.toBe("no document");

    closeAllTabs();
    render();
    await flush(4);
    expect(rightPanel.querySelector(".panel-header-level")?.textContent).toBe("no document");
  });
});

describe("the layout selection", () => {
  const headerHit = {
    className: "site-header",
    layoutFile: "layouts/base.json",
    layoutPath: ["children", 0, "children", 0],
    rect: { height: 40, width: 800, x: 0, y: 0 },
    tagName: "header",
  };

  test("clicking layout chrome repaints the dock on its own, and Content answers", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);

    // No renderOnly, no selection change — only the shell record the canvas host writes.
    setLayoutSelection(headerHit as never);
    await flush(4);

    const body = visibleBodies()[0]!;
    expect(body.querySelector('sp-accordion-item[label="Layout Element"]')).not.toBeNull();
    expect(body.textContent).toContain("<header>");
    expect(body.textContent).toContain("layouts/base.json");
  });

  test("the header names the layout element AND the file it came from", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    setLayoutSelection(headerHit as never);
    await flush(4);
    expect(rightPanel.querySelector(".panel-header-level")?.textContent?.trim()).toBe(
      "<header> in layouts/base.json",
    );
  });

  test("the inspector header names the BATCH when several elements are selected (§6.5)", async () => {
    const tab = resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    tab.session.selection = [["children", 0]];
    await flush(4);
    const oneLabel = rightPanel.querySelector(".panel-header-level")?.textContent?.trim();
    expect(oneLabel).not.toBe("2 elements");
    tab.session.selection = [["children", 0], []];
    await flush(4);
    expect(rightPanel.querySelector(".panel-header-level")?.textContent?.trim()).toBe("2 elements");
  });

  test("releasing it puts the dock back on the document", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    setLayoutSelection(headerHit as never);
    await flush(4);
    setLayoutSelection(null);
    await flush(4);
    expect(
      visibleBodies()[0]!.querySelector('sp-accordion-item[label="Layout Element"]'),
    ).toBeNull();
  });
});

describe("with no document open", () => {
  test("the strip stays and the three document tabs teach what they need", async () => {
    closeAllTabs();
    mount(makeCtx() as never);
    render();
    await flush(4);
    // The strip does NOT vanish: the Assistant works with no document, so the dock has to stay
    // Navigable — which is why the containers are permanent now rather than rebuilt per render.
    expect(rightPanel.querySelector("sp-tabs")).not.toBeNull();
    expect(rightPanel.querySelector(".empty-state-message")?.textContent).toBe(
      "Open a page to inspect and style what you click.",
    );
  });

  test("the selection falls back to the module's own field, and survives a tab opening", async () => {
    closeAllTabs();
    mount(makeCtx() as never);
    setInspectorTab("assistant");
    await flush(4);
    expect(inspectorTab()).toBe("assistant");
    // A document brings its OWN remembered tab — the detached one was never the document's.
    resetWorkspaceWithTab();
    render();
    await flush(4);
    expect(inspectorTab()).toBe("properties");
  });

  test("the no-document state is replaced when a tab opens", async () => {
    closeAllTabs();
    mount(makeCtx() as never);
    render();
    await flush(4);
    resetWorkspaceWithTab();
    render();
    await flush(4);
    expect(rightPanel.textContent).not.toContain("Open a page to inspect");
    expect(rightPanel.querySelector("sp-tabs")).not.toBeNull();
  });
});

describe("lifecycle", () => {
  test("unmount disposes scheduler and scope; render after unmount is a no-op", async () => {
    resetWorkspaceWithTab();
    mount(makeCtx() as never);
    render();
    await flush(4);
    unmount();
    expect(() => render()).not.toThrow();
    await flush(2);
  });

  test("render before mount is a no-op", () => {
    expect(() => render()).not.toThrow();
  });
});

afterEach(() => {
  globalThis.requestAnimationFrame = origRaf;
});
