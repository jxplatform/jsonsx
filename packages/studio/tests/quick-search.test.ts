/**
 * Quick-search overlay tests (E9). Exercises the real overlay against a mock platform: debounced
 * search, recent files, keyboard navigation, selection side effects (recent tracking + tab open),
 * file icons, and dismissal paths. openFileInTab is mocked so selection stays side-effect free.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StudioFormat } from "../src/format/format-host";

const openFileInTab = mock((_path: string) => {});
void mock.module("../src/files/files.js", () => ({ openFileInTab }));

const { closeQuickSearch, initQuickSearch, openQuickSearch } =
  await import("../src/panels/quick-search");
const { setFormats } = await import("../src/format/format-host");
const { initLayers } = await import("../src/ui/layers");
const { setProjectState } = await import("../src/store");
const { getRecentFiles, trackRecentFile } = await import("../src/recent-projects");

const PROJECT_ROOT = "/project";

// Layer DOM is set up once — getLayerSlot caches its slot element, so the body must not be
// Replaced between tests (the cached slot would keep pointing into a detached subtree).
document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

const MARKDOWN_FORMAT: StudioFormat = {
  capabilities: { parse: { identifier: "parse", timing: ["buildtime"] } },
  documentKinds: ["content"],
  exportTarget: false,
  extensions: [".md"],
  mediaType: "text/markdown",
  name: "Markdown",
  remote: false,
  studio: null,
};

const SEED_FILES = {
  "/project/pages/doc-a.json": "{}",
  "/project/pages/doc-b.json": "{}",
  "/project/posts/hello.md": "# Hello",
  "/project/raw/blob.xyz": "data",
  "rootfile-doc.json": "{}",
};

function overlay(): HTMLElement | null {
  return document.querySelector(".quick-search-overlay");
}

function searchInput(): HTMLInputElement {
  return document.querySelector(".quick-search-input") as HTMLInputElement;
}

function items(): HTMLElement[] {
  return [...document.querySelectorAll(".quick-search-item")] as HTMLElement[];
}

function keydown(keyName: string) {
  searchInput().dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: keyName }),
  );
}

/** Type into the search box and wait out the 150ms debounce + async search. */
async function search(query: string) {
  const input = searchInput();
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => {
    setTimeout(resolve, 220);
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  openFileInTab.mockClear();
  initQuickSearch();
  setFormats([MARKDOWN_FORMAT]);
  installMockPlatform({}, SEED_FILES);
  // Default to a project being open: the modal searches/lists that project's files.
  resetStudioState({ isSiteProject: true, name: "Test", projectRoot: PROJECT_ROOT });
  closeQuickSearch();
});

describe("quick-search — open/close", () => {
  test("open renders the overlay with an empty-state hint; close removes it", () => {
    openQuickSearch();
    expect(overlay()).toBeTruthy();
    expect(document.querySelector(".quick-search-empty")?.textContent).toBe(
      "Type to search project files",
    );
    closeQuickSearch();
    expect(overlay()).toBeNull();
  });

  test("clicking the backdrop closes; clicks inside the panel do not", () => {
    openQuickSearch();
    const panel = document.querySelector(".quick-search-panel") as HTMLElement;
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlay()).toBeTruthy();
    overlay()!.dispatchEvent(new MouseEvent("click", { bubbles: false }));
    expect(overlay()).toBeNull();
  });

  test("Escape closes the overlay", () => {
    openQuickSearch();
    keydown("Escape");
    expect(overlay()).toBeNull();
  });
});

describe("quick-search — searching", () => {
  test("debounced query hits platform.searchFiles with document extensions", async () => {
    const { state } = installMockPlatform({}, SEED_FILES);
    openQuickSearch();
    await search("  Hello "); // Trimmed + lowercased before the platform call
    const call = state.calls.find((c) => c[0] === "searchFiles") as unknown[];
    expect(call).toEqual(["searchFiles", "hello", [".md"]]);

    const rows = items();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector(".quick-search-name")?.textContent).toBe("hello.md");
    expect(rows[0]!.querySelector(".quick-search-path")?.textContent).toBe("/project/posts");
    // Format-claimed extension renders the text-file icon
    expect(rows[0]!.querySelector("sp-icon-file-txt")).toBeTruthy();
    // No recent badge in search mode
    expect(rows[0]!.querySelector(".quick-search-badge")).toBeNull();
  });

  test("renders json and unknown-extension icons and a rootless dir part", async () => {
    openQuickSearch();
    await search("doc");
    const names = items().map((el) => el.querySelector(".quick-search-name")?.textContent);
    expect(names).toEqual(["doc-a.json", "doc-b.json", "rootfile-doc.json"]);
    expect(items()[0]!.querySelector("sp-icon-file-code")).toBeTruthy();
    // File at the search root has an empty dir part
    expect(items()[2]!.querySelector(".quick-search-path")?.textContent).toBe("");

    await search("blob");
    expect(items()[0]!.querySelector("sp-icon-document")).toBeTruthy();
  });

  test("shows No results for a query with no matches", async () => {
    openQuickSearch();
    await search("zzz-nothing");
    expect(items()).toHaveLength(0);
    expect(document.querySelector(".quick-search-empty")?.textContent).toBe("No results");
  });

  test("clearing the query resets to the empty-state hint", async () => {
    openQuickSearch();
    await search("doc");
    expect(items().length).toBeGreaterThan(0);
    await search("");
    expect(items()).toHaveLength(0);
    expect(document.querySelector(".quick-search-empty")?.textContent).toBe(
      "Type to search project files",
    );
  });

  test("a failing platform search degrades to empty results", async () => {
    installMockPlatform({
      searchFiles: (async () => {
        throw new Error("search backend down");
      }) as never,
    });
    openQuickSearch();
    await search("doc");
    expect(items()).toHaveLength(0);
    expect(document.querySelector(".quick-search-empty")?.textContent).toBe("No results");
  });
});

describe("quick-search — keyboard navigation and selection", () => {
  test("arrow keys move the selection within bounds", async () => {
    openQuickSearch();
    await search("doc");
    expect(items()[0]!.classList.contains("selected")).toBe(true);

    keydown("ArrowDown");
    expect(items()[1]!.classList.contains("selected")).toBe(true);
    keydown("ArrowDown");
    keydown("ArrowDown"); // Clamped at the last row
    expect(items()[2]!.classList.contains("selected")).toBe(true);

    keydown("ArrowUp");
    keydown("ArrowUp");
    keydown("ArrowUp"); // Clamped at the first row
    expect(items()[0]!.classList.contains("selected")).toBe(true);

    keydown("x"); // Default branch: no state change
    expect(items()[0]!.classList.contains("selected")).toBe(true);
  });

  test("Enter opens the selected result and tracks it as recent", async () => {
    openQuickSearch();
    await search("doc");
    keydown("ArrowDown");
    keydown("Enter");
    expect(overlay()).toBeNull();
    expect(openFileInTab).toHaveBeenCalledWith("/project/pages/doc-b.json");
    expect(getRecentFiles()[0]).toMatchObject({
      name: "doc-b.json",
      path: "/project/pages/doc-b.json",
    });
  });

  test("Enter with no items is a no-op", () => {
    openQuickSearch();
    keydown("Enter");
    expect(overlay()).toBeTruthy();
    expect(openFileInTab).not.toHaveBeenCalled();
  });

  test("mouseenter moves the selection and click opens the row", async () => {
    openQuickSearch();
    await search("doc");
    items()[2]!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    expect(items()[2]!.classList.contains("selected")).toBe(true);
    items()[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openFileInTab).toHaveBeenCalledWith("rootfile-doc.json");
    expect(overlay()).toBeNull();
  });
});

describe("quick-search — recent files", () => {
  test("empty query lists the open project's recent files with badges and supports Enter", () => {
    trackRecentFile({ name: "old.md", path: "/project/posts/old.md", root: PROJECT_ROOT });
    trackRecentFile({ name: "fresh.json", path: "/project/pages/fresh.json", root: PROJECT_ROOT });
    openQuickSearch();

    expect(document.querySelector(".quick-search-section-label")?.textContent).toBe(
      "Recently opened",
    );
    const rows = items();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".quick-search-name")?.textContent).toBe("fresh.json");
    expect(rows[0]!.querySelector(".quick-search-badge")?.textContent).toBe("recent");

    keydown("Enter");
    expect(openFileInTab).toHaveBeenCalledWith("/project/pages/fresh.json");
    expect(overlay()).toBeNull();
  });

  test("recent files from other projects are never shown", () => {
    trackRecentFile({ name: "mine.md", path: "pages/mine.md", root: PROJECT_ROOT });
    trackRecentFile({ name: "theirs.md", path: "pages/theirs.md", root: "/other/project" });
    openQuickSearch();
    const names = items().map((el) => el.querySelector(".quick-search-name")?.textContent);
    expect(names).toEqual(["mine.md"]);
  });

  test("selecting a file tracks it under the open project", () => {
    trackRecentFile({ name: "a.md", path: "pages/a.md", root: PROJECT_ROOT });
    openQuickSearch();
    items()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getRecentFiles(PROJECT_ROOT).map((f) => f.path)).toEqual(["pages/a.md"]);
  });
});

describe("quick-search — no project open", () => {
  const RECENT_PROJECTS_KEY = "jx-studio-recent-projects";

  beforeEach(() => {
    setProjectState(null);
  });

  function seedProjects() {
    localStorage.setItem(
      RECENT_PROJECTS_KEY,
      JSON.stringify([
        { name: "Alpha", root: "/home/u/alpha", timestamp: 2 },
        { name: "Beta", root: "/srv/beta", timestamp: 1 },
      ]),
    );
  }

  test("lists recent projects (newest-first) and opens one on Enter", () => {
    seedProjects();
    const openRecentProject = mock((_root: string) => {});
    initQuickSearch({ openRecentProject });
    openQuickSearch();

    expect(searchInput().placeholder).toBe("Open a recent project…");
    expect(document.querySelector(".quick-search-section-label")?.textContent).toBe(
      "Recent projects",
    );
    const rows = items();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".quick-search-name")?.textContent).toBe("Alpha");
    expect(rows[0]!.querySelector(".quick-search-path")?.textContent?.trim()).toBe("~/alpha");

    keydown("Enter");
    expect(openRecentProject).toHaveBeenCalledWith("/home/u/alpha");
    expect(openFileInTab).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });

  test("filters recent projects by query without hitting the file-search backend", async () => {
    seedProjects();
    const { state } = installMockPlatform({}, SEED_FILES);
    initQuickSearch({ openRecentProject: mock((_root: string) => {}) });
    openQuickSearch();
    await search("beta");
    const rows = items();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector(".quick-search-name")?.textContent).toBe("Beta");
    expect(state.calls.some((c) => c[0] === "searchFiles")).toBe(false);
  });

  test("shows an empty hint when there are no recent projects", () => {
    initQuickSearch({ openRecentProject: mock((_root: string) => {}) });
    openQuickSearch();
    expect(document.querySelector(".quick-search-empty")?.textContent).toContain(
      "No recent projects",
    );
  });
});
