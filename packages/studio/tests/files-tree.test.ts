/**
 * Coverage for src/files/files.ts — file tree rendering, toolbar actions (new file, refresh,
 * search), keyboard navigation, the context menu with rename/delete dialogs, and drag-and-drop (via
 * a mocked pragmatic-drag-and-drop adapter so registrations and drops are deterministic).
 */
import {
  answerPromptDialog,
  dragEvent,
  flush,
  installMockPlatform,
  key,
  pointer,
  promptFormatOptions,
  renderInto,
  testFile,
} from "./harness";
import type { MockPlatformState } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { requireProjectState, setProjectState } from "../src/store";
import { closeAllTabs, openTab, workspace } from "../src/workspace/workspace";
import { initLayers } from "../src/ui/layers";
import { setFormats } from "../src/format/format-host";
import { MARKDOWN_FORMAT, mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import type { DirEntry, StudioPlatform } from "../src/types";

// ─── Mock the DnD adapter (registrations recorded, callbacks driveable) ───────

interface DndRegistry {
  draggables: any[];
  dropTargets: any[];
  monitors: any[];
  cleanups: string[];
}
const dnd: DndRegistry = { cleanups: [], draggables: [], dropTargets: [], monitors: [] };

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: (opts: unknown) => {
    dnd.draggables.push(opts);
    return () => dnd.cleanups.push("draggable");
  },
  dropTargetForElements: (opts: unknown) => {
    dnd.dropTargets.push(opts);
    return () => dnd.cleanups.push("dropTarget");
  },
  monitorForElements: (opts: unknown) => {
    dnd.monitors.push(opts);
    return () => dnd.cleanups.push("monitor");
  },
}));

const { loadDirectory, registerFileTreeDnD, renderFilesTemplate, setShowIgnoredFiles } =
  await import("../src/files/files");
const { resetIgnoreCache } = await import("../src/files/gitignore");
const { createCommandRegistry } = await import("../src/commands/registry");
const { emptyContext } = await import("../src/commands/context");
const { setActiveRegistry } = await import("../src/commands/active-registry");
const { gridCommands } = await import("../src/grid/grid-open");
const { registerContentCommands } = await import("../src/content/entry-commands");

// ─── Local helpers ────────────────────────────────────────────────────────────

function dirEntriesOf(files: Map<string, string>, dir: string): DirEntry[] {
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

function installFsPlatform(
  seed: Record<string, string> = {},
  overrides: Partial<StudioPlatform> = {},
): { platform: StudioPlatform; state: MockPlatformState } {
  const handle = installMockPlatform(
    {
      formatAction: mockFormatAction,
      listFormats: async () => [MARKDOWN_FORMAT],
      ...overrides,
    } as Partial<StudioPlatform>,
    seed,
  );
  if (!overrides.listDirectory) {
    handle.platform.listDirectory = async (dir: string) => {
      handle.state.calls.push(["listDirectory", dir]);
      return dirEntriesOf(handle.state.files, dir);
    };
  }
  return handle;
}

function siteState(overrides: Record<string, unknown> = {}) {
  setProjectState({
    dirs: new Map<string, DirEntry[]>(),
    expanded: new Set<string>(),
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

function makeTreeCtx() {
  const opened: string[] = [];
  const counters = { left: 0, project: 0 };
  const ctx = {
    openFileFromTree: (p: string) => {
      opened.push(p);
    },
    openProject: () => {
      counters.project += 1;
    },
    renderLeftPanel: () => {
      counters.left += 1;
    },
  };
  return { counters, ctx, opened };
}

/** Standard fixture: root with two dirs + assorted files, "pages" pre-expanded. */
function seedTreeState(): void {
  const st = requireProjectState();
  st.dirs.set(".", [
    { name: "zeta.json", path: "zeta.json", type: "file" },
    { name: "pages", path: "pages", type: "directory" },
    { name: "beta.md", path: "beta.md", type: "file" },
    { name: "assets", path: "assets", type: "directory" },
    { name: "gamma.png", path: "gamma.png", type: "file" },
    { name: "delta.css", path: "delta.css", type: "file" },
    { name: "epsilon.ts", path: "epsilon.ts", type: "file" },
    { name: "omega.js", path: "omega.js", type: "file" },
    { name: "license", path: "license", type: "file" },
  ]);
  st.dirs.set("pages", [{ name: "index.json", path: "pages/index.json", type: "file" }]);
  st.expanded.add("pages");
}

function rowFor(container: HTMLElement, path: string, expected = true): HTMLElement {
  const row = container.querySelector(`.file-tree-item[data-path="${path}"]`);
  if (expected) {
    expect(row).not.toBeNull();
  }
  return row as HTMLElement;
}

function popoverMenuItems(): HTMLElement[] {
  return [...document.querySelectorAll("#layer-popover sp-menu-item")] as HTMLElement[];
}

async function clickMenuItem(label: string): Promise<void> {
  const item = popoverMenuItems().find((el) => el.textContent?.trim() === label);
  expect(item).toBeDefined();
  pointer(item!, "click");
  await flush();
}

function dialogWrapper(): HTMLElement | null {
  return document.querySelector("#layer-dialog sp-dialog-wrapper");
}

async function dismissOutside(): Promise<void> {
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await flush();
}

let host: HTMLElement;

beforeEach(() => {
  closeAllTabs();
  setProjectState(null);
  seedMarkdownFormat();
  dnd.draggables = [];
  dnd.dropTargets = [];
  dnd.monitors = [];
  dnd.cleanups = [];
  for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
    let layer = document.querySelector(`#${id}`);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = id;
      document.body.append(layer);
    }
    layer.innerHTML = "";
  }
  initLayers();
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await dismissOutside();
  host.remove();
  // The tree's context menu renders `forPlacement("context/file")`; a registry left published
  // Would leak declared rows into every later case.
  setActiveRegistry(null);
});

// ─── renderFilesTemplate — empty / welcome states ─────────────────────────────

describe("renderFilesTemplate states", () => {
  test("no project state — placeholder", async () => {
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);
    expect(out.textContent).toContain("No project loaded");
  });

  test("monorepo welcome prompt wires the Open Project button", async () => {
    installFsPlatform();
    siteState({ isSiteProject: false, projectConfig: null });
    const { counters, ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    expect(out.textContent).toContain("Open a project folder");
    pointer(out.querySelector("sp-button")!, "click");
    expect(counters.project).toBe(1);
  });

  test("site header prefers projectConfig name, falls back to project name", async () => {
    installFsPlatform();
    siteState({ projectConfig: { name: "Config Name" } });
    seedTreeState();
    const { ctx } = makeTreeCtx();
    let out = await renderInto(renderFilesTemplate(ctx), host);
    expect(out.querySelector(".project-name")?.textContent).toBe("Config Name");

    requireProjectState().projectConfig = null;
    out = await renderInto(renderFilesTemplate(ctx), host);
    expect(out.querySelector(".project-name")?.textContent).toBe("Demo");
  });

  test("unloaded root renders Loading… then triggers a background load", async () => {
    installFsPlatform({ "pages/index.json": "{}" });
    siteState();
    const { counters, ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    expect(out.textContent).toContain("Loading…");
    await flush();
    expect(requireProjectState().dirs.get(".")).toBeDefined();
    expect(counters.left).toBeGreaterThan(0);
  });
});

// ─── renderFilesTemplate — tree listing ───────────────────────────────────────

describe("file tree listing", () => {
  test("sorts directories first, then files alphabetically; nested group renders", async () => {
    installFsPlatform();
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    const names = [...out.querySelectorAll(".file-tree-item .file-tree-name")].map(
      (el) => el.textContent,
    );
    expect(names).toEqual([
      "assets",
      "pages",
      "index.json", // Expanded "pages" renders its child group inline
      "beta.md",
      "delta.css",
      "epsilon.ts",
      "gamma.png",
      "license",
      "omega.js",
      "zeta.json",
    ]);
    // The tree is FLAT — one windowed row list, not a `role="group"` per level (R5). A child of an
    // Expanded directory says where it sits with aria-level/posinset/setsize instead, which is the
    // Only account that stays true when the tree draws a window rather than all of itself.
    expect(out.querySelector('[role="group"]')).toBeNull();
    expect(rowFor(out, "pages/index.json").getAttribute("aria-level")).toBe("2");
    expect(rowFor(out, "pages/index.json").getAttribute("aria-posinset")).toBe("1");
    expect(rowFor(out, "pages/index.json").getAttribute("aria-setsize")).toBe("1");
    expect(rowFor(out, "pages").getAttribute("aria-level")).toBe("1");
    expect(rowFor(out, "pages").getAttribute("aria-posinset")).toBe("2");
    expect(rowFor(out, "pages").getAttribute("aria-setsize")).toBe("9");
    expect(rowFor(out, "pages").getAttribute("aria-expanded")).toBe("true");
    expect(rowFor(out, "assets").getAttribute("aria-expanded")).toBe("false");
  });

  test("file-type icons match extensions; folder icons track expansion", async () => {
    installFsPlatform();
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    expect(rowFor(out, "zeta.json").querySelector("sp-icon-file-code")).not.toBeNull();
    expect(rowFor(out, "epsilon.ts").querySelector("sp-icon-file-code")).not.toBeNull();
    expect(rowFor(out, "omega.js").querySelector("sp-icon-file-code")).not.toBeNull();
    expect(rowFor(out, "delta.css").querySelector("sp-icon-file-code")).not.toBeNull();
    expect(rowFor(out, "beta.md").querySelector("sp-icon-file-txt")).not.toBeNull();
    expect(rowFor(out, "gamma.png").querySelector("sp-icon-image")).not.toBeNull();
    expect(rowFor(out, "license").querySelector("sp-icon-document")).not.toBeNull();
    expect(rowFor(out, "assets").querySelector("sp-icon-folder")).not.toBeNull();
    expect(rowFor(out, "pages").querySelector("sp-icon-folder-open")).not.toBeNull();
  });

  test("selectedPath row carries the selected class", async () => {
    installFsPlatform();
    siteState({ selectedPath: "beta.md" });
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    expect(rowFor(out, "beta.md").classList.contains("selected")).toBe(true);
    expect(rowFor(out, "zeta.json").classList.contains("selected")).toBe(false);
  });

  test("search query filters files but keeps directories", async () => {
    installFsPlatform();
    siteState({ searchQuery: "beta" });
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    const names = [...out.querySelectorAll(".file-tree-item .file-tree-name")].map(
      (el) => el.textContent,
    );
    expect(names).toContain("beta.md");
    expect(names).toContain("assets");
    expect(names).toContain("pages");
    expect(names).not.toContain("zeta.json");
  });

  test("a language is a CHIP on the row, never a term the search matches", async () => {
    installFsPlatform();
    siteState({
      projectConfig: { i18n: { defaultLocale: "en", locales: ["en", "fr"] }, name: "Demo" },
    });
    const st = requireProjectState();
    st.dirs.set(".", [{ name: "pages", path: "pages", type: "directory" }]);
    st.dirs.set("pages", [
      { name: "fr", path: "pages/fr", type: "directory" },
      { name: "index.json", path: "pages/index.json", type: "file" },
    ]);
    st.dirs.set("pages/fr", [{ name: "about.json", path: "pages/fr/about.json", type: "file" }]);
    st.expanded.add("pages");
    st.expanded.add("pages/fr");
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    // The chip is drawn — and the query that matches it exactly still matches no FILE, because the
    // Filter reads `entry.name` alone. A search that silently also matched a language would make
    // "why is this file here" unanswerable from what is on screen.
    expect(rowFor(out, "pages/fr/about.json").querySelector(".file-tree-locale")?.textContent).toBe(
      "français",
    );
    expect(rowFor(out, "pages/index.json").querySelector(".file-tree-locale")).toBeNull();

    requireProjectState().searchQuery = "français";
    const filtered = await renderInto(renderFilesTemplate(ctx), host);
    expect(rowFor(filtered, "pages/fr/about.json", false)).toBeNull();
  });

  test("search input updates the query and re-renders", async () => {
    installFsPlatform();
    siteState();
    seedTreeState();
    const { counters, ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    const search = out.querySelector("sp-search") as HTMLInputElement;
    search.value = "gamma";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(requireProjectState().searchQuery).toBe("gamma");
    expect(counters.left).toBe(1);

    // Submit is prevented (no navigation)
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    search.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  test("clicking a file opens it; clicking a directory toggles expansion", async () => {
    installFsPlatform({ "assets/logo.png": "binary" });
    siteState();
    seedTreeState();
    const { counters, ctx, opened } = makeTreeCtx();
    let out = await renderInto(renderFilesTemplate(ctx), host);

    pointer(rowFor(out, "beta.md"), "click");
    await flush();
    expect(opened).toEqual(["beta.md"]);

    pointer(rowFor(out, "assets"), "click");
    await flush();
    expect(requireProjectState().expanded.has("assets")).toBe(true);
    expect(
      requireProjectState()
        .dirs.get("assets")
        ?.map((e) => e.path),
    ).toEqual(["assets/logo.png"]);
    expect(counters.left).toBeGreaterThan(0);

    out = await renderInto(renderFilesTemplate(ctx), host);
    pointer(rowFor(out, "assets"), "click");
    await flush();
    expect(requireProjectState().expanded.has("assets")).toBe(false);
  });

  test("refresh button reloads root and expanded directories", async () => {
    const { state } = installFsPlatform({
      "pages/index.json": "{}",
      "project.json": "{}",
    });
    siteState();
    seedTreeState();
    requireProjectState().dirs.set("stale", []);
    const { counters, ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    pointer(out.querySelector('sp-action-button[label="Refresh"]')!, "click");
    await flush();

    const st = requireProjectState();
    expect(st.dirs.has("stale")).toBe(false);
    expect(st.dirs.has(".")).toBe(true);
    expect(st.dirs.has("pages")).toBe(true);
    expect(state.calls).toContainEqual(["listDirectory", "pages"]);
    expect(counters.left).toBe(1);
  });
});

// ─── New file ─────────────────────────────────────────────────────────────────

describe("createNewFile (toolbar + context menu)", () => {
  /** Open the New File dialog from the toolbar and answer it (null cancels). */
  async function clickNewFile(out: HTMLElement, answer: string | null, pick?: string) {
    pointer(out.querySelector('sp-action-button[label="New File"]')!, "click");
    await flush();
    await answerPromptDialog(answer, pick);
  }

  test("opens a Spectrum prompt dialog rather than a native prompt", async () => {
    installFsPlatform();
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    pointer(out.querySelector('sp-action-button[label="New File"]')!, "click");
    await flush();

    const wrapper = dialogWrapper();
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute("headline")).toBe("New File");
    expect(wrapper!.getAttribute("confirm-label")).toBe("Create");
    // A NAME, not a file name: the picker beside it owns the extension.
    expect(wrapper!.querySelector("sp-textfield")!.getAttribute("value")).toBe("untitled");
    expect(promptFormatOptions()).toEqual([
      [".json", "JSON (.json)"],
      [".md", "Markdown (.md)"],
      ["__other__", "Other…"],
    ]);

    await answerPromptDialog(null);
  });

  test("cancelled dialog writes nothing", async () => {
    const { state } = installFsPlatform();
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    await clickNewFile(out, null);

    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
    expect(dialogWrapper()).toBeNull();
  });

  test("a blank name keeps the dialog open and writes nothing", async () => {
    const { state } = installFsPlatform();
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    await clickNewFile(out, "   ");

    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
    expect(dialogWrapper()).not.toBeNull();
    expect(dialogWrapper()!.querySelector("sp-help-text")?.textContent).toContain(
      "Enter a file name.",
    );

    await answerPromptDialog(null);
  });

  test("unknown extension gets the default JSON scaffold", async () => {
    setFormats([]);
    const { state } = installFsPlatform();
    siteState();
    seedTreeState();
    const { counters, ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    await clickNewFile(out, "untitled", ".json");

    expect(JSON.parse(state.files.get("untitled.json")!)).toEqual({
      children: [{ children: [], tagName: "p" }],
      tagName: "div",
    });
    expect(counters.left).toBe(1);
  });

  test("format extension uses the format's newFileTemplate", async () => {
    const { state } = installFsPlatform();
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    await clickNewFile(out, "note", ".md");

    expect(state.files.get("note.md")).toBe("---\ntitle: Untitled\n---\n\n");
  });

  test("the entered name is trimmed before it becomes a path", async () => {
    const { state } = installFsPlatform();
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    await clickNewFile(out, "  spaced  ", ".md");

    expect(state.files.has("spaced.md")).toBe(true);
  });

  test("format without a template creates an empty file", async () => {
    setFormats([{ ...MARKDOWN_FORMAT, studio: null }]);
    const { state } = installFsPlatform();
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    await clickNewFile(out, "bare", ".md");

    expect(state.files.get("bare.md")).toBe("");
  });

  test("write failure is reported, not thrown", async () => {
    const { state } = installFsPlatform(
      {},
      {
        writeFile: async () => {
          throw new Error("quota exceeded");
        },
      },
    );
    siteState();
    seedTreeState();
    const { counters, ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    await clickNewFile(out, "fail", ".json");

    expect(state.files.has("fail.json")).toBe(false);
    expect(counters.left).toBe(0);
  });

  test("context-menu New File scopes the path to the directory", async () => {
    const { state } = installFsPlatform();
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    pointer(rowFor(out, "pages"), "contextmenu");
    await flush();
    await clickMenuItem("New File…");
    await flush();

    expect(dialogWrapper()?.textContent).toContain("Creating in pages/");
    await answerPromptDialog("inner", ".md");

    expect(state.files.get("pages/inner.md")).toBe("---\ntitle: Untitled\n---\n\n");
  });
});

// ─── Context menu ─────────────────────────────────────────────────────────────

describe("file context menu", () => {
  async function renderSeededTree(seed: Record<string, string> = {}) {
    const handle = installFsPlatform(seed);
    siteState();
    seedTreeState();
    const tree = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(tree.ctx), host);
    return { ...tree, handle, out };
  }

  test("file rows offer Open / Rename / Delete; Open invokes the callback", async () => {
    const { opened, out } = await renderSeededTree();

    pointer(rowFor(out, "beta.md"), "contextmenu");
    await flush();

    expect(popoverMenuItems().map((el) => el.textContent?.trim())).toEqual([
      "Open",
      "Rename…",
      "Delete",
    ]);
    expect(document.querySelector("#layer-popover sp-menu-divider")).not.toBeNull();

    await clickMenuItem("Open");
    expect(opened).toEqual(["beta.md"]);
    expect(document.querySelector("#layer-popover sp-popover")).toBeNull();
  });

  test("directory rows offer New File and Upload Files instead of Open", async () => {
    const { out } = await renderSeededTree();

    pointer(rowFor(out, "assets"), "contextmenu");
    await flush();

    expect(popoverMenuItems().map((el) => el.textContent?.trim())).toEqual([
      "New File…",
      "Upload Files…",
      "Rename…",
      "Delete",
    ]);
  });

  /**
   * The tree with a project that declares a `posts` collection, and the app registry published.
   *
   * The registry is the point of these cases. `context/file` is a DECLARED placement, and until now
   * the tree drew a hand-built list beside it — so `content.openEntry` shipped with a menu entry no
   * surface rendered, and "Edit Collection in Grid" existed twice: once as `collection.editInGrid`
   * and once as a literal string here. Every row below comes out of `forPlacement`.
   */
  async function renderTreeWithRegistry() {
    const handle = installFsPlatform({
      "posts/first.md": "---\ntitle: First\n---\n",
      "styles/site.css": "body{}",
    });
    siteState({
      projectConfig: {
        content: {
          posts: {
            format: "Markdown",
            schema: { properties: { title: { type: "string" } } },
            source: "./posts/",
          },
        },
        name: "Demo",
      },
    });
    seedTreeState();
    requireProjectState()
      .dirs.get(".")!
      .push(
        { name: "posts", path: "posts", type: "directory" },
        { name: "styles", path: "styles", type: "directory" },
      );
    requireProjectState().dirs.set("posts", [
      { name: "first.md", path: "posts/first.md", type: "file" },
    ]);
    requireProjectState().dirs.set("styles", [
      { name: "site.css", path: "styles/site.css", type: "file" },
    ]);
    requireProjectState().expanded.add("posts");
    requireProjectState().expanded.add("styles");

    const registry = createCommandRegistry({
      getContext: () => ({ ...emptyContext(), project: { open: true } }) as never,
    });
    registry.registerAll(gridCommands());
    registerContentCommands(registry);
    setActiveRegistry(registry);

    const tree = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(tree.ctx), host);
    return { ...tree, handle, out, registry };
  }

  test("a collection directory offers the DECLARED collection.editInGrid row", async () => {
    const { out } = await renderTreeWithRegistry();

    pointer(rowFor(out, "posts"), "contextmenu");
    await flush();
    expect(popoverMenuItems().map((el) => el.textContent?.trim())).toContain(
      "Edit Collection in Grid",
    );
    await clickMenuItem("Edit Collection in Grid");
    expect(workspace.tabs.has("grid://collection/posts")).toBeTrue();
  });

  test("a content entry offers Open Entry Form; a file in no collection does not", async () => {
    const { out } = await renderTreeWithRegistry();

    pointer(rowFor(out, "posts/first.md"), "contextmenu");
    await flush();
    expect(popoverMenuItems().map((el) => el.textContent?.trim())).toContain("Open Entry Form");

    // `styles/site.css` states no `path` fact, because it is an entry of no collection — so the
    // Command that requires one is not offered rather than being offered and refusing.
    pointer(rowFor(out, "styles/site.css"), "contextmenu");
    await flush();
    expect(popoverMenuItems().map((el) => el.textContent?.trim())).not.toContain("Open Entry Form");
  });

  test("Open Entry Form opens the tab in entry mode — the route the palette could not offer", async () => {
    const { out } = await renderTreeWithRegistry();

    pointer(rowFor(out, "posts/first.md"), "contextmenu");
    await flush();
    await clickMenuItem("Open Entry Form");
    await flush();
    await flush();

    const tab = [...workspace.tabs.values()].find((t) => t.documentPath === "posts/first.md")!;
    expect(tab).toBeDefined();
    expect(tab.session.ui.canvasMode).toBe("entry");
  });

  test("the declared rows come from the registry — with none published, they are absent", async () => {
    const { out } = await renderTreeWithRegistry();
    setActiveRegistry(null);

    pointer(rowFor(out, "posts"), "contextmenu");
    await flush();
    const labels = popoverMenuItems().map((el) => el.textContent?.trim());
    expect(labels).not.toContain("Edit Collection in Grid");
    // The tree's own verbs are unaffected: they are what the TREE does, not what a command does.
    expect(labels).toEqual(["New File…", "Upload Files…", "Rename…", "Delete"]);
  });

  test("the pages directory keeps its hand-built grid row — no command declares one", async () => {
    const { out } = await renderTreeWithRegistry();

    pointer(rowFor(out, "pages"), "contextmenu");
    await flush();
    expect(popoverMenuItems().map((el) => el.textContent?.trim())).toContain("Edit Pages in Grid");
    await clickMenuItem("Edit Pages in Grid");
    expect(workspace.tabs.has("grid://pages")).toBeTrue();
  });

  test("a declared row whose command is disabled is shown, greyed, with its reason", async () => {
    const { out } = await renderTreeWithRegistry();
    const registry = createCommandRegistry({
      getContext: () => ({ ...emptyContext(), project: { open: true } }) as never,
    });
    registry.register({
      args: {
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"],
        type: "object",
      },
      category: "File",
      enablement: () => false,
      id: "content.demoDisabled",
      level: "project",
      menus: ["context/file"],
      requires: "a reason the author can act on",
      run: () => {},
      title: "Demo Disabled",
      when: () => true,
    });
    setActiveRegistry(registry);

    pointer(rowFor(out, "posts/first.md"), "contextmenu");
    await flush();
    const item = popoverMenuItems().find((el) => el.textContent?.includes("Demo Disabled"))!;
    expect(item).toBeDefined();
    expect(item.hasAttribute("disabled")).toBeTrue();
    expect(item.textContent).toContain("Needs a reason the author can act on");

    // Clicking it does nothing AND does not close the menu — a row that explains itself has to
    // Stay on screen long enough to be read.
    pointer(item, "click");
    await flush();
    expect(document.querySelector("#layer-popover sp-popover")).not.toBeNull();
  });

  test("opening a second menu dismisses the first", async () => {
    const { out } = await renderSeededTree();

    pointer(rowFor(out, "beta.md"), "contextmenu");
    await flush();
    pointer(rowFor(out, "zeta.json"), "contextmenu");
    await flush();

    expect(document.querySelectorAll("#layer-popover sp-popover")).toHaveLength(1);
  });

  test("menu is clamped to the viewport when opened near the edge", async () => {
    const { out } = await renderSeededTree();

    pointer(rowFor(out, "beta.md"), "contextmenu", { clientX: 2000, clientY: 2000 });
    await flush();

    const popover = document.querySelector("#layer-popover sp-popover") as HTMLElement;
    expect(popover.style.left).toBe(`${window.innerWidth - 4}px`);
    expect(popover.style.top).toBe(`${window.innerHeight - 4}px`);
  });
});

// ─── Rename dialog ────────────────────────────────────────────────────────────

describe("rename flow", () => {
  async function openRenameDialog(out: HTMLElement, path: string) {
    pointer(rowFor(out, path), "contextmenu");
    await flush();
    await clickMenuItem("Rename…");
    await flush();
    const wrapper = dialogWrapper();
    expect(wrapper).not.toBeNull();
    const field = wrapper!.querySelector("sp-textfield") as HTMLInputElement;
    return { field, wrapper: wrapper! };
  }

  async function renderSeededTree(seed: Record<string, string>) {
    const handle = installFsPlatform(seed);
    siteState();
    seedTreeState();
    const tree = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(tree.ctx), host);
    return { ...tree, handle, out };
  }

  test("renames a nested file, updating selection and the open tab", async () => {
    const { handle, out, counters } = await renderSeededTree({
      "pages/index.json": "{}",
    });
    requireProjectState().selectedPath = "pages/index.json";
    openTab({
      document: { tagName: "div" },
      documentPath: "pages/index.json",
      id: "pages/index.json",
    });

    const { field, wrapper } = await openRenameDialog(out, "pages/index.json");
    field.value = "home.json";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    wrapper.dispatchEvent(new Event("confirm"));
    await flush();

    expect(handle.state.files.has("pages/home.json")).toBe(true);
    expect(handle.state.files.has("pages/index.json")).toBe(false);
    expect(requireProjectState().selectedPath).toBe("pages/home.json");
    expect(workspace.tabs.has("pages/home.json")).toBe(true);
    expect(workspace.tabs.get("pages/home.json")?.documentPath).toBe("pages/home.json");
    expect(counters.left).toBe(1);
  });

  test("renames a root-level file via the Enter key", async () => {
    const { handle, out } = await renderSeededTree({ "beta.md": "# b" });

    const { field } = await openRenameDialog(out, "beta.md");
    field.value = "renamed.md";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    key(field, "Enter");
    await flush();

    expect(handle.state.files.has("renamed.md")).toBe(true);
    expect(handle.state.files.has("beta.md")).toBe(false);
  });

  test("cancel leaves everything untouched", async () => {
    const { handle, out } = await renderSeededTree({ "beta.md": "# b" });

    const { wrapper } = await openRenameDialog(out, "beta.md");
    wrapper.dispatchEvent(new Event("cancel"));
    await flush();

    expect(handle.state.calls.filter(([name]) => name === "renameFile")).toHaveLength(0);
    expect(handle.state.files.has("beta.md")).toBe(true);
  });

  test("unchanged name is a no-op", async () => {
    const { handle, out } = await renderSeededTree({ "beta.md": "# b" });

    const { wrapper } = await openRenameDialog(out, "beta.md");
    wrapper.dispatchEvent(new Event("confirm"));
    await flush();

    expect(handle.state.calls.filter(([name]) => name === "renameFile")).toHaveLength(0);
  });

  test("blank name keeps the dialog open until cancelled", async () => {
    const { handle, out } = await renderSeededTree({ "beta.md": "# b" });

    const { field, wrapper } = await openRenameDialog(out, "beta.md");
    field.value = "   ";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    wrapper.dispatchEvent(new Event("confirm"));
    await flush();

    expect(dialogWrapper()).not.toBeNull();
    wrapper.dispatchEvent(new Event("close"));
    await flush();

    expect(dialogWrapper()).toBeNull();
    expect(handle.state.calls.filter(([name]) => name === "renameFile")).toHaveLength(0);
  });

  test("platform rename failure surfaces gracefully", async () => {
    const handle = installFsPlatform(
      { "beta.md": "# b" },
      {
        renameFile: async () => {
          throw new Error("locked");
        },
      },
    );
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(ctx), host);

    const { field, wrapper } = await openRenameDialog(out, "beta.md");
    field.value = "other.md";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    wrapper.dispatchEvent(new Event("confirm"));
    await flush();

    expect(handle.state.files.has("beta.md")).toBe(true);
  });
});

// ─── Delete dialog ────────────────────────────────────────────────────────────

describe("delete flow", () => {
  async function renderSeededTree(seed: Record<string, string>, overrides = {}) {
    const handle = installFsPlatform(seed, overrides);
    siteState();
    seedTreeState();
    const tree = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(tree.ctx), host);
    return { ...tree, handle, out };
  }

  async function openDeleteDialog(out: HTMLElement, path: string) {
    pointer(rowFor(out, path), "contextmenu");
    await flush();
    await clickMenuItem("Delete");
    await flush();
    const wrapper = dialogWrapper();
    expect(wrapper).not.toBeNull();
    return wrapper!;
  }

  test("confirm deletes the file and clears matching selection", async () => {
    const { handle, out, counters } = await renderSeededTree({ "beta.md": "# b" });
    requireProjectState().selectedPath = "beta.md";

    const wrapper = await openDeleteDialog(out, "beta.md");
    // The name is now emphasised markup rather than a quoted string, and the dialog carries the
    // Consequence line beneath it — see tests/destructive-confirmations.test.ts for the sentence.
    expect(wrapper.textContent).toContain("Delete beta.md?");
    wrapper.dispatchEvent(new Event("confirm"));
    await flush();

    expect(handle.state.files.has("beta.md")).toBe(false);
    expect(requireProjectState().selectedPath).toBeNull();
    expect(counters.left).toBe(1);
  });

  test("cancel deletes nothing", async () => {
    const { handle, out } = await renderSeededTree({ "beta.md": "# b" });

    const wrapper = await openDeleteDialog(out, "beta.md");
    wrapper.dispatchEvent(new Event("cancel"));
    await flush();

    expect(handle.state.files.has("beta.md")).toBe(true);
    expect(handle.state.calls.filter(([name]) => name === "deleteFile")).toHaveLength(0);
  });

  test("nested file delete reloads the parent directory and keeps other selection", async () => {
    const { handle, out } = await renderSeededTree({ "pages/index.json": "{}" });
    requireProjectState().selectedPath = "other.json";

    const wrapper = await openDeleteDialog(out, "pages/index.json");
    wrapper.dispatchEvent(new Event("confirm"));
    await flush();

    expect(handle.state.files.has("pages/index.json")).toBe(false);
    expect(requireProjectState().selectedPath).toBe("other.json");
    expect(handle.state.calls).toContainEqual(["listDirectory", "pages"]);
  });

  test("platform delete failure surfaces gracefully", async () => {
    const { out } = await renderSeededTree(
      { "beta.md": "# b" },
      {
        deleteFile: async () => {
          throw new Error("in use");
        },
      },
    );

    const wrapper = await openDeleteDialog(out, "beta.md");
    wrapper.dispatchEvent(new Event("confirm"));
    await flush();
    // No crash; dialog resolved
    expect(dialogWrapper()).toBeNull();
  });
});

// ─── Keyboard navigation ──────────────────────────────────────────────────────

describe("the tree's keyboard", () => {
  /**
   * The keyboard is driven against the REAL rendered tree, not a hand-built one.
   *
   * It used to be three divs assembled by this file, which was equivalent while every row was drawn
   * and stopped being equivalent when the tree windowed: ↑/↓ now step through the row MODEL
   * `renderFilesTemplate` builds, so a fixture that never went through the renderer has no rows to
   * step through. Rendering the template is also the only way the tab stop, the aria attributes and
   * the walk are asserted about the same thing.
   */
  async function renderTree(seed: Record<string, string> = {}) {
    const handle = installFsPlatform(seed);
    siteState();
    const st = requireProjectState();
    st.dirs.set(".", [
      { name: "pages", path: "pages", type: "directory" },
      { name: "a.json", path: "a.json", type: "file" },
      { name: "b.json", path: "b.json", type: "file" },
    ]);
    st.dirs.set("pages", [{ name: "index.json", path: "pages/index.json", type: "file" }]);
    const tree = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(tree.ctx), host);
    const el = out.querySelector(".file-tree") as HTMLElement;
    const items = [...el.querySelectorAll(".file-tree-item")] as HTMLElement[];
    return { ...tree, handle, items, tree: el };
  }

  test("the first row is the tab stop, and the selected row takes it over", async () => {
    const { items } = await renderTree();
    expect(items[0]!.getAttribute("tabindex")).toBe("0");
    expect(items[1]!.getAttribute("tabindex")).toBe("-1");

    requireProjectState().selectedPath = "b.json";
    const out = await renderInto(renderFilesTemplate(makeTreeCtx().ctx), host);
    expect(rowFor(out, "b.json").getAttribute("tabindex")).toBe("0");
    expect(rowFor(out, "pages").getAttribute("tabindex")).toBe("-1");
  });

  test("ArrowDown / ArrowUp move focus and clamp at the edges", async () => {
    const { items, tree } = await renderTree();
    items[0]!.focus();

    key(tree, "ArrowDown");
    expect(document.activeElement).toBe(items[1]!);
    key(tree, "ArrowDown");
    key(tree, "ArrowDown"); // Already at the last item
    expect(document.activeElement).toBe(items[2]!);

    key(tree, "ArrowUp");
    key(tree, "ArrowUp");
    key(tree, "ArrowUp"); // Already at the first item
    expect(document.activeElement).toBe(items[0]!);
  });

  test("Enter clicks the focused row; unhandled keys are not prevented", async () => {
    const { items, tree } = await renderTree();
    let clicks = 0;
    items[1]!.addEventListener("click", () => {
      clicks += 1;
    });
    items[1]!.focus();

    key(tree, "Enter");
    expect(clicks).toBe(1);

    const passthrough = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "x",
    });
    const notPrevented = items[1]!.dispatchEvent(passthrough);
    expect(notPrevented).toBe(true);

    const handled = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowUp",
    });
    items[1]!.dispatchEvent(handled);
    expect(handled.defaultPrevented).toBe(true);
  });

  test("keystrokes without a focused item are ignored", async () => {
    const { items, tree } = await renderTree();
    (document.activeElement as HTMLElement | null)?.blur?.();

    key(tree, "ArrowDown");
    expect(document.activeElement).not.toBe(items[1]);
  });

  /* One handler, however many times the panel repaints — and now by construction rather than by a
     WeakSet of trees that already had one. The keydown is `@keydown` on the element the template
     renders, so lit swaps the binding on each pass instead of a call site stacking another
     listener. Three registrations used to walk three rows for one keystroke, which is what
     `afterRender` calling a bare addEventListener on every repaint built up to. */
  test("one listener per tree, however many times the panel re-renders", async () => {
    const { handle, items, tree } = await renderTree();
    for (let i = 0; i < 3; i++) {
      await renderInto(renderFilesTemplate(makeTreeCtx().ctx), host);
    }
    void handle;
    const rows = [
      ...(host.querySelector(".file-tree") as HTMLElement).querySelectorAll(".file-tree-item"),
    ] as HTMLElement[];
    rows[0]!.focus();
    key(host.querySelector(".file-tree") as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(rows[1]!);
    void items;
    void tree;
  });

  test("ArrowRight expands a collapsed directory and repaints the panel", async () => {
    const { counters, handle, items, tree } = await renderTree({ "pages/index.json": "{}" });
    requireProjectState().dirs.delete("pages");
    const before = counters.left;
    items[0]!.focus();

    key(tree, "ArrowRight");
    await flush();

    expect(requireProjectState().expanded.has("pages")).toBe(true);
    expect(handle.state.calls).toContainEqual(["listDirectory", "pages"]);
    // The repaint used to be a synthesised click on the focused row, which ran that row's own
    // Toggle a second time; the panel is asked directly now.
    expect(counters.left).toBeGreaterThan(before);
  });

  test("ArrowRight on an expanded directory does not reload", async () => {
    const { handle, items, tree } = await renderTree({ "pages/index.json": "{}" });
    requireProjectState().expanded.add("pages");
    handle.state.calls.length = 0;
    items[0]!.focus();

    key(tree, "ArrowRight");
    await flush();

    expect(handle.state.calls.filter(([name]) => name === "listDirectory")).toHaveLength(0);
  });

  test("ArrowLeft collapses an expanded directory, repaints, and ignores files", async () => {
    const { counters, items, tree } = await renderTree();
    requireProjectState().expanded.add("pages");
    const before = counters.left;
    items[0]!.focus();

    key(tree, "ArrowLeft");
    expect(requireProjectState().expanded.has("pages")).toBe(false);
    // It used to change the state and leave the children on screen — the collapse was invisible
    // Until something else happened to redraw the panel.
    expect(counters.left).toBeGreaterThan(before);

    items[1]!.focus();
    key(tree, "ArrowLeft"); // File row — nothing to collapse
    expect(requireProjectState().expanded.has("pages")).toBe(false);
  });
});

// ─── Drag and drop ────────────────────────────────────────────────────────────

describe("registerFileTreeDnD", () => {
  async function renderAndRegister(seed: Record<string, string> = {}) {
    const handle = installFsPlatform(seed);
    siteState();
    seedTreeState();
    const tree = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(tree.ctx), host);
    registerFileTreeDnD({ renderLeftPanel: tree.ctx.renderLeftPanel });
    await flush();
    return { ...tree, handle, out };
  }

  function dirTarget(targetDir: string) {
    const target = dnd.dropTargets.find((t) => t.getData?.().targetDir === targetDir);
    expect(target).toBeDefined();
    return target;
  }

  test("registers draggables for every row, drop targets for directories + root, one monitor", async () => {
    const handle = installFsPlatform();
    siteState();
    seedTreeState();
    const tree = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(tree.ctx), host);

    // A row without data-path (defensive) must be skipped, not registered
    const pathless = document.createElement("div");
    pathless.className = "file-tree-item";
    out.querySelector(".file-tree")!.append(pathless);

    registerFileTreeDnD({ renderLeftPanel: tree.ctx.renderLeftPanel });
    await flush();

    // 10 visible rows (2 dirs, 7 root files, 1 nested file); the pathless row is skipped
    expect(dnd.draggables).toHaveLength(10);
    expect(dnd.dropTargets).toHaveLength(3); // Pages, assets, root tree
    expect(dnd.monitors).toHaveLength(1);
    expect(handle.state.calls.filter(([name]) => name === "renameFile")).toHaveLength(0);
  });

  test("does nothing when no file tree is in the document", async () => {
    installFsPlatform();
    host.remove();
    registerFileTreeDnD({ renderLeftPanel: () => {} });
    await flush();

    expect(dnd.draggables).toHaveLength(0);
    expect(dnd.monitors).toHaveLength(0);
  });

  test("re-registering cleans up previous registrations", async () => {
    const { ctx } = await renderAndRegister();

    registerFileTreeDnD({ renderLeftPanel: ctx.renderLeftPanel });
    await flush();

    expect(dnd.cleanups).toContain("draggable");
    expect(dnd.cleanups).toContain("dropTarget");
    expect(dnd.cleanups).toContain("monitor");
  });

  test("draggable rows expose file-tree data and toggle the dragging class", async () => {
    await renderAndRegister();

    const drag = dnd.draggables.find((d) => d.element?.dataset?.path === "beta.md");
    expect(drag.getInitialData()).toEqual({
      entryType: "file",
      path: "beta.md",
      type: "file-tree",
    });

    drag.onDragStart();
    expect(drag.element.classList.contains("dragging")).toBe(true);
    drag.onDrop();
    expect(drag.element.classList.contains("dragging")).toBe(false);
  });

  test("directory drop target accept/reject logic", async () => {
    await renderAndRegister();
    const target = dirTarget("assets");

    expect(target.canDrop({ source: { data: { path: "x", type: "canvas" } } })).toBe(false);
    expect(target.canDrop({ source: { data: { path: "assets", type: "file-tree" } } })).toBe(false);
    expect(
      target.canDrop({ source: { data: { path: "assets/logo.png", type: "file-tree" } } }),
    ).toBe(false);
    expect(
      target.canDrop({
        source: { data: { path: String.raw`assets\logo.png`, type: "file-tree" } },
      }),
    ).toBe(false);
    expect(target.canDrop({ source: { data: { path: "beta.md", type: "file-tree" } } })).toBe(true);
    expect(
      target.canDrop({ source: { data: { path: "pages/index.json", type: "file-tree" } } }),
    ).toBe(true);
  });

  test("directory drop target toggles the drag-over class", async () => {
    await renderAndRegister();
    const target = dirTarget("assets");

    target.onDragEnter();
    expect(target.element.classList.contains("drag-over")).toBe(true);
    target.onDragLeave();
    expect(target.element.classList.contains("drag-over")).toBe(false);
    target.onDrag();
    target.onDrag(); // Idempotent
    expect(target.element.classList.contains("drag-over")).toBe(true);
    target.onDrop();
    expect(target.element.classList.contains("drag-over")).toBe(false);
  });

  test("root drop target accepts only entries not already at the root", async () => {
    await renderAndRegister();
    const root = dirTarget(".");

    expect(root.canDrop({ source: { data: { path: "beta.md", type: "file-tree" } } })).toBe(false);
    expect(
      root.canDrop({ source: { data: { path: "pages/index.json", type: "file-tree" } } }),
    ).toBe(true);
    expect(root.canDrop({ source: { data: { path: "x", type: "canvas" } } })).toBe(false);

    root.onDragEnter();
    expect(root.element.classList.contains("drag-over-root")).toBe(true);
    root.onDragLeave();
    expect(root.element.classList.contains("drag-over-root")).toBe(false);
    root.onDrop();
  });

  test("monitor ignores drops without a target or with foreign data", async () => {
    const { handle } = await renderAndRegister();
    const [monitor] = dnd.monitors;

    monitor.onDrop({
      location: { current: { dropTargets: [] } },
      source: { data: { path: "beta.md", type: "file-tree" } },
    });
    monitor.onDrop({
      location: {
        current: { dropTargets: [{ data: { targetDir: ".", type: "file-tree-target" } }] },
      },
      source: { data: { path: "x", type: "canvas" } },
    });
    monitor.onDrop({
      location: { current: { dropTargets: [{ data: { type: "canvas-target" } }] } },
      source: { data: { path: "beta.md", type: "file-tree" } },
    });
    // Same resulting path — no move
    monitor.onDrop({
      location: {
        current: { dropTargets: [{ data: { targetDir: ".", type: "file-tree-target" } }] },
      },
      source: { data: { path: "beta.md", type: "file-tree" } },
    });
    await flush();

    expect(handle.state.calls.filter(([name]) => name === "renameFile")).toHaveLength(0);
  });

  test("dropping a file on the root moves it and renames its open tab", async () => {
    const { handle, counters } = await renderAndRegister({ "pages/index.json": "{}" });
    openTab({
      document: { tagName: "div" },
      documentPath: "pages/index.json",
      id: "pages/index.json",
    });
    const [monitor] = dnd.monitors;

    monitor.onDrop({
      location: {
        current: { dropTargets: [{ data: { targetDir: ".", type: "file-tree-target" } }] },
      },
      source: { data: { path: "pages/index.json", type: "file-tree" } },
    });
    await flush();

    expect(handle.state.calls).toContainEqual(["renameFile", "pages/index.json", "index.json"]);
    expect(handle.state.files.has("index.json")).toBe(true);
    expect(workspace.tabs.has("index.json")).toBe(true);
    expect(workspace.tabs.get("index.json")?.documentPath).toBe("index.json");
    expect(requireProjectState().expanded.has(".")).toBe(false);
    expect(counters.left).toBe(1);
  });

  test("dropping a directory into another moves nested tabs and expands the target", async () => {
    const { handle } = await renderAndRegister({
      "assets/logo.png": "x",
      "pages/index.json": "{}",
    });
    openTab({
      document: { tagName: "div" },
      documentPath: "pages/index.json",
      id: "pages/index.json",
    });
    const [monitor] = dnd.monitors;

    monitor.onDrop({
      location: {
        current: { dropTargets: [{ data: { targetDir: "assets", type: "file-tree-target" } }] },
      },
      source: { data: { entryType: "directory", path: "pages", type: "file-tree" } },
    });
    await flush();

    expect(handle.state.calls).toContainEqual(["renameFile", "pages", "assets/pages"]);
    expect(workspace.tabs.has("assets/pages/index.json")).toBe(true);
    expect(requireProjectState().expanded.has("assets")).toBe(true);
  });

  test("rename failure during a drop is reported, not thrown", async () => {
    const handle = installFsPlatform(
      { "pages/index.json": "{}" },
      {
        renameFile: async () => {
          throw new Error("EBUSY");
        },
      },
    );
    siteState();
    seedTreeState();
    const { ctx } = makeTreeCtx();
    await renderInto(renderFilesTemplate(ctx), host);
    registerFileTreeDnD({ renderLeftPanel: ctx.renderLeftPanel });
    await flush();
    const [monitor] = dnd.monitors;

    monitor.onDrop({
      location: {
        current: { dropTargets: [{ data: { targetDir: ".", type: "file-tree-target" } }] },
      },
      source: { data: { path: "pages/index.json", type: "file-tree" } },
    });
    await flush();

    expect(handle.state.files.has("pages/index.json")).toBe(true);
  });
});

// ─── External (OS) file drops ─────────────────────────────────────────────────

describe("file tree external file drops", () => {
  async function renderAndRegister(seed: Record<string, string> = {}) {
    const handle = installFsPlatform(seed);
    siteState();
    seedTreeState();
    const tree = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(tree.ctx), host);
    registerFileTreeDnD({ renderLeftPanel: tree.ctx.renderLeftPanel });
    await flush();
    return { ...tree, handle, out };
  }

  const uploadPaths = (handle: { state: MockPlatformState }) =>
    handle.state.calls.filter((c) => c[0] === "uploadFile").map((c) => c[1]);

  test("a directory row accepts files and uploads into itself", async () => {
    const { handle, out } = await renderAndRegister();

    const over = dragEvent(rowFor(out, "assets"), "dragover", [testFile("hero.png")]);
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("copy");
    expect(rowFor(out, "assets").classList.contains("drag-over")).toBe(true);

    dragEvent(rowFor(out, "assets"), "drop", [testFile("hero.png")]);
    await flush();

    expect(uploadPaths(handle)).toEqual(["assets/hero.png"]);
    expect(rowFor(out, "assets").classList.contains("drag-over")).toBe(false);
    // The target expands so the new file is visible without a manual disclosure click.
    expect(requireProjectState().expanded.has("assets")).toBe(true);
  });

  test("a file row uploads beside itself, into its parent directory", async () => {
    const handle = installFsPlatform({ "assets/note.txt": "x" });
    siteState();
    seedTreeState();
    const st = requireProjectState();
    st.dirs.set("assets", [{ name: "note.txt", path: "assets/note.txt", type: "file" }]);
    st.expanded.add("assets");
    const out = await renderInto(renderFilesTemplate(makeTreeCtx().ctx), host);
    registerFileTreeDnD({ renderLeftPanel: () => {} });
    await flush();

    dragEvent(rowFor(out, "assets/note.txt"), "drop", [testFile("hero.png")]);
    await flush();

    expect(uploadPaths(handle)).toEqual(["assets/hero.png"]);
  });

  test("the tree background uploads to the project root", async () => {
    const { handle, out } = await renderAndRegister();
    const tree = out.querySelector(".file-tree") as HTMLElement;

    dragEvent(tree, "drop", [testFile("hero.png")]);
    await flush();

    // "." contributes no prefix — the file lands at the root, not under "./".
    expect(uploadPaths(handle)).toEqual(["hero.png"]);
  });

  test("an in-app pragmatic drag is ignored (no Files type, no preventDefault)", async () => {
    const { handle, out } = await renderAndRegister();

    const over = dragEvent(rowFor(out, "assets"), "dragover", []);
    expect(over.event.defaultPrevented).toBe(false);
    expect(rowFor(out, "assets").classList.contains("drag-over")).toBe(false);

    dragEvent(rowFor(out, "assets"), "drop", []);
    await flush();
    expect(uploadPaths(handle)).toEqual([]);
  });

  test("dragleave clears the highlight without uploading", async () => {
    const { handle, out } = await renderAndRegister();
    const row = rowFor(out, "assets");

    dragEvent(row, "dragover", [testFile("hero.png")]);
    dragEvent(row, "dragleave", [testFile("hero.png")]);

    expect(row.classList.contains("drag-over")).toBe(false);
    expect(uploadPaths(handle)).toEqual([]);
  });

  test("a row drop does not also fire the tree-background handler", async () => {
    const { handle, out } = await renderAndRegister();

    dragEvent(rowFor(out, "assets"), "drop", [testFile("hero.png")]);
    await flush();

    // One upload, into the row's directory — not a second one at the root.
    expect(uploadPaths(handle)).toEqual(["assets/hero.png"]);
  });
});

// ─── .gitignore-aware rows ────────────────────────────────────────────────────

/**
 * The Files sidebar hides what `.gitignore` masks.
 *
 * These cases go through `loadDirectory` rather than `seedTreeState`, and that is the whole
 * difference between them and every case above: seeding `projectState.dirs` by hand loads no ignore
 * layers, so nothing is hidden and the older fixtures keep meaning what they always meant. A real
 * listing fetches the rules alongside the entries, which is what makes a row disappear.
 *
 * The mock backend lists dotfiles that the dev server and the desktop session both drop, so the
 * `.gitignore` itself draws a row here. Left as it is on purpose: a fixture that quietly filtered
 * more than the code under test would make the row counts below unreadable.
 */
describe("the file tree and .gitignore", () => {
  beforeEach(() => {
    /* Both are module state that outlives a test: the compiled layers, and the roaming setting
       behind the toolbar toggle. A tree that hides rows for a reason the case never stated is the
       hardest kind of failure to read. */
    resetIgnoreCache();
    setShowIgnoredFiles(false);
  });

  /** Seed a backend, load the root (plus any directories to expand), and render the tree. */
  async function renderIgnoreTree(
    seed: Record<string, string>,
    opts: { expand?: string[]; searchQuery?: string } = {},
  ) {
    const handle = installFsPlatform(seed);
    siteState({ searchQuery: opts.searchQuery ?? "" });
    await loadDirectory(".");
    for (const dir of opts.expand ?? []) {
      requireProjectState().expanded.add(dir);
      await loadDirectory(dir);
    }
    const tree = makeTreeCtx();
    const out = await renderInto(renderFilesTemplate(tree.ctx), host);
    return { ...tree, handle, out };
  }

  /** The standard noisy project: a tool-written directory and a tool-written file. */
  const NOISY_ROOT = {
    ".gitignore": "node_modules/\n*.log\n",
    "beta.md": "# b",
    "build.log": "compiled at…",
    "node_modules/left-pad/index.js": "module.exports = () => {};",
    "pages/index.json": "{}",
  };

  test("an ignored directory and an ignored file draw no row; the rest still do", async () => {
    const { out } = await renderIgnoreTree(NOISY_ROOT);

    expect(rowFor(out, "node_modules", false)).toBeNull();
    expect(rowFor(out, "build.log", false)).toBeNull();
    expect(rowFor(out, "beta.md")).not.toBeNull();
    expect(rowFor(out, "pages")).not.toBeNull();
  });

  test("the cache still mirrors the filesystem — hiding is a repaint, not a refetch", async () => {
    await renderIgnoreTree(NOISY_ROOT);

    /* Filtering happens where rows are BUILT, so everything else that reads `dirs` — the fs-event
       reducer, the reference index, a later toggle — goes on seeing the real directory. Drop the
       entries at the listing instead and showing them again costs a round trip. */
    const paths = requireProjectState()
      .dirs.get(".")!
      .map((e) => e.path);
    expect(paths).toContain("node_modules");
    expect(paths).toContain("build.log");
  });

  test("the toolbar toggle draws the ignored rows, and takes them away again", async () => {
    const { counters, ctx, handle, out } = await renderIgnoreTree(NOISY_ROOT);
    expect(rowFor(out, "node_modules", false)).toBeNull();
    handle.state.calls.length = 0;

    pointer(out.querySelector('sp-action-button[label="Show ignored files"]')!, "click");
    await flush();
    /* The button asks the panel to repaint and nothing else — the entries were never dropped from
       the cache, so nothing has to be fetched back. */
    expect(counters.left).toBe(1);
    expect(handle.state.calls.filter(([name]) => name === "listDirectory")).toHaveLength(0);

    const shown = await renderInto(renderFilesTemplate(ctx), host);
    expect(rowFor(shown, "node_modules")).not.toBeNull();
    expect(rowFor(shown, "build.log")).not.toBeNull();
    const hide = shown.querySelector('sp-action-button[label="Hide ignored files"]');
    expect(hide).not.toBeNull();
    expect(hide!.hasAttribute("selected")).toBe(true);

    pointer(hide!, "click");
    await flush();
    const hidden = await renderInto(renderFilesTemplate(ctx), host);
    expect(rowFor(hidden, "node_modules", false)).toBeNull();
    expect(rowFor(hidden, "beta.md")).not.toBeNull();
  });

  test("the search filter runs on what is visible and cannot resurrect an ignored file", async () => {
    // "catalog.md" and "build.log" both match the query; only one of them is the author's.
    const seed = {
      ".gitignore": "*.log\n",
      "build.log": "compiled at…",
      "catalog.md": "# c",
      "other.md": "# o",
    };
    const { ctx, out } = await renderIgnoreTree(seed, { searchQuery: "log" });

    expect(rowFor(out, "catalog.md")).not.toBeNull();
    expect(rowFor(out, "build.log", false)).toBeNull();
    expect(rowFor(out, "other.md", false)).toBeNull();

    /* The ignore filter runs BEFORE the query, so the toggle is the only thing that brings the
       masked match back — a search that reached past `.gitignore` would make the toggle a lie. */
    setShowIgnoredFiles(true);
    const shown = await renderInto(renderFilesTemplate(ctx), host);
    expect(rowFor(shown, "build.log")).not.toBeNull();
  });

  test("a nested .gitignore hides only inside its own directory", async () => {
    const { out } = await renderIgnoreTree(
      {
        "root.tmp": "kept",
        "src/.gitignore": "*.tmp\n",
        "src/main.ts": "export {};",
        "src/scratch.tmp": "dropped",
      },
      { expand: ["src"] },
    );

    expect(rowFor(out, "src/scratch.tmp", false)).toBeNull();
    expect(rowFor(out, "src/main.ts")).not.toBeNull();
    /* The same name at the root is untouched: `src/.gitignore` is relative to `src/`, and a rule
       the author wrote one level down must not reach back up. */
    expect(rowFor(out, "root.tmp")).not.toBeNull();
  });

  test("aria-setsize / aria-posinset count the rows that are drawn", async () => {
    const seed = {
      ".gitignore": "node_modules/\ndist/\n",
      "alpha.md": "# a",
      "beta.md": "# b",
      "dist/bundle.js": "x",
      "node_modules/left-pad/index.js": "x",
    };
    const { ctx, out } = await renderIgnoreTree(seed);

    /* Five entries in the directory, three rows on screen. A hidden row that still inflated the
       set would have a screen reader announce "2 of 5" over a list of three — the count has to
       describe what is drawn, not what was listed. */
    expect(rowFor(out, "alpha.md").getAttribute("aria-posinset")).toBe("2");
    expect(rowFor(out, "alpha.md").getAttribute("aria-setsize")).toBe("3");
    expect(rowFor(out, "beta.md").getAttribute("aria-posinset")).toBe("3");
    expect(rowFor(out, "beta.md").getAttribute("aria-setsize")).toBe("3");

    setShowIgnoredFiles(true);
    const shown = await renderInto(renderFilesTemplate(ctx), host);
    expect(shown.querySelectorAll(".file-tree-item")).toHaveLength(5);
    expect(rowFor(shown, "beta.md").getAttribute("aria-setsize")).toBe("5");
  });

  test("Refresh re-reads the .gitignore, not just the listing", async () => {
    const { handle, out } = await renderIgnoreTree(NOISY_ROOT);
    expect(handle.state.calls).toContainEqual(["readFile", ".gitignore"]);
    handle.state.calls.length = 0;

    pointer(out.querySelector('sp-action-button[label="Refresh"]')!, "click");
    await flush();

    /* Refresh is what an author reaches for after editing a `.gitignore` by hand. The rules are
       cached per directory, so without the reset the second listing would be filtered by the first
       run's rules and the button would look broken. */
    expect(handle.state.calls).toContainEqual(["listDirectory", "."]);
    expect(handle.state.calls).toContainEqual(["readFile", ".gitignore"]);
  });
});
