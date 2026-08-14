/**
 * The Files tree draws a WINDOW over a flattened row model.
 *
 * The recursion it replaces had no row list at all — a template per directory level — so a project
 * with an expanded `node_modules` built tens of thousands of rows, each with an `sp-icon` custom
 * element, on every repaint. Flattening is what makes a window possible, and it is also what makes
 * the questions below answerable: which row is below this one, where does this row sit among its
 * siblings, and where is the tab stop when the selected row has scrolled out of the DOM.
 */
import { flush, installMockPlatform, renderInto, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { requireProjectState, setProjectState } from "../src/store";
import { initLayers } from "../src/ui/layers";
import type { DirEntry } from "../src/types";

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
  monitorForElements: () => () => {},
}));

const { FILE_ROW_HEIGHT, renderFilesTemplate, setupTreeKeyboard } =
  await import("../src/files/files");

/** Files in the project root — enough that a window is a small fraction of the tree. */
const FILE_COUNT = 300;
/** A Navigator tall enough for ten rows. */
const VIEWPORT = 240;

let scroller: HTMLElement;
let host: HTMLElement;
let renders = 0;

function fileName(index: number): string {
  return `file-${String(index).padStart(3, "0")}.json`;
}

/** A root of 300 files with one expanded directory in front of them. */
function seedProject(): void {
  const root: DirEntry[] = [
    { name: "pages", path: "pages", type: "directory" },
    ...Array.from({ length: FILE_COUNT }, (_v, index) => ({
      name: fileName(index),
      path: fileName(index),
      type: "file" as const,
    })),
  ];
  setProjectState({
    dirs: new Map<string, DirEntry[]>([
      [".", root],
      [
        "pages",
        [
          { name: "index.json", path: "pages/index.json", type: "file" },
          { name: "about.json", path: "pages/about.json", type: "file" },
        ],
      ],
    ]),
    expanded: new Set(["pages"]),
    isSiteProject: true,
    name: "Demo",
    projectConfig: { name: "Demo" },
    projectDirs: [],
    projectRoot: ".",
    searchQuery: "",
    selectedPath: null,
  } as never);
}

/** Rows in the model: the directory, its two children, and every root file. */
const ROW_COUNT = 3 + FILE_COUNT;

/** Happy-dom performs no layout, so the tree's top relative to the scroller is stubbed. */
function place(): void {
  const tree = host.querySelector<HTMLElement>(".file-tree");
  if (tree) {
    (tree as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ height: ROW_COUNT * FILE_ROW_HEIGHT, top: -scroller.scrollTop }) as DOMRect;
  }
}

async function renderTree(): Promise<void> {
  renders += 1;
  await renderInto(
    renderFilesTemplate({
      openFileFromTree: () => {},
      openProject: () => {},
      renderLeftPanel: () => {
        void renderTree();
      },
    }),
    host,
  );
  place();
}

/** Render until the tree has been adopted and the second, windowed pass has run. */
async function renderWindowed(): Promise<void> {
  await renderTree();
  await flush();
  place();
}

async function scrollTo(top: number): Promise<void> {
  scroller.scrollTop = top;
  place();
  scroller.dispatchEvent(new Event("scroll"));
  await flush();
  await flush();
}

function rows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.file-tree-item[role="treeitem"]')];
}

function rowFor(path: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`.file-tree-item[data-path="${CSS.escape(path)}"]`);
}

function pads(): number[] {
  return [...host.querySelectorAll<HTMLElement>(".file-tree > div[aria-hidden]")].map((el) =>
    Number(el.style.height.replace("px", "")),
  );
}

beforeEach(async () => {
  document.body.innerHTML = `
    <div id="scroller"><div id="host"></div></div>
    <div id="layer-popover"></div>
    <div id="layer-modal"></div>
    <div id="layer-dialog"></div>
  `;
  initLayers();
  installMockPlatform();
  scroller = document.querySelector("#scroller") as HTMLElement;
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: VIEWPORT });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: ROW_COUNT * FILE_ROW_HEIGHT,
  });
  stubRect(scroller, { height: VIEWPORT, top: 0 });
  host = document.querySelector("#host") as HTMLElement;
  renders = 0;
  seedProject();
  await renderWindowed();
});

afterEach(() => {
  setProjectState(null);
  document.body.innerHTML = "";
});

describe("the window", () => {
  test("draws the viewport and its overscan, not the project", () => {
    const drawn = rows();
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(20);
    expect(drawn.length).toBeLessThan(ROW_COUNT);
    // An expanded directory contributes its children right after itself, in display order.
    expect(drawn.slice(0, 3).map((el) => el.dataset.path)).toEqual([
      "pages",
      "pages/about.json",
      "pages/index.json",
    ]);
  });

  test("reserves the scroll height of every row it did not draw", () => {
    const [padTop, padBottom] = pads();
    expect(padTop).toBe(0);
    expect(padTop! + rows().length * FILE_ROW_HEIGHT + padBottom!).toBe(
      ROW_COUNT * FILE_ROW_HEIGHT,
    );
  });

  test("moves with the scroller, and still totals the whole project", async () => {
    await scrollTo(FILE_ROW_HEIGHT * 200);
    expect(rowFor("pages")).toBeNull();
    expect(rowFor(fileName(200))).not.toBeNull();
    const [padTop, padBottom] = pads();
    expect(padTop).toBeGreaterThan(0);
    expect(padTop! + rows().length * FILE_ROW_HEIGHT + padBottom!).toBe(
      ROW_COUNT * FILE_ROW_HEIGHT,
    );
  });

  test("reports each row's place in the PROJECT, not in the window", async () => {
    await scrollTo(FILE_ROW_HEIGHT * 200);
    const row = rowFor(fileName(200))!;
    // The 202nd of 301 entries in the root (the `pages` directory sorts first).
    expect(row.getAttribute("aria-posinset")).toBe("202");
    expect(row.getAttribute("aria-setsize")).toBe(String(FILE_COUNT + 1));
    expect(row.getAttribute("aria-level")).toBe("1");
  });

  test("a child of an expanded directory says which level it is on", () => {
    expect(rowFor("pages/index.json")!.getAttribute("aria-level")).toBe("2");
    expect(rowFor("pages/index.json")!.getAttribute("aria-posinset")).toBe("2");
    expect(rowFor("pages/index.json")!.getAttribute("aria-setsize")).toBe("2");
  });

  test("keeps exactly one tab stop, and keeps it inside the window", async () => {
    expect(rows().filter((el) => el.tabIndex === 0)).toHaveLength(1);
    await scrollTo(FILE_ROW_HEIGHT * 200);
    // The row that WOULD hold it (the first) has scrolled away; a tree with no tabbable row is a
    // Panel the Tab key skips entirely.
    const stops = rows().filter((el) => el.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.dataset.path).toBe(rows()[0]!.dataset.path);
  });

  test("the selected row takes the tab stop while it is on screen", async () => {
    requireProjectState().selectedPath = fileName(1);
    await renderTree();
    expect(rowFor(fileName(1))!.tabIndex).toBe(0);
    expect(rows().filter((el) => el.tabIndex === 0)).toHaveLength(1);
  });
});

describe("the keyboard walks the model", () => {
  test("↓ steps past the last DRAWN row instead of stopping at it", async () => {
    const tree = host.querySelector(".file-tree") as HTMLElement;
    setupTreeKeyboard(tree);
    const last = rows().at(-1)!;
    last.focus();

    last.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }),
    );
    await flush();
    await flush();

    // The row below the window: the walk scrolled to it and the repaint handed it the keyboard.
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect((document.activeElement as HTMLElement).dataset.path).not.toBe(last.dataset.path);
  });
});

describe("a drag keeps the window it started with", () => {
  test("a scroll mid-drag does not repaint the rows pragmatic-dnd is holding", async () => {
    const dragged = rows()[2]!;
    dragged.classList.add("dragging");
    const before = renders;

    scroller.scrollTop = FILE_ROW_HEIGHT * 100;
    place();
    scroller.dispatchEvent(new Event("scroll"));
    await flush();

    expect(renders).toBe(before);
    expect(dragged.isConnected).toBe(true);
  });
});
