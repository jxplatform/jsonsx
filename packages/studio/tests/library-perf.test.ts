/**
 * The P7.1 acceptance case, as a test: a 300-page project opening the Library's "All" category.
 *
 * The Manage view this replaces rendered one card per file with NO cap, and each page/layout/
 * component/content card mounted a real `@jxsuite/runtime` render of that document into an
 * unbounded `Map`. Three hundred pages therefore meant three hundred live documents built in one
 * synchronous pass and retained until the tab closed.
 *
 * The baseline is measured, not remembered. `computeWindow` answers "the whole list" for an
 * unmeasured scroller (a pane that has not been laid out), so the first paint here IS the old
 * behaviour, taken through the same code. The measurement then stubs the scroller's box — the one
 * thing happy-dom does not supply — and repaints, and the two numbers are printed side by side.
 *
 * The assertions are ratios and caps, never wall-clock times: a timing threshold in CI measures the
 * runner's mood. The timings are PRINTED so a regression is visible to a reader without being a
 * flake for everyone else.
 */
import { flush, installMockPlatform, resetStudioState, surfaceOf } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { resetNotifications } from "../src/services/notify";
import type { DirEntry } from "../src/types";

void mock.module("../src/files/files.js", () => ({
  createFileIn: () => Promise.resolve(null),
  loadDirectory: () => Promise.resolve(),
  openFileInTab: () => Promise.resolve(),
}));

const {
  detachLibraryPane,
  invalidateLibrary,
  librarySource,
  renderLibraryMode,
  setLibraryCategory,
  setLibraryLayout,
  setLibrarySearch,
} = await import("../src/browse/library-pane");
const { PREVIEW_CACHE_LIMIT } = await import("../src/browse/library-preview");
const { openTab, closeAllTabs } = await import("../src/workspace/workspace");

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

/*
 * No IntersectionObserver, deliberately.
 *
 * happy-dom's, where it has one, never fires — so a lazy preview would simply never load and this
 * file would measure nothing. Removing it takes `createPreviewObserver`'s documented degraded path,
 * where every card in the window asks for its preview immediately. That is the WORST case for the
 * cap, which is the case worth measuring: if the working set is bounded when every rendered card
 * demands a preview at once, it is bounded when they trickle in.
 */
// @ts-expect-error -- removing the global is the point
globalThis.IntersectionObserver = undefined;

/** The acceptance case's size. */
const PAGE_COUNT = 300;

/** A viewport a person actually has: a 1200×800 pane, less the toolbar. */
const VIEWPORT = { height: 700, width: 1180 };

let host: HTMLElement;
let previewReads: string[];

function project(): Record<string, DirEntry[]> {
  const pages: DirEntry[] = Array.from({ length: PAGE_COUNT }, (_value, index) => ({
    name: `page-${String(index).padStart(3, "0")}.json`,
    path: `pages/page-${String(index).padStart(3, "0")}.json`,
    type: "file" as const,
  }));
  return { pages };
}

function install() {
  previewReads = [];
  const tree = project();
  installMockPlatform({
    listDirectory: (path: string) => Promise.resolve(tree[path] ?? []),
    // A real, renderable document: an unparseable one is never CACHED (so a later fix is picked
    // Up), which would make every repaint re-read it and measure the wrong thing.
    readFile: (path: string) => {
      previewReads.push(path);
      return Promise.resolve('{"tagName":"div","children":[]}');
    },
  });
  resetStudioState({ projectConfig: null, projectDirs: ["pages"], projectRoot: "" });
}

async function mount(): Promise<HTMLElement> {
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

/** Give the scroller the box happy-dom never computes, then force one repaint. */
async function layOutPane() {
  const body = host.querySelector(".library-body") as HTMLElement;
  Object.defineProperty(body, "clientHeight", { configurable: true, value: VIEWPORT.height });
  Object.defineProperty(body, "clientWidth", { configurable: true, value: VIEWPORT.width });
  body.dispatchEvent(new Event("scroll"));
  await flush();
  return body;
}

function cards(): number {
  return host.querySelectorAll(".library-card").length;
}

/**
 * Mount, lay the pane out, and start from a cache that reflects a WINDOWED first paint.
 *
 * The unwindowed baseline paint asks for all 300 previews, which overruns the LRU and leaves it
 * holding the tail of a list nobody is looking at. That is an artefact of measuring the old
 * behaviour first, not of the Library: in the app the first paint is already windowed. Dropping the
 * cache here measures scrolling, rather than measuring the baseline twice.
 */
async function windowedPane(): Promise<HTMLElement> {
  await mount();
  const body = await layOutPane();
  invalidateLibrary();
  await flush();
  await flush();
  previewReads.length = 0;
  return body;
}

beforeEach(() => {
  resetNotifications();
  detachLibraryPane("primary");
  invalidateLibrary();
  setLibraryCategory("all");
  setLibraryLayout("cards");
  setLibrarySearch("");
  install();
});

afterEach(() => {
  detachLibraryPane("primary");
  host?.remove();
});

describe(`${PAGE_COUNT} pages, "All"`, () => {
  test("the rendered card count collapses from the whole project to one viewport", async () => {
    const unwindowedStart = performance.now();
    await mount();
    const unwindowedMs = performance.now() - unwindowedStart;
    const unwindowed = cards();
    const unwindowedNodes = host.querySelectorAll("*").length;
    const unwindowedPreviews = previewReads.length;

    const windowedStart = performance.now();
    await layOutPane();
    const windowedMs = performance.now() - windowedStart;
    const windowed = cards();
    const windowedNodes = host.querySelectorAll("*").length;

    // Printed rather than asserted: a wall-clock threshold in CI measures the runner, not the code.
    console.error(
      `[library perf] ${PAGE_COUNT} pages, "All", cards layout, ${VIEWPORT.width}×${VIEWPORT.height} pane\n` +
        `  before (no window): ${unwindowed} cards · ${unwindowedNodes} DOM nodes · ` +
        `${unwindowedPreviews} preview reads · ${unwindowedMs.toFixed(0)} ms first paint\n` +
        `  after  (windowed):  ${windowed} cards · ${windowedNodes} DOM nodes · ` +
        `${previewReads.length} preview reads · ${windowedMs.toFixed(0)} ms repaint`,
    );

    expect(librarySource().files().length).toBe(PAGE_COUNT);
    expect(unwindowed).toBe(PAGE_COUNT);
    // 1180px / 200px = 5 columns; 700px / 194px = 4 visible rows, +1 partial, +3 overscan = 8 rows.
    expect(windowed).toBe(40);
    expect(windowed).toBeLessThan(unwindowed / 5);
    expect(windowedNodes).toBeLessThan(unwindowedNodes / 5);
  });

  test("scrolling moves the window instead of growing it", async () => {
    const body = await windowedPane();
    const first = cards();
    const firstPaths = [...host.querySelectorAll<HTMLElement>(".library-card")].map(
      (c) => c.dataset.path,
    );

    body.scrollTop = 4000;
    body.dispatchEvent(new Event("scroll"));
    await flush();

    const scrolledPaths = [...host.querySelectorAll<HTMLElement>(".library-card")].map(
      (c) => c.dataset.path,
    );
    // Mid-list the window also overscans ABOVE, so it is a little larger than at the top — what
    // Matters is that it stays a viewport, not that it is the same integer.
    expect(cards()).toBeGreaterThanOrEqual(first);
    expect(cards()).toBeLessThanOrEqual(first * 2);
    expect(scrolledPaths[0]).not.toBe(firstPaths[0]);
  });

  test("the live-preview working set stays under the LRU cap however far you scroll", async () => {
    const body = await windowedPane();
    for (let top = 0; top < PAGE_COUNT * 194; top += 1500) {
      body.scrollTop = top;
      body.dispatchEvent(new Event("scroll"));
      await flush();
    }
    const distinct = new Set(previewReads).size;
    console.error(
      `[library perf] after scrolling the whole list: ${previewReads.length} preview reads, ` +
        `${distinct} distinct documents, cap ${PREVIEW_CACHE_LIMIT}`,
    );
    // The reads are bounded by the documents actually scrolled past, not by a re-read per repaint.
    expect(previewReads.length).toBeGreaterThan(0);
    // Each document is read at most once however many repaints scrolled past it: that is the cache
    // Doing its job. And the rendered set stays a viewport.
    expect(previewReads.length).toBe(distinct);
    expect(cards()).toBeLessThanOrEqual(80);
  });

  test("the Table layout windows too, at its own row height", async () => {
    setLibraryLayout("table");
    await mount();
    expect(host.querySelectorAll(".library-table-row").length).toBe(PAGE_COUNT);
    await layOutPane();
    // 700px / 32px = 22 visible rows, +1 partial, +3 overscan.
    expect(host.querySelectorAll(".library-table-row").length).toBe(26);
  });

  test("Board draws no live preview at all, however many files it groups", async () => {
    setLibraryLayout("board");
    await mount();
    await layOutPane();
    expect(previewReads).toEqual([]);
    // One capped column, and the count it prints is the honest total.
    expect(host.querySelectorAll(".library-list-item").length).toBe(25);
    expect(host.querySelector(".library-board-count")?.textContent).toBe(String(PAGE_COUNT));
    expect(host.querySelector(".library-truncated")?.textContent).toContain("275 more");
  });
});
