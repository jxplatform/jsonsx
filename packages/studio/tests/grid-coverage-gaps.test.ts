/**
 * Coverage-gap tests for the grid stack:
 *
 * - Content-source: unreadable source dirs, nested-object cells, long-text column inference, commits
 *   against unloaded rows, vanished files, clean-open-tab reloads, format-less inserts, serializer
 *   failures, and delete failures.
 * - Grid-layout: storage-denied degradation.
 * - Cell-editors: checkbox Enter/blur commits and select Escape cancel.
 * - Edit-buffer: multi-field row errors, error clearing, drop-insert/delete redo, unbalanced
 *   endGroup, and group-op history pruning.
 * - Grid-panel: the Prev pager and the Replace popover's no-match/cancel paths.
 */
import { flush, installMockPlatform, resetStudioState, surfaceOf } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import { FakeTabulator, tabulatorMockModule } from "./tabulator-mock";
import { render } from "lit-html";
import { mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import type { GridColumn, GridSource } from "../src/grid/grid-source";
import type { CellLike } from "../src/grid/cell-editors";
import type { StudioPlatform } from "../src/types";

void mock.module("tabulator-tables", () => tabulatorMockModule);
void mock.module("tabulator-tables/dist/css/tabulator.min.css", () => ({}));
void mock.module("../src/ui/layers.js", () => ({
  clearLayerSlot: () => {},
  getLayerSlot: () => document.createElement("div"),
  initLayers: () => {},
  openModal: () => ({ close: () => {}, update: () => {} }),
  renderPopover: (template: unknown) => {
    const host = document.createElement("div");
    host.className = "test-popover-host";
    document.body.append(host);
    render(template as never, host);
    return {
      dismiss: () => {
        host.remove();
      },
      host,
      update: (tpl: unknown) => render(tpl as never, host),
    };
  },
  showConfirmDialog: async () => dialogAnswers.confirm,
  showDialog: async () => null,
  showPromptDialog: async () => dialogAnswers.prompt,
}));

/** What the mocked dialogs answer. Mutated per test — `mock.module` runs once, at import. */
const dialogAnswers: { confirm: boolean; prompt: string | null } = { confirm: true, prompt: null };
void mock.module("../src/ui/progress-modal.js", () => ({
  showProgressModal: () => ({ done: () => {}, fail: () => {}, setStatus: () => {} }),
}));
void mock.module("../src/services/notify.js", () => notifyModule(() => {}));

const { closeAllTabs, openTab } = await import("../src/workspace/workspace");
const { createCollectionSource, createPagesSource, PATH_FIELD } =
  await import("../src/grid/sources/content-source");
const { setFormats } = await import("../src/format/format-host");
const { loadGridLayout, saveGridLayout } = await import("../src/grid/grid-layout");
const { editorForColumn } = await import("../src/grid/cell-editors");
const { createEditBuffer } = await import("../src/grid/edit-buffer");
const { createGridController } = await import("../src/grid/grid-controller");
const { detachGridPanel, renderGridMode } = await import("../src/grid/grid-panel");

const LONG_TEXT = "long descriptive paragraph ".repeat(10).trim(); // > 200 chars

const POSTS_CONFIG = {
  content: {
    posts: { format: "Markdown", schema: {}, source: "./content/posts/" },
  },
};

function setupPosts(seedFiles: Record<string, string> = {}, overrides = {}) {
  const { state } = installMockPlatform(
    { formatAction: mockFormatAction, ...overrides } as unknown as Partial<StudioPlatform>,
    seedFiles,
  );
  resetStudioState({ projectConfig: POSTS_CONFIG });
  return state;
}

beforeEach(() => {
  closeAllTabs();
  seedMarkdownFormat();
  detachGridPanel("primary");
  FakeTabulator.reset();
});

// ─── Content source ──────────────────────────────────────────────────────────

describe("content-source gaps", () => {
  test("an unreadable source directory yields an empty grid, not an error", async () => {
    setupPosts(
      {},
      {
        listDirectory: async () => {
          throw new Error("EACCES");
        },
      },
    );
    const source = createCollectionSource("posts");
    const { rows, total } = await source.rows();
    expect(total).toBe(0);
    expect(rows).toEqual([]);
  });

  test("nested objects render as read-only JSON text; long strings stay editable", async () => {
    setupPosts({
      "content/posts/meta.md": `---\ntitle: Meta\nmeta:\n  description: ${LONG_TEXT}\n---\n\nBody\n`,
      "content/posts/plain.md": `---\ntitle: Plain\nblurb: ${LONG_TEXT}\n---\n\nBody\n`,
    });
    const source = createCollectionSource("posts");
    const columns = await source.columns();
    const byField = new Map(columns.map((c) => [c.field, c]));
    // Stringified nested object → text column locked read-only.
    expect(byField.get("meta")!.kind).toBe("text");
    expect(byField.get("meta")!.editable).toBeFalse();
    // Genuinely long string → text column that stays editable.
    expect(byField.get("blurb")!.kind).toBe("text");
    expect(byField.get("blurb")!.editable).toBeTrue();

    const { rows } = await source.rows();
    const meta = rows.find((r) => r.key === "content/posts/meta.md")!;
    expect(meta.cells.meta).toBe(JSON.stringify({ description: LONG_TEXT }));
  });

  test("a commit against a row that never loaded reports it", async () => {
    setupPosts();
    const source = createCollectionSource("posts");
    await source.rows();
    const result = await source.commit({
      cells: [{ baseline: "x", field: "title", rowKey: "content/posts/ghost.md", value: "y" }],
      deletes: [],
      inserts: [],
    });
    expect(result.cells[0]!.ok).toBeFalse();
    expect(result.cells[0]!.error).toContain("no longer loaded");
  });

  test("a file deleted on disk since load is treated as stale", async () => {
    const state = setupPosts({
      "content/posts/vanishing.md": "---\ntitle: Here\n---\n",
    });
    const source = createCollectionSource("posts");
    await source.rows();
    state.files.delete("content/posts/vanishing.md");
    const result = await source.commit({
      cells: [
        { baseline: "Here", field: "title", rowKey: "content/posts/vanishing.md", value: "Gone" },
      ],
      deletes: [],
      inserts: [],
    });
    expect(result.cells[0]!.ok).toBeFalse();
    expect(result.cells[0]!.stale).toBeTrue();
  });

  test("a clean open tab on the edited file gets reloaded after the write", async () => {
    const state = setupPosts({
      "content/posts/open-clean.md": "---\ntitle: Original\n---\n\nBody\n",
    });
    const source = createCollectionSource("posts");
    await source.rows();
    openTab({
      document: { tagName: "div" },
      documentPath: "content/posts/open-clean.md",
      id: "content/posts/open-clean.md",
    });

    const result = await source.commit({
      cells: [
        {
          baseline: "Original",
          field: "title",
          rowKey: "content/posts/open-clean.md",
          value: "Synced",
        },
      ],
      deletes: [],
      inserts: [],
    });
    await flush();
    expect(result.cells[0]!.ok).toBeTrue();
    expect(state.files.get("content/posts/open-clean.md")).toContain("title: Synced");
  });

  test("inserts fail cleanly when no format can serialize the path", async () => {
    installMockPlatform({ formatAction: mockFormatAction } as unknown as Partial<StudioPlatform>);
    resetStudioState({ projectConfig: {} });
    setFormats([]); // No registered formats at all.
    const source = createPagesSource();
    const result = await source.commit({
      cells: [],
      deletes: [],
      inserts: [{ cells: { [PATH_FIELD]: "landing", title: "Landing" }, tempKey: "t1" }],
    });
    expect(result.inserts[0]!.ok).toBeFalse();
    expect(result.inserts[0]!.error).toContain("No format can serialize");
  });

  test("a serializer failure during insert surfaces as the insert error", async () => {
    setupPosts(
      {},
      {
        formatAction: async (payload: Record<string, unknown>) => {
          if (payload.action === "serialize") {
            throw new Error("serializer exploded");
          }
          return mockFormatAction(payload);
        },
      },
    );
    const source = createCollectionSource("posts");
    const result = await source.commit({
      cells: [],
      deletes: [],
      inserts: [{ cells: { [PATH_FIELD]: "fresh", title: "Fresh" }, tempKey: "t1" }],
    });
    expect(result.inserts[0]!.ok).toBeFalse();
    expect(result.inserts[0]!.error).toContain("serializer exploded");
  });

  test("a delete failure surfaces per row without aborting the batch", async () => {
    setupPosts(
      { "content/posts/locked.md": "---\ntitle: Locked\n---\n" },
      {
        deleteFile: async () => {
          throw new Error("EPERM: locked");
        },
      },
    );
    const source = createCollectionSource("posts");
    await source.rows();
    const result = await source.commit({
      cells: [],
      deletes: [{ rowKey: "content/posts/locked.md" }],
      inserts: [],
    });
    expect(result.deletes[0]!.ok).toBeFalse();
    expect(result.deletes[0]!.error).toContain("EPERM");
  });
});

// ─── Grid layout persistence ─────────────────────────────────────────────────

describe("grid-layout storage failure", () => {
  test("load and save degrade to no-ops when localStorage access throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage denied");
      },
    });
    try {
      expect(loadGridLayout("grid://pages")).toBeNull();
      expect(() => {
        saveGridLayout("grid://pages", { widths: { title: 120 } });
      }).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      }
    }
    expect(loadGridLayout("grid://pages")).toBeNull(); // Nothing was persisted.
  });
});

// ─── Cell editors ────────────────────────────────────────────────────────────

describe("cell-editor gaps", () => {
  const makeHost = (className: string) => {
    const el = document.createElement("div");
    el.className = className;
    return el;
  };

  const cellWith = (value: unknown): CellLike => ({ getValue: () => value });

  function openEditor(column: GridColumn, value: unknown) {
    const editor = editorForColumn(column, makeHost)!;
    const outcome: { success: unknown[]; cancel: number } = { cancel: 0, success: [] };
    const host = editor(
      cellWith(value),
      (fn) => fn(),
      (v) => outcome.success.push(v),
      () => (outcome.cancel += 1),
    );
    document.body.append(host);
    return { host, outcome };
  }

  function keydown(el: Element, key: string) {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  }

  test("checkbox editor commits the current state on Enter, once", () => {
    const column: GridColumn = { editable: true, field: "f", kind: "boolean", title: "F" };
    const { host, outcome } = openEditor(column, true);
    const input = host.querySelector("input")!;
    keydown(input, "Enter");
    input.dispatchEvent(new Event("blur")); // Late blur after commit is ignored.
    expect(outcome.success).toEqual([true]);
    expect(outcome.cancel).toBe(0);
  });

  test("checkbox editor commits on blur when nothing else settled it", () => {
    const column: GridColumn = { editable: true, field: "f", kind: "boolean", title: "F" };
    const { host, outcome } = openEditor(column, false);
    const input = host.querySelector("input")!;
    input.dispatchEvent(new Event("blur"));
    expect(outcome.success).toEqual([false]);
  });

  test("select editor cancels on Escape, once", () => {
    const column: GridColumn = {
      editable: true,
      field: "f",
      kind: "enum",
      schema: { enum: ["a", "b"] },
      title: "F",
    };
    const { host, outcome } = openEditor(column, "a");
    const select = host.querySelector("select")!;
    keydown(select, "Escape");
    select.dispatchEvent(new Event("blur")); // Late blur after cancel is ignored.
    expect(outcome.cancel).toBe(1);
    expect(outcome.success).toEqual([]);
  });
});

// ─── Edit buffer ─────────────────────────────────────────────────────────────

describe("edit-buffer gaps", () => {
  function makeBuffer(committed: Record<string, Record<string, unknown>> = {}) {
    return createEditBuffer({
      resolveBaseline: (rowKey, field) => (committed[rowKey]?.[field] ?? null) as string | null,
    });
  }

  test("multiple failed cells on one row accumulate errors, then clear as they succeed", () => {
    const buffer = makeBuffer({ r1: { body: "b", title: "t" } });
    buffer.setCell("r1", "title", "T2");
    buffer.setCell("r1", "body", "B2");
    buffer.applyCommitResult({
      cells: [
        { error: "nope-title", field: "title", ok: false, rowKey: "r1" },
        { error: "nope-body", field: "body", ok: false, rowKey: "r1" },
      ],
      deletes: [],
      inserts: [],
    });
    expect(buffer.cellError("r1", "title")).toBe("nope-title");
    expect(buffer.cellError("r1", "body")).toBe("nope-body");
    expect(buffer.rowState("r1")).toBe("dirty");

    buffer.applyCommitResult({
      cells: [
        { field: "title", ok: true, rowKey: "r1" },
        { field: "body", ok: true, rowKey: "r1" },
      ],
      deletes: [],
      inserts: [],
    });
    expect(buffer.cellError("r1", "title")).toBeNull();
    expect(buffer.cellError("r1", "body")).toBeNull();
    expect(buffer.state.errors.size).toBe(0); // The emptied row map is dropped entirely.
  });

  test("dropping a pending insert redoes symmetrically", () => {
    const buffer = makeBuffer();
    const tempKey = buffer.insertRow({ title: "New" });
    buffer.deleteRow(tempKey); // Drop-insert: the row disappears.
    expect(buffer.state.inserts.has(tempKey)).toBeFalse();

    expect(buffer.undo()).toBeTrue(); // Insert restored.
    expect(buffer.state.inserts.get(tempKey)).toEqual({ title: "New" });

    expect(buffer.redo()).toBeTrue(); // Drop replays.
    expect(buffer.state.inserts.has(tempKey)).toBeFalse();
  });

  test("row deletes redo symmetrically", () => {
    const buffer = makeBuffer({ r1: { title: "t" } });
    buffer.deleteRow("r1");
    expect(buffer.undo()).toBeTrue();
    expect(buffer.state.deletes.has("r1")).toBeFalse();
    expect(buffer.redo()).toBeTrue();
    expect(buffer.state.deletes.has("r1")).toBeTrue();
  });

  test("endGroup without beginGroup is a harmless no-op", () => {
    const buffer = makeBuffer();
    expect(() => {
      buffer.endGroup();
    }).not.toThrow();
    expect(buffer.canUndo()).toBeFalse();
  });

  test("committing part of a grouped delete prunes only that row from history", () => {
    const buffer = makeBuffer({ r1: { title: "a" }, r2: { title: "b" } });
    buffer.group(() => {
      buffer.deleteRow("r1");
      buffer.deleteRow("r2");
    });
    buffer.applyCommitResult({
      cells: [],
      deletes: [{ ok: true, rowKey: "r1" }],
      inserts: [],
    });
    // R1 is committed and gone from the set; the group op survives with just r2.
    expect(buffer.state.deletes.has("r2")).toBeTrue();
    expect(buffer.undo()).toBeTrue();
    expect(buffer.state.deletes.size).toBe(0);
    expect(buffer.redo()).toBeTrue();
    expect(buffer.state.deletes.has("r2")).toBeTrue();
  });

  test("committing every row of a grouped delete drops the whole group op", () => {
    const buffer = makeBuffer({ r1: { title: "a" }, r2: { title: "b" } });
    buffer.group(() => {
      buffer.deleteRow("r1");
      buffer.deleteRow("r2");
    });
    buffer.applyCommitResult({
      cells: [],
      deletes: [
        { ok: true, rowKey: "r1" },
        { ok: true, rowKey: "r2" },
      ],
      inserts: [],
    });
    expect(buffer.canUndo()).toBeFalse();
  });
});

// ─── Grid panel ──────────────────────────────────────────────────────────────

describe("grid-panel gaps", () => {
  function stubSource(id: string): GridSource {
    return {
      capabilities: { delete: true, insert: true, remotePaging: false, remoteSort: false },
      columns: async () => [{ editable: true, field: "title", kind: "string", title: "Title" }],
      commit: async (batch) => ({
        cells: batch.cells.map((c) => ({ field: c.field, ok: true, rowKey: c.rowKey })),
        deletes: batch.deletes.map((d) => ({ ok: true, rowKey: d.rowKey })),
        inserts: batch.inserts.map((i) => ({ ok: true, tempKey: i.tempKey })),
      }),
      id,
      label: "posts",
      rows: async () => ({ rows: [{ cells: { title: "One" }, key: "a" }], total: 1 }),
    };
  }

  function gridTab(id: string) {
    return openTab({
      capabilities: { modes: ["grid"] },
      document: { tagName: "div" },
      documentPath: null,
      id,
    });
  }

  beforeEach(() => {
    resetStudioState();
    installMockPlatform();
  });

  test("the Prev pager steps back and clamps at the first page", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab("grid://data/main/users");
    const queries: unknown[] = [];
    const source = stubSource("grid://data/main/users");
    source.capabilities = { delete: true, insert: true, remotePaging: true, remoteSort: true };
    source.rows = async (q) => {
      queries.push({ ...q });
      return { rows: [{ cells: { title: "Row" }, key: `r${q?.offset ?? 0}` }], total: 120 };
    };
    const controller = createGridController(tab, source);
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();

    const buttonByTitle = (title: string) =>
      [...wrap.querySelectorAll("sp-action-button")].find(
        (b) => b.getAttribute("title") === title,
      ) as HTMLElement;

    buttonByTitle("Next page").click();
    await flush();
    expect(wrap.textContent).toContain("51–100");

    buttonByTitle("Previous page").click();
    await flush();
    expect(queries.at(-1)).toEqual({ limit: 50, offset: 0 });
    expect(wrap.textContent).toContain("1–50");
    expect(buttonByTitle("Previous page").hasAttribute("disabled")).toBeTrue();
  });

  test("Replace with no matches keeps the popover open; Cancel dismisses it", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab("grid://collection/posts");
    const controller = createGridController(tab, stubSource("grid://collection/posts"));
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();

    const replaceButton = [...wrap.querySelectorAll("sp-action-button")].find((b) =>
      b.textContent?.includes("Replace"),
    ) as HTMLElement;
    replaceButton.click();
    await flush();

    const popover = document.querySelector(".jx-grid-replace-popover")!;
    const [findInput] = [...popover.querySelectorAll("input")];
    findInput!.value = "zzz-not-present";
    findInput!.dispatchEvent(new Event("input", { bubbles: true }));
    const [replaceAll, cancel] = [...popover.querySelectorAll("sp-button")];
    (replaceAll as HTMLElement).click();
    await flush();
    // No matches → nothing buffered, popover stays up.
    expect(controller.buffer.isDirty()).toBeFalse();
    expect(document.querySelector(".jx-grid-replace-popover")).not.toBeNull();

    (cancel as HTMLElement).click();
    await flush();
    expect(document.querySelector(".jx-grid-replace-popover")).toBeNull();
  });
});
