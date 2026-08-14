import { renderInto, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { shell } from "../src/shell";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { UsageState } from "../src/services/references";

/**
 * The scope chip's affected count, against a host that CAN answer.
 *
 * Separate from `style-panel.test.ts` because it mocks `services/references` wholesale: the count
 * behind a project-wide warning is the one number in the panel that comes from outside the
 * document, and the rule it has to obey — "unknown", never a confident zero — is only testable by
 * driving every state the query can be in.
 */

let usage: UsageState | null = null;
const loadMock = mock(async () => usage ?? { status: "unsupported" as const });

void mock.module("../src/services/references", () => ({
  loadUsages: loadMock,
  peekUsages: () => usage,
  usageFiles: (result: { files: unknown[] }) => result.files,
}));

const { renderStylePanelTemplate, resetAffectedDisclosure } =
  await import("../src/panels/style-panel");
const { initCssData } = await import("../src/panels/style-utils");

function ready(files: { path: string; count: number }[], refsTotal: number): UsageState {
  return {
    result: {
      errors: [],
      files: files.map((f) => ({ ...f, refs: [] })),
      filesReferencing: files.length,
      path: null,
      refsTotal,
      tagName: "h1",
    },
    status: "ready",
  } as UsageState;
}

function setupLayoutTab() {
  resetStudioState();
  const doc = { children: [], tagName: "div" } as unknown as JxMutableNode;
  const tab = resetWorkspaceWithTab(doc);
  tab.documentPath = "layouts/base.json";
  tab.session.selection = [[]];
  shell.stylebook.selection = "h1";
  return tab;
}

async function renderPanel() {
  return renderInto(renderStylePanelTemplate({ getCanvasMode: () => "stylebook" }));
}

beforeEach(() => {
  initCssData({ cssProps: [["display", "inline"]] });
  loadMock.mockClear();
  resetAffectedDisclosure();
  usage = null;
});

afterEach(() => {
  closeAllTabs();
});

describe("the project-wide warning band", () => {
  test("with no answer yet it says it is counting, and asks exactly once per paint cycle", async () => {
    setupLayoutTab();
    const c = await renderPanel();
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain("counting the elements");
    expect(loadMock).toHaveBeenCalledWith({ tagName: "h1" });
  });

  test("a failed sweep is 'unknown', never zero", async () => {
    setupLayoutTab();
    usage = { message: "no backend", status: "failed" };
    const c = await renderPanel();
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain("is unknown");
    // Settled: nothing is re-requested.
    expect(loadMock).not.toHaveBeenCalled();
  });

  test("a ready answer is counted, pluralised, and listed on demand", async () => {
    setupLayoutTab();
    usage = ready([{ count: 7, path: "pages/index.json" }], 7);
    let c = await renderPanel();
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain("7 elements in 1 file");
    expect(c.querySelector(".tl-affected")).toBeNull();

    c.querySelector(".tl-warning-action")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    c = await renderPanel();
    expect(c.querySelector(".tl-affected-path")!.textContent).toBe("pages/index.json");

    // And it folds away again — the disclosure is a toggle with an idempotent reset behind it.
    c.querySelector(".tl-warning-action")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    c = await renderPanel();
    expect(c.querySelector(".tl-affected")).toBeNull();
  });

  test("one element in one file reads in the singular", async () => {
    setupLayoutTab();
    usage = ready([{ count: 1, path: "pages/index.json" }], 1);
    const c = await renderPanel();
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain("1 element in 1 file");
  });

  test("a tag nothing uses says so, rather than reporting a count of zero", async () => {
    setupLayoutTab();
    usage = ready([], 0);
    const c = await renderPanel();
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain("no element in the project");
  });

  test("a pending sweep is still counting", async () => {
    setupLayoutTab();
    usage = { status: "pending" };
    const c = await renderPanel();
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain("counting the elements");
  });

  test("a page document with the same tag is document-scoped, with no band at all", async () => {
    const tab = setupLayoutTab();
    tab.documentPath = "pages/index.json";
    usage = ready([], 0);
    const c = await renderPanel();
    expect(c.querySelector(".tl-warning")).toBeNull();
    expect(c.querySelector(".tl-scope")!.textContent).toContain("all <h1> in this document");
    expect(activeTab.value!.documentPath).toBe("pages/index.json");
  });
});

/**
 * The project stylesheet — the document Stylebook opens by default.
 *
 * Its `style` is handed to every route's compile as `projectStyle`, so a bare tag key becomes a
 * global `h1 { … }` rule on every page and inside every component instance (nothing attaches a
 * shadow root), and Studio merges the same object into every open document via `getEffectiveStyle`.
 * It spent P5 labelled "in this document" — the narrowest phrase in the vocabulary on the widest
 * blast radius in the app.
 */
describe("project.json is the widest scope, not the narrowest", () => {
  test("a tag selected in the project stylesheet warns project-wide, and counts", async () => {
    const tab = setupLayoutTab();
    tab.documentPath = "project.json";
    usage = ready([{ count: 4, path: "pages/index.json" }], 4);
    const c = await renderPanel();
    expect(c.querySelector(".tl-scope")!.textContent).toContain("all <h1> in this project");
    expect((c.querySelector(".tl-scope") as HTMLElement).dataset.scope).toBe("project");
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain("4 elements in 1 file");
  });

  test("a config reached from a sub-directory is still the project stylesheet", async () => {
    const tab = setupLayoutTab();
    tab.documentPath = "sites/blog/project.json";
    usage = ready([], 3);
    const c = await renderPanel();
    expect(c.querySelector(".tl-scope")!.textContent).toContain("all <h1> in this project");
  });

  test("a document merely NAMED project.json under another name is not it", async () => {
    const tab = setupLayoutTab();
    tab.documentPath = "pages/my-project.json";
    usage = ready([], 0);
    const c = await renderPanel();
    expect(c.querySelector(".tl-warning")).toBeNull();
    expect(c.querySelector(".tl-scope")!.textContent).toContain("all <h1> in this document");
  });

  test("with no tag selected the root style still warns, and says unknown rather than zero", async () => {
    const tab = setupLayoutTab();
    tab.documentPath = "project.json";
    // Clicking empty canvas in Stylebook clears the tag but leaves the root path selected, so the
    // Tab goes on editing project.json's `:root`/`body` block with nothing selected.
    shell.stylebook.selection = null;
    usage = ready([{ count: 9, path: "pages/index.json" }], 9);
    const c = await renderPanel();
    expect(c.querySelector(".tl-scope")!.textContent).toContain("every page in this project");
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain(
      "how many pages that is, is unknown",
    );
    // No tag means no query and no file list — so no disclosure to offer, and nothing asked.
    expect(c.querySelector(".tl-warning-action")).toBeNull();
    expect(loadMock).not.toHaveBeenCalled();
  });

  test("an ordinary document with no tag is still just the element", async () => {
    const tab = setupLayoutTab();
    tab.documentPath = "pages/index.json";
    shell.stylebook.selection = null;
    const c = await renderPanel();
    expect(c.querySelector(".tl-scope")!.textContent).toContain("this element");
    expect(c.querySelector(".tl-warning")).toBeNull();
  });
});
