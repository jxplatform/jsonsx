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
import { shell } from "../src/shell";
import type { JxMutableNode } from "@jxsuite/schema/types";

type AnyFn = (...args: any[]) => any;

let ctx: Record<string, any>;
let captured: { head: any; imports: any; signals: any[]; git: any[] };

function makeCtx(overrides: Record<string, unknown> = {}) {
  captured = { git: [], head: null, imports: null, signals: [] };
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
  shell.leftTab = "layers";
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
    shell.leftTab = "files";
    await mountWith();
    expect(leftPanel.querySelector("#files-rendered")).not.toBeNull();
    expect(ctx.setupTreeKeyboard).toHaveBeenCalledTimes(1);
    expect(ctx.setupTreeKeyboard.mock.calls[0][0].classList.contains("file-tree")).toBe(true);
    expect(ctx.registerFileTreeDnD).toHaveBeenCalled();
  });

  test("files tab without a .file-tree skips keyboard wiring", async () => {
    shell.leftTab = "files";
    await mountWith({ renderFilesTemplate: mock(() => html`<div id="no-tree"></div>`) });
    expect(leftPanel.querySelector("#no-tree")).not.toBeNull();
    expect(ctx.setupTreeKeyboard).not.toHaveBeenCalled();
  });

  test("git tab passes the ctx through and reads project state, not the tab", async () => {
    shell.leftTab = "git";
    await mountWith();
    expect(leftPanel.querySelector("#git-rendered")).not.toBeNull();
    expect(captured.git[0]).toBe(ctx);
  });

  test("git tab renders with no active tab — Source Control is project level", async () => {
    closeAllTabs();
    shell.leftTab = "git";
    await mountWith();
    expect(leftPanel.querySelector("#git-rendered")).not.toBeNull();
  });

  test("project-level source-control changes repaint the panel with no tab open", async () => {
    // The panel used to be repainted by hand from inside git-panel (renderOnly("leftPanel") after
    // Every write). Those calls are gone: the fields it renders from are tracked here.
    closeAllTabs();
    shell.leftTab = "git";
    await mountWith();
    const renders = () => (ctx.renderGitPanel as ReturnType<typeof mock>).mock.calls.length;
    const before = renders();

    shell.git.subTab = "history";
    await flush(3);
    expect(renders()).toBeGreaterThan(before);

    const afterSubTab = renders();
    shell.git.logEntries = [{ author: "a", date: "d", hash: "abc", message: "m" }];
    await flush(3);
    expect(renders()).toBeGreaterThan(afterSubTab);
  });

  test("insert panel renders the elements palette and registers DnD", async () => {
    shell.leftTab = "insert";
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
    activeTab.value!.session.selection = [["children", 0]];
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

  test("packages panel passes document elements and a transact-backed applyMutation", async () => {
    activeTab.value!.doc.document.$elements = ["@acme/widgets"] as never;
    shell.leftTab = "packages";
    await mountWith();
    expect(leftPanel.querySelector("#imports-rendered")).not.toBeNull();
    expect(captured.imports.documentElements).toEqual(["@acme/widgets"]);
    expect(captured.imports.documentPath).toBe("/project/index.json");

    captured.imports.applyMutation((doc: JxMutableNode) => {
      doc.title = "Mutated";
    });
    expect(activeTab.value!.doc.document.title).toBe("Mutated");
  });

  test("the data tab renders the ONE template, over the whole tab", async () => {
    // `state` and `data` were two tabs calling two templates with two slices of the same tab —
    // `renderSignalsTemplate` got a snapshot, `renderDataExplorerTemplate` got `document.state` and
    // `canvas.scope` separately. One panel takes the tab record itself, so the definitions and the
    // Values it resolved to cannot come from different reads.
    activeTab.value!.doc.document.state = { count: 1 } as never;
    activeTab.value!.session.canvas.scope = { count: 1 };
    shell.leftTab = "data";
    await mountWith();
    expect(leftPanel.querySelector("#signals-rendered")).not.toBeNull();
    const [snapshot, deps] = captured.signals as [Record<string, unknown>, Record<string, AnyFn>];
    expect(snapshot.document).toBe(activeTab.value!.doc.document);
    expect(snapshot.selection).toBe(activeTab.value!.session.selection);
    expect((snapshot.canvas as Record<string, unknown>).scope).toBe(
      activeTab.value!.session.canvas.scope,
    );
    // A repaint and a refetch. `renderCanvas` and `updateSession` were threaded through here until
    // Nothing in the panel read either — see `SignalsPanelCtx`.
    expect(Object.keys(deps).toSorted()).toEqual(["refreshData", "renderLeftPanel"]);
  });

  test("there is no `state` tab left to render", async () => {
    shell.leftTab = "state";
    await mountWith();
    const body = leftPanel.querySelector(".panel-body") as HTMLElement;
    expect(body.querySelector(".empty-state-message")?.textContent).toBe(
      'No Navigator panel is registered as "state".',
    );
  });

  test("an id the registry does not declare says so instead of painting a blank body", async () => {
    shell.leftTab = "bogus";
    await mountWith();
    const body = leftPanel.querySelector(".panel-body") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.querySelector(".empty-state-message")?.textContent).toBe(
      'No Navigator panel is registered as "bogus".',
    );
  });

  test("no active tab teaches what each document tab is for instead of painting a blank body", async () => {
    closeAllTabs();
    shell.leftTab = "layers";
    await mountWith();
    const body = leftPanel.querySelector(".panel-body") as HTMLElement;
    expect(body.querySelector(".empty-state-message")?.textContent).toBe(
      "Open a page to see the elements it is built from.",
    );
    expect((body.querySelector(".empty-state-action") as HTMLElement).textContent?.trim()).toBe(
      "Open a page…",
    );
    expect(ctx.registerLayersDnD).not.toHaveBeenCalled();
  });

  test("every document tab has its own no-document sentence", async () => {
    closeAllTabs();
    const seen = new Set<string>();
    for (const tabName of ["layers", "packages", "data", "page"]) {
      shell.leftTab = tabName;
      await mountWith();
      const message = leftPanel.querySelector(".empty-state-message")?.textContent ?? "";
      expect(message.startsWith("Open a page to")).toBe(true);
      seen.add(message);
      unmount();
    }
    expect(seen.size).toBe(4);
  });
});

describe("left panel — page panel", () => {
  test("non-content mode passes the document and transacts mutations directly", async () => {
    shell.leftTab = "page";
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
    shell.leftTab = "page";
    await mountWith();
    expect(captured.head.document.title).toBe("FM Title");
    expect(captured.head.document.$head).toEqual([{ content: "x", tag: "meta" }]);
  });

  test("content-mode applyMutation routes title and $head into frontmatter", async () => {
    const tab = activeTab.value!;
    tab.doc.mode = "content";
    tab.doc.content.frontmatter = { title: "Old" };
    shell.leftTab = "page";
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
    shell.leftTab = "page";
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
    activeTab.value!.session.selection = [["children", 0]];
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
    shell.leftTab = "git";
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
    shell.leftTab = "git";
    await mountWith({
      renderGitPanel: mock(() => {
        throw new Error("always");
      }),
    });
    expect(leftPanel.querySelector("#git-rendered")).toBeNull();
  });
});
