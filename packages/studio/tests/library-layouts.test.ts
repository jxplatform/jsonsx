/**
 * Tests for src/browse/library-layouts.ts — the five arrangements over one row set.
 *
 * Two properties matter beyond "it renders": the grouped layouts CAP what they draw and SAY what
 * they left out (a silently truncated list is the same lie as "No files found"), and the geometry
 * table is the single place the window's row height comes from.
 */
import { renderInto } from "./harness";
import { describe, expect, test } from "bun:test";
import { html } from "lit-html";
import {
  BOARD_COLUMN_LIMIT,
  CALENDAR_DAY_LIMIT,
  LAYOUT_METRICS,
  boardTpl,
  calendarTpl,
  cardsTpl,
  cellText,
  cellTextOf,
  columnsAt,
  formatModified,
  formatSize,
  mediaTpl,
  tableHeadTpl,
  tableRowsTpl,
} from "../src/browse/library-layouts";
import { LIBRARY_LAYOUTS } from "../src/browse/library-model";
import { libraryColumns } from "../src/browse/library-source";
import type { LayoutContext } from "../src/browse/library-layouts";
import type { LibraryFile } from "../src/browse/library-model";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function page(index: number): LibraryFile {
  return {
    category: "Pages",
    ext: ".json",
    modified: "2024-06-07T00:00:00.000Z",
    name: `page-${index}.json`,
    path: `pages/page-${index}.json`,
    size: 1024,
    type: ".json",
  };
}

const IMAGE: LibraryFile = {
  category: "Media",
  ext: ".png",
  name: "logo.png",
  path: "public/logo.png",
  type: ".png",
};

const SCRIPT: LibraryFile = {
  category: "Other",
  ext: ".sh",
  name: "deploy.sh",
  path: "bin/deploy.sh",
  type: ".sh",
};

function context(overrides: Partial<LayoutContext> = {}): LayoutContext {
  return {
    columns: libraryColumns(),
    contextMenu: () => {},
    mountPreview: () => {},
    openFile: () => {},
    ...overrides,
  };
}

// ─── Geometry ────────────────────────────────────────────────────────────────

describe("geometry", () => {
  test("every layout declares a metric, and only the flat ones window", () => {
    for (const layout of LIBRARY_LAYOUTS) {
      expect(LAYOUT_METRICS[layout]).toBeDefined();
    }
    const windowed = LIBRARY_LAYOUTS.filter((l) => LAYOUT_METRICS[l].windowed);
    expect(windowed.toSorted()).toEqual(["cards", "media", "table"]);
  });

  test("columnsAt divides the width by the item width, and never returns zero", () => {
    expect(columnsAt("cards", 1000)).toBe(5);
    expect(columnsAt("cards", 10)).toBe(1);
    expect(columnsAt("table", 1000)).toBe(1);
    expect(columnsAt("cards", 0)).toBe(1);
  });
});

// ─── Cell text ───────────────────────────────────────────────────────────────

describe("cell text", () => {
  test("sizes scale, and an unreported size is blank rather than 0 B", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(20_480)).toBe("20 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
    const noSize: number | undefined = undefined;
    expect(formatSize(noSize)).toBe("");
    expect(formatSize(Number.NaN)).toBe("");
  });

  test("a modification time is a date, and a bad one is blank rather than Invalid Date", () => {
    expect(formatModified("2024-06-07T13:00:00.000Z")).toBe("2024-06-07");
    expect(formatModified("nonsense")).toBe("");
    const noDate: string | undefined = undefined;
    expect(formatModified(noDate)).toBe("");
  });

  test("every declared column has cell text, and an unknown field is empty", () => {
    const file = page(1);
    for (const column of libraryColumns()) {
      expect(typeof cellText(file, column.field)).toBe("string");
    }
    expect(cellText(file, "name")).toBe("page-1.json");
    expect(cellText(file, "category")).toBe("Pages");
    expect(cellText(file, "type")).toBe(".json");
    expect(cellText(file, "path")).toBe("pages/page-1.json");
    expect(cellText(file, "invented")).toBe("");
  });

  /*
   * The assertion above passes for a column `cellText` has no `case` for: `default:` returns "",
   * which is still a string. A file with every field populated must therefore produce text for
   * every column `libraryColumns()` declares — that is the shape that catches a header over blanks.
   */
  test("a fully-populated file has NON-EMPTY text in every declared column", () => {
    const file: LibraryFile = { ...page(1), locale: "fr", path: "pages/fr/page-1.json" };
    for (const column of libraryColumns()) {
      expect([column.field, cellText(file, column.field)]).not.toEqual([column.field, ""]);
    }
  });

  test("the locale column shows the language's own name, and nothing where there is none", () => {
    expect(cellText({ ...page(1), locale: "fr" }, "locale")).toBe("français");
    expect(cellText({ ...page(1), locale: "fr-CA" }, "locale")).toBe("français canadien");
    expect(cellText(page(1), "locale")).toBe("");
  });

  test("a raw grid cell prints as text, and null prints as nothing", () => {
    expect(cellTextOf(null)).toBe("");
    expect(cellTextOf(42)).toBe("42");
    expect(cellTextOf("x")).toBe("x");
  });
});

// ─── Table ───────────────────────────────────────────────────────────────────

describe("Table", () => {
  test("its header comes from the SOURCE's columns, not from a second hand-written list", async () => {
    const host = await renderInto(html`${tableHeadTpl(libraryColumns())}`);
    expect(
      [...host.querySelectorAll("[role=columnheader]")].map((c) => c.textContent?.trim()),
    ).toEqual(["Name", "Category", "Locale", "Type", "Size", "Modified", "Path"]);
  });

  test("draws one row per file, and opens on click", async () => {
    const opened: string[] = [];
    const host = await renderInto(
      html`${tableRowsTpl([page(1), page(2)], context({ openFile: (p) => opened.push(p) }))}`,
    );
    const rows = [...host.querySelectorAll(".library-table-row")];
    expect(rows.length).toBe(2);
    (rows[0] as HTMLElement).click();
    expect(opened).toEqual(["pages/page-1.json"]);
  });

  test("an empty slice draws no rows at all", async () => {
    const host = await renderInto(html`${tableRowsTpl([], context())}`);
    expect(host.querySelectorAll(".library-table-row").length).toBe(0);
  });

  test("right-clicking a row raises the context menu for that file", async () => {
    const seen: string[] = [];
    const host = await renderInto(
      html`${tableRowsTpl([page(1)], context({ contextMenu: (_e, f) => seen.push(f.path) }))}`,
    );
    host
      .querySelector(".library-table-row")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(seen).toEqual(["pages/page-1.json"]);
  });
});

// ─── Cards and Media ─────────────────────────────────────────────────────────

describe("Cards", () => {
  test("a previewable document gets a slot; an image gets the image itself", async () => {
    const asked: string[] = [];
    const ctx = context({ mountPreview: (_el, file) => asked.push(file.path) });
    const host = await renderInto(html`${cardsTpl([page(1), IMAGE], ctx)}`);
    expect(asked).toEqual(["pages/page-1.json"]);
    expect(host.querySelectorAll("img.library-thumb").length).toBe(1);
  });

  test("a file nothing can preview gets a glyph rather than an empty box", async () => {
    const host = await renderInto(html`${cardsTpl([SCRIPT], context())}`);
    expect(host.querySelector("sp-icon-document")).not.toBeNull();
    expect(host.querySelector(".library-preview-slot")).toBeNull();
  });

  test("clicking a card opens its file", async () => {
    const opened: string[] = [];
    const host = await renderInto(
      html`${cardsTpl([page(3)], context({ openFile: (p) => opened.push(p) }))}`,
    );
    (host.querySelector(".library-card") as HTMLElement).click();
    expect(opened).toEqual(["pages/page-3.json"]);
  });
});

describe("Media", () => {
  test("draws image tiles and never a live document render", async () => {
    const asked: string[] = [];
    const host = await renderInto(
      html`${mediaTpl([IMAGE, page(1)], context({ mountPreview: (_e, f) => asked.push(f.path) }))}`,
    );
    expect(asked).toEqual([]);
    expect(host.querySelectorAll(".library-tile").length).toBe(2);
    expect(host.querySelectorAll("img.library-thumb").length).toBe(1);
  });

  test("a tile opens and context-menus like every other item", async () => {
    const opened: string[] = [];
    const menued: string[] = [];
    const host = await renderInto(
      html`${mediaTpl(
        [IMAGE],
        context({ contextMenu: (_e, f) => menued.push(f.path), openFile: (p) => opened.push(p) }),
      )}`,
    );
    const tile = host.querySelector(".library-tile") as HTMLElement;
    tile.click();
    tile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(opened).toEqual(["public/logo.png"]);
    expect(menued).toEqual(["public/logo.png"]);
  });
});

// ─── Calendar ────────────────────────────────────────────────────────────────

describe("Calendar", () => {
  function dated(date: string, index: number): LibraryFile {
    return { ...page(index), name: `${date}-post-${index}.md` };
  }

  test("groups by day, newest first", async () => {
    const host = await renderInto(
      html`${calendarTpl([dated("2024-01-01", 1), dated("2024-05-05", 2)], context())}`,
    );
    expect([...host.querySelectorAll(".library-day-date")].map((n) => n.textContent)).toEqual([
      "2024-05-05",
      "2024-01-01",
    ]);
  });

  test("caps the days it draws and STATES how many it did not", async () => {
    const files = Array.from({ length: CALENDAR_DAY_LIMIT + 5 }, (_v, i) =>
      dated(
        `20${String(10 + Math.floor(i / 12)).padStart(2, "0")}-01-${String((i % 12) + 1).padStart(2, "0")}`,
        i,
      ),
    );
    const host = await renderInto(html`${calendarTpl(files, context())}`);
    expect(host.querySelectorAll(".library-day:not(.library-day-undated)").length).toBe(
      CALENDAR_DAY_LIMIT,
    );
    expect(host.querySelector(".library-truncated")?.textContent).toContain("5 older");
  });

  test("undated files are set apart and counted, never parked on today", async () => {
    const undated: LibraryFile = { ...SCRIPT };
    const host = await renderInto(
      html`${calendarTpl([dated("2024-01-01", 1), undated], context())}`,
    );
    const section = host.querySelector(".library-day-undated")!;
    expect(section.querySelector(".library-day-date")?.textContent).toBe("No date");
    expect(section.querySelector(".library-day-note")?.textContent).toContain("1 file");
  });

  test("with no undated file there is no undated section", async () => {
    const host = await renderInto(html`${calendarTpl([dated("2024-01-01", 1)], context())}`);
    expect(host.querySelector(".library-day-undated")).toBeNull();
    expect(host.querySelector(".library-truncated")).toBeNull();
  });
});

// ─── Board ───────────────────────────────────────────────────────────────────

describe("Board", () => {
  test("one column per category, each printing its own total", async () => {
    const host = await renderInto(html`${boardTpl([page(1), page(2), IMAGE], context())}`);
    const columns = [...host.querySelectorAll(".library-board-column")];
    expect(columns.length).toBe(2);
    expect(columns[0]!.querySelector(".library-board-count")?.textContent).toBe("2");
  });

  test("caps a column and states the remainder rather than truncating in silence", async () => {
    const files = Array.from({ length: BOARD_COLUMN_LIMIT + 3 }, (_v, i) => page(i));
    const host = await renderInto(html`${boardTpl(files, context())}`);
    expect(host.querySelectorAll(".library-list-item").length).toBe(BOARD_COLUMN_LIMIT);
    expect(host.querySelector(".library-truncated")?.textContent).toContain("3 more");
  });

  test("a list item opens its file and offers its context menu", async () => {
    const opened: string[] = [];
    const menued: string[] = [];
    const host = await renderInto(
      html`${boardTpl(
        [page(1)],
        context({ contextMenu: (_e, f) => menued.push(f.path), openFile: (p) => opened.push(p) }),
      )}`,
    );
    const item = host.querySelector(".library-list-item") as HTMLElement;
    item.click();
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(opened).toEqual(["pages/page-1.json"]);
    expect(menued).toEqual(["pages/page-1.json"]);
  });
});
