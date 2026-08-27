/**
 * Diff gaps across the four Files modules — the branches the rest of the Files suite never enters.
 *
 * Each case here is a fall-through nobody was standing on: the session restore that actually
 * restores something (and the second pane it has to build first), a `.csv` whose grid editor
 * refuses to open, the "Loading…" placeholder sitting in the keyboard's path, a grid tab's save
 * verdict, and a component that can be named neither by package nor by path being un-imported.
 */
import { flush, installMockPlatform, renderInto } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { requireProjectState, setProjectState } from "../src/store";
import {
  PRIMARY_PANE,
  SECONDARY_PANE,
  closeAllTabs,
  closePane,
  focusPane,
  openTab,
  paneById,
  setWorkspaceProject,
  workspace,
} from "../src/workspace/workspace";
import { problems, resetNotifications } from "../src/services/notify";
import { MARKDOWN_FORMAT, mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import { disableElement } from "../src/files/elements";
import type { ElementsEntry } from "../src/files/elements";
import type { ComponentEntry } from "../src/files/components";
import type { DirEntry, StudioPlatform } from "../src/types";
import type { Tab } from "../src/tabs/tab";

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
  monitorForElements: () => () => {},
}));

/** What the (mocked) CSV grid editor does when `openFileInTab` hands it a path. */
let csvOpenFails: Error | null = null;
void mock.module("../src/grid/grid-open", () => ({
  openCsvGridTab: async (path: string) => {
    if (csvOpenFails) {
      throw csvOpenFails;
    }
    openTab({ document: { children: [], tagName: "div" }, documentPath: path, id: path });
  },
  openPagesGrid: async () => {},
}));

/** Tabs this file has declared to be grid tabs, keyed by the raw tab `openTab` handed back. */
const gridTabs = new Map<
  object,
  { save: () => Promise<void>; serializeForSource: () => string | null }
>();
void mock.module("../src/grid/grid-controller", () => ({
  ROW_KEY_FIELD: "__key",
  getGridController: (tab: object | null) => (tab === null ? null : (gridTabs.get(tab) ?? null)),
}));

const { openFileInTab, openLastSessionOrHome, renderFilesTemplate } =
  await import("../src/files/files");
const { saveFile } = await import("../src/files/file-ops");
const { serializeDocument } = await import("../src/files/serialize-document");

// ─── Local helpers ────────────────────────────────────────────────────────────

/** Derive DirEntry[] (with `type`, as files.ts expects) from the mock platform's file map. */
function dirEntries(files: Map<string, string>, dir: string): DirEntry[] {
  const prefix = dir === "." || dir === "" ? "" : dir.endsWith("/") ? dir : `${dir}/`;
  const seen = new Map<string, DirEntry>();
  for (const path of files.keys()) {
    if (prefix && !path.startsWith(prefix)) {
      continue;
    }
    const rest = path.slice(prefix.length);
    const [head] = rest.split("/");
    if (!head || seen.has(head)) {
      continue;
    }
    seen.set(head, {
      name: head,
      path: prefix + head,
      type: rest.includes("/") ? "directory" : "file",
    });
  }
  return [...seen.values()];
}

/** Mock platform whose listDirectory speaks files.ts' `type`-based DirEntry shape. */
function installFsPlatform(seed: Record<string, string> = {}) {
  const handle = installMockPlatform(
    {
      formatAction: mockFormatAction,
      listFormats: async () => [MARKDOWN_FORMAT],
    } as Partial<StudioPlatform>,
    seed,
  );
  handle.platform.listDirectory = async (dir: string) => {
    handle.state.calls.push(["listDirectory", dir]);
    return dirEntries(handle.state.files, dir);
  };
  return handle;
}

function siteState(overrides: Record<string, unknown> = {}) {
  setProjectState({
    dirs: new Map(),
    expanded: new Set(),
    isSiteProject: true,
    name: "Demo",
    projectConfig: { name: "Demo" },
    projectDirs: [],
    projectRoot: ".",
    searchQuery: "",
    selectedPath: null,
    ...overrides,
  } as never);
}

/** Write the per-project record `persistedSession` reads, for `root`. */
function storeSession(root: string, session: Record<string, unknown>): void {
  localStorage.setItem(
    `jx-studio-project::${root}`,
    JSON.stringify({ activeLayout: null, layouts: [], session }),
  );
}

/** The documents a pane is holding, in strip order. */
function documentsIn(paneId: string): (string | null | undefined)[] {
  return (paneById(paneId)?.tabOrder ?? []).map((id) => workspace.tabs.get(id)?.documentPath);
}

beforeEach(() => {
  closeAllTabs();
  closePane(SECONDARY_PANE);
  focusPane(PRIMARY_PANE);
  setProjectState(null);
  setWorkspaceProject(null);
  gridTabs.clear();
  csvOpenFails = null;
  localStorage.clear();
  resetNotifications();
  seedMarkdownFormat();
});

// ─── openLastSessionOrHome ────────────────────────────────────────────────────

describe("openLastSessionOrHome", () => {
  test("a two-pane session builds the second pane before filling it", async () => {
    // `receivingPane()` is the whole point of `ensureSecondPane`: `openTab` falls back to the ACTIVE
    // Pane for a `paneId` the grid does not have, so without it both documents land in the primary
    // And the split the author left the project in is silently gone.
    installFsPlatform({
      "pages/a.json": JSON.stringify({ children: [], tagName: "article" }),
      "pages/b.json": JSON.stringify({ children: [], tagName: "aside" }),
      "pages/index.json": JSON.stringify({ children: [], tagName: "main" }),
    });
    siteState({ projectRoot: "/abs/two-pane" });
    setWorkspaceProject("/abs/two-pane");
    storeSession("/abs/two-pane", {
      focusedPane: SECONDARY_PANE,
      panes: [
        { activeFile: "pages/a.json", files: ["pages/a.json"], id: PRIMARY_PANE },
        { activeFile: "pages/b.json", files: ["pages/b.json"], id: SECONDARY_PANE },
      ],
      ui: {},
    });

    expect(await openLastSessionOrHome()).toBe(true);

    expect(documentsIn(PRIMARY_PANE)).toEqual(["pages/a.json"]);
    expect(documentsIn(SECONDARY_PANE)).toEqual(["pages/b.json"]);
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    // A restored session is an answer to "what should be open", so the home page must not also be.
    expect([...workspace.tabs.values()].map((tab) => tab.documentPath)).not.toContain(
      "pages/index.json",
    );
  });

  test("a session whose every file has moved falls through to the home page, and says so", async () => {
    installFsPlatform({ "pages/index.json": JSON.stringify({ children: [], tagName: "main" }) });
    siteState({ projectRoot: "/abs/stale" });
    setWorkspaceProject("/abs/stale");
    storeSession("/abs/stale", {
      focusedPane: PRIMARY_PANE,
      panes: [{ activeFile: null, files: ["pages/gone.json"], id: PRIMARY_PANE }],
      ui: {},
    });

    // `false` is "no SESSION was restored" — the `?project=` boot still has its own open to run.
    expect(await openLastSessionOrHome()).toBe(false);

    expect(documentsIn(PRIMARY_PANE)).toEqual(["pages/index.json"]);
    expect(paneById(SECONDARY_PANE)).toBeUndefined();
  });
});

// ─── openFileInTab · the CSV grid editor ──────────────────────────────────────

describe("a .csv the grid editor cannot open", () => {
  test("is one Problem naming the file, and no tab", async () => {
    installFsPlatform({ "data/rows.csv": "a,b\n1,2\n" });
    siteState();
    csvOpenFails = new Error("unterminated quote on line 4");

    await openFileInTab("data/rows.csv");

    const problem = problems.at(-1)!;
    expect(problem.message).toBe("Could not open data/rows.csv.");
    expect(problem.detail).toContain("unterminated quote on line 4");
    expect(problem.path).toBe("data/rows.csv");
    expect(problem.source).toBe("Open File");
    // The failure is terminal: a `.csv` never falls through to the document reader behind it.
    expect(workspace.tabs.size).toBe(0);
  });

  test("a .csv that DOES open raises nothing and is the tab", async () => {
    installFsPlatform({ "data/rows.csv": "a,b\n1,2\n" });
    siteState();

    await openFileInTab("data/rows.csv");

    expect(problems).toHaveLength(0);
    expect(documentsIn(PRIMARY_PANE)).toEqual(["data/rows.csv"]);
    expect(requireProjectState().selectedPath).toBe("data/rows.csv");
  });
});

/**
 * An empty file still has to answer for itself.
 *
 * Returning silently was defensible while every file the tree could create was a seeded document.
 * The format picker's `Other…` row makes an empty `main.css` or `.gitignore` an ordinary thing to
 * create, and clicking one and having NOTHING happen — no tab, no error, no toast — reads as a
 * broken tree rather than as a file Studio has no editor for.
 */
describe("an empty file", () => {
  test("that no format claims reports the same named error a non-empty one would", async () => {
    installFsPlatform({ "styles/main.css": "" });
    siteState();

    await openFileInTab("styles/main.css");

    expect(problems.at(-1)!.detail).toContain("No format class imported");
    expect(workspace.tabs.size).toBe(0);
  });

  test("that IS a document is nothing to report — there is simply nothing to show yet", async () => {
    installFsPlatform({ "pages/blank.json": "" });
    siteState();

    await openFileInTab("pages/blank.json");

    expect(problems).toHaveLength(0);
    expect(workspace.tabs.size).toBe(0);
  });
});

// ─── The tree keyboard walks the MODEL, placeholders included ─────────────────

describe("the ↓ walk and the Loading… placeholder", () => {
  test("steps over a directory still being listed onto the next real row", async () => {
    // An expanded directory nobody has listed yet contributes a placeholder row, and a placeholder
    // Is not a destination: it has no `data-path` of its own — it carries its DIRECTORY's — so
    // Stopping on it would hand the keyboard straight back to the row ↓ was pressed on.
    const { platform } = installFsPlatform();
    platform.listDirectory = async (dir: string) => {
      if (dir === "assets") {
        // Still in flight: the placeholder stays in the model for the whole test.
        return new Promise<DirEntry[]>(() => {});
      }
      return [
        { name: "assets", path: "assets", type: "directory" },
        { name: "one.json", path: "one.json", type: "file" },
        { name: "two.json", path: "two.json", type: "file" },
      ];
    };
    siteState({
      dirs: new Map<string, DirEntry[]>([
        [
          ".",
          [
            { name: "assets", path: "assets", type: "directory" },
            { name: "one.json", path: "one.json", type: "file" },
            { name: "two.json", path: "two.json", type: "file" },
          ],
        ],
      ]),
      expanded: new Set(["assets"]),
    });

    const host = document.createElement("div");
    document.body.append(host);
    await renderInto(
      renderFilesTemplate({
        openFileFromTree: () => {},
        openProject: () => {},
        renderLeftPanel: () => {},
      }),
      host,
    );
    await flush();

    const tree = host.querySelector(".file-tree") as HTMLElement;
    // Model: assets · Loading… · one.json · two.json
    expect(
      [...tree.querySelectorAll(".file-tree-item")].map((el) => el.textContent?.trim()),
    ).toContain("Loading…");
    const assets = tree.querySelector('.file-tree-item[data-path="assets"]') as HTMLElement;
    assets.focus();

    assets.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }),
    );
    await flush();

    expect((document.activeElement as HTMLElement).dataset.path).toBe("one.json");
    host.remove();
  });
});

// ─── saveFile · a grid tab's own verdict ─────────────────────────────────────

describe("saving a grid tab", () => {
  /** Open a `.csv` tab and declare a grid controller for it whose save behaves as `after` says. */
  function gridTab(id: string, after: (tab: Tab) => void) {
    const tab = openTab({
      document: { children: [], tagName: "div" },
      documentPath: id,
      id,
    });
    tab.doc.dirty = true;
    gridTabs.set(tab, {
      save: async () => {
        after(tab);
      },
      serializeForSource: () => null,
    });
    return tab;
  }

  test("a commit that cleared the buffer is a save", async () => {
    const { state } = installMockPlatform({ formatAction: mockFormatAction });
    const tab = gridTab("data/clean.csv", (t) => {
      t.doc.dirty = false;
    });

    expect(await saveFile(tab)).toBe(true);
    // Per-source commit semantics, not a document write — the file is never serialized here.
    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
  });

  test("rows the commit could not take keep the tab dirty, and that is the answer", async () => {
    const { state } = installMockPlatform({ formatAction: mockFormatAction });
    const tab = gridTab("data/partial.csv", () => {
      // A batch commit keeps failed rows dirty and mirrors that onto the tab.
    });

    expect(await saveFile(tab)).toBe(false);
    expect(tab.doc.dirty).toBe(true);
    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
  });
});

// ─── serializeDocument · a grid tab serializes through its source ─────────────

describe("serializing a grid tab", () => {
  /*
   * The SOURCE, not the document. A grid tab's document is the grid's own shape, so serializing it
   * would show the Monaco source View something no save would ever write — and the pending edits,
   * which live in the buffer rather than the document, would be missing from it.
   */
  test("the source's pending text is what serializes, document untouched", async () => {
    installMockPlatform({ formatAction: mockFormatAction });
    const tab = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "data/live.csv",
      id: "data/live.csv",
    });
    gridTabs.set(tab, {
      save: async () => {},
      serializeForSource: () => "name,role\nAda,author\n",
    });

    expect(await serializeDocument(tab)).toBe("name,role\nAda,author\n");
  });

  // A source with nothing to say is not an answer — the document is still the fallback.
  test("a source that answers with nothing falls through to the document", async () => {
    installMockPlatform({ formatAction: mockFormatAction });
    const tab = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "data/empty.csv",
      id: "data/empty.csv",
    });
    gridTabs.set(tab, { save: async () => {}, serializeForSource: () => null });

    expect(JSON.parse(await serializeDocument(tab))).toEqual({ children: [], tagName: "div" });
  });
});

// ─── disableElement · a component nameable neither way ───────────────────────

describe("disableElement", () => {
  test("a component with no package and no path leaves the list exactly as it was", () => {
    // The registry entry is unusable, and there is nothing to look for: `computeRelativePath` would
    // Be handed `undefined` as the component's path and throw on a real importing document.
    const before: ElementsEntry[] = ["@acme/ui", { $ref: "./components/card.json" }];
    const ghost = { tagName: "x-ghost" } as unknown as ComponentEntry;

    const after = disableElement(before, ghost, "pages/index.md");

    expect(after).toEqual(["@acme/ui", { $ref: "./components/card.json" }]);
    // A new list, never the caller's own array: the two levels persist it differently.
    expect(after).not.toBe(before);
  });
});
