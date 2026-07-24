/**
 * Coverage for src/files/files.ts — project/directory loading and tab-oriented file flows
 * (loadDirectory, loadProject, openProject, openHomePage, openFileFromTree, openFileInTab,
 * reloadFileInTab). Tree rendering, keyboard, context menu, and DnD live in files-tree.test.ts.
 */
import { flush, installMockPlatform } from "./harness";
import type { MockPlatformState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { createState, requireProjectState, setProjectState, projectState } from "../src/store";
import { activeTab, closeAllTabs, openTab, workspace } from "../src/workspace/workspace";
import { MARKDOWN_FORMAT, mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import {
  findHomePage,
  loadDirectory,
  loadProject,
  openFileFromTree,
  openFileInTab,
  openHomePage,
  openProject,
  reloadFileInTab,
} from "../src/files/files";
import type { DirEntry, StudioPlatform } from "../src/types";
import type { StudioState } from "../src/state";

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
      return dirEntries(handle.state.files, dir);
    };
  }
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

beforeEach(() => {
  closeAllTabs();
  setProjectState(null);
  localStorage.clear();
  seedMarkdownFormat();
});

// ─── loadDirectory ────────────────────────────────────────────────────────────

describe("loadDirectory", () => {
  test("does nothing when no project is loaded", async () => {
    const { state } = installFsPlatform({ "pages/index.json": "{}" });

    await loadDirectory(".");

    expect(state.calls.filter(([name]) => name === "listDirectory")).toHaveLength(0);
  });

  test("stores listed entries on projectState.dirs", async () => {
    installFsPlatform({
      "pages/about.json": "{}",
      "pages/index.json": "{}",
      "project.json": "{}",
    });
    siteState();

    await loadDirectory(".");

    const root = requireProjectState().dirs.get(".");
    expect(root?.map((e) => [e.name, e.type])).toEqual([
      ["pages", "directory"],
      ["project.json", "file"],
    ]);

    await loadDirectory("pages");
    expect(
      requireProjectState()
        .dirs.get("pages")
        ?.map((e) => e.path),
    ).toEqual(["pages/about.json", "pages/index.json"]);
  });

  test("stores an empty list when listing fails", async () => {
    installFsPlatform(
      {},
      {
        listDirectory: async () => {
          throw new Error("EACCES");
        },
      },
    );
    siteState();

    await loadDirectory("locked");

    expect(requireProjectState().dirs.get("locked")).toEqual([]);
  });
});

// ─── loadProject ──────────────────────────────────────────────────────────────

describe("loadProject", () => {
  test("returns silently when probe finds nothing", async () => {
    installFsPlatform({}, { probeRootProject: async () => null });

    await loadProject();

    expect(projectState).toBeNull();
  });

  test("monorepo (non-site) probe sets state without loading the tree", async () => {
    const { state } = installFsPlatform(
      { "pages/index.json": "{}" },
      {
        probeRootProject: async () =>
          ({
            info: { isSiteProject: false },
            meta: { name: "mono", root: "/srv/mono" },
          }) as never,
      },
    );

    await loadProject();

    const st = requireProjectState();
    expect(st.isSiteProject).toBe(false);
    expect(st.name).toBe("mono");
    expect(st.projectConfig).toBeNull();
    expect(state.calls.filter(([name]) => name === "listDirectory")).toHaveLength(0);
    expect(activeTab.value).toBeNull();
  });

  test("site probe loads the tree, components, and opens the markdown home page", async () => {
    const { state } = installFsPlatform(
      {
        "pages/index.json": JSON.stringify({ tagName: "div" }),
        "pages/index.md": "---\ntitle: Home\n---\n\n# Welcome\n",
      },
      {
        probeRootProject: async () =>
          ({
            info: {
              directories: ["pages"],
              isSiteProject: true,
              projectConfig: { name: "My Blog" },
            },
            meta: { name: "fallback", root: "/srv/blog" },
          }) as never,
      },
    );

    await loadProject();

    const st = requireProjectState();
    expect(st.name).toBe("My Blog");
    expect(st.isSiteProject).toBe(true);
    expect(st.projectDirs).toEqual(["pages"]);
    expect(st.root).toBe("/srv/blog");
    expect(st.dirs.get(".")).toBeDefined();
    expect(state.calls.some(([name]) => name === "discoverComponents")).toBe(true);

    // Markdown format claims "page" documents, so index.md wins over index.json
    expect(activeTab.value?.documentPath).toBe("pages/index.md");
    expect(activeTab.value?.doc.sourceFormat).toBe("Markdown");
  });

  test("site probe without projectConfig falls back to meta name", async () => {
    installFsPlatform(
      { "pages/index.json": JSON.stringify({ tagName: "div" }) },
      {
        probeRootProject: async () =>
          ({
            info: { isSiteProject: true },
            meta: { name: "meta-name", root: "/srv/x" },
          }) as never,
      },
    );

    await loadProject();

    const st = requireProjectState();
    expect(st.name).toBe("meta-name");
    expect(st.projectConfig).toBeNull();
    expect(st.projectDirs).toEqual([]);
  });

  test("probe failure leaves project features disabled", async () => {
    installFsPlatform(
      {},
      {
        probeRootProject: async () => {
          throw new Error("not a dev server");
        },
      },
    );

    await loadProject();

    expect(projectState).toBeNull();
  });
});

// ─── openHomePage ─────────────────────────────────────────────────────────────

describe("openHomePage", () => {
  test("falls back to pages/index.json when no format candidate exists", async () => {
    installFsPlatform({ "pages/index.json": JSON.stringify({ tagName: "main" }) });
    siteState();

    await openHomePage();

    expect(activeTab.value?.documentPath).toBe("pages/index.json");
    expect(activeTab.value?.doc.document.tagName).toBe("main");
  });

  test("opens nothing when no home page candidate exists", async () => {
    installFsPlatform({ "readme.md": "# hi" });
    siteState();

    await openHomePage();

    expect(activeTab.value).toBeNull();
  });
});

// ─── findHomePage (listing-based; never provokes per-candidate 404s) ────────────

describe("findHomePage", () => {
  test("prefers a format page candidate over index.json", async () => {
    installFsPlatform({ "pages/index.json": "{}", "pages/index.md": "# Home" });
    siteState();

    expect(await findHomePage()).toBe("pages/index.md");
  });

  test("falls back to pages/index.json when no format candidate exists", async () => {
    installFsPlatform({ "pages/index.json": "{}" });
    siteState();

    expect(await findHomePage()).toBe("pages/index.json");
  });

  test("returns null when no index page exists", async () => {
    installFsPlatform({ "readme.md": "# hi" });
    siteState();

    expect(await findHomePage()).toBeNull();
  });

  test("returns null when the pages listing fails", async () => {
    installFsPlatform(
      { "pages/index.json": "{}" },
      {
        listDirectory: async () => {
          throw new Error("offline");
        },
      },
    );
    siteState();

    expect(await findHomePage()).toBeNull();
  });
});

// ─── openProject ──────────────────────────────────────────────────────────────

describe("openProject", () => {
  function ctxSpies() {
    const calls: string[] = [];
    return {
      calls,
      renderActivityBar: () => calls.push("activity"),
      renderLeftPanel: () => calls.push("left"),
    };
  }

  test("user cancellation is a no-op", async () => {
    const ctx = ctxSpies();
    installFsPlatform({}, { openProject: async () => null });

    await openProject(ctx);

    expect(ctx.calls).toEqual([]);
    expect(projectState).toBeNull();
  });

  test("loads the project, expands conventional dirs, and opens the home page", async () => {
    const ctx = ctxSpies();
    installFsPlatform(
      {
        "components/card.json": "{}",
        "notes/scratch.md": "# notes",
        "pages/index.json": JSON.stringify({ tagName: "div" }),
        "project.json": "{}",
      },
      {
        openProject: async () =>
          ({
            config: { name: "My Site" },
            handle: { name: "proj-dir", root: "/abs/proj" },
          }) as never,
      },
    );

    await openProject(ctx);

    const st = requireProjectState();
    expect(st.isSiteProject).toBe(true);
    expect(st.name).toBe("My Site");
    expect(st.projectRoot).toBe("/abs/proj");
    expect([...(st.projectDirs ?? [])].toSorted()).toEqual(["components", "pages"]);
    expect(st.expanded.has("pages")).toBe(true);
    expect(st.expanded.has("components")).toBe(true);
    expect(st.expanded.has("notes")).toBe(false);
    expect(st.dirs.has("pages")).toBe(true);
    expect(st.dirs.has("components")).toBe(true);

    expect(ctx.calls).toEqual(["activity", "left"]);
    expect(activeTab.value?.documentPath).toBe("pages/index.json");

    const recent = JSON.parse(localStorage.getItem("jx-studio-recent-projects") ?? "[]");
    expect(recent[0]?.name).toBe("My Site");
    expect(recent[0]?.root).toBe("/abs/proj");
  });

  test("falls back to the directory handle name when config has none", async () => {
    const ctx = ctxSpies();
    installFsPlatform(
      { "project.json": "{}" },
      {
        openProject: async () =>
          ({ config: {}, handle: { name: "proj-dir", root: "/abs/p2" } }) as never,
      },
    );

    await openProject(ctx);

    expect(requireProjectState().name).toBe("proj-dir");
    expect(requireProjectState().projectDirs).toEqual([]);
  });

  test("platform failure surfaces as a status message, not a crash", async () => {
    const ctx = ctxSpies();
    installFsPlatform(
      {},
      {
        openProject: async () => {
          throw new Error("dialog crashed");
        },
      },
    );

    await openProject(ctx);

    expect(ctx.calls).toEqual([]);
  });
});

// ─── openFileFromTree ─────────────────────────────────────────────────────────

describe("openFileFromTree", () => {
  function makeCtx(init: Partial<StudioState> = {}) {
    const S = createState({ children: [], tagName: "div" });
    Object.assign(S, init);
    const commits: StudioState[] = [];
    const renders: number[] = [];
    const mdLoads: [string, unknown][] = [];
    return {
      S,
      commit: (s: StudioState) => commits.push(s),
      commits,
      loadMarkdown: (source: string, handle: unknown) => {
        mdLoads.push([source, handle]);
      },
      mdLoads,
      render: () => renders.push(1),
      renders,
    };
  }

  test("opens a JSON document and commits fresh state", async () => {
    installFsPlatform({
      "pages/a.json": JSON.stringify({ children: [], tagName: "article" }),
    });
    siteState();
    const ctx = makeCtx();

    await openFileFromTree(ctx, "pages/a.json");

    expect(ctx.commits).toHaveLength(1);
    expect(ctx.commits[0]!.documentPath).toBe("pages/a.json");
    expect(ctx.commits[0]!.dirty).toBe(false);
    expect(ctx.commits[0]!.document.tagName).toBe("article");
    expect(requireProjectState().selectedPath).toBe("pages/a.json");
    expect(ctx.renders).toHaveLength(1);
  });

  test("routes format files through loadMarkdown", async () => {
    installFsPlatform({ "post.md": "# Hello\n" });
    siteState();
    const ctx = makeCtx();

    await openFileFromTree(ctx, "post.md");

    expect(ctx.mdLoads).toEqual([["# Hello\n", null]]);
    expect(ctx.S.documentPath).toBe("post.md");
    expect(ctx.S.dirty).toBe(false);
    expect(ctx.commits).toEqual([ctx.S]);
  });

  test("auto-saves the current dirty document before switching", async () => {
    const { state } = installFsPlatform({
      "pages/next.json": JSON.stringify({ tagName: "div" }),
    });
    siteState();
    const ctx = makeCtx({
      dirty: true,
      document: { children: [], tagName: "section" },
      documentPath: "pages/old.json",
    });

    await openFileFromTree(ctx, "pages/next.json");

    expect(JSON.parse(state.files.get("pages/old.json")!)).toEqual({
      children: [],
      tagName: "section",
    });
    expect(ctx.commits[0]!.documentPath).toBe("pages/next.json");
  });

  test("auto-save failure still opens the new file", async () => {
    installFsPlatform(
      { "pages/next.json": JSON.stringify({ tagName: "div" }) },
      {
        writeFile: async () => {
          throw new Error("read-only fs");
        },
      },
    );
    siteState();
    const ctx = makeCtx({ dirty: true, documentPath: "pages/old.json" });

    await openFileFromTree(ctx, "pages/next.json");

    expect(ctx.commits).toHaveLength(1);
    expect(ctx.commits[0]!.documentPath).toBe("pages/next.json");
  });

  test("empty content aborts without committing", async () => {
    installFsPlatform({ "empty.json": "" });
    siteState({ selectedPath: "before" });
    const ctx = makeCtx();

    await openFileFromTree(ctx, "empty.json");

    expect(ctx.commits).toHaveLength(0);
    expect(requireProjectState().selectedPath).toBe("before");
  });

  test("unknown extension surfaces a no-format error", async () => {
    installFsPlatform({ "data.toml": "a = 1" });
    siteState({ selectedPath: null });
    const ctx = makeCtx();

    await openFileFromTree(ctx, "data.toml");

    expect(ctx.commits).toHaveLength(0);
    expect(ctx.renders).toHaveLength(0);
    expect(requireProjectState().selectedPath).toBeNull();
  });

  test("read failure is reported without committing", async () => {
    installFsPlatform({});
    siteState();
    const ctx = makeCtx();

    await openFileFromTree(ctx, "missing.json");

    expect(ctx.commits).toHaveLength(0);
  });
});

// ─── openFileInTab ────────────────────────────────────────────────────────────

describe("openFileInTab", () => {
  test("activates an existing tab instead of re-reading the file", async () => {
    const { state } = installFsPlatform({ "pages/a.json": "{}" });
    siteState();
    openTab({
      document: { tagName: "div" },
      documentPath: "pages/a.json",
      id: "tab-a",
    });
    openTab({
      document: { tagName: "div" },
      documentPath: "pages/b.json",
      id: "tab-b",
    });
    expect(activeTab.value?.id).toBe("tab-b");

    await openFileInTab("pages/a.json");

    expect(activeTab.value?.id).toBe("tab-a");
    expect(requireProjectState().selectedPath).toBe("pages/a.json");
    expect(state.calls.filter(([name]) => name === "readFile")).toHaveLength(0);
  });

  test("opens a JSON file into a new tab and tracks it as recent", async () => {
    installFsPlatform({
      "pages/about.json": JSON.stringify({ children: [], tagName: "article" }),
    });
    siteState();

    await openFileInTab("pages/about.json");

    const tab = activeTab.value;
    expect(tab?.id).toBe("pages/about.json");
    expect(tab?.doc.document.tagName).toBe("article");
    expect(tab?.doc.sourceFormat).toBeNull();
    expect(requireProjectState().selectedPath).toBe("pages/about.json");

    const recent = JSON.parse(localStorage.getItem("jx-studio-recent-files") ?? "[]");
    expect(recent[0]).toMatchObject({ name: "about.json", path: "pages/about.json" });
  });

  test("parses format files with frontmatter", async () => {
    installFsPlatform({ "posts/hello.md": "---\ntitle: Hi\n---\n\n# Hello\n" });
    siteState();

    await openFileInTab("posts/hello.md");

    const tab = activeTab.value;
    expect(tab?.doc.sourceFormat).toBe("Markdown");
    expect(tab?.doc.content.frontmatter).toMatchObject({ title: "Hi" });
    expect(Array.isArray(tab?.doc.document.children)).toBe(true);
  });

  test("project.json opens in stylebook canvas mode", async () => {
    installFsPlatform({ "project.json": JSON.stringify({ name: "Demo" }) });
    siteState();

    await openFileInTab("project.json");

    expect(activeTab.value?.session.ui.canvasMode).toBe("stylebook");
  });

  test("empty content opens no tab", async () => {
    installFsPlatform({ "empty.json": "" });
    siteState();

    await openFileInTab("empty.json");

    expect(activeTab.value).toBeNull();
  });

  test("unknown extension opens no tab", async () => {
    installFsPlatform({ "data.toml": "a = 1" });
    siteState();

    await openFileInTab("data.toml");

    expect(activeTab.value).toBeNull();
  });

  test("read failure opens no tab", async () => {
    installFsPlatform({});
    siteState();

    await openFileInTab("missing.json");

    expect(activeTab.value).toBeNull();
  });
});

// ─── reloadFileInTab ──────────────────────────────────────────────────────────

describe("reloadFileInTab", () => {
  test("no matching tab — does not touch the platform", async () => {
    const { state } = installFsPlatform({ "pages/a.json": "{}" });
    siteState();

    await reloadFileInTab("pages/a.json");

    expect(state.calls.filter(([name]) => name === "readFile")).toHaveLength(0);
  });

  test("reloads a JSON tab from disk and clears dirty", async () => {
    const { state } = installFsPlatform({
      "pages/a.json": JSON.stringify({ tagName: "div" }),
    });
    siteState();
    const tab = openTab({
      document: { tagName: "div" },
      documentPath: "pages/a.json",
      id: "pages/a.json",
    });
    tab.doc.dirty = true;
    state.files.set("pages/a.json", JSON.stringify({ tagName: "header" }));

    await reloadFileInTab("pages/a.json");

    expect(tab.doc.document.tagName).toBe("header");
    expect(tab.doc.dirty).toBe(false);
  });

  test("reloads a format tab, replacing document and frontmatter", async () => {
    const { state } = installFsPlatform({ "post.md": "# Old\n" });
    siteState();
    const tab = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "post.md",
      id: "post.md",
      sourceFormat: "Markdown",
    });
    tab.doc.dirty = true;
    state.files.set("post.md", "---\ntitle: Fresh\n---\n\n# New heading\n");

    await reloadFileInTab("post.md");

    expect(tab.doc.content.frontmatter).toMatchObject({ title: "Fresh" });
    expect(tab.doc.dirty).toBe(false);
    expect(JSON.stringify(tab.doc.document)).toContain("New heading");
  });

  test("empty content leaves the tab untouched", async () => {
    installFsPlatform({ "pages/a.json": "" });
    siteState();
    const tab = openTab({
      document: { tagName: "aside" },
      documentPath: "pages/a.json",
      id: "pages/a.json",
    });
    tab.doc.dirty = true;

    await reloadFileInTab("pages/a.json");

    expect(tab.doc.document.tagName).toBe("aside");
    expect(tab.doc.dirty).toBe(true);
  });

  test("read failure is swallowed", async () => {
    installFsPlatform({});
    siteState();
    const tab = openTab({
      document: { tagName: "aside" },
      documentPath: "gone.json",
      id: "gone.json",
    });
    tab.doc.dirty = true;

    await reloadFileInTab("gone.json");

    expect(tab.doc.document.tagName).toBe("aside");
    expect(tab.doc.dirty).toBe(true);
  });

  test("non-format, non-json path leaves document untouched but clears dirty", async () => {
    installFsPlatform({ "notes.txt": "plain text" });
    siteState();
    const tab = openTab({
      document: { tagName: "pre" },
      documentPath: "notes.txt",
      id: "notes.txt",
    });
    tab.doc.dirty = true;

    await reloadFileInTab("notes.txt");

    expect(tab.doc.document.tagName).toBe("pre");
    expect(tab.doc.dirty).toBe(false);
  });

  test("only the matching tab is refreshed", async () => {
    const { state } = installFsPlatform({
      "pages/a.json": JSON.stringify({ tagName: "div" }),
      "pages/b.json": JSON.stringify({ tagName: "div" }),
    });
    siteState();
    const tabA = openTab({
      document: { tagName: "div" },
      documentPath: "pages/a.json",
      id: "pages/a.json",
    });
    const tabB = openTab({
      document: { tagName: "div" },
      documentPath: "pages/b.json",
      id: "pages/b.json",
    });
    state.files.set("pages/a.json", JSON.stringify({ tagName: "nav" }));
    state.files.set("pages/b.json", JSON.stringify({ tagName: "footer" }));

    await reloadFileInTab("pages/b.json");
    await flush();

    expect(tabA.doc.document.tagName).toBe("div");
    expect(tabB.doc.document.tagName).toBe("footer");
    expect(workspace.tabs.size).toBe(2);
  });
});
