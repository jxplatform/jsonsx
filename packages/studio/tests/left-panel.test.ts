/**
 * Left panel orchestrator — mount/unmount lifecycle, per-tab routing (files/git/blocks/layers/
 * imports/state/data/head), the content-mode head applyMutation bridge, and error recovery.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { html } from "lit-html";
import { mount, render, unmount } from "../src/panels/left-panel";
import { initShellRefs, leftPanel } from "../src/store";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { view } from "../src/view";
import type { JxMutableNode } from "@jxsuite/schema/types";

type AnyFn = (...args: any[]) => any;

let ctx: Record<string, any>;
let captured: { head: any; imports: any; signals: any[]; data: any[]; git: any[] };

function makeCtx(overrides: Record<string, unknown> = {}) {
  captured = { data: [], git: [], head: null, imports: null, signals: [] };
  return {
    cloneRepository: mock(() => {}),
    defaultDef: (tag: string) => ({ tagName: tag }),
    defBadgeLabel: () => "badge",
    defCategory: () => "cat",
    getCanvasMode: mock(() => "design"),
    navigateToComponent: mock(() => {}),
    registerComponentsDnD: mock(() => {}),
    registerElementsDnD: mock(() => {}),
    registerFileTreeDnD: mock(() => {}),
    registerLayersDnD: mock(() => {}),
    renderCanvas: mock(() => {}),
    renderDataExplorerTemplate: mock((...args: unknown[]) => {
      captured.data = args;
      return html`<div id="data-rendered"></div>`;
    }),
    renderFilesTemplate: mock(() => html`<div class="file-tree" id="files-rendered"></div>`),
    renderGitPanel: mock((...args: unknown[]) => {
      captured.git = args;
      return html`<div id="git-rendered"></div>`;
    }),
    renderHeadTemplate: mock((opts: unknown) => {
      captured.head = opts;
      return html`<div id="head-rendered"></div>`;
    }),
    renderImportsTemplate: mock((opts: unknown) => {
      captured.imports = opts;
      return html`<div id="imports-rendered"></div>`;
    }),
    renderSignalsTemplate: mock((...args: unknown[]) => {
      captured.signals = args;
      return html`<div id="signals-rendered"></div>`;
    }),
    setCanvasMode: mock(() => {}),
    setGitDiffState: mock(() => {}),
    setupTreeKeyboard: mock(() => {}),
    webdata: { elements: { Text: [{ tag: "p" }] } },
    ...overrides,
  };
}

async function mountWith(overrides: Record<string, unknown> = {}) {
  ctx = makeCtx(overrides);
  mount(ctx as never);
  await flush(3);
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="canvas-wrap"></div>
    <div id="activity-bar"></div>
    <div id="left-panel"></div>
    <div id="right-panel"></div>
    <div id="toolbar"></div>
    <div id="statusbar"></div>
  `;
  initShellRefs();
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  view.leftTab = "layers";
  view.dndCleanups = [];
  view._layersCollapsed = new Set();
  resetStudioState();
  resetWorkspaceWithTab({
    children: [{ tagName: "p", textContent: "Hello" }],
    tagName: "div",
  });
});

afterEach(() => {
  unmount();
  closeAllTabs();
  document.body.innerHTML = "";
});

describe("left panel — project-level tabs", () => {
  test("files tab renders the file tree and wires keyboard + DnD", async () => {
    view.leftTab = "files";
    await mountWith();
    expect(leftPanel.querySelector("#files-rendered")).not.toBeNull();
    expect(ctx.setupTreeKeyboard).toHaveBeenCalledTimes(1);
    expect(ctx.setupTreeKeyboard.mock.calls[0][0].classList.contains("file-tree")).toBe(true);
    expect(ctx.registerFileTreeDnD).toHaveBeenCalled();
  });

  test("files tab without a .file-tree skips keyboard wiring", async () => {
    view.leftTab = "files";
    await mountWith({ renderFilesTemplate: mock(() => html`<div id="no-tree"></div>`) });
    expect(leftPanel.querySelector("#no-tree")).not.toBeNull();
    expect(ctx.setupTreeKeyboard).not.toHaveBeenCalled();
  });

  test("git tab passes the active tab's ui and the ctx through", async () => {
    activeTab.value!.session.ui.gitCommitMessage = "wip";
    view.leftTab = "git";
    await mountWith();
    expect(leftPanel.querySelector("#git-rendered")).not.toBeNull();
    expect(captured.git[0].ui.gitCommitMessage).toBe("wip");
    expect(captured.git[1]).toBe(ctx);
  });

  test("git tab with no active tab passes an empty ui", async () => {
    closeAllTabs();
    view.leftTab = "git";
    await mountWith();
    expect(captured.git[0].ui).toEqual({});
  });

  test("blocks tab renders the elements palette and registers DnD", async () => {
    view.leftTab = "blocks";
    await mountWith();
    expect(leftPanel.querySelector('[data-block-tag="p"]')).not.toBeNull();
    expect(ctx.registerElementsDnD).toHaveBeenCalled();
    expect(ctx.registerComponentsDnD).toHaveBeenCalled();
  });
});

describe("left panel — document tabs", () => {
  test("layers tab renders the layer tree and registers layers DnD", async () => {
    await mountWith();
    expect(leftPanel.querySelector(".layers-tree")).not.toBeNull();
    expect(leftPanel.querySelectorAll(".layer-row").length).toBeGreaterThan(0);
    expect(ctx.registerLayersDnD).toHaveBeenCalled();
  });

  test("layers tab scrolls the selected row into view", async () => {
    activeTab.value!.session.selection = ["children", 0];
    const scrolled: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    try {
      await mountWith();
      expect(scrolled.some((el) => el.classList.contains("layer-row"))).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  test("stylebook canvas mode renders the stylebook layer tree instead", async () => {
    await mountWith({ getCanvasMode: () => "stylebook" });
    // Stylebook meta sections render rows with tag badges, no layers DnD registration
    expect(leftPanel.querySelectorAll(".layer-row").length).toBeGreaterThan(0);
    expect(leftPanel.querySelector(".layers-tree")).toBeNull();
    expect(ctx.registerLayersDnD).not.toHaveBeenCalled();
  });

  test("imports tab passes document elements and a transact-backed applyMutation", async () => {
    activeTab.value!.doc.document.$elements = ["@acme/widgets"] as never;
    view.leftTab = "imports";
    await mountWith();
    expect(leftPanel.querySelector("#imports-rendered")).not.toBeNull();
    expect(captured.imports.documentElements).toEqual(["@acme/widgets"]);
    expect(captured.imports.documentPath).toBe("/project/index.json");

    captured.imports.applyMutation((doc: JxMutableNode) => {
      doc.title = "Mutated";
    });
    expect(activeTab.value!.doc.document.title).toBe("Mutated");
  });

  test("state tab passes a state snapshot to renderSignalsTemplate", async () => {
    view.leftTab = "state";
    await mountWith();
    expect(leftPanel.querySelector("#signals-rendered")).not.toBeNull();
    const [snapshot, deps] = captured.signals as [Record<string, unknown>, Record<string, AnyFn>];
    expect(snapshot.document).toBe(activeTab.value!.doc.document);
    expect(snapshot.selection).toBe(activeTab.value!.session.selection);
    expect(typeof deps.updateSession).toBe("function");
  });

  test("data tab passes document state and canvas scope", async () => {
    activeTab.value!.doc.document.state = { count: 1 } as never;
    activeTab.value!.session.canvas.scope = { stop: () => {} };
    view.leftTab = "data";
    await mountWith();
    expect(leftPanel.querySelector("#data-rendered")).not.toBeNull();
    expect(captured.data[0]).toEqual({ count: 1 });
    expect(captured.data[1]).toBe(activeTab.value!.session.canvas.scope);
  });

  test("data tab defaults to empty state and null scope", async () => {
    view.leftTab = "data";
    await mountWith();
    expect(captured.data[0]).toEqual({});
    expect(captured.data[1]).toBeNull();
  });

  test("unknown tab renders an empty panel body", async () => {
    view.leftTab = "bogus";
    await mountWith();
    const body = leftPanel.querySelector(".panel-body") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.children.length).toBe(0);
  });

  test("no active tab renders an empty panel body for document tabs", async () => {
    closeAllTabs();
    view.leftTab = "layers";
    await mountWith();
    const body = leftPanel.querySelector(".panel-body") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.children.length).toBe(0);
    expect(ctx.registerLayersDnD).not.toHaveBeenCalled();
  });
});

describe("left panel — head tab", () => {
  test("non-content mode passes the document and transacts mutations directly", async () => {
    view.leftTab = "head";
    await mountWith();
    expect(leftPanel.querySelector("#head-rendered")).not.toBeNull();
    expect(captured.head.document).toBe(activeTab.value!.doc.document);

    captured.head.applyMutation((doc: JxMutableNode) => {
      doc.title = "Page title";
    });
    expect(activeTab.value!.doc.document.title).toBe("Page title");
  });

  test("content mode overlays frontmatter title/$head onto the head document", async () => {
    const tab = activeTab.value!;
    tab.doc.mode = "content";
    tab.doc.content.frontmatter = {
      $head: [{ content: "x", tag: "meta" }],
      title: "FM Title",
    };
    view.leftTab = "head";
    await mountWith();
    expect(captured.head.document.title).toBe("FM Title");
    expect(captured.head.document.$head).toEqual([{ content: "x", tag: "meta" }]);
  });

  test("content-mode applyMutation routes title and $head into frontmatter", async () => {
    const tab = activeTab.value!;
    tab.doc.mode = "content";
    tab.doc.content.frontmatter = { title: "Old" };
    view.leftTab = "head";
    await mountWith();

    captured.head.applyMutation((doc: JxMutableNode) => {
      doc.title = "New";
      doc.$head = [{ href: "a.css", tag: "link" }] as never;
    });
    expect(tab.doc.content.frontmatter.title).toBe("New");
    expect(tab.doc.content.frontmatter.$head).toEqual([{ href: "a.css", tag: "link" }]);
    expect(tab.doc.dirty).toBe(true);
  });

  test("content-mode applyMutation clears $head when emptied and keeps equal title", async () => {
    const tab = activeTab.value!;
    tab.doc.mode = "content";
    tab.doc.content.frontmatter = {
      $head: [{ content: "x", tag: "meta" }],
      title: "Same",
    };
    view.leftTab = "head";
    await mountWith();

    captured.head.applyMutation((doc: JxMutableNode) => {
      (doc.$head as unknown[]).length = 0;
    });
    expect(tab.doc.content.frontmatter.$head).toBeUndefined();
    expect(tab.doc.content.frontmatter.title).toBe("Same");
  });
});

describe("left panel — lifecycle and recovery", () => {
  test("reactive effect re-renders on selection change", async () => {
    await mountWith();
    expect(leftPanel.querySelector(".layer-row.selected")).toBeNull();
    activeTab.value!.session.selection = ["children", 0];
    await flush(3);
    expect(leftPanel.querySelector(".layer-row.selected")).not.toBeNull();
  });

  test("render after unmount is a no-op", async () => {
    await mountWith();
    unmount();
    leftPanel.textContent = "";
    render();
    await flush(3);
    expect(leftPanel.querySelector(".panel-body")).toBeNull();
  });

  test("a render error is recovered by clearing lit state and retrying", async () => {
    let calls = 0;
    view.leftTab = "git";
    await mountWith({
      renderGitPanel: mock(() => {
        calls += 1;
        if (calls === 1) {
          throw new Error("boom");
        }
        return html`<div id="git-recovered"></div>`;
      }),
    });
    expect(calls).toBe(2);
    expect(leftPanel.querySelector("#git-recovered")).not.toBeNull();
  });

  test("a persistent render error is swallowed without crashing", async () => {
    view.leftTab = "git";
    await mountWith({
      renderGitPanel: mock(() => {
        throw new Error("always");
      }),
    });
    expect(leftPanel.querySelector("#git-rendered")).toBeNull();
  });
});
