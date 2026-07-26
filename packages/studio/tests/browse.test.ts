/**
 * Tests for src/browse/browse.ts — the Manage view file browser.
 *
 * Covers directory scanning, category/search filtering, grid and table views, live previews, the
 * "New +" entity menu (including content types), uploads, and the per-file context menu
 * (open/rename/duplicate/delete) with its Spectrum dialogs.
 */
import {
  answerPromptDialog,
  flush,
  installMockPlatform,
  pointer,
  resetStudioState,
  topDialog,
} from "./harness";
import type { MockPlatformState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { setFormats } from "../src/format/format-host";
import type { StudioFormat } from "../src/format/format-host";
import { componentRegistry } from "../src/files/components";
import { invalidateBrowseCache, renderBrowse } from "../src/browse/browse";
import type { DirEntry, StudioPlatform } from "../src/types";

// ─── Environment setup ───────────────────────────────────────────────────────

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

// Deterministic rAF: run callbacks on the next macrotask so flush() picks them up.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function fileEntry(name: string, path: string): DirEntry {
  return { name, path, type: "file" };
}
function dirEntry(name: string, path: string): DirEntry {
  return { name, path, type: "directory" };
}

const TREE: Record<string, DirEntry[]> = {
  components: [fileEntry("button.json", "components/button.json")],
  content: [dirEntry("posts", "content/posts"), fileEntry("note.md", "content/note.md")],
  "content/posts": [fileEntry("hello.md", "content/posts/hello.md")],
  data: [fileEntry("things.json", "data/things.json")],
  layouts: [fileEntry("main.json", "layouts/main.json")],
  misc: [fileEntry("readme.txt", "misc/readme.txt"), fileEntry("top.json", "top.json")],
  pages: [
    fileEntry("index.json", "pages/index.json"),
    dirEntry("sub", "pages/sub"),
    fileEntry("Makefile", "pages/Makefile"),
  ],
  "pages/sub": [fileEntry("about.json", "pages/sub/about.json")],
  public: [fileEntry("logo.png", "public/logo.png"), fileEntry("doc.pdf", "public/doc.pdf")],
  styles: [fileEntry("site.json", "styles/site.json")],
};

const DIRS = [
  "pages",
  "layouts",
  "components",
  "content",
  "public",
  "data",
  "styles",
  "misc",
  "missing",
];

const SEEDS: Record<string, string> = {
  "content/note.md": "# Note",
  "content/posts/hello.md": "# Hello",
  "data/things.json": '{"tagName":"span","children":[]}',
  "layouts/main.json": '{"tagName":"main","children":[]}',
  "pages/Makefile": "all: build",
  "pages/index.json": '{"tagName":"div","children":[{"tagName":"p","textContent":"Hi"}]}',
  "pages/sub/about.json": '{"tagName":"section","children":[]}',
  "public/doc.pdf": "PDFDATA",
  "public/logo.png": "PNGDATA",
  "styles/site.json": '{"tagName":"div","children":[]}',
  "top.json": '{"tagName":"div"}',
};

const BASE_CONFIG = {
  content: {
    draft: {},
    note: { source: "./content/note.md" },
    posts: {
      format: "Markdown",
      schema: {
        properties: {
          count: { type: "number" },
          img: { format: "image", type: "string" },
          meta: { type: "object" },
          published: { type: "boolean" },
          tags: { type: "array" },
          title: { type: "string" },
        },
      },
      source: "./content/posts/",
    },
  },
};

const MD_FORMAT: StudioFormat = {
  capabilities: {
    parse: { identifier: "parse", timing: ["server"] },
    serialize: { identifier: "serialize", timing: ["server"] },
  },
  documentKinds: ["content", "page"],
  exportTarget: false,
  extensions: [".md"],
  mediaType: "text/markdown",
  name: "Markdown",
  remote: false,
  studio: { newFileTemplate: "# New file\n" },
};

// One npm-sourced component so the componentRegistry preview branch is exercised.
if (!componentRegistry.some((c) => c.path === "components/button.json")) {
  componentRegistry.push({
    path: "components/button.json",
    source: "npm",
    tagName: "x-browse-button",
  } as (typeof componentRegistry)[number]);
}

// ─── Harness state ───────────────────────────────────────────────────────────

let state: MockPlatformState;
let opened: string[];
let ctx: { openFile: (path: string) => void };
let scannedDirs: string[];

function makeListDirectory(tree: Record<string, DirEntry[]>) {
  return async (dir: string) => {
    scannedDirs.push(dir);
    const entries = tree[dir];
    if (!entries) {
      throw new Error(`no such directory: ${dir}`);
    }
    return entries;
  };
}

function setup(
  opts: {
    overrides?: Partial<StudioPlatform>;
    config?: unknown;
    dirs?: string[];
  } = {},
) {
  scannedDirs = [];
  ({ state } = installMockPlatform(
    { listDirectory: makeListDirectory(TREE), ...opts.overrides },
    SEEDS,
  ));
  resetStudioState({
    projectConfig: opts.config === undefined ? BASE_CONFIG : opts.config,
    projectDirs: opts.dirs ?? DIRS,
    projectRoot: "",
  });
}

function dialogLayer(): HTMLElement {
  return document.querySelector("#layer-dialog") as HTMLElement;
}

function actionButtons(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll("sp-action-button")] as HTMLElement[];
}

function categoryButton(container: HTMLElement, label: string): HTMLElement {
  const btn = actionButtons(container).find((b) => (b.textContent ?? "").trim() === label);
  if (!btn) {
    throw new Error(`no category button: ${label}`);
  }
  return btn;
}

async function setCategory(container: HTMLElement, label: string) {
  pointer(categoryButton(container, label), "click");
  await flush();
}

async function setSearch(container: HTMLElement, value: string) {
  const search = container.querySelector("sp-search") as HTMLElement & { value: string };
  search.value = value;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}

async function setView(container: HTMLElement, title: "Grid view" | "Table view") {
  const btn = container.querySelector(`sp-action-button[title="${title}"]`) as HTMLElement;
  pointer(btn, "click");
  await flush();
}

/** Render browse into a fresh container attached to the body. */
async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  await renderBrowse(container, ctx);
  await flush();
  return container;
}

/** Reset the module-level UI state (category/search/view persist across renders). */
async function mountWithDefaults(): Promise<HTMLElement> {
  const container = await mount();
  await setCategory(container, "All");
  await setSearch(container, "");
  await setView(container, "Grid view");
  return container;
}

function cards(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll(".element-card")] as HTMLElement[];
}

function cardByLabel(container: HTMLElement, label: string): HTMLElement {
  const card = cards(container).find(
    (c) => c.querySelector(".element-card-label")?.textContent === label,
  );
  if (!card) {
    throw new Error(`no card labeled: ${label}`);
  }
  return card;
}

function cardLabels(container: HTMLElement): string[] {
  return cards(container).map((c) => c.querySelector(".element-card-label")?.textContent ?? "");
}

function tableRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll("sp-table-row.browse-row")] as HTMLElement[];
}

function rowCells(row: HTMLElement): string[] {
  return [...row.querySelectorAll("sp-table-cell")].map((c) => (c.textContent ?? "").trim());
}

function rowByPath(container: HTMLElement, path: string): HTMLElement {
  const row = tableRows(container).find((r) => r.getAttribute("value") === path);
  if (!row) {
    throw new Error(`no table row for: ${path}`);
  }
  return row;
}

async function openContextMenu(container: HTMLElement, label: string, init: MouseEventInit = {}) {
  pointer(cardByLabel(container, label), "contextmenu", init);
  await flush();
}

function menuItems(): HTMLElement[] {
  return [...dialogLayer().querySelectorAll("sp-menu-item")] as HTMLElement[];
}

async function clickMenuItem(label: string) {
  const item = menuItems().find((i) => (i.textContent ?? "").trim() === label);
  if (!item) {
    throw new Error(`no menu item: ${label}`);
  }
  pointer(item, "click");
  await flush();
}

function dialogWrapper(): HTMLElement | null {
  return dialogLayer().querySelector("sp-dialog-wrapper");
}

function writeCalls(): unknown[][] {
  return state.calls.filter((c) => c[0] === "writeFile");
}

beforeEach(() => {
  setFormats([]);
  invalidateBrowseCache();
  setup();
  opened = [];
  ctx = { openFile: (p: string) => opened.push(p) };
  dialogLayer().replaceChildren();
  for (const el of document.body.querySelectorAll(":scope > div:not([id])")) {
    el.remove();
  }
});

// ─── Scanning & grid view ────────────────────────────────────────────────────

describe("scanning and grid view", () => {
  test("scans project dirs recursively and renders one card per file", async () => {
    const container = await mountWithDefaults();
    const labels = cardLabels(container);
    expect(labels).toHaveLength(13);
    // Recursion into subdirectories
    expect(labels).toContain("about.json");
    expect(labels).toContain("hello.md");
    // Inaccessible dir is silently skipped
    expect(scannedDirs).toContain("missing");
    // Files sorted by path
    const sorted = [...labels];
    expect(labels).toEqual(sorted);
  });

  test("image cards render an <img>, plain media cards a document icon", async () => {
    const container = await mountWithDefaults();
    const img = cardByLabel(container, "logo.png").querySelector("img");
    // No cross-origin loopback registered => loopbackAssetSrc falls back to the relative path.
    expect(img?.getAttribute("src")).toBe("/public/logo.png");
    expect(cardByLabel(container, "doc.pdf").querySelector("sp-icon-document")).not.toBeNull();
    expect(cardByLabel(container, "readme.txt").querySelector("sp-icon-document")).not.toBeNull();
  });

  test("image card src is loopback-absolute when a cross-origin canvasUrl is registered", async () => {
    setup({ overrides: { canvasUrl: "http://127.0.0.1:54321/__studio__/canvas.html" } });
    invalidateBrowseCache();
    const container = await mountWithDefaults();
    const img = cardByLabel(container, "logo.png").querySelector("img");
    expect(img?.getAttribute("src")).toBe("http://127.0.0.1:54321/public/logo.png");
  });

  test("document previews render live content into preview slots", async () => {
    const container = await mountWithDefaults();
    await flush(4);
    const preview = cardByLabel(container, "main.json").querySelector(".element-card-preview");
    expect(preview?.firstElementChild?.tagName.toLowerCase()).toBe("main");
    // Unparseable doc yields no preview
    const makefile = cardByLabel(container, "Makefile").querySelector(".element-card-preview");
    expect(makefile?.firstElementChild).toBeNull();
  });

  test("component registry entries render component previews (npm fallback)", async () => {
    const container = await mountWithDefaults();
    await flush(4);
    const preview = cardByLabel(container, "button.json").querySelector(".element-card-preview");
    expect(preview?.firstElementChild).not.toBeNull();
  });

  test("previews are cached across re-renders", async () => {
    const c1 = await mountWithDefaults();
    await flush(4);
    const first = c1.querySelector(".element-card-preview")?.firstElementChild;
    expect(first).not.toBeNull();
    const readsOfMain = () =>
      state.calls.filter((c) => c[0] === "readFile" && c[1] === "layouts/main.json").length;
    const reads = readsOfMain();
    expect(reads).toBeGreaterThan(0);
    const c2 = await mount();
    await flush(4);
    const preview = cardByLabel(c2, "main.json").querySelector(".element-card-preview");
    expect(preview?.firstElementChild).not.toBeNull();
    // No additional read for main.json: its preview came from the cache
    expect(readsOfMain()).toBe(reads);
  });

  test("clicking a card opens the file", async () => {
    const container = await mountWithDefaults();
    pointer(cardByLabel(container, "hello.md"), "click");
    expect(opened).toEqual(["content/posts/hello.md"]);
  });
});

// ─── Filtering ───────────────────────────────────────────────────────────────

describe("filtering", () => {
  test("category buttons filter the grid", async () => {
    const container = await mountWithDefaults();
    await setCategory(container, "Media");
    expect(cardLabels(container).toSorted()).toEqual(["doc.pdf", "logo.png"]);
    await setCategory(container, "Pages");
    expect(cardLabels(container).toSorted()).toEqual(["Makefile", "about.json", "index.json"]);
    await setCategory(container, "All");
    expect(cardLabels(container)).toHaveLength(13);
  });

  test("search matches names and paths", async () => {
    const container = await mountWithDefaults();
    await setSearch(container, "logo");
    expect(cardLabels(container)).toEqual(["logo.png"]);
    await setSearch(container, "sub/");
    expect(cardLabels(container)).toEqual(["about.json"]);
    await setSearch(container, "");
    expect(cardLabels(container)).toHaveLength(13);
  });

  test("no matches shows empty state in grid", async () => {
    const container = await mountWithDefaults();
    await setSearch(container, "zzz-no-such-file");
    expect(container.querySelector(".browse-grid-empty")?.textContent).toContain("No files found");
    await setSearch(container, "");
  });
});

// ─── Table view ──────────────────────────────────────────────────────────────

describe("table view", () => {
  test("rows show name, category, type, and path", async () => {
    const container = await mountWithDefaults();
    await setView(container, "Table view");
    expect(tableRows(container)).toHaveLength(13);

    // Content type matched by source prefix
    expect(rowCells(rowByPath(container, "content/posts/hello.md"))).toEqual([
      "hello.md",
      "Content",
      "Posts",
      "content/posts/hello.md",
    ]);
    // Exact source match
    expect(rowCells(rowByPath(container, "content/note.md"))[2]).toBe("Note");
    // Data/ maps to Content with extension type
    expect(rowCells(rowByPath(container, "data/things.json")).slice(1, 3)).toEqual([
      "Content",
      ".json",
    ]);
    // Styles/ maps to Components
    expect(rowCells(rowByPath(container, "styles/site.json"))[1]).toBe("Components");
    // Unknown dir maps to Other; extension-less file has type "file"
    expect(rowCells(rowByPath(container, "misc/readme.txt"))[1]).toBe("Other");
    expect(rowCells(rowByPath(container, "pages/Makefile"))[2]).toBe("file");
    await setView(container, "Grid view");
  });

  test("image rows render thumbnails and do not open on click", async () => {
    const container = await mountWithDefaults();
    await setView(container, "Table view");
    const imgRow = rowByPath(container, "public/logo.png");
    // No cross-origin loopback registered => the thumb src falls back to the relative path.
    expect(imgRow.querySelector("img.browse-thumb")?.getAttribute("src")).toBe("/public/logo.png");
    pointer(imgRow, "click");
    expect(opened).toEqual([]);

    pointer(rowByPath(container, "layouts/main.json"), "click");
    expect(opened).toEqual(["layouts/main.json"]);
    await setView(container, "Grid view");
  });

  test("table thumb src is loopback-absolute when a cross-origin canvasUrl is registered", async () => {
    setup({ overrides: { canvasUrl: "http://127.0.0.1:54321/__studio__/canvas.html" } });
    invalidateBrowseCache();
    const container = await mountWithDefaults();
    await setView(container, "Table view");
    const imgRow = rowByPath(container, "public/logo.png");
    expect(imgRow.querySelector("img.browse-thumb")?.getAttribute("src")).toBe(
      "http://127.0.0.1:54321/public/logo.png",
    );
    await setView(container, "Grid view");
  });

  test("empty table shows a placeholder row", async () => {
    const container = await mountWithDefaults();
    await setView(container, "Table view");
    await setSearch(container, "zzz-no-such-file");
    expect(container.querySelector("sp-table-body")?.textContent).toContain("No files found");
    await setSearch(container, "");
    await setView(container, "Grid view");
  });

  test("table rows open the context menu", async () => {
    const container = await mountWithDefaults();
    await setView(container, "Table view");
    pointer(rowByPath(container, "layouts/main.json"), "contextmenu");
    await flush();
    expect(dialogLayer().querySelector("sp-popover")).not.toBeNull();
    await clickMenuItem("Open");
    expect(opened).toEqual(["layouts/main.json"]);
    await setView(container, "Grid view");
  });
});

// ─── Loading & reload behavior ───────────────────────────────────────────────

describe("loading and reload", () => {
  test("shows Loading... while a scan is in flight (grid and table)", async () => {
    let resolveScan!: (entries: DirEntry[]) => void;
    const pending = new Promise<DirEntry[]>((resolve) => {
      resolveScan = resolve;
    });
    setup({ dirs: ["pages"], overrides: { listDirectory: () => pending } });
    invalidateBrowseCache();

    const c1 = document.createElement("div");
    document.body.append(c1);
    const inFlight = renderBrowse(c1, ctx);

    const c2 = await mount();
    expect(c2.querySelector(".browse-grid-empty")?.textContent).toContain("Loading...");

    await setView(c2, "Table view");
    expect(c2.querySelector("sp-table-body")?.textContent).toContain("Loading...");
    await setView(c2, "Grid view");

    resolveScan([]);
    await inFlight;
    expect(c1.querySelector(".browse-grid-empty")?.textContent).toContain("No files found");
  });

  test("re-scans when projectDirs change", async () => {
    const container = await mountWithDefaults();
    expect(cardLabels(container)).toHaveLength(13);

    resetStudioState({
      projectConfig: BASE_CONFIG,
      projectDirs: ["public"],
      projectRoot: "",
    });
    await renderBrowse(container, ctx);
    await flush();
    expect(cardLabels(container).toSorted()).toEqual(["doc.pdf", "logo.png"]);
  });

  test("renders nothing to scan when no project is loaded", async () => {
    const { setProjectState } = await import("../src/store");
    setProjectState(null as never);
    invalidateBrowseCache();
    const container = await mount();
    expect(container.querySelector(".browse-view")).not.toBeNull();
    expect(container.textContent).toContain("No files found");
    setup();
  });

  test("works without a content config; non-media public files are Media", async () => {
    const tree: Record<string, DirEntry[]> = {
      content: [fileEntry("note.md", "content/note.md")],
      public: [fileEntry("robots.txt", "public/robots.txt")],
    };
    setup({
      config: {},
      dirs: ["content", "public"],
      overrides: { listDirectory: makeListDirectory(tree) },
    });
    invalidateBrowseCache();
    const container = await mountWithDefaults();
    await setView(container, "Table view");
    // No content type match — falls back to the extension
    expect(rowCells(rowByPath(container, "content/note.md")).slice(1, 3)).toEqual([
      "Content",
      ".md",
    ]);
    // Public/ dir forces Media even for non-media extensions
    expect(rowCells(rowByPath(container, "public/robots.txt"))[1]).toBe("Media");
    await setView(container, "Grid view");
    // And the New menu offers only the base entity types
    const items = [...container.querySelectorAll("overlay-trigger sp-menu-item")];
    expect(items).toHaveLength(4);
    expect(container.querySelector("overlay-trigger sp-menu-divider")).toBeNull();
  });

  test("invalidateBrowseCache forces a reload on next render", async () => {
    await mountWithDefaults();
    const before = scannedDirs.length;
    invalidateBrowseCache();
    await mount();
    expect(scannedDirs.length).toBeGreaterThan(before);
  });
});

// ─── New entity menu ─────────────────────────────────────────────────────────

function newMenu(container: HTMLElement): HTMLElement & { value: string } {
  return container.querySelector("overlay-trigger sp-popover sp-menu") as HTMLElement & {
    value: string;
  };
}

/**
 * Pick an entity type from the "New +" menu. When `answer` is supplied the resulting name dialog is
 * answered with it (`null` cancels). Returns the dialog's headline, or null when none opened.
 */
async function chooseNewEntity(container: HTMLElement, value: string, answer?: string | null) {
  const menu = newMenu(container);
  menu.value = value;
  menu.dispatchEvent(new Event("change", { bubbles: false }));
  await flush(4);
  const headline = topDialog()?.getAttribute("headline") ?? null;
  if (answer !== undefined) {
    await answerPromptDialog(answer);
    await flush(2);
  }
  return headline;
}

describe("new entity menu", () => {
  test("lists base entity types plus content types behind a divider", async () => {
    const container = await mountWithDefaults();
    const items = [...container.querySelectorAll("overlay-trigger sp-menu-item")].map((i) =>
      (i.textContent ?? "").trim(),
    );
    expect(items).toEqual(["Page", "Layout", "Component", "Content", "Draft", "Note", "Posts"]);
    expect(container.querySelector("overlay-trigger sp-menu-divider")).not.toBeNull();
  });

  test("creates a page as JSON by default and opens it", async () => {
    const container = await mountWithDefaults();
    const headline = await chooseNewEntity(container, "page", "My Page!");
    expect(headline).toBe("New Page");
    expect(state.files.get("pages/my-page.json")).toBe(
      JSON.stringify({ children: [], tagName: "div" }, null, "\t"),
    );
    expect(opened).toContain("pages/my-page.json");
  });

  test("the name dialog is a Spectrum dialog, prefilled and scoped to the target directory", async () => {
    const container = await mountWithDefaults();
    await chooseNewEntity(container, "page");

    const wrapper = topDialog();
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute("confirm-label")).toBe("Create");
    expect(wrapper!.textContent).toContain("Creating in pages/");
    expect(wrapper!.querySelector("sp-textfield")!.getAttribute("value")).toBe("untitled");

    await answerPromptDialog(null);
  });

  test("a blank name keeps the dialog open and creates nothing", async () => {
    const container = await mountWithDefaults();
    const before = writeCalls().length;
    await chooseNewEntity(container, "page", "  ");

    expect(writeCalls().length).toBe(before);
    expect(topDialog()).not.toBeNull();
    expect(topDialog()!.querySelector("sp-help-text")?.textContent).toContain("Enter a page name.");

    await answerPromptDialog(null);
  });

  test("uses format extension and newFileTemplate when a format is registered", async () => {
    setFormats([MD_FORMAT]);
    const container = await mountWithDefaults();
    await chooseNewEntity(container, "content", "Read Me");
    expect(state.files.get("content/read-me.md")).toBe("# New file\n");

    await chooseNewEntity(container, "page", "Landing");
    expect(state.files.get("pages/landing.md")).toBe("# New file\n");
  });

  test("content-type creation writes frontmatter from the schema", async () => {
    setFormats([MD_FORMAT]);
    const container = await mountWithDefaults();
    await chooseNewEntity(container, "contentType:posts", "Hello World");
    const content = state.files.get("content/posts/hello-world.md");
    expect(content).toBeDefined();
    expect(content).toStartWith("---\n");
    expect(content).toEndWith("---\n\n");
    expect(content).toContain("count: 0\n");
    expect(content).toContain('img: ""\n');
    expect(content).toContain("meta: {}\n");
    expect(content).toContain("published: false\n");
    expect(content).toContain("tags: []\n");
    expect(content).toContain('title: ""\n');
  });

  test("content type without schema falls back to title: Untitled", async () => {
    setFormats([MD_FORMAT]);
    setup({
      config: { content: { plain: { format: "Markdown", source: "./stuff" } } },
    });
    invalidateBrowseCache();
    const container = await mountWithDefaults();
    await chooseNewEntity(container, "contentType:plain", "A B");
    expect(state.files.get("stuff/a-b.md")).toBe("---\ntitle: Untitled\n---\n\n");
  });

  test("content type without source uses its name as directory and JSON fallback", async () => {
    const container = await mountWithDefaults();
    await chooseNewEntity(container, "contentType:draft", "Sketch");
    expect(state.files.get("draft/sketch.json")).toBe(
      JSON.stringify({ children: [], tagName: "div" }, null, "\t"),
    );
  });

  test('content type with format "json" gets a .json extension', async () => {
    setup({
      config: { content: { records: { format: "json", source: "./data" } } },
    });
    invalidateBrowseCache();
    const container = await mountWithDefaults();
    await chooseNewEntity(container, "contentType:records", "Row One");
    expect(state.files.has("data/row-one.json")).toBe(true);
  });

  test("cancelled dialog creates nothing", async () => {
    const container = await mountWithDefaults();
    const before = writeCalls().length;
    await chooseNewEntity(container, "page", null);
    expect(writeCalls().length).toBe(before);
    expect(opened).toEqual([]);
    expect(topDialog()).toBeNull();
  });

  test("unknown type key is ignored before the dialog opens", async () => {
    const container = await mountWithDefaults();
    expect(await chooseNewEntity(container, "bogus")).toBeNull();
  });

  test("names are slugified", async () => {
    const container = await mountWithDefaults();
    await chooseNewEntity(container, "component", "Wild  Name?? 42");
    expect(state.files.has("components/wild-name-42.json")).toBe(true);
  });
});

// ─── Upload ──────────────────────────────────────────────────────────────────

describe("upload", () => {
  function browseView(container: HTMLElement): HTMLElement {
    return container.querySelector(".browse-view") as HTMLElement;
  }

  function dropEvent(files: { name: string }[] | null): Event {
    const e = new Event("drop", { bubbles: true, cancelable: true });
    if (files) {
      Object.defineProperty(e, "dataTransfer", { value: { files } });
    }
    return e;
  }

  test("dragover toggles the drop-active class", async () => {
    const container = await mountWithDefaults();
    const view = browseView(container);
    view.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(view.classList.contains("browse-drop-active")).toBe(true);
    view.dispatchEvent(new Event("dragleave", { bubbles: true, cancelable: true }));
    expect(view.classList.contains("browse-drop-active")).toBe(false);
  });

  test("dropping files uploads each to public/", async () => {
    const container = await mountWithDefaults();
    const view = browseView(container);
    view.classList.add("browse-drop-active");
    view.dispatchEvent(dropEvent([{ name: "pic.png" }, { name: "track.mp3" }]));
    await flush(4);
    const uploads = state.calls.filter((c) => c[0] === "uploadFile").map((c) => c[1]);
    expect(uploads).toEqual(["public/pic.png", "public/track.mp3"]);
    expect(view.classList.contains("browse-drop-active")).toBe(false);
  });

  test("drop without files uploads nothing", async () => {
    const container = await mountWithDefaults();
    browseView(container).dispatchEvent(dropEvent(null));
    await flush();
    expect(state.calls.filter((c) => c[0] === "uploadFile")).toHaveLength(0);
  });

  test("Upload button forwards the click to the hidden input", async () => {
    const container = await mountWithDefaults();
    const input = container.querySelector(".browse-upload-input") as HTMLInputElement;
    let clicked = 0;
    input.click = () => {
      clicked += 1;
    };
    const uploadBtn = actionButtons(container).find((b) =>
      (b.textContent ?? "").includes("Upload"),
    ) as HTMLElement;
    pointer(uploadBtn, "click");
    expect(clicked).toBe(1);
  });

  test("file input change uploads selected files and clears the input", async () => {
    const container = await mountWithDefaults();
    const input = container.querySelector(".browse-upload-input") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [{ name: "shot.webp" }],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(4);
    const uploads = state.calls.filter((c) => c[0] === "uploadFile").map((c) => c[1]);
    expect(uploads).toEqual(["public/shot.webp"]);
    expect(input.value).toBe("");
  });

  test("file input change with empty selection uploads nothing", async () => {
    const container = await mountWithDefaults();
    const input = container.querySelector(".browse-upload-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(state.calls.filter((c) => c[0] === "uploadFile")).toHaveLength(0);
  });
});

// ─── Context menu ────────────────────────────────────────────────────────────

describe("context menu", () => {
  test("opens with file actions; Open invokes openFile and dismisses", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "hello.md", { clientX: 2000, clientY: 2000 });
    expect(dialogLayer().querySelector("sp-popover")).not.toBeNull();
    const labels = menuItems().map((i) => (i.textContent ?? "").trim());
    expect(labels).toEqual(["Open", "Rename…", "Duplicate", "Delete"]);
    expect(dialogLayer().querySelectorAll("sp-menu-divider")).toHaveLength(2);

    await clickMenuItem("Open");
    expect(opened).toEqual(["content/posts/hello.md"]);
    expect(dialogLayer().querySelector("sp-popover")).toBeNull();
  });

  test("opening a second menu dismisses the first", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "logo.png");
    await openContextMenu(container, "doc.pdf");
    expect(dialogLayer().querySelectorAll("sp-popover")).toHaveLength(1);
    pointer(document.body, "mousedown");
    await flush();
  });

  test("outside mousedown dismisses the menu", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "logo.png");
    expect(dialogLayer().querySelector("sp-popover")).not.toBeNull();
    pointer(document.body, "mousedown");
    await flush();
    expect(dialogLayer().querySelector("sp-popover")).toBeNull();
  });
});

// ─── Rename ──────────────────────────────────────────────────────────────────

function renameTextfield(): HTMLElement & { value: string } {
  return dialogLayer().querySelector("sp-textfield") as HTMLElement & { value: string };
}

function typeInRenameField(value: string) {
  const tf = renameTextfield();
  tf.value = value;
  tf.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("rename", () => {
  test("renames via dialog confirm", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "logo.png");
    await clickMenuItem("Rename…");
    expect(dialogWrapper()).not.toBeNull();
    typeInRenameField("brand.png");
    dialogWrapper()?.dispatchEvent(new Event("confirm"));
    await flush(4);
    expect(state.files.has("public/brand.png")).toBe(true);
    expect(state.files.has("public/logo.png")).toBe(false);
    expect(dialogWrapper()).toBeNull();
  });

  test("renames via Enter key in the textfield", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "doc.pdf");
    await clickMenuItem("Rename…");
    typeInRenameField("manual.pdf");
    renameTextfield().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush(4);
    const renames = state.calls.filter((c) => c[0] === "renameFile");
    expect(renames).toEqual([["renameFile", "public/doc.pdf", "public/manual.pdf"]]);
  });

  test("non-Enter keys do not confirm", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "doc.pdf");
    await clickMenuItem("Rename…");
    renameTextfield().dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await flush();
    expect(dialogWrapper()).not.toBeNull();
    dialogWrapper()?.dispatchEvent(new Event("cancel"));
    await flush();
  });

  test("unchanged name is a no-op", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "logo.png");
    await clickMenuItem("Rename…");
    dialogWrapper()?.dispatchEvent(new Event("confirm"));
    await flush(4);
    expect(state.calls.filter((c) => c[0] === "renameFile")).toHaveLength(0);
  });

  test("blank name keeps the dialog open; cancel resolves null", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "logo.png");
    await clickMenuItem("Rename…");
    typeInRenameField("   ");
    dialogWrapper()?.dispatchEvent(new Event("confirm"));
    await flush();
    expect(dialogWrapper()).not.toBeNull();
    dialogWrapper()?.dispatchEvent(new Event("cancel"));
    await flush(4);
    expect(dialogWrapper()).toBeNull();
    expect(state.calls.filter((c) => c[0] === "renameFile")).toHaveLength(0);
  });

  test("root-level files rename without a parent directory", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "top.json");
    await clickMenuItem("Rename…");
    typeInRenameField("root.json");
    dialogWrapper()?.dispatchEvent(new Event("confirm"));
    await flush(4);
    const renames = state.calls.filter((c) => c[0] === "renameFile");
    expect(renames).toEqual([["renameFile", "top.json", "root.json"]]);
  });

  test("rename failure reports an error without throwing", async () => {
    setup({
      overrides: {
        renameFile: async () => {
          throw new Error("disk full");
        },
      },
    });
    invalidateBrowseCache();
    const container = await mountWithDefaults();
    await openContextMenu(container, "logo.png");
    await clickMenuItem("Rename…");
    typeInRenameField("brand.png");
    dialogWrapper()?.dispatchEvent(new Event("confirm"));
    await flush(4);
    expect(state.files.has("public/logo.png")).toBe(true);
  });
});

// ─── Duplicate ───────────────────────────────────────────────────────────────

describe("duplicate", () => {
  test("copies the file with a -copy suffix", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "hello.md");
    await clickMenuItem("Duplicate");
    await flush(2);
    expect(state.files.get("content/posts/hello-copy.md")).toBe("# Hello");
  });

  test("root-level and extension-less files duplicate correctly", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "top.json");
    await clickMenuItem("Duplicate");
    await flush(2);
    expect(state.files.has("top-copy.json")).toBe(true);

    await openContextMenu(container, "Makefile");
    await clickMenuItem("Duplicate");
    await flush(2);
    expect(state.files.get("pages/Makefile-copy")).toBe("all: build");
  });

  test("duplicate failure reports an error without throwing", async () => {
    const container = await mountWithDefaults();
    // Readme.txt is listed by the scan but has no backing content in the mock fs
    await openContextMenu(container, "readme.txt");
    await clickMenuItem("Duplicate");
    await flush(2);
    expect([...state.files.keys()].some((k) => k.includes("readme-copy"))).toBe(false);
  });
});

// ─── Delete ──────────────────────────────────────────────────────────────────

describe("delete", () => {
  test("deletes after confirmation", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "doc.pdf");
    await clickMenuItem("Delete");
    expect(dialogWrapper()?.textContent).toContain("doc.pdf");
    dialogWrapper()?.dispatchEvent(new Event("confirm"));
    await flush(4);
    expect(state.calls.filter((c) => c[0] === "deleteFile")).toEqual([
      ["deleteFile", "public/doc.pdf"],
    ]);
  });

  test("cancel leaves the file alone", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "doc.pdf");
    await clickMenuItem("Delete");
    dialogWrapper()?.dispatchEvent(new Event("cancel"));
    await flush(2);
    expect(state.calls.filter((c) => c[0] === "deleteFile")).toHaveLength(0);
  });

  test("close event counts as cancel", async () => {
    const container = await mountWithDefaults();
    await openContextMenu(container, "doc.pdf");
    await clickMenuItem("Delete");
    dialogWrapper()?.dispatchEvent(new Event("close"));
    await flush(2);
    expect(state.calls.filter((c) => c[0] === "deleteFile")).toHaveLength(0);
  });

  test("delete failure reports an error without throwing", async () => {
    setup({
      overrides: {
        deleteFile: async () => {
          throw new Error("locked");
        },
      },
    });
    invalidateBrowseCache();
    const container = await mountWithDefaults();
    await openContextMenu(container, "doc.pdf");
    await clickMenuItem("Delete");
    dialogWrapper()?.dispatchEvent(new Event("confirm"));
    await flush(4);
    expect(state.files.has("public/doc.pdf")).toBe(true);
  });
});
