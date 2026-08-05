/**
 * Stylebook panel (src/panels/stylebook-panel.ts) — the iframe-era orchestrator: builds one
 * specimen doc, one panel per breakpoint, and mounts each through the (mocked) iframe host.
 * Selection is session-state only; overlay drawing/measurement lives in the host.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { html } from "lit-html";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { CanvasPanel } from "../src/types";
import { shell } from "../src/shell";
import { PROJECT_STYLES_TITLE, PROJECT_STYLES_VIEW } from "../src/style/project-styles";

// ─── iframe-host mock (captures stylebook mounts + pans) ────────────────────────

interface MountCall {
  gen: number;
  generated: {
    doc: JxMutableNode;
    pathToTag: ReadonlyMap<string, string>;
    tagToCardPath: ReadonlyMap<string, (string | number)[]>;
  };
  canvasEl: HTMLElement;
  widthPx: number | null;
}
const mounts: MountCall[] = [];
const pans: string[] = [];

void mock.module("../src/canvas/iframe-host", () => ({
  mountStylebookCanvas: (
    gen: number,
    generated: MountCall["generated"],
    canvasEl: HTMLElement,
    widthPx: number | null,
  ) => {
    mounts.push({ canvasEl, gen, generated, widthPx });
  },
  panToStylebookTag: (tag: string) => {
    pans.push(tag);
  },
}));

const { renderStylebookMode, selectStylebookTag } = await import("../src/panels/stylebook-panel");
const { canvasPanels, initShellRefs } = await import("../src/store");
const { componentRegistry } = await import("../src/files/components");
const { view } = await import("../src/view");
const { closeAllTabs } = await import("../src/workspace/workspace");

// ─── Shell + panel scaffolding ────────────────────────────────────────────────

function setupShell() {
  document.body.innerHTML = "";
  for (const id of [
    "canvas-wrap",
    "activity-bar",
    "left-panel",
    "right-panel",
    "toolbar",
    "statusbar",
  ]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
}

const panelTemplateCalls: unknown[][] = [];
const ctx = {
  applyTransform: mock(() => {}),
  canvasPanelTemplate: (
    mediaName: string | null,
    label: string | null,
    fullWidth: boolean,
    width?: number | null,
  ) => {
    panelTemplateCalls.push([mediaName, label, fullWidth, width]);
    const element = document.createElement("div");
    const canvas = document.createElement("div");
    element.append(canvas);
    const panel = {
      _width: width ?? null,
      canvas,
      element,
      mediaName,
    } as unknown as CanvasPanel;
    return { panel, tpl: html`${element}` };
  },
  observeCenterUntilStable: mock(() => {}),
  updateActivePanelHeaders: mock(() => {}),
} as Parameters<typeof renderStylebookMode>[0];

const ctxMocks = ctx as unknown as Record<string, ReturnType<typeof mock>>;

function makeTab(doc: Record<string, unknown> = {}) {
  return resetWorkspaceWithTab({ children: [], tagName: "div", ...doc } as JxMutableNode);
}

beforeEach(() => {
  setupShell();
  resetStudioState();
  canvasPanels.length = 0;
  componentRegistry.length = 0;
  panelTemplateCalls.length = 0;
  mounts.length = 0;
  pans.length = 0;
  view.renderGeneration = 7;
  for (const key of ["applyTransform", "observeCenterUntilStable", "updateActivePanelHeaders"]) {
    ctxMocks[key]!.mockClear();
  }
});

afterEach(() => {
  closeAllTabs();
  document.body.innerHTML = "";
});

// ─── renderStylebookMode ──────────────────────────────────────────────────────

describe("renderStylebookMode", () => {
  test("no $media → one full-width panel mounting the generated doc", () => {
    makeTab();
    renderStylebookMode(ctx);
    expect(panelTemplateCalls).toEqual([[null, null, true, undefined]]);
    expect(canvasPanels).toHaveLength(1);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.gen).toBe(7);
    expect(mounts[0]!.widthPx).toBeNull();
    expect(mounts[0]!.canvasEl).toBe(canvasPanels[0]!.canvas as HTMLElement);
    // The generated specimen doc reached the mount intact (sb-root + path maps).
    expect((mounts[0]!.generated.doc.attributes as Record<string, string>).class).toBe("sb-root");
    expect(mounts[0]!.generated.tagToCardPath.has("h1")).toBe(true);
    expect(ctxMocks.applyTransform).toHaveBeenCalled();
    expect(ctxMocks.observeCenterUntilStable).toHaveBeenCalled();
  });

  test("$media breakpoints → base + one panel per breakpoint, SAME generated doc for all", () => {
    makeTab({ $media: { "--": "320px", md: "(min-width: 768px)" } });
    renderStylebookMode(ctx);
    expect(canvasPanels.map((p) => p.mediaName)).toEqual(["base", "md"]);
    expect(mounts).toHaveLength(2);
    expect(mounts[0]!.generated).toBe(mounts[1]!.generated);
    expect(mounts[1]!.widthPx).toBe(768);
    expect(ctxMocks.updateActivePanelHeaders).toHaveBeenCalled();
  });

  test("the chrome bar filter narrows the generated doc; Customized toggles the session flag", async () => {
    makeTab();
    shell.stylebook.filter = "h1";
    renderStylebookMode(ctx);
    expect(mounts[0]!.generated.tagToCardPath.has("h1")).toBe(true);
    expect(mounts[0]!.generated.tagToCardPath.has("ul")).toBe(false);

    const toggle = document.querySelector(".sb-chrome button") as HTMLButtonElement;
    toggle.click();
    await flush();
    expect(shell.stylebook.customizedOnly).toBe(true);

    const input = document.querySelector(".sb-chrome input") as HTMLInputElement;
    input.value = "table";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(shell.stylebook.filter).toBe("table");
  });

  test("the chrome bar's two controls name themselves, and the toggle states which way it is", async () => {
    /* §2 principle 6: no unlabelled control. Both names are spelled from PROJECT_STYLES_TITLE, so
       the surface has one name and not one per control. The wire value must never surface here. */
    makeTab();
    shell.stylebook.customizedOnly = false;
    renderStylebookMode(ctx);
    const bar = document.querySelector(".sb-chrome [role='toolbar']") as HTMLElement;
    expect(bar.getAttribute("aria-label")).toBe(PROJECT_STYLES_TITLE);

    const input = document.querySelector(".sb-chrome input") as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe(`Filter the ${PROJECT_STYLES_TITLE} catalogue`);
    expect(input.getAttribute("aria-label")).not.toContain(PROJECT_STYLES_VIEW);

    const toggle = document.querySelector(".sb-chrome button") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("title")).toBeTruthy();
    toggle.click();
    await flush();
    renderStylebookMode(ctx);
    expect(
      (document.querySelector(".sb-chrome button") as HTMLElement).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

// ─── selectStylebookTag ───────────────────────────────────────────────────────

describe("selectStylebookTag", () => {
  test("writes the stylebook selection session state (selection stays a path-empty [])", () => {
    const tab = makeTab();
    selectStylebookTag("table th", "md");
    expect(shell.stylebook.selection).toBe("table th");
    expect(tab.session.ui.activeSelector).toBe("table th");
    expect(tab.session.ui.rightTab).toBe("style");
    expect(tab.session.ui.activeMedia).toBe("md");
    expect(tab.session.selection).toEqual([[]]);
  });

  test("omitting media leaves the current breakpoint context untouched", () => {
    const tab = makeTab();
    tab.session.ui.activeMedia = "md";
    selectStylebookTag("p");
    expect(tab.session.ui.activeMedia).toBe("md");
  });

  test("panCanvas routes to the host's pan-to-card (measured over the bridge)", () => {
    makeTab();
    selectStylebookTag("h1", null, { panCanvas: true });
    expect(pans).toEqual(["h1"]);
    selectStylebookTag("p");
    expect(pans).toEqual(["h1"]); // No pan without the flag.
  });
});
