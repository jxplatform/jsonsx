/// <reference lib="dom" />
/**
 * Data section actions — the owner console entry points over the platform's data surface.
 *
 * Integration: the settings modal's contributed sections stay fully generic — extension-sections
 * passes this module's {@link dataSectionActions} into the ContributedSectionOptions.actions slot
 * for the data-domain sections ("connections"/"data") whenever the platform implements the
 * protocol's data routes. Those actions surface Test Connection, Push Schema (dry-run plan
 * confirmation before apply), and Open Data Grid — which opens the grid-tab source picker; table
 * editing itself lives in the spreadsheet grid tabs (src/grid/), which replaced the old modal grid
 * at feature parity (paging, cell edit, add/delete row) and added batch save with undo.
 */

import { html, nothing } from "lit-html";
import { openModal } from "../ui/layers";
import { dataSurfaceAvailable, pushSchema, testConnection } from "../services/data-service";
import { openGridSourcePicker } from "../grid/grid-open";
import type { TemplateResult } from "lit-html";
import type { DataConnectionTestResult, DataPushResult } from "../types";
import type { SectionActionsContext } from "../settings/contributed-section";

// ─── Grid opening (delegates to the grid-tab source picker) ──────────────────

/** Reset all module UI state and close any open surfaces (test hook / project switch). */
export function resetDataGridState(): void {
  actionsState = { pushing: false, testResult: null, testing: null };
  closePushDialog();
}

/** True when the platform serves the data grid. */
export function isDataGridAvailable(): boolean {
  return dataSurfaceAvailable();
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
  const handle = openModal(html``, { label: "Push Schema", onDismiss: closePushDialog });
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
      ${
        state.phase === "done"
          ? html`<div class="push-dialog-status">
              ${shown?.applied ? "Schema applied." : "Push failed."}
            </div>`
          : steps.length === 0 && errors.length === 0
            ? html`<div class="push-dialog-status">
                Nothing to push — the schema is up to date.
              </div>`
            : nothing
      }
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
        ${
          confirmable
            ? html`<sp-action-button
                size="s"
                emphasized
                class="push-apply"
                @click=${() => void applyPush()}
                >Apply</sp-action-button
              >`
            : nothing
        }
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
      ${
        sectionKey === "connections"
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
          : nothing
      }
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
        @click=${() => void openGridSourcePicker()}
      >
        Open Data Grid
      </sp-action-button>
      ${
        testResult
          ? html`<span
              class="data-test-result ${testResult.ok ? "ok" : "failed"}"
              title=${testResult.error ?? ""}
            >
              ${testResult.connection}:
              ${testResult.ok ? "connected" : (testResult.error ?? "failed")}
            </span>`
          : nothing
      }
    </div>
  `;
}
