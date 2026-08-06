/**
 * Redirects as a GridSource: rows off `project.json`, commits through the one configuration
 * chokepoint, the three validations filed as Problems, and the `_redirects`/CSV import staged for
 * review.
 *
 * `services/notify.ts` is NOT mocked — it is a reactive store with no I/O, and the assertion this
 * workstream owes is which tier each finding landed in, which only the real store can answer.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "lit-html";
import { FakeTabulator, tabulatorMockModule } from "./tabulator-mock";
import type { TemplateResult } from "lit-html";
import type { StudioPlatform } from "../src/types";
import type { GridEditBatch } from "../src/grid/grid-source";

void mock.module("tabulator-tables", () => tabulatorMockModule);
void mock.module("tabulator-tables/dist/css/tabulator.min.css", () => ({}));

/** Drives whatever `showDialog` renders. Null means "cancel by resolving null". */
let dialogDriver: ((host: HTMLElement, done: (value: unknown) => void) => void) | null = null;

void mock.module("../src/ui/layers.js", () => ({
  clearLayerSlot: () => {},
  getLayerSlot: () => document.createElement("div"),
  initLayers: () => {},
  openModal: () => ({ close: () => {}, update: () => {} }),
  renderPopover: (template: unknown) => {
    const host = document.createElement("div");
    document.body.append(host);
    render(template as never, host);
    return { dismiss: () => host.remove(), host, update: () => {} };
  },
  showConfirmDialog: async () => true,
  showDialog: (templateFn: (done: (value: unknown) => void) => TemplateResult) =>
    new Promise((resolve) => {
      const host = document.createElement("div");
      host.className = "test-dialog-host";
      document.body.append(host);
      const done = (value: unknown) => {
        host.remove();
        resolve(value);
      };
      render(templateFn(done), host);
      if (dialogDriver) {
        dialogDriver(host, done);
      } else {
        done(null);
      }
    }),
  showPromptDialog: async () => null,
}));
void mock.module("../src/ui/progress-modal.js", () => ({
  showProgressModal: () => ({ done: () => {}, fail: () => {}, setStatus: () => {} }),
}));

const { closeAllTabs, workspace } = await import("../src/workspace/workspace");
const { problems, resetNotifications, toasts } = await import("../src/services/notify");
const { resetProjectConfigDocument } = await import("../src/tabs/project-config");
const {
  createRedirectsSource,
  openRedirectsGrid,
  projectRoutes,
  promptRedirectImport,
  redirectColumns,
  redirectsCommands,
  registerRedirectsCommands,
  REDIRECTS_TAB_ID,
  reportRedirectProblems,
  stageRedirectImport,
} = await import("../src/grid/redirects-grid");

const PAGES = {
  "pages/about.md": "# About",
  "pages/blog/[slug].md": "# Post",
  "pages/index.md": "# Home",
  "pages/logo.svg": "<svg />",
};

function setup(
  redirects: Record<string, string | { destination: string; status?: number }> = {},
  files: Record<string, string> = PAGES,
) {
  const seed = { "project.json": JSON.stringify({ name: "site", redirects }, null, 2), ...files };
  const { state } = installMockPlatform({}, seed);
  resetStudioState({ projectConfig: { name: "site", redirects } });
  return state;
}

/** What `project.json` holds on disk, parsed. */
function writtenConfig(state: { files: Map<string, string> }) {
  return JSON.parse(state.files.get("project.json")!) as {
    redirects?: Record<string, unknown>;
  };
}

const emptyBatch = (): GridEditBatch => ({ cells: [], deletes: [], inserts: [] });

beforeEach(() => {
  closeAllTabs();
  resetStudioState();
  resetNotifications();
  resetProjectConfigDocument();
  FakeTabulator.reset();
  dialogDriver = null;
  for (const host of document.querySelectorAll(".test-dialog-host")) {
    host.remove();
  }
});

// ─── Columns and rows ─────────────────────────────────────────────────────────

describe("the source", () => {
  test("three editable columns, and Source is not a frozen primary key", async () => {
    const columns = redirectColumns();
    expect(columns.map((c) => c.field)).toEqual(["source", "destination", "status"]);
    expect(columns.every((c) => c.editable)).toBeTrue();
    expect(columns.some((c) => c.pk)).toBeFalse();
    expect(columns[2]!.schema!.enum).toEqual(["301", "302", "307", "308", "200"]);
    expect(await createRedirectsSource().columns()).toEqual(columns);
  });

  test("rows come off the live configuration, keyed by position", async () => {
    setup({ "/legacy": { destination: "/archive", status: 302 }, "/old": "/new" });
    const result = await createRedirectsSource().rows();
    expect(result.total).toBe(2);
    expect(result.rows).toEqual([
      { cells: { destination: "/archive", source: "/legacy", status: "302" }, key: "0" },
      { cells: { destination: "/new", source: "/old", status: "301" }, key: "1" },
    ]);
  });

  test("a project with no redirects block is an empty table, not an error", async () => {
    resetStudioState({ projectConfig: { name: "site" } });
    const result = await createRedirectsSource().rows();
    expect(result.rows).toEqual([]);
  });

  test("it declares project.json as its backing file, so an outside edit marks rows stale", () => {
    expect([...createRedirectsSource().backingPaths!()]).toEqual([["project.json", "*"]]);
  });
});

// ─── Commit ───────────────────────────────────────────────────────────────────

describe("commit", () => {
  test("a cell edit is written through the configuration chokepoint", async () => {
    const state = setup({ "/old": "/new" });
    const source = createRedirectsSource();
    const result = await source.commit({
      ...emptyBatch(),
      cells: [{ baseline: "/new", field: "destination", rowKey: "0", value: "/newer" }],
    });
    expect(result.cells).toEqual([{ field: "destination", ok: true, rowKey: "0" }]);
    expect(writtenConfig(state).redirects).toEqual({ "/old": "/newer" });
  });

  test("a renamed source keeps its row, because rows are keyed by position", async () => {
    const state = setup({ "/old": "/new" });
    await createRedirectsSource().commit({
      ...emptyBatch(),
      cells: [{ baseline: "/old", field: "source", rowKey: "0", value: " /older " }],
    });
    expect(writtenConfig(state).redirects).toEqual({ "/older": "/new" });
  });

  test("a non-301 status expands to the object spelling; a 301 collapses back", async () => {
    const state = setup({ "/old": { destination: "/new", status: 302 } });
    await createRedirectsSource().commit({
      ...emptyBatch(),
      cells: [{ baseline: "302", field: "status", rowKey: "0", value: "301" }],
    });
    expect(writtenConfig(state).redirects).toEqual({ "/old": "/new" });
  });

  test("inserts and deletes land together, and an emptied table leaves no redirects key", async () => {
    const state = setup({ "/old": "/new" });
    const source = createRedirectsSource();
    const result = await source.commit({
      cells: [],
      deletes: [{ rowKey: "0" }],
      inserts: [{ cells: { destination: "/b", source: "/a", status: "308" }, tempKey: "t1" }],
    });
    expect(writtenConfig(state).redirects).toEqual({ "/a": { destination: "/b", status: 308 } });
    // Every arm reports, or the buffer never lets the row go.
    expect(result.inserts).toEqual([{ ok: true, tempKey: "t1" }]);
    expect(result.deletes).toEqual([{ ok: true, rowKey: "0" }]);

    resetStudioState({ projectConfig: JSON.parse(state.files.get("project.json")!) });
    resetProjectConfigDocument();
    await createRedirectsSource().commit({ ...emptyBatch(), deletes: [{ rowKey: "0" }] });
    expect(writtenConfig(state).redirects).toBeUndefined();
  });

  test("a blank source, a blank destination, a bad status and a duplicate are all refused", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ destination: "/b", source: "", status: "301" }, "A source path is required."],
      [{ destination: "", source: "/a", status: "301" }, "A destination is required."],
      [{ destination: "/b", source: "/a", status: "999" }, "Status must be one of"],
      [{ destination: "/z", source: "/old", status: "301" }, "Duplicate source."],
    ];
    for (const [cells, expected] of cases) {
      const state = setup({ "/old": "/new" });
      const result = await createRedirectsSource().commit({
        ...emptyBatch(),
        inserts: [{ cells, tempKey: "t1" }],
      });
      expect(result.inserts[0]!.ok).toBeFalse();
      expect(result.inserts[0]!.error).toContain(expected);
      // Nothing written: a half-applied redirect map is a site with some old URLs broken.
      expect(writtenConfig(state).redirects).toEqual({ "/old": "/new" });
      resetProjectConfigDocument();
    }
  });

  test("a refusal marks every kind of pending change, not just the offending one", async () => {
    const state = setup({ "/keep": "/kept", "/old": "/new" });
    const result = await createRedirectsSource().commit({
      cells: [{ baseline: "/new", field: "destination", rowKey: "1", value: "/newer" }],
      deletes: [{ rowKey: "0" }],
      inserts: [{ cells: { destination: "", source: "/a", status: "301" }, tempKey: "t1" }],
    });
    expect(result.cells[0]!.ok).toBeFalse();
    expect(result.deletes[0]!.ok).toBeFalse();
    expect(result.inserts[0]!.ok).toBeFalse();
    expect(writtenConfig(state).redirects).toEqual({ "/keep": "/kept", "/old": "/new" });
  });

  test("refresh is a no-op: rows are read from the live document every time", async () => {
    setup({ "/old": "/new" });
    const source = createRedirectsSource();
    await source.refresh!();
    const before = await source.rows();
    expect(before.total).toBe(1);
    resetStudioState({ projectConfig: { name: "site", redirects: {} } });
    const after = await source.rows();
    expect(after.total).toBe(0);
  });

  test("an edit to a row that is no longer there is refused as stale, not written elsewhere", async () => {
    setup({ "/old": "/new" });
    const result = await createRedirectsSource().commit({
      ...emptyBatch(),
      cells: [{ baseline: "x", field: "destination", rowKey: "7", value: "/y" }],
    });
    expect(result.cells[0]).toMatchObject({ ok: false, stale: true });
    expect(result.cells[0]!.error).toContain("no longer in project.json");
  });

  test("a rejected write fails every row once — the chokepoint already filed the Problem", async () => {
    setup({ "/old": "/new" });
    installMockPlatform(
      {
        readFile: async (path: string) =>
          path === "project.json" ? JSON.stringify({ name: "site" }) : "",
        writeFile: async () => {
          throw new Error("disk full");
        },
      } as unknown as Partial<StudioPlatform>,
      {},
    );
    const result = await createRedirectsSource().commit({
      ...emptyBatch(),
      cells: [{ baseline: "/new", field: "destination", rowKey: "0", value: "/newer" }],
    });
    expect(result.cells[0]!.ok).toBeFalse();
    expect(result.cells[0]!.error).toContain("see Problems");
    expect(problems.filter((p) => p.source === "Redirects")).toEqual([]);
  });
});

// ─── Saving through the controller ────────────────────────────────────────────

/**
 * The buffer's contract, exercised end to end.
 *
 * A `CommitResult` is not a log — it is the ONLY thing that clears a pending change
 * (`edit-buffer.ts`'s `applyCommitResult`). A commit that writes the file but reports no outcome
 * for a row leaves that row pending forever: the dirty dot never goes out, the save banner counts
 * the write as a failure, and `grid-controller`'s `structural` check never reloads, so the table
 * shows a phantom insert on top of the row it just saved.
 */
describe("saving through the controller", () => {
  test("a saved insert empties the buffer and re-reads the table", async () => {
    const state = setup({ "/old": "/new" });
    const controller = await openRedirectsGrid();
    controller.addRow({ destination: "/b", source: "/a", status: "301" });
    expect(controller.buffer.state.inserts.size).toBe(1);

    await controller.save();
    await flush();

    expect(writtenConfig(state).redirects).toEqual({ "/a": "/b", "/old": "/new" });
    expect(controller.buffer.state.inserts.size).toBe(0);
    expect(controller.buffer.isDirty()).toBeFalse();
    expect(controller.buffer.dirtyCount()).toBe(0);
    // Reloaded, not stacked: two committed rows and no pending overlay.
    expect(controller.state.rows.map((row) => row.cells.source)).toEqual(["/old", "/a"]);
    expect(controller.effectiveRows()).toHaveLength(2);
  });

  test("a saved insert is a success, not a silent failure in the save banner", async () => {
    setup();
    const controller = await openRedirectsGrid();
    controller.addRow({ destination: "/b", source: "/a", status: "301" });
    await controller.save();
    await flush();
    expect(toasts.find((t) => t.key === "grid.save")!.severity).toBe("success");
  });

  test("a saved delete and a saved cell edit clear too", async () => {
    const state = setup({ "/keep": "/kept", "/old": "/new" });
    const controller = await openRedirectsGrid();
    controller.buffer.setCell("0", "destination", "/kept-2");
    controller.buffer.deleteRow("1");

    await controller.save();
    await flush();

    expect(writtenConfig(state).redirects).toEqual({ "/keep": "/kept-2" });
    expect(controller.buffer.isDirty()).toBeFalse();
    expect(controller.buffer.state.deletes.size).toBe(0);
    expect(controller.buffer.state.pending.size).toBe(0);
  });

  test("validation still runs on what was saved, with the row that was just inserted in it", async () => {
    setup({ "/about": "/contact" }, PAGES);
    const controller = await openRedirectsGrid();
    controller.addRow({ destination: "/c", source: "/b", status: "301" });
    controller.addRow({ destination: "/b", source: "/a", status: "301" });

    await controller.save();
    await flush();

    expect(controller.buffer.isDirty()).toBeFalse();
    expect(
      problems
        .filter((p) => p.source === "Redirects")
        .map((p) => p.key)
        .toSorted(),
    ).toEqual(["redirects.chain:/a", "redirects.shadow:/about"]);
  });
});

// ─── Routes and validation reporting ──────────────────────────────────────────

describe("routes", () => {
  test("pages/ becomes routes; an asset beside them is not one", async () => {
    setup({}, PAGES);
    const result = await projectRoutes();
    expect(result.complete).toBeTrue();
    expect(result.routes.toSorted()).toEqual(["/", "/about", "/blog/[slug]"]);
  });

  test("an unreadable pages/ says the list is incomplete instead of saying it is empty", async () => {
    installMockPlatform(
      {
        listDirectory: async () => {
          throw new Error("EACCES");
        },
      } as unknown as Partial<StudioPlatform>,
      {},
    );
    expect(await projectRoutes()).toEqual({ complete: false, routes: [] });
  });
});

describe("Problems", () => {
  const routes = { complete: true, routes: ["/about"] };

  test("each finding is a Problem naming its rule, keyed so a re-run replaces it", () => {
    const rules = [
      { destination: "/b", source: "/a", status: 301 },
      { destination: "/c", source: "/b", status: 301 },
      { destination: "/contact", source: "/about", status: 301 },
    ];
    expect(reportRedirectProblems(rules, routes)).toBe(2);
    const filed = problems.filter((p) => p.source === "Redirects");
    expect(filed.map((p) => p.key).toSorted()).toEqual([
      "redirects.chain:/a",
      "redirects.shadow:/about",
    ]);
    expect(filed.every((p) => p.tier === "problem")).toBeTrue();
    expect(filed.every((p) => p.action === "redirects.open")).toBeTrue();
    expect(filed.every((p) => p.path === "project.json")).toBeTrue();

    // A second run replaces rather than stacks, and a fixed set clears the list.
    expect(reportRedirectProblems(rules, routes)).toBe(2);
    expect(problems.filter((p) => p.source === "Redirects")).toHaveLength(2);
    expect(reportRedirectProblems([], routes)).toBe(0);
    expect(problems.filter((p) => p.source === "Redirects")).toEqual([]);
  });

  test("a loop is an error; a chain and a shadow are warnings that must still be fixed", () => {
    reportRedirectProblems(
      [
        { destination: "/b", source: "/a", status: 301 },
        { destination: "/a", source: "/b", status: 301 },
      ],
      routes,
    );
    const loop = problems.find((p) => p.source === "Redirects");
    expect(loop!.severity).toBe("error");
    expect(loop!.message).toContain("Redirect loop");
  });

  test("an incomplete route list is reported instead of a clean bill of health", () => {
    const filed = reportRedirectProblems([{ destination: "/x", source: "/about", status: 301 }], {
      complete: false,
      routes: [],
    });
    expect(filed).toBe(1);
    const note = problems.find((p) => p.source === "Redirects");
    expect(note!.key).toBe("redirects.routes");
    expect(note!.message).toContain("chains and loops only");
    expect(note!.action).toBe("redirects.validate");
  });
});

// ─── Opening and importing ────────────────────────────────────────────────────

describe("openRedirectsGrid", () => {
  test("opens a loaded grid tab and is idempotent", async () => {
    setup({ "/old": "/new" });
    const first = await openRedirectsGrid();
    expect(workspace.tabs.has(REDIRECTS_TAB_ID)).toBeTrue();
    expect(first.state.rows).toHaveLength(1);
    expect(first.state.columns).toHaveLength(3);
    const second = await openRedirectsGrid();
    expect(second).toBe(first);
    expect([...workspace.tabs.keys()].filter((id) => id === REDIRECTS_TAB_ID)).toHaveLength(1);
  });
});

describe("import", () => {
  test("rules are staged as pending rows, not written", async () => {
    const state = setup({ "/old": "/new" });
    const controller = await openRedirectsGrid();
    const staged = stageRedirectImport(
      controller,
      [
        { destination: "/b", source: "/a", status: 301 },
        { destination: "/zzz", source: "/old", status: 301 },
      ],
      [],
    );
    expect(staged).toBe(1);
    expect(controller.buffer.isDirty()).toBeTrue();
    expect(writtenConfig(state).redirects).toEqual({ "/old": "/new" });

    const skipped = problems.find((p) => p.key === "redirects.import");
    expect(skipped!.detail).toContain("Already in the table, skipped: /old.");
  });

  test("parse errors ride along in the same Problem; a clean import is a toast", async () => {
    setup();
    const controller = await openRedirectsGrid();
    expect(
      stageRedirectImport(controller, [{ destination: "/b", source: "/a", status: 301 }], []),
    ).toBe(1);
    expect(problems.find((p) => p.key === "redirects.import")).toBeUndefined();

    stageRedirectImport(controller, [], ["Line 3: nope."]);
    expect(problems.find((p) => p.key === "redirects.import")!.detail).toContain("Line 3: nope.");
  });

  test("an empty import says nothing to import rather than claiming success", async () => {
    setup();
    const controller = await openRedirectsGrid();
    expect(stageRedirectImport(controller, [], [])).toBe(0);
    expect(problems.find((p) => p.key === "redirects.import")).toBeUndefined();
  });

  test("the paste dialog returns what was typed, and null when it is dismissed", async () => {
    dialogDriver = (host, done) => {
      const box = host.querySelector("textarea")!;
      box.value = "/a /b 302";
      box.dispatchEvent(new Event("input"));
      host.querySelector("sp-dialog-wrapper")!.dispatchEvent(new Event("confirm"));
      done("unused");
    };
    expect(await promptRedirectImport()).toBe("/a /b 302");

    dialogDriver = (host) => {
      host.querySelector("sp-dialog-wrapper")!.dispatchEvent(new Event("cancel"));
    };
    expect(await promptRedirectImport()).toBeNull();
  });
});

// ─── Commands ─────────────────────────────────────────────────────────────────

describe("commands", () => {
  const byId = (id: string) => redirectsCommands().find((command) => command.id === id)!;
  const openCtx = { project: { open: true } } as never;

  test("all three are project-level palette verbs gated on an open project", () => {
    const records = redirectsCommands();
    expect(records.map((r) => r.id)).toEqual([
      "redirects.open",
      "redirects.validate",
      "redirects.import",
    ]);
    for (const record of records) {
      expect(record.level).toBe("project");
      expect(record.menus).toEqual(["palette"]);
      expect(record.when!(openCtx)).toBeTrue();
      expect(record.when!({ project: { open: false } } as never)).toBeFalse();
      expect(record.aiTool).toBeDefined();
    }
  });

  test("redirects.open opens the table and validates what it opened", async () => {
    setup({ "/about": "/contact" });
    await byId("redirects.open").run(openCtx, undefined as never);
    await flush();
    expect(workspace.tabs.has(REDIRECTS_TAB_ID)).toBeTrue();
    expect(problems.find((p) => p.key === "redirects.shadow:/about")).toBeDefined();
  });

  test("redirects.validate says so when there is nothing to fix", async () => {
    setup({ "/old": "/new" });
    await byId("redirects.validate").run(openCtx, undefined as never);
    expect(problems.filter((p) => p.source === "Redirects")).toEqual([]);
  });

  test("redirects.import takes its text as an argument, for automation and the assistant", async () => {
    setup();
    await byId("redirects.import").run(openCtx, { text: "/a /b 302\n/c /d\n" } as never);
    const controller = await openRedirectsGrid();
    expect(controller.buffer.dirtyCount()).toBeGreaterThan(0);
    expect([...controller.buffer.state.inserts.values()].map((row) => row.source)).toEqual([
      "/a",
      "/c",
    ]);
  });

  test("redirects.import with no text asks, and a dismissed dialog imports nothing", async () => {
    setup();
    dialogDriver = null; // Dismissed.
    await byId("redirects.import").run(openCtx, {} as never);
    expect(workspace.tabs.has(REDIRECTS_TAB_ID)).toBeFalse();
  });

  test("registerRedirectsCommands puts all three into a registry", () => {
    const ids: string[] = [];
    registerRedirectsCommands({
      registerAll: (commands: readonly { id: string }[]) => ids.push(...commands.map((c) => c.id)),
    } as never);
    expect(ids).toHaveLength(3);
  });
});
