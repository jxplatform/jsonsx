/// <reference lib="dom" />
/**
 * Data grid — the owner console over the platform's data surface (plan Part 4a).
 *
 * Integration: the settings modal's contributed sections stay fully generic — extension-sections
 * passes this module's {@link dataSectionActions} into the ContributedSectionOptions.actions slot
 * for the data-domain sections ("connections"/"data") whenever the platform implements the
 * protocol's data routes. Those actions surface Test Connection, Push Schema (dry-run plan
 * confirmation before apply), and Open Data Grid; the grid itself is a full-surface modal
 * (settings-modal pattern) gated on `platform.dataRows`.
 *
 * The grid is v1-minimal by design: connection + table picker (declared tables plus system tables
 * discovered from backend introspection), 50-row pagination, inline cell edit committed via
 * dataUpdateRow keyed on the introspected primary key, an add-row footer, and two-step per-row
 * delete. No filter/sort UI.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { openModal } from "../ui/layers";
import {
  dataSurfaceAvailable,
  deleteRow,
  fetchConnections,
  fetchRows,
  insertRow,
  pushSchema,
  testConnection,
  updateRow,
} from "../services/data-service";
import type { TemplateResult } from "lit-html";
import type {
  DataColumnMeta,
  DataConnectionInfo,
  DataConnectionTestResult,
  DataPushResult,
} from "../types";
import type { SectionActionsContext } from "../settings/contributed-section";

export const DATA_GRID_PAGE_SIZE = 50;

// ─── Grid state ───────────────────────────────────────────────────────────────

interface GridState {
  connections: DataConnectionInfo[];
  connection: string | null;
  table: string | null;
  columns: DataColumnMeta[];
  rows: Record<string, unknown>[];
  total: number;
  offset: number;
  loading: boolean;
  error: string | null;
  /** Pk value armed for the two-step delete confirm. */
  pendingDelete: string | null;
  /** Add-row footer draft, keyed by column name. */
  draft: Record<string, string>;
}

const blankGrid = (): GridState => ({
  columns: [],
  connection: null,
  connections: [],
  draft: {},
  error: null,
  loading: false,
  offset: 0,
  pendingDelete: null,
  rows: [],
  table: null,
  total: 0,
});

let grid: GridState = blankGrid();
let gridHandle: ReturnType<typeof openModal> | null = null;

/** Reset all module UI state and close any open surfaces (test hook / project switch). */
export function resetDataGridState(): void {
  grid = blankGrid();
  gridHandle?.close();
  gridHandle = null;
  actionsState = { pushing: false, testResult: null, testing: null };
  closePushDialog();
}

/** True when the platform serves the data grid. */
export function isDataGridAvailable(): boolean {
  return dataSurfaceAvailable();
}

/** Close the grid modal. */
export function closeDataGrid(): void {
  gridHandle?.close();
  gridHandle = null;
}

/**
 * Open the data grid modal, loading connections and the first page.
 *
 * @param {{ connection?: string; table?: string }} [preselect]
 */
export async function openDataGrid(preselect: { connection?: string; table?: string } = {}) {
  if (!isDataGridAvailable() || gridHandle) {
    return;
  }
  grid = blankGrid();
  grid.loading = true;
  renderGrid();
  const res = await fetchConnections().catch(() => null);
  grid.connections = res?.connections ?? [];
  grid.connection =
    (preselect.connection &&
      grid.connections.some((c) => c.name === preselect.connection) &&
      preselect.connection) ||
    grid.connections.find((c) => c.isDefault)?.name ||
    grid.connections[0]?.name ||
    null;
  const tables = currentTables();
  grid.table =
    preselect.table && tables.includes(preselect.table) ? preselect.table : (tables[0] ?? null);
  await loadRows();
}

/** Table names of the selected connection (declared + backend-introspected system tables). */
function currentTables(): string[] {
  return grid.connections.find((c) => c.name === grid.connection)?.tables ?? [];
}

/** The primary-key column name (backend convention: "id" when nothing is flagged). */
function pkColumn(): string {
  return grid.columns.find((c) => c.pk)?.name ?? "id";
}

/** Load the current page. */
async function loadRows(): Promise<void> {
  if (!grid.table) {
    grid.rows = [];
    grid.columns = [];
    grid.total = 0;
    grid.loading = false;
    renderGrid();
    return;
  }
  grid.loading = true;
  renderGrid();
  try {
    const result = await fetchRows({
      limit: DATA_GRID_PAGE_SIZE,
      offset: grid.offset,
      table: grid.table,
      ...(grid.connection === null ? {} : { connection: grid.connection }),
    });
    grid.rows = result.rows;
    grid.columns = result.columns;
    grid.total = result.total;
    grid.error = null;
  } catch (error) {
    grid.rows = [];
    grid.columns = [];
    grid.total = 0;
    grid.error = error instanceof Error ? error.message : String(error);
  }
  grid.loading = false;
  grid.pendingDelete = null;
  renderGrid();
}

/** Commit one edited cell via dataUpdateRow, keyed on the row's pk. */
async function commitCell(
  row: Record<string, unknown>,
  column: DataColumnMeta,
  raw: string,
): Promise<void> {
  const current = row[column.name];
  const currentText = current == null ? "" : String(current);
  if (raw === currentText || !grid.table) {
    return;
  }
  try {
    const updated = await updateRow({
      pk: row[pkColumn()] as string | number,
      set: { [column.name]: raw === "" ? null : raw },
      table: grid.table,
      ...(grid.connection === null ? {} : { connection: grid.connection }),
    });
    const index = grid.rows.indexOf(row);
    if (index !== -1) {
      grid.rows[index] = updated.row;
    }
    grid.error = null;
  } catch (error) {
    grid.error = error instanceof Error ? error.message : String(error);
  }
  renderGrid();
}

/** Two-step delete: first click arms the row, second click deletes. */
async function requestDelete(pk: string): Promise<void> {
  if (grid.pendingDelete !== pk) {
    grid.pendingDelete = pk;
    renderGrid();
    return;
  }
  if (!grid.table) {
    return;
  }
  try {
    await deleteRow({
      pk,
      table: grid.table,
      ...(grid.connection === null ? {} : { connection: grid.connection }),
    });
    await loadRows();
  } catch (error) {
    grid.error = error instanceof Error ? error.message : String(error);
    grid.pendingDelete = null;
    renderGrid();
  }
}

/** Insert the add-row footer draft. */
async function commitDraft(): Promise<void> {
  if (!grid.table) {
    return;
  }
  const values: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(grid.draft)) {
    if (raw !== "") {
      values[name] = raw;
    }
  }
  try {
    await insertRow({
      table: grid.table,
      values,
      ...(grid.connection === null ? {} : { connection: grid.connection }),
    });
    grid.draft = {};
    await loadRows();
  } catch (error) {
    grid.error = error instanceof Error ? error.message : String(error);
    renderGrid();
  }
}

/** Columns editable in the grid (system-managed columns are display-only). */
function editableColumn(column: DataColumnMeta): boolean {
  return !column.pk && column.name !== "created_at" && column.name !== "updated_at";
}

function gridBody(): TemplateResult {
  if (grid.loading) {
    return html`<div class="data-grid-empty">Loading…</div>`;
  }
  if (grid.error) {
    return html`<div class="data-grid-error">${grid.error}</div>`;
  }
  if (!grid.table) {
    return html`<div class="data-grid-empty">
      No tables on this connection — push a schema first.
    </div>`;
  }
  const pk = pkColumn();
  return html`
    <table class="data-grid-table">
      <thead>
        <tr>
          ${grid.columns.map(
            (c) =>
              html`<th title=${c.type}>
                ${c.name}${c.pk ? html` <span class="data-grid-pk">pk</span>` : nothing}
              </th>`,
          )}
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${grid.rows.map((row) => {
          const pkValue = String(row[pk] ?? "");
          return html`<tr>
            ${grid.columns.map((c) =>
              editableColumn(c)
                ? html`<td>
                    <input
                      class="data-grid-cell"
                      .value=${live(row[c.name] == null ? "" : String(row[c.name]))}
                      @change=${(e: Event) =>
                        void commitCell(row, c, (e.target as HTMLInputElement).value)}
                    />
                  </td>`
                : html`<td class="data-grid-readonly">
                    ${row[c.name] == null ? "" : String(row[c.name])}
                  </td>`,
            )}
            <td>
              <sp-action-button
                quiet
                size="s"
                class="data-grid-delete"
                @click=${() => void requestDelete(pkValue)}
              >
                ${grid.pendingDelete === pkValue ? "Confirm?" : "Delete"}
              </sp-action-button>
            </td>
          </tr>`;
        })}
      </tbody>
      <tfoot>
        <tr class="data-grid-add-row">
          ${grid.columns.map((c) =>
            editableColumn(c)
              ? html`<td>
                  <input
                    class="data-grid-draft"
                    placeholder=${c.name}
                    .value=${live(grid.draft[c.name] ?? "")}
                    @input=${(e: Event) => {
                      grid.draft[c.name] = (e.target as HTMLInputElement).value;
                    }}
                  />
                </td>`
              : html`<td></td>`,
          )}
          <td>
            <sp-action-button size="s" class="data-grid-add" @click=${() => void commitDraft()}>
              Add
            </sp-action-button>
          </td>
        </tr>
      </tfoot>
    </table>
  `;
}

function renderGrid(): void {
  const first = grid.total === 0 ? 0 : grid.offset + 1;
  const last = grid.offset + grid.rows.length;
  const tpl = html`
    <sp-underlay open @close=${closeDataGrid}></sp-underlay>
    <div class="settings-modal data-grid-modal">
      <div class="settings-modal-header">
        <h2 class="settings-modal-title">Data</h2>
        <sp-picker
          size="s"
          class="data-grid-connection"
          value=${grid.connection ?? ""}
          @change=${(e: Event) => {
            grid.connection = (e.target as HTMLInputElement).value || null;
            grid.offset = 0;
            grid.table = currentTables()[0] ?? null;
            void loadRows();
          }}
        >
          ${grid.connections.map(
            (c) => html`<sp-menu-item value=${c.name}>${c.name}</sp-menu-item>`,
          )}
        </sp-picker>
        <sp-picker
          size="s"
          class="data-grid-tables"
          value=${grid.table ?? ""}
          @change=${(e: Event) => {
            grid.table = (e.target as HTMLInputElement).value || null;
            grid.offset = 0;
            grid.draft = {};
            void loadRows();
          }}
        >
          ${currentTables().map(
            (table) => html`<sp-menu-item value=${table}>${table}</sp-menu-item>`,
          )}
        </sp-picker>
        <sp-action-button quiet size="s" title="Close" @click=${closeDataGrid}>
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      <div class="settings-modal-body data-grid-body">${gridBody()}</div>
      <div class="data-grid-footer">
        <sp-action-button
          size="s"
          class="data-grid-prev"
          ?disabled=${grid.offset === 0}
          @click=${() => {
            grid.offset = Math.max(0, grid.offset - DATA_GRID_PAGE_SIZE);
            void loadRows();
          }}
          >Prev</sp-action-button
        >
        <span class="data-grid-range">${first}–${last} of ${grid.total}</span>
        <sp-action-button
          size="s"
          class="data-grid-next"
          ?disabled=${grid.offset + DATA_GRID_PAGE_SIZE >= grid.total}
          @click=${() => {
            grid.offset += DATA_GRID_PAGE_SIZE;
            void loadRows();
          }}
          >Next</sp-action-button
        >
      </div>
    </div>
  `;
  if (gridHandle) {
    gridHandle.update(tpl);
  } else {
    gridHandle = openModal(tpl);
  }
}

// ─── Push dialog (dry-run plan confirmation before apply) ─────────────────────

interface PushDialogState {
  handle: ReturnType<typeof openModal>;
  connection: string | undefined;
  phase: "loading" | "confirm" | "applying" | "done";
  plan: DataPushResult | null;
  result: DataPushResult | null;
  onDone: () => void;
}

let pushDialog: PushDialogState | null = null;

/** Close the push dialog (also part of resetDataGridState). */
function closePushDialog(): void {
  pushDialog?.handle.close();
  pushDialog = null;
}

/** Start a push: dry-run first, then a confirmation dialog gates the apply. */
export async function startPush(connection: string | undefined, onDone: () => void) {
  if (pushDialog) {
    return;
  }
  const handle = openModal(html``);
  pushDialog = { connection, handle, onDone, phase: "loading", plan: null, result: null };
  renderPushDialog();
  const plan = await pushSchema({
    dryRun: true,
    ...(connection === undefined ? {} : { connection }),
  });
  if (!pushDialog) {
    return;
  }
  pushDialog.plan = plan;
  pushDialog.phase = "confirm";
  renderPushDialog();
}

async function applyPush(): Promise<void> {
  if (!pushDialog) {
    return;
  }
  pushDialog.phase = "applying";
  renderPushDialog();
  const result = await pushSchema(
    pushDialog.connection === undefined ? {} : { connection: pushDialog.connection },
  );
  if (!pushDialog) {
    return;
  }
  pushDialog.result = result;
  pushDialog.phase = "done";
  renderPushDialog();
  pushDialog.onDone();
}

function pushDialogBody(state: PushDialogState): TemplateResult {
  if (state.phase === "loading" || state.phase === "applying") {
    return html`<div class="push-dialog-status">
      ${state.phase === "loading" ? "Compiling plan…" : "Applying…"}
    </div>`;
  }
  const shown = state.phase === "done" ? state.result : state.plan;
  const steps = shown?.plan ?? [];
  const warnings = shown?.warnings ?? [];
  const errors = shown?.errors ?? [];
  return html`
    <div class="push-dialog-plan">
      ${state.phase === "done"
        ? html`<div class="push-dialog-status">
            ${shown?.applied ? "Schema applied." : "Push failed."}
          </div>`
        : steps.length === 0 && errors.length === 0
          ? html`<div class="push-dialog-status">Nothing to push — the schema is up to date.</div>`
          : nothing}
      <ul class="push-dialog-steps">
        ${steps.map(
          (step) => html`<li class="push-step push-step-${step.kind}">${step.summary}</li>`,
        )}
      </ul>
      ${warnings.map((w) => html`<div class="push-dialog-warning">${w}</div>`)}
      ${errors.map((e) => html`<div class="push-dialog-error">${e}</div>`)}
    </div>
  `;
}

function renderPushDialog(): void {
  if (!pushDialog) {
    return;
  }
  const state = pushDialog;
  const confirmable = state.phase === "confirm" && (state.plan?.plan.length ?? 0) > 0;
  const tpl = html`
    <sp-underlay open @close=${closePushDialog}></sp-underlay>
    <div class="settings-modal push-dialog">
      <div class="settings-modal-header">
        <h2 class="settings-modal-title">
          Push Schema${state.connection ? html` — ${state.connection}` : nothing}
        </h2>
      </div>
      <div class="settings-modal-body">${pushDialogBody(state)}</div>
      <div class="push-dialog-actions">
        <sp-action-button size="s" class="push-cancel" @click=${closePushDialog}>
          ${state.phase === "done" ? "Close" : "Cancel"}
        </sp-action-button>
        ${confirmable
          ? html`<sp-action-button
              size="s"
              emphasized
              class="push-apply"
              @click=${() => void applyPush()}
              >Apply</sp-action-button
            >`
          : nothing}
      </div>
    </div>
  `;
  state.handle.update(tpl);
}

// ─── Contributed-section actions (Test / Push / Open grid) ────────────────────

interface ActionsState {
  /** Connection currently being tested, when any. */
  testing: string | null;
  testResult: (DataConnectionTestResult & { connection: string }) | null;
  pushing: boolean;
}

let actionsState: ActionsState = { pushing: false, testResult: null, testing: null };

/**
 * The actions renderer for a data-domain contributed section, or null when the section is not
 * data-domain or the platform lacks the data routes. Section keys "connections"/"data" are the
 * connector's host wire contract (the same literals the backend's data routes serve) — the generic
 * contributed-section renderer itself stays extension-agnostic.
 *
 * @param {string} sectionKey
 * @returns {((ctx: SectionActionsContext) => TemplateResult) | null}
 */
export function dataSectionActions(
  sectionKey: string,
): ((ctx: SectionActionsContext) => TemplateResult) | null {
  if ((sectionKey !== "connections" && sectionKey !== "data") || !dataSurfaceAvailable()) {
    return null;
  }
  return (ctx) => renderSectionActions(sectionKey, ctx);
}

async function runTest(connection: string, rerender: () => void): Promise<void> {
  actionsState.testing = connection;
  actionsState.testResult = null;
  rerender();
  const result = await testConnection(connection);
  actionsState.testing = null;
  actionsState.testResult = { ...result, connection };
  rerender();
}

function renderSectionActions(sectionKey: string, ctx: SectionActionsContext): TemplateResult {
  const { selected, rerender } = ctx;
  const { testResult } = actionsState;
  // On the connections section a selected entry scopes both Test and Push to that connection.
  const pushTarget = sectionKey === "connections" && selected ? selected : undefined;
  return html`
    <div class="data-section-actions">
      ${sectionKey === "connections"
        ? html`<sp-action-button
            size="s"
            class="data-action-test"
            ?disabled=${!selected || actionsState.testing !== null}
            @click=${() => {
              if (selected) {
                void runTest(selected, rerender);
              }
            }}
          >
            ${actionsState.testing ? "Testing…" : "Test Connection"}
          </sp-action-button>`
        : nothing}
      <sp-action-button
        size="s"
        class="data-action-push"
        @click=${() => void startPush(pushTarget, rerender)}
      >
        Push Schema
      </sp-action-button>
      <sp-action-button
        size="s"
        class="data-action-grid"
        @click=${() =>
          void openDataGrid(
            sectionKey === "connections" && selected ? { connection: selected } : {},
          )}
      >
        Open Data Grid
      </sp-action-button>
      ${testResult
        ? html`<span
            class="data-test-result ${testResult.ok ? "ok" : "failed"}"
            title=${testResult.error ?? ""}
          >
            ${testResult.connection}:
            ${testResult.ok ? "connected" : (testResult.error ?? "failed")}
          </span>`
        : nothing}
    </div>
  `;
}
