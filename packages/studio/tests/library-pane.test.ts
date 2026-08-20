/**
 * Tests for src/browse/library-pane.ts — the Library editor kind.
 *
 * The two claims this file exists to hold to account:
 *
 * 1. **"No files found" is never printed for two different reasons.** A scan that could not read a
 *    directory raises a Problem carrying a Retry command and says the list is INCOMPLETE; a filter
 *    that matched nothing says which filter; a project with no files says that; and none of them is
 *    the sentence shown while the scan is still running.
 * 2. **An upload has a destination the author chose.** With a category that names one it is printed on
 *    the control before the drop; with "All" it is asked for, and cancelling asks nobody's
 *    permission to guess.
 */
import {
  answerPromptDialog,
  dragEvent,
  flush,
  installMockPlatform,
  pointer,
  resetStudioState,
  stubRect,
  surfaceOf,
  testFile,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { problems, resetNotifications } from "../src/services/notify";
import { activities, resetActivities } from "../src/panels/activity-panel";
import type { DirEntry } from "../src/types";

// ─── Seams ───────────────────────────────────────────────────────────────────

const created: unknown[] = [];
const opened: string[] = [];
const uploads: { dir: string | undefined; count: number }[] = [];
let deleteAnswer = true;

let createAnswer: string | null = "new-thing.json";

void mock.module("../src/files/files.js", () => ({
  createFileIn: (request: { dir: string }) => {
    created.push(request);
    return Promise.resolve(createAnswer === null ? null : `${request.dir}/${createAnswer}`);
  },
  loadDirectory: () => Promise.resolve(),
  openFileInTab: (path: string) => {
    opened.push(path);
    return Promise.resolve();
  },
}));
void mock.module("../src/files/media-upload.js", () => ({
  MEDIA_EXTENSIONS: new Set([".png", ".jpg", ".svg"]),
  UPLOAD_ACCEPT: "image/*",
  extensionOf: (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot).toLowerCase();
  },
  isImage: (ext: string) => ext === ".png",
  uploadAssets: (files: File[], opts: { dir?: string }) => {
    uploads.push({ count: files.length, dir: opts.dir });
    return Promise.resolve(files.map((f) => ({ path: `${opts.dir ?? "?"}/${f.name}` })));
  },
}));
void mock.module("../src/files/file-ops.js", () => ({
  confirmFileDelete: () => Promise.resolve(deleteAnswer),
  parseSourceForPath: () => Promise.resolve({ document: { children: [], tagName: "div" } }),
  renamePromptMessage: () => Promise.resolve("Used on 2 pages."),
}));
void mock.module("../src/services/references.js", () => ({
  invalidateUsages: () => {},
}));

const {
  createLibraryEntry,
  detachLibraryPane,
  invalidateLibrary,
  libraryNewEntries,
  libraryPaneMounted,
  librarySource,
  libraryView,
  refreshLibrary,
  renderLibraryMode,
  SCAN_ACTIVITY_DELAY_MS,
  resolveUploadDir,
  setLibraryCategory,
  setLibraryLayout,
  setLibraryLocale,
  setLibrarySearch,
} = await import("../src/browse/library-pane");
const { openTab, closeAllTabs } = await import("../src/workspace/workspace");

// ─── Environment ─────────────────────────────────────────────────────────────

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

/* No IntersectionObserver: happy-dom's never fires, so a lazily-mounted preview would simply never
   load and nothing here could assert on it. Its absence takes `createPreviewObserver`'s documented
   degraded path, where every card in the window asks for its preview at once. */
// @ts-expect-error -- removing the global is the point
globalThis.IntersectionObserver = undefined;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function file(name: string, path: string): DirEntry {
  return { name, path, type: "file" };
}

/**
 * The one content collection the fixture project declares.
 *
 * It carries a real `schema`, because the seeding this file asserts on is derived from it: `draft`
 * has a default, `title` is required with none, and `summary` is optional with neither — one of
 * each of `seedEntry`'s three cases.
 */
const POSTS = {
  format: "json",
  schema: {
    properties: {
      draft: { default: false, type: "boolean" },
      summary: { type: "string" },
      title: { type: "string" },
    },
    required: ["title"],
    type: "object",
  },
  source: "./content/",
};

const TREE: Record<string, DirEntry[]> = {
  content: [file("2024-01-02-hello.md", "content/2024-01-02-hello.md")],
  layouts: [file("main.json", "layouts/main.json")],
  pages: [file("index.json", "pages/index.json"), file("about.json", "pages/about.json")],
  public: [file("logo.png", "public/logo.png")],
};

let host: HTMLElement;

function setup(tree: Record<string, DirEntry[]> = TREE, dirs = Object.keys(TREE)) {
  installMockPlatform(
    {
      listDirectory: (path: string) => {
        const entries = tree[path];
        return entries ? Promise.resolve(entries) : Promise.reject(new Error(`HTTP 500: ${path}`));
      },
    },
    { "pages/index.json": '{"tagName":"div","children":[]}' },
  );
  resetStudioState({
    projectConfig: { content: { posts: POSTS } },
    projectDirs: dirs,
    projectRoot: "",
  });
}

async function mount(): Promise<HTMLElement> {
  // A live pane holds the tab id, so a second mount in the same test would be answered by the
  // Re-entrancy guard and leave the new host empty.
  detachLibraryPane("primary");
  host?.remove();
  closeAllTabs();
  const tab = openTab({
    capabilities: { modes: ["manage"] },
    document: { children: [], tagName: "div" },
    documentPath: null,
    id: "grid://library",
  });
  host = document.createElement("div");
  document.body.append(host);
  renderLibraryMode(surfaceOf(host), tab);
  await flush();
  await flush();
  return host;
}

function text(): string {
  return host.textContent ?? "";
}

beforeEach(() => {
  created.length = 0;
  opened.length = 0;
  uploads.length = 0;
  deleteAnswer = true;
  createAnswer = "new-thing.json";
  resetNotifications();
  resetActivities();
  detachLibraryPane("primary");
  invalidateLibrary();
  setLibraryCategory("all");
  setLibraryLayout("cards");
  setLibraryLocale("");
  setLibrarySearch("");
  setup();
});

afterEach(() => {
  detachLibraryPane("primary");
  host?.remove();
});

// ─── Mounting ────────────────────────────────────────────────────────────────

describe("mounting", () => {
  test("draws the Library and reports itself mounted for that tab", async () => {
    await mount();
    expect(host.querySelector('[data-jx-region="pane.primary/library"]')).not.toBeNull();
    expect(host.querySelector('[data-jx-region="pane.primary/library/dropZone"]')).not.toBeNull();
    const tab = openTab({
      capabilities: { modes: ["manage"] },
      document: { children: [], tagName: "div" },
      documentPath: null,
      id: "grid://library",
    });
    expect(libraryPaneMounted("primary", tab)).toBe(true);
  });

  test("a second mount for the same tab is a no-op — the pane owns its own reactivity", async () => {
    const tab = openTab({
      capabilities: { modes: ["manage"] },
      document: { children: [], tagName: "div" },
      documentPath: null,
      id: "grid://library",
    });
    host = document.createElement("div");
    document.body.append(host);
    renderLibraryMode(surfaceOf(host), tab);
    await flush();
    const first = host.querySelector(".library");
    renderLibraryMode(surfaceOf(host), tab);
    await flush();
    expect(host.querySelector(".library")).toBe(first!);
  });

  test("detaching is idempotent", async () => {
    await mount();
    detachLibraryPane("primary");
    detachLibraryPane("primary");
    const tab = openTab({
      capabilities: { modes: ["manage"] },
      document: { children: [], tagName: "div" },
      documentPath: null,
      id: "grid://library",
    });
    expect(libraryPaneMounted("primary", tab)).toBe(false);
  });

  test("a repaint while previews are still loading does not ask for them twice", async () => {
    const reads: string[] = [];
    installMockPlatform({
      listDirectory: (path: string) => Promise.resolve(TREE[path] ?? []),
      readFile: (path: string) => {
        reads.push(path);
        return Promise.resolve('{"tagName":"div","children":[]}');
      },
    });
    resetStudioState({ projectConfig: null, projectDirs: Object.keys(TREE) });
    await mount();
    const first = reads.length;
    expect(first).toBeGreaterThan(0);
    // Repaint immediately: lit hands a fresh `ref` closure per render, so the slot re-registers
    // While its read is still in flight.
    setLibrarySearch("");
    setLibraryCategory("all");
    await flush();
    expect(reads.length).toBe(first);
  });

  test("a document that cannot be rendered leaves its card without a preview, not broken", async () => {
    installMockPlatform({
      listDirectory: (path: string) => Promise.resolve(TREE[path] ?? []),
      readFile: () => Promise.reject(new Error("EIO")),
    });
    resetStudioState({ projectConfig: null, projectDirs: Object.keys(TREE) });
    await mount();
    await flush();
    expect(host.querySelectorAll(".library-card").length).toBe(5);
    expect(host.querySelector(".library-preview-slot")?.firstElementChild ?? null).toBeNull();
  });

  test("scans once and lists the project's files", async () => {
    await mount();
    expect(librarySource().files().length).toBe(5);
    expect(host.querySelectorAll(".library-card").length).toBe(5);
  });
});

// ─── Honest states ───────────────────────────────────────────────────────────

describe("the four states the old view called “No files found”", () => {
  test("a project with no files says exactly that", async () => {
    setup({ pages: [] }, ["pages"]);
    await mount();
    expect(text()).toContain("This project has no files yet");
  });

  test("a filter that matched nothing names the filter, and offers to clear it", async () => {
    await mount();
    setLibrarySearch("zzz");
    await flush();
    expect(text()).toContain("No files match");
    expect(text()).toContain("zzz");
    expect(text()).toContain("5 file(s) in the project");
    const clear = [...host.querySelectorAll("sp-button")].find((b) =>
      (b.textContent ?? "").includes("Clear filters"),
    ) as HTMLElement;
    clear.click();
    await flush();
    expect(libraryView.query).toBe("");
    expect(libraryView.category).toBe("all");
  });

  test("a category with no matches names the category too", async () => {
    setup({ pages: [file("a.json", "pages/a.json")] }, ["pages"]);
    await mount();
    setLibraryCategory("media");
    await flush();
    expect(text()).toContain("in Media");
  });

  test("a scan that could not read a directory says INCOMPLETE, not empty", async () => {
    setup(TREE, [...Object.keys(TREE), "broken"]);
    await mount();
    expect(text()).toContain("This list is incomplete");
    expect(text()).toContain("broken");
  });

  test("the banner's Retry re-scans without the reader leaving the pane", async () => {
    let attempt = 0;
    installMockPlatform({
      listDirectory: (path: string) => {
        attempt += 1;
        return attempt <= 4
          ? Promise.reject(new Error("HTTP 500"))
          : Promise.resolve(TREE[path] ?? []);
      },
    });
    resetStudioState({ projectConfig: null, projectDirs: Object.keys(TREE) });
    await mount();
    // Everything failed, so this is the empty state's Retry.
    const emptyRetry = [...host.querySelectorAll("sp-button")].find((b) =>
      (b.textContent ?? "").includes("Retry"),
    ) as HTMLElement;
    emptyRetry.click();
    await flush();
    await flush();
    expect(host.querySelectorAll(".library-card").length).toBe(5);
  });

  test("a partly-failed scan offers Retry in the banner above the list it did get", async () => {
    let broken = true;
    installMockPlatform({
      listDirectory: (path: string) => {
        if (path === "broken") {
          return broken ? Promise.reject(new Error("HTTP 500")) : Promise.resolve([]);
        }
        return Promise.resolve(TREE[path] ?? []);
      },
    });
    resetStudioState({ projectConfig: null, projectDirs: [...Object.keys(TREE), "broken"] });
    await mount();
    const banner = host.querySelector(".library-banner")!;
    broken = false;
    (banner.querySelector("sp-button") as HTMLElement).click();
    await flush();
    await flush();
    expect(host.querySelector(".library-banner")).toBeNull();
  });

  test("and raises a Problem carrying the retry command and the directory", async () => {
    setup(TREE, [...Object.keys(TREE), "broken"]);
    await mount();
    const problem = problems.at(-1)!;
    expect(problem.severity).toBe("error");
    expect(problem.action).toBe("library.refresh");
    expect(problem.path).toBe("broken");
    expect(problem.detail).toContain("HTTP 500");
    expect(problem.source).toBe("Library");
  });

  test("a scan that failed entirely does not claim the project is empty", async () => {
    setup({}, ["pages", "public"]);
    await mount();
    expect(text()).toContain("the scan did not finish");
    expect(text()).not.toContain("no files yet");
  });

  test("the failure banner's Retry re-scans", async () => {
    let attempt = 0;
    installMockPlatform({
      listDirectory: (path: string) => {
        attempt += 1;
        if (attempt === 1) {
          return Promise.reject(new Error("HTTP 500"));
        }
        return Promise.resolve(TREE[path] ?? []);
      },
    });
    resetStudioState({ projectConfig: null, projectDirs: ["pages"] });
    await mount();
    expect(text()).toContain("did not finish");
    await refreshLibrary();
    await flush();
    expect(host.querySelectorAll(".library-card").length).toBe(2);
  });
});

// ─── The language facet ──────────────────────────────────────────────────────

describe("the language facet", () => {
  const I18N_TREE: Record<string, DirEntry[]> = {
    layouts: [file("main.json", "layouts/main.json")],
    pages: [
      { name: "fr", path: "pages/fr", type: "directory" },
      { name: "de", path: "pages/de", type: "directory" },
      file("index.json", "pages/index.json"),
    ],
    "pages/de": [file("index.json", "pages/de/index.json")],
    "pages/fr": [file("about.json", "pages/fr/about.json")],
  };

  /**
   * A project that declares three locales and has files under two directories — plus
   * `pages/index.json`, which under `prefix-except-default` is the DEFAULT locale's copy and is why
   * `en` is an option the picker can offer.
   */
  function setupI18n(locales: string[] = ["en", "fr", "de"]) {
    installMockPlatform({
      listDirectory: (path: string) => {
        const entries = I18N_TREE[path];
        return entries ? Promise.resolve(entries) : Promise.reject(new Error(`HTTP 500: ${path}`));
      },
    });
    resetStudioState({
      projectConfig: { i18n: { defaultLocale: "en", locales } },
      projectDirs: ["pages", "layouts"],
      projectRoot: "",
    });
  }

  function picker(): (HTMLElement & { value: string }) | null {
    return host.querySelector(".library-locale-filter");
  }

  test("draws a picker of the locales PRESENT, labelled in each language's own words", async () => {
    setupI18n();
    await mount();
    const options = [...picker()!.querySelectorAll("sp-menu-item")].map((el) => [
      el.getAttribute("value"),
      el.textContent?.trim(),
    ]);
    /*
     * `en` has no directory of its own and is still an option, because under
     * `prefix-except-default` the unprefixed `pages/index.json` IS its copy — and a language filter
     * that could offer French and German but never English cannot answer the question it is most
     * often asked. Declaration order, so the default comes first.
     */
    expect(options).toEqual([
      ["all", "All languages"],
      ["en", "English"],
      ["fr", "français"],
      ["de", "Deutsch"],
    ]);
  });

  test("draws no picker at all where there is nothing to choose between", async () => {
    /*
     * One language present. `fr` and `de` are not declared, so those directories are ordinary path
     * segments and everything under `pages/` is served as the only language there is — which is
     * exactly what the build does with them, and a filter with one option is not a filter.
     */
    setupI18n(["en"]);
    await mount();
    expect(picker()).toBeNull();
    setup();
    await mount();
    expect(picker()).toBeNull();
  });

  test("its options come from every scanned file, not from the filtered ones", async () => {
    setupI18n();
    await mount();
    setLibraryLocale("fr");
    await flush();
    // A picker whose choices collapsed to the choice just made could not be used to make another.
    expect([...picker()!.querySelectorAll("sp-menu-item")]).toHaveLength(4);
  });

  test("choosing a language filters to it, and All puts every file back", async () => {
    setupI18n();
    await mount();
    const control = picker()!;
    control.value = "fr";
    control.dispatchEvent(new Event("change"));
    await flush();
    expect(text()).toContain("about.json");
    expect(text()).not.toContain("main.json");
    control.value = "all";
    control.dispatchEvent(new Event("change"));
    await flush();
    expect(libraryView.locale).toBe("");
    expect(text()).toContain("main.json");
  });

  test("the locale is in the render effect's dependency list, not merely in the setter's bump", async () => {
    setupI18n();
    await mount();
    // Written DIRECTLY, so `bump()` never touches `revision`: the repaint below can only come from
    // The effect having read `libraryView.locale`. A field missing from that hand-written list is a
    // Filter the pane applies on the paint that happens to follow it and never again.
    libraryView.locale = "de";
    await flush();
    expect(text()).not.toContain("about.json");
    expect(text()).toContain("index.json");
  });

  test("a filter that matched nothing names the LANGUAGE too, and Clear filters clears it", async () => {
    setupI18n();
    await mount();
    setLibraryCategory("layouts");
    setLibraryLocale("fr");
    await flush();
    expect(text()).toContain("in Layouts and français");
    const clear = [...host.querySelectorAll("sp-button")].find((b) =>
      (b.textContent ?? "").includes("Clear filters"),
    ) as HTMLElement;
    clear.click();
    await flush();
    expect(libraryView.locale).toBe("");
    expect(libraryView.category).toBe("all");
  });
});

// ─── Layouts ─────────────────────────────────────────────────────────────────

describe("layouts", () => {
  test("switching layout repaints from the SAME scan — no second read", async () => {
    let reads = 0;
    installMockPlatform({
      listDirectory: (path: string) => {
        reads += 1;
        return Promise.resolve(TREE[path] ?? []);
      },
    });
    resetStudioState({ projectConfig: null, projectDirs: Object.keys(TREE) });
    await mount();
    const after = reads;
    for (const layout of ["table", "media", "calendar", "board"] as const) {
      setLibraryLayout(layout);
      await flush();
    }
    expect(reads).toBe(after);
    expect(host.querySelector(".library-board")).not.toBeNull();
  });

  test("each layout draws its own structure", async () => {
    await mount();
    setLibraryLayout("table");
    await flush();
    expect(host.querySelector(".library-table-head")).not.toBeNull();
    setLibraryLayout("calendar");
    await flush();
    expect(host.querySelector(".library-calendar")).not.toBeNull();
    setLibraryLayout("media");
    await flush();
    expect(host.querySelector(".library-grid-media")).not.toBeNull();
  });

  test("the category buttons run the same state change the command does", async () => {
    await mount();
    const pages = [...host.querySelectorAll("sp-action-button")].find(
      (b) => (b.textContent ?? "").trim() === "Pages",
    ) as HTMLElement;
    pages.click();
    await flush();
    expect(libraryView.category).toBe("pages");
    expect(host.querySelectorAll(".library-card").length).toBe(2);
  });

  test("the layout switcher runs the same state change the command does", async () => {
    await mount();
    const board = [...host.querySelectorAll(".library-layout-switch sp-action-button")].find(
      (b) => (b.textContent ?? "").trim() === "Board",
    ) as HTMLElement;
    board.click();
    await flush();
    expect(libraryView.layout).toBe("board");
    expect(host.querySelector(".library-board")).not.toBeNull();
  });

  test("the New menu creates through the same flow the command uses", async () => {
    await mount();
    const menu = host.querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "layout";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(created).toEqual([
      { dir: "layouts", source: "Library", suggestedName: "untitled", title: "New Layout" },
    ]);
  });

  test("submitting the search field does not reload the page", async () => {
    await mount();
    const search = host.querySelector("sp-search")!;
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    search.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  test("scrolling the body repaints — the window is recomputed, not the scan", async () => {
    await mount();
    const body = host.querySelector(".library-body") as HTMLElement;
    const before = libraryView.revision;
    body.dispatchEvent(new Event("scroll"));
    expect(libraryView.revision).toBeGreaterThan(before);
  });

  test("the search field filters", async () => {
    await mount();
    const search = host.querySelector("sp-search") as HTMLElement & { value: string };
    search.value = "logo";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(host.querySelectorAll(".library-card").length).toBe(1);
  });
});

// ─── Uploads ─────────────────────────────────────────────────────────────────

describe("the upload destination", () => {
  test("a category that names a folder uploads there, and says so before the drop", async () => {
    setLibraryCategory("media");
    await mount();
    const upload = [...host.querySelectorAll("sp-action-button")].find((b) =>
      (b.textContent ?? "").includes("Upload"),
    )!;
    expect(upload.getAttribute("title")).toBe("Upload into public/");
    expect(await resolveUploadDir()).toBe("public");
  });

  test("All has no folder of its own, so it ASKS rather than guessing", async () => {
    setLibraryCategory("all");
    await mount();
    const upload = [...host.querySelectorAll("sp-action-button")].find((b) =>
      (b.textContent ?? "").includes("Upload"),
    )!;
    expect(upload.getAttribute("title")).toBe("Upload — asks for a folder");
    const pending = resolveUploadDir();
    await flush();
    await answerPromptDialog("assets/media/");
    expect(await pending).toBe("assets/media");
  });

  test("cancelling the destination prompt uploads nothing at all", async () => {
    setLibraryCategory("all");
    await mount();
    const pending = resolveUploadDir();
    await flush();
    await answerPromptDialog(null);
    expect(await pending).toBeNull();
    expect(uploads).toEqual([]);
  });

  test("a drop on the body uploads into the named destination and re-scans", async () => {
    setLibraryCategory("media");
    await mount();
    const body = host.querySelector(".library-body") as HTMLElement;
    dragEvent(body, "dragover");
    expect(body.classList.contains("library-drop-active")).toBe(true);
    dragEvent(body, "drop", [testFile("shot.png")]);
    await flush();
    expect(body.classList.contains("library-drop-active")).toBe(false);
    expect(uploads).toEqual([{ count: 1, dir: "public" }]);
  });

  test("dragging away clears the drop affordance", async () => {
    await mount();
    const body = host.querySelector(".library-body") as HTMLElement;
    dragEvent(body, "dragover");
    dragEvent(body, "dragleave");
    expect(body.classList.contains("library-drop-active")).toBe(false);
  });

  test("a drop carrying no files does nothing", async () => {
    await mount();
    const body = host.querySelector(".library-body") as HTMLElement;
    dragEvent(body, "drop");
    await flush();
    expect(uploads).toEqual([]);
  });
});

// ─── The upload control ──────────────────────────────────────────────────────

describe("the Upload control", () => {
  test("clicks the hidden picker, and a chosen file uploads to the named folder", async () => {
    setLibraryCategory("media");
    await mount();
    const input = host.querySelector(".library-upload-input") as HTMLInputElement;
    let clicked = 0;
    input.click = () => {
      clicked += 1;
    };
    const upload = [...host.querySelectorAll("sp-action-button")].find((b) =>
      (b.textContent ?? "").includes("Upload"),
    ) as HTMLElement;
    upload.click();
    expect(clicked).toBe(1);

    Object.defineProperty(input, "files", { configurable: true, value: [testFile("a.png")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(uploads).toEqual([{ count: 1, dir: "public" }]);
  });

  test("a picker dismissed with no file uploads nothing", async () => {
    await mount();
    const input = host.querySelector(".library-upload-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(uploads).toEqual([]);
  });
});

// ─── Creation ────────────────────────────────────────────────────────────────

describe("creation", () => {
  test("offers the three document kinds plus every creatable collection, each with its folder", async () => {
    await mount();
    expect(libraryNewEntries()).toEqual([
      { dir: "pages", key: "page", label: "Page" },
      { dir: "layouts", key: "layout", label: "Layout" },
      { dir: "components", key: "component", label: "Component" },
      { collection: "posts", dir: "content", key: "collection:posts", label: "Posts" },
    ]);
  });

  test("offers no row for a collection an entry cannot be created in", async () => {
    // A collection with no `source` has no entry directory, and one whose source names a FILE has
    // Rows rather than entry files. The predecessor offered both — deriving `drafts/` from the type
    // Name, and composing `content/catalog.csv/untitled` for the catalogue — and each created a
    // File the collection would never load.
    resetStudioState({
      projectConfig: {
        content: {
          catalogue: { source: "./content/catalog.csv" },
          drafts: {},
          posts: { source: "./content/" },
        },
      },
      projectDirs: ["pages"],
    });
    expect(libraryNewEntries().filter((row) => row.collection !== undefined)).toEqual([
      { collection: "posts", dir: "content", key: "collection:posts", label: "Posts" },
    ]);
  });

  test("a document kind goes through the SHARED flow and opens the result", async () => {
    await mount();
    const path = await createLibraryEntry("page");
    // No `ext`: the field takes the typed name verbatim, because a page may be a `.md` as easily
    // As a `.json` and that is the author's choice to make. Contrast the collection row below.
    expect(created).toEqual([
      { dir: "pages", source: "Library", suggestedName: "untitled", title: "New Page" },
    ]);
    expect(path).toBe("pages/new-thing.json");
    expect(opened).toEqual(["pages/new-thing.json"]);
  });

  test("a collection row is content/'s createEntry — the collection's extension and a SEEDED body", async () => {
    await mount();
    const path = await createLibraryEntry("collection:posts");
    expect(created).toHaveLength(1);
    const request = created[0] as Record<string, unknown>;
    expect(request.dir).toBe("content");
    expect(request.ext).toBe(".json");
    // "Content", not "Library": the creation really is the content module's, and a Problem from it
    // Has to name the surface that can explain it.
    expect(request.source).toBe("Content");
    // The whole point. `default`s land, a required field with no default gets its type's empty
    // Value, and an optional one with neither is omitted — so the entry is valid the moment it
    // Exists instead of arriving as an empty file.
    expect(JSON.parse(request.content as string)).toEqual({ draft: false, title: "" });
    expect(path).toBe("content/new-thing.json");
    // Opened exactly once, by the entry editor. Opening it again here would swap the form for the
    // Generic editor on the same tab.
    expect(opened).toEqual(["content/new-thing.json"]);
  });

  test("an unknown kind creates nothing", async () => {
    await mount();
    expect(await createLibraryEntry("widget")).toBeNull();
    expect(created).toEqual([]);
  });

  test("a cancelled creation opens nothing", async () => {
    createAnswer = null;
    await mount();
    expect(await createLibraryEntry("page")).toBeNull();
    expect(opened).toEqual([]);
  });

  test("a cancelled collection entry opens nothing either", async () => {
    createAnswer = null;
    await mount();
    expect(await createLibraryEntry("collection:posts")).toBeNull();
    expect(opened).toEqual([]);
  });
});

// ─── The scan, as an operation ───────────────────────────────────────────────

describe("a slow scan", () => {
  test("earns an Activity row rather than a silent wait, and closes it when it lands", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installMockPlatform({
      listDirectory: async (path: string) => {
        await gate;
        return TREE[path] ?? [];
      },
    });
    resetStudioState({ projectConfig: null, projectDirs: ["pages"] });

    // The row appears on a timer, so the clock is what is faked — not the platform.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms === SCAN_ACTIVITY_DELAY_MS ? 0 : ms)) as typeof setTimeout;
    try {
      await mount();
      await flush();
      const row = activities.at(-1)!;
      expect(row.title).toBe("Scan project files");
      expect(row.state).toBe("running");
      // No Cancel: `listDirectory` cannot be aborted, and a button that cannot do what it says is
      // Exactly the failure the Activity contract exists to end.
      expect(row.cancellable).toBe(false);
      release!();
      await flush();
      await flush();
      expect(activities.at(-1)!.state).toBe("done");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("a slow scan that then fails FAILS its row rather than leaving it running", async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms === SCAN_ACTIVITY_DELAY_MS ? 0 : ms)) as typeof setTimeout;
    // A scan that is slow AND then fails: the row is up before the failure arrives, so the failure
    // Has to land ON it rather than beside it.
    resetStudioState({
      projectConfig: null,
      projectDirs: {
        map: () => [
          new Promise((_resolve, reject) => {
            realSetTimeout(() => reject(new Error("the dev server went away")), 5);
          }),
        ],
      },
    });
    try {
      await mount();
      await flush();
      await flush();
      expect(activities.at(-1)!.state).toBe("failed");
      // The row failed, so the caller does NOT also notify: `fail()` raises the Problem itself.
      expect(problems.at(-1)!.message).toContain("Could not scan");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("a scan that blows up in a way the scanner did not model is still a Problem", async () => {
    // `scanLibrary` never rejects, so the pane's outer catch only fires when the scan itself is
    // Unrunnable — a corrupt project record here, a dead platform in the field. It must not take
    // The pane down with it.
    resetStudioState({ projectConfig: null, projectDirs: 7 });
    await mount();
    const problem = problems.at(-1)!;
    expect(problem.message).toBe("Could not scan the project's files.");
    expect(problem.action).toBe("library.refresh");
    expect(problem.tier).toBe("problem");
  });
});

// ─── Context menu ────────────────────────────────────────────────────────────

describe("the per-file context menu", () => {
  async function openMenu(): Promise<HTMLElement> {
    await mount();
    const card = host.querySelector(".library-card") as HTMLElement;
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    return document.querySelector("#layer-dialog") as HTMLElement;
  }

  function item(layer: HTMLElement, label: string): HTMLElement {
    const found = [...layer.querySelectorAll("sp-menu-item")].find(
      (n) => (n.textContent ?? "").trim() === label,
    );
    if (!found) {
      throw new Error(`no menu item: ${label}`);
    }
    return found as HTMLElement;
  }

  test("opens the file", async () => {
    const layer = await openMenu();
    item(layer, "Open").click();
    await flush();
    expect(opened.length).toBe(1);
  });

  test("renames through the shared dialog, which states what moves with the file", async () => {
    const layer = await openMenu();
    item(layer, "Rename…").click();
    await flush();
    const dialog = document.querySelector("#layer-dialog")!;
    expect(dialog.textContent).toContain("Used on 2 pages.");
    await answerPromptDialog("renamed.json");
    await flush();
    expect(librarySource().files().length).toBeGreaterThan(0);
  });

  test("a cancelled rename changes nothing", async () => {
    const layer = await openMenu();
    item(layer, "Rename…").click();
    await flush();
    await answerPromptDialog(null);
    await flush();
    expect(problems.length).toBe(0);
  });

  test("duplicates beside the original, with a -copy suffix", async () => {
    const written: string[] = [];
    installMockPlatform({
      listDirectory: (path: string) => Promise.resolve(TREE[path] ?? []),
      readFile: () => Promise.resolve("# Hello"),
      writeFile: (path: string) => {
        written.push(path);
        return Promise.resolve();
      },
    });
    resetStudioState({ projectConfig: null, projectDirs: Object.keys(TREE) });
    const layer = await openMenu();
    item(layer, "Duplicate").click();
    await flush();
    await flush();
    expect(written).toEqual(["content/2024-01-02-hello-copy.md"]);
    expect(problems.length).toBe(0);
  });

  test("a refused delete deletes nothing", async () => {
    deleteAnswer = false;
    const layer = await openMenu();
    item(layer, "Delete").click();
    await flush();
    expect(librarySource().files().length).toBe(5);
  });

  test("a confirmed delete removes the file and re-scans", async () => {
    const removed: string[] = [];
    installMockPlatform({
      deleteFile: (path: string) => {
        removed.push(path);
        return Promise.resolve();
      },
      listDirectory: (path: string) =>
        Promise.resolve((TREE[path] ?? []).filter((entry) => !removed.includes(entry.path))),
    });
    resetStudioState({ projectConfig: null, projectDirs: Object.keys(TREE) });
    const layer = await openMenu();
    item(layer, "Delete").click();
    await flush();
    await flush();
    expect(removed.length).toBe(1);
    expect(librarySource().files().length).toBe(4);
  });

  test("a failing delete is reported against the path, not swallowed", async () => {
    installMockPlatform({
      deleteFile: () => Promise.reject(new Error("EACCES")),
      listDirectory: (path: string) => Promise.resolve(TREE[path] ?? []),
    });
    resetStudioState({ projectConfig: null, projectDirs: Object.keys(TREE) });
    const layer = await openMenu();
    item(layer, "Delete").click();
    await flush();
    await flush();
    const problem = problems.at(-1)!;
    expect(problem.message).toContain("Could not delete");
    expect(problem.source).toBe("Library");
  });

  test("a menu opened at the far edge of the window is pulled back inside it", async () => {
    await mount();
    const card = host.querySelector(".library-card") as HTMLElement;
    card.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: window.innerWidth - 2,
        clientY: window.innerHeight - 2,
      }),
    );
    const popover = document.querySelector("#layer-dialog sp-popover") as HTMLElement;
    stubRect(popover, { height: 200, width: 240 });
    await flush();
    expect(popover.style.left).toBe(`${window.innerWidth - 244}px`);
    expect(popover.style.top).toBe(`${window.innerHeight - 204}px`);
  });

  test("dismissing by clicking away releases the handle, so the next right-click reopens", async () => {
    await mount();
    const card = host.querySelector(".library-card") as HTMLElement;
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelectorAll("#layer-dialog sp-popover").length).toBe(1);
    pointer(document.body, "pointerdown");
    pointer(document.body, "click");
    await flush();
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelectorAll("#layer-dialog sp-popover").length).toBe(1);
  });

  test("a failing rename and a failing duplicate report the same way", async () => {
    installMockPlatform({
      listDirectory: (path: string) => Promise.resolve(TREE[path] ?? []),
      readFile: () => Promise.reject(new Error("EIO")),
      renameFile: () => Promise.reject(new Error("EPERM")),
    });
    resetStudioState({ projectConfig: null, projectDirs: Object.keys(TREE) });
    let layer = await openMenu();
    item(layer, "Rename…").click();
    await flush();
    await answerPromptDialog("other.json");
    await flush();
    expect(problems.at(-1)!.message).toContain("Could not rename");

    layer = await openMenu();
    item(layer, "Duplicate").click();
    await flush();
    await flush();
    expect(problems.at(-1)!.message).toContain("Could not duplicate");
  });
});
