/// <reference lib="dom" />
/**
 * Redirects as a {@link GridSource} — the editor §11.4 asks for, over the table the grid already
 * is.
 *
 * `project.json`'s `redirects` map is tabular, so it does not need a bespoke editor: it needs the
 * one Studio already has. Columns, inline editing, add/delete rows, undo, the dirty dot, ⌘S,
 * find-and-replace, saved views and CSV export all arrive with the contract. What this module adds
 * is the three things a redirect table needs and a spreadsheet cannot know — that a chain costs a
 * round trip, that a loop is a broken page, and that a rule shadowed by a real route is dead config
 * — and it says each one as a **Problem naming the rule** (studio.md §16) rather than a toast that
 * disappears before the author has read the path it printed.
 *
 * **Every write goes through the one door.** Rows commit with {@link commitProjectConfig}, so a
 * redirect edit is a transaction on the `project.json` document with the same undo, the same
 * serialisation and the same refusal-with-a-Problem as every other configuration write (P6.1). This
 * module never touches `platform.writeFile`.
 *
 * **Row keys are positions.** A redirect's identity in `project.json` IS its source string, and the
 * source is the cell an author most often edits — so keying rows by it would turn every rename into
 * a delete plus an insert and lose the row's pending edits. Positions survive a rename; an insert
 * or a delete is structural and makes the controller reload, which re-keys everything.
 *
 * @docs studio/projects/settings
 */

import { html } from "lit-html";
import { getPlatform } from "../platform";
import { projectState } from "../store";
import { clearProblems, notify } from "../services/notify";
import { showDialog } from "../ui/layers";
import { activateTab, openTab, workspace } from "../workspace/workspace";
import { PROJECT_CONFIG_PATH, commitProjectConfig } from "../tabs/project-config";
import { pageRoute } from "../panels/tab-strip";
import { createGridController, getGridController } from "./grid-controller";
import {
  REDIRECT_TARGETS,
  REWRITE,
  configFromRules,
  parseRedirectImport,
  rulesFromConfig,
  validateRedirects,
} from "./redirects";
import { optionalStringArg, stringProperty } from "../commands/command-args";
import type { RedirectConfig, RedirectRule, RedirectTarget } from "./redirects";
import type {
  CommitResult,
  GridCellValue,
  GridColumn,
  GridEditBatch,
  GridRow,
  GridRowsResult,
  GridSource,
} from "./grid-source";
import type { GridController } from "./grid-controller";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/**
 * The redirect table's tab id.
 *
 * A `grid://` id, in the space `grid-source.ts` owns — but NOT yet one of its `GridTabRef` kinds,
 * which is a one-line union member plus three switch cases in a file this workstream does not own.
 * Until that lands `gridTabLabel()` cannot name the tab and the strip falls back to "Untitled".
 */
export const REDIRECTS_TAB_ID = "grid://redirects";

/** Who the Problems list attributes a redirect finding to. Also the key it clears them by. */
export const REDIRECTS_PROBLEM_SOURCE = "Redirects";

/** Placeholder document for the virtual tab — the grid never reads it; save routes to the source. */
const GRID_STUB_DOCUMENT = { children: [], tagName: "div" };

/** Extensions the router treats as pages. Anything else under `pages/` is an asset, not a route. */
const PAGE_EXTENSIONS = [".json", ".md", ".html"];

// ─── Columns and rows ─────────────────────────────────────────────────────────

/**
 * Three columns, all editable.
 *
 * `source` is not declared `pk`: a primary-key column is frozen and read-only by contract, and
 * retargeting an old URL is the second most common edit a redirect table sees.
 */
export function redirectColumns(): GridColumn[] {
  return [
    {
      editable: true,
      field: "source",
      kind: "string",
      required: true,
      title: "Source",
      widthHint: 260,
    },
    {
      editable: true,
      field: "destination",
      kind: "string",
      required: true,
      title: "Destination",
      widthHint: 260,
    },
    {
      editable: true,
      field: "status",
      kind: "enum",
      schema: { enum: REDIRECT_TARGETS.map(String) },
      title: "Status",
      widthHint: 110,
    },
  ];
}

/** One rule as a grid row. Status is text because that is what an enum editor traffics in. */
export function redirectRow(rule: RedirectRule, index: number): GridRow {
  return {
    cells: { destination: rule.destination, source: rule.source, status: String(rule.status) },
    key: String(index),
  };
}

/** The live redirects map, straight off the configuration document. */
function currentConfig(): RedirectConfig | undefined {
  return projectState?.projectConfig?.redirects as RedirectConfig | undefined;
}

/**
 * A cell's text back to a target. An unrecognised value becomes the string itself, so
 * {@link ruleErrors} can name what the author actually typed rather than reporting a silent 0.
 */
function parseTarget(raw: string): RedirectTarget {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === REWRITE) {
    return REWRITE;
  }
  const value = Number(trimmed);
  return Number.isInteger(value) ? (value as RedirectTarget) : (trimmed as RedirectTarget);
}

/** A cell bag back to a rule. An unrecognised target is refused by {@link ruleErrors}. */
function ruleFromCells(cells: Record<string, GridCellValue>): RedirectRule {
  const text = (value: GridCellValue | undefined) =>
    value === null || value === undefined ? "" : String(value);
  return {
    destination: text(cells.destination).trim(),
    source: text(cells.source).trim(),
    status: parseTarget(text(cells.status)),
  };
}

/** Why one rule cannot be written, or null. */
function ruleErrors(rule: RedirectRule): string | null {
  if (rule.source === "") {
    return "A source path is required.";
  }
  if (rule.destination === "") {
    return "A destination is required.";
  }
  if (!REDIRECT_TARGETS.includes(rule.status)) {
    return `Status must be one of ${REDIRECT_TARGETS.join(", ")}.`;
  }
  return null;
}

// ─── Routes, for the shadow check ─────────────────────────────────────────────

export interface ProjectRoutes {
  routes: string[];
  /** False when a directory could not be listed — the shadow check MUST NOT run on a partial list. */
  complete: boolean;
}

/**
 * The site's real routes, derived from `pages/` by the same function the tab strip labels with.
 *
 * `complete` is the honest half: an unreadable directory means the route list is short, and a short
 * list makes every shadowed rule look clean. The caller reports the gap instead of the finding.
 */
export async function projectRoutes(): Promise<ProjectRoutes> {
  const platform = getPlatform();
  const routes = new Set<string>();
  let complete = true;

  const walkDir = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await platform.listDirectory(dir);
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries) {
      const path = entry.path || `${dir}/${entry.name}`;
      if (entry.type === "directory") {
        await walkDir(path);
      } else if (PAGE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
        const route = pageRoute(path);
        if (route !== null) {
          routes.add(route);
        }
      }
    }
  };
  await walkDir("pages");
  return { complete, routes: [...routes] };
}

/**
 * Re-file the redirect Problems: one per finding, named by its rule, keyed so a re-run replaces
 * rather than stacks.
 *
 * Previous findings are cleared first, so a fixed chain stops being listed without anybody having
 * kept its record id — and a run that finds nothing leaves an empty list rather than a stale one.
 *
 * @returns The number of Problems filed.
 */
export function reportRedirectProblems(
  rules: readonly RedirectRule[],
  routes: ProjectRoutes,
): number {
  clearProblems((record) => record.source === REDIRECTS_PROBLEM_SOURCE);
  const problems = validateRedirects(rules, routes.complete ? routes.routes : []);
  for (const problem of problems) {
    notify(problem.rule === "loop" ? "error" : "warn", problem.message, {
      action: "redirects.open",
      detail: problem.detail,
      key: `redirects.${problem.rule}:${problem.source}`,
      path: PROJECT_CONFIG_PATH,
      source: REDIRECTS_PROBLEM_SOURCE,
      tier: "problem",
    });
  }
  if (!routes.complete) {
    notify.warn("Redirects were checked for chains and loops only.", {
      action: "redirects.validate",
      detail:
        "pages/ could not be listed, so this run cannot say whether a rule is shadowed by a real " +
        "route. Reporting no shadowed rules from an incomplete list would be a guess.",
      key: "redirects.routes",
      path: "pages",
      source: REDIRECTS_PROBLEM_SOURCE,
      tier: "problem",
    });
    return problems.length + 1;
  }
  return problems.length;
}

// ─── The source ───────────────────────────────────────────────────────────────

/**
 * The redirect table as a grid source.
 *
 * Rows are read from the live configuration each time, because `project.json` is a document and an
 * undo on its tab is a legitimate way for the table to change underneath this.
 */
export function createRedirectsSource(): GridSource {
  const load = () => rulesFromConfig(currentConfig());

  return {
    backingPaths: () => new Map([[PROJECT_CONFIG_PATH, "*"]]),
    capabilities: { delete: true, insert: true, remotePaging: false, remoteSort: false },
    columns: () => Promise.resolve(redirectColumns()),

    /**
     * Write the batch, then say what happened to **every** row in it.
     *
     * The result is not a log: `edit-buffer.ts`'s `applyCommitResult` clears a pending change only
     * when an outcome naming it comes back `ok`. An arm that writes the file and reports nothing
     * leaves its rows pending forever — the dirty dot never goes out, `grid-controller` counts the
     * write as a failure and skips the reload, and the table shows a phantom row on top of the one
     * it just saved. All three arms report; a refusal reports through {@link refuseAll}.
     */
    async commit(batch: GridEditBatch): Promise<CommitResult> {
      const rules = load();
      const result: CommitResult = { cells: [], deletes: [], inserts: [] };

      // Cell edits land on the rule at that position; a row whose position no longer exists is a
      // Row the author cannot see, so it is refused rather than written somewhere else.
      for (const cell of batch.cells) {
        const rule = rules[Number(cell.rowKey)];
        if (!rule) {
          result.cells.push({
            error: "This row is no longer in project.json — refresh the grid.",
            field: cell.field,
            ok: false,
            rowKey: cell.rowKey,
            stale: true,
          });
          continue;
        }
        const text = cell.value === null ? "" : String(cell.value);
        if (cell.field === "status") {
          rule.status = parseTarget(text);
        } else if (cell.field === "source") {
          rule.source = text.trim();
        } else {
          rule.destination = text.trim();
        }
        result.cells.push({ field: cell.field, ok: true, rowKey: cell.rowKey });
      }

      const deleted = new Set(batch.deletes.map((row) => Number(row.rowKey)));
      const next = rules.filter((_rule, index) => !deleted.has(index));
      for (const row of batch.deletes) {
        result.deletes.push({ ok: true, rowKey: row.rowKey });
      }
      for (const insert of batch.inserts) {
        next.push(ruleFromCells(insert.cells));
        result.inserts.push({ ok: true, tempKey: insert.tempKey });
      }

      // Validity and uniqueness are decided BEFORE anything is written: a half-written redirects
      // Map is a site with some of its old URLs working.
      const seen = new Set<string>();
      const failures: string[] = [];
      for (const rule of next) {
        const error = ruleErrors(rule) ?? (seen.has(rule.source) ? `Duplicate source.` : null);
        if (error) {
          failures.push(`${rule.source || "(blank)"} — ${error}`);
        }
        seen.add(rule.source);
      }
      if (failures.length > 0) {
        return refuseAll(batch, failures.join(" "));
      }

      // `undefined` CLEARS the key (see `commitProjectConfig`): an empty table should leave no
      // `"redirects": {}` behind. The local type spells the undefined out, which
      // `exactOptionalPropertyTypes` will not let `Partial<ProjectConfig>` do.
      const patch: { redirects: RedirectConfig | undefined } = {
        redirects: next.length > 0 ? configFromRules(next) : undefined,
      };
      const commit = await commitProjectConfig(patch as Partial<ProjectConfig>);
      if (!commit.ok) {
        // `commitProjectConfig` already filed the Problem; repeating it would list one failure
        // Twice. The cell errors are what keep the rows pending and marked.
        return refuseAll(batch, "project.json could not be written — see Problems.");
      }
      reportRedirectProblems(next, await projectRoutes());
      return result;
    },

    id: REDIRECTS_TAB_ID,
    label: "Redirects",
    refresh: () => Promise.resolve(),
    rows(): Promise<GridRowsResult> {
      const rules = load();
      return Promise.resolve({
        rows: rules.map((rule, index) => redirectRow(rule, index)),
        total: rules.length,
      });
    },
  };
}

/** Mark every pending change failed with one reason — a refusal is all-or-nothing here. */
function refuseAll(batch: GridEditBatch, error: string): CommitResult {
  return {
    cells: batch.cells.map((cell) => ({
      error,
      field: cell.field,
      ok: false,
      rowKey: cell.rowKey,
    })),
    deletes: batch.deletes.map((row) => ({ error, ok: false, rowKey: row.rowKey })),
    inserts: batch.inserts.map((row) => ({ error, ok: false, tempKey: row.tempKey })),
  };
}

// ─── Opening ──────────────────────────────────────────────────────────────────

/**
 * Open (or activate) the redirect table, and hand back its controller.
 *
 * Idempotent, and awaits the first load, so a caller that wants to stage imported rows into the
 * buffer has columns to stage them against.
 */
export async function openRedirectsGrid(): Promise<GridController> {
  const existing = workspace.tabs.get(REDIRECTS_TAB_ID);
  if (existing) {
    activateTab(REDIRECTS_TAB_ID);
    const controller = getGridController(existing);
    if (controller) {
      return controller;
    }
  }
  const tab =
    existing ??
    openTab({
      capabilities: { modes: ["grid"] },
      document: structuredClone(GRID_STUB_DOCUMENT),
      documentPath: null,
      id: REDIRECTS_TAB_ID,
    });
  const controller = createGridController(tab, createRedirectsSource());
  await controller.load();
  return controller;
}

// ─── Import ───────────────────────────────────────────────────────────────────

/** The paste box. One textarea, because both formats are things an author copies out of a file. */
export function promptRedirectImport(): Promise<string | null> {
  let text = "";
  return showDialog<string | null>(
    (done) => html`
      <sp-dialog-wrapper
        open
        dismissable
        underlay
        headline="Import Redirects"
        confirm-label="Import"
        cancel-label="Cancel"
        @confirm=${() => done(text)}
        @cancel=${() => done(null)}
        @close=${() => done(null)}
      >
        <p>
          Paste a Netlify/Cloudflare <code>_redirects</code> file, or CSV with
          <code>source,destination,status</code> columns. Rows are staged for review — nothing is
          written until you save.
        </p>
        <textarea
          class="jx-grid-input jx-redirect-import"
          rows="10"
          placeholder="/old-page  /new-page  301"
          @input=${(e: Event) => (text = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
      </sp-dialog-wrapper>
    `,
    { region: "redirects/import" },
  );
}

/**
 * Stage parsed rules as pending rows on the open table.
 *
 * Staged, not written: an import is the one redirect edit an author has not read line by line, so
 * it arrives in the same reviewable, undoable buffer a typed row does. A source the table already
 * holds is skipped and named — silently overwriting a rule with a pasted one is how an import
 * quietly retargets a URL that was already correct.
 *
 * @returns How many rows were staged.
 */
export function stageRedirectImport(
  controller: GridController,
  rules: readonly RedirectRule[],
  errors: readonly string[],
): number {
  const existing = new Set(
    controller.effectiveRows().map((row) => String(row.source ?? "").trim()),
  );
  const skipped: string[] = [];
  let staged = 0;
  for (const rule of rules) {
    if (existing.has(rule.source)) {
      skipped.push(rule.source);
      continue;
    }
    existing.add(rule.source);
    controller.addRow({
      destination: rule.destination,
      source: rule.source,
      status: String(rule.status),
    });
    staged += 1;
  }

  const notes = [
    ...errors,
    ...(skipped.length > 0 ? [`Already in the table, skipped: ${skipped.join(", ")}.`] : []),
  ];
  if (notes.length > 0) {
    notify.warn(
      `Imported ${staged} redirect${staged === 1 ? "" : "s"} · ${notes.length} line${notes.length === 1 ? "" : "s"} not imported.`,
      {
        action: "redirects.import",
        detail: notes.join("\n"),
        key: "redirects.import",
        path: PROJECT_CONFIG_PATH,
        source: REDIRECTS_PROBLEM_SOURCE,
        tier: "problem",
      },
    );
  } else if (staged > 0) {
    notify.success(`Staged ${staged} redirect${staged === 1 ? "" : "s"} — review, then save.`, {
      action: "file.save",
      key: "redirects.import",
    });
  } else {
    notify.info("Nothing to import.", { key: "redirects.import" });
  }
  return staged;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * The redirect verbs.
 *
 * All three are `project` level: a redirect belongs to the site, not to whichever document happens
 * to be open. `redirects.validate` exists as a command because it is the `action` a Problem can
 * offer, and because "check this again" is what an author wants after fixing one.
 *
 * @returns {AnyCommand[]}
 */
export function redirectsCommands(): AnyCommand[] {
  return [
    {
      category: "Project",
      id: "redirects.open",
      level: "project",
      menus: ["palette"],
      group: "5_data",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description:
          "Open the site's redirect rules as an editable table, validated for chains, loops and rules shadowed by a real page.",
        name: "open_redirects",
      },
      run: async () => {
        await openRedirectsGrid();
        reportRedirectProblems(rulesFromConfig(currentConfig()), await projectRoutes());
      },
      title: "Edit Redirects",
    },
    {
      category: "Project",
      id: "redirects.validate",
      level: "project",
      menus: ["palette"],
      group: "5_data",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description:
          "Check the site's redirect rules for chains, loops and rules shadowed by a real page. Reports each finding as a Problem.",
        name: "validate_redirects",
      },
      run: async () => {
        const rules = rulesFromConfig(currentConfig());
        const filed = reportRedirectProblems(rules, await projectRoutes());
        if (filed === 0) {
          notify.success(
            `${rules.length} redirect${rules.length === 1 ? "" : "s"} checked — no chains, loops or shadowed rules.`,
            { key: "redirects.validate" },
          );
        }
      },
      title: "Validate Redirects",
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          text: stringProperty(
            "A _redirects file or CSV to import. Omit it and Studio asks for a paste.",
          ),
        },
        required: [],
        type: "object",
      },
      category: "Project",
      id: "redirects.import",
      level: "project",
      menus: ["palette"],
      group: "5_data",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description:
          "Import redirect rules from _redirects or CSV text. Rows are staged in the redirect table for review, not written.",
        name: "import_redirects",
      },
      run: async (_ctx, args) => {
        const given = optionalStringArg("redirects.import", args, "text");
        const text = given ?? (await promptRedirectImport());
        if (text === null || text.trim() === "") {
          return;
        }
        const parsed = parseRedirectImport(text);
        const controller = await openRedirectsGrid();
        stageRedirectImport(controller, parsed.rules, parsed.errors);
      },
      title: "Import Redirects…",
    },
  ];
}

/**
 * Register the redirect commands.
 *
 * @param {CommandRegistry} registry
 */
export function registerRedirectsCommands(registry: CommandRegistry): void {
  registry.registerAll(redirectsCommands());
}
