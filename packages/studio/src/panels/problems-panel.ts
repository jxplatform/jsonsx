/// <reference lib="dom" />
/**
 * Problems — everything that must be fixed, listed until it is (plan §7.1, §7.2).
 *
 * `services/notify.ts` landed the RECORD in P4 wave A: a failure is a `Notification` with `tier:
 * "problem"`, which means the app promises to keep it until somebody fixes it. This is the surface
 * that keeps the promise. Until it existed, `problems` was a reactive array with a count (the rail
 * badge, the status bar) and no way to read what was in it.
 *
 * A row is the record, rendered:
 *
 * | Field      | Renders as                                                                 |
 * | ---------- | -------------------------------------------------------------------------- |
 * | `severity` | the glyph and the row's colour                                             |
 * | `message`  | the line                                                                   |
 * | `source`   | the group heading — "Save", "Source Control", "Canvas", "Assistant"        |
 * | `path`     | a button that opens the file it names                                      |
 * | `detail`   | a disclosure with the captured log (an Activity failure puts its log here) |
 * | `action`   | a REAL button, built from the command record, not a per-call-site closure  |
 *
 * **The recovery button is the command.** Its label is the command's title, its disabled state is
 * the command's `enablement`, and its tooltip is the command's `requires` sentence — four facts a
 * callback could carry none of, and the reason `NotifyOptions.action` is a command id. A row whose
 * command the registry does not have renders no button at all, rather than a dead one.
 *
 * **One record, one host.** Problems lives in the BOTTOM DOCK — plan §7.2's table says so outright
 * ("Problems | Bottom dock ⑪, badge on the rail") and §3.2 ⑪ makes it the dock's first tab. §3.2 ③
 * also lists it among the Navigator's panels; that line loses, because a list open in two docks at
 * once is two hosts for one record, and hosting it in the Navigator spends left-dock width on
 * something that belongs under the pane grid.
 *
 * The rail keeps its button and its badge all the same — {@link railGroups} groups by LEVEL, not by
 * dock — so ⌘4 and the status bar's `panel.focus.problems` item still address Problems. They now
 * reveal it where it lives: `panels/activity-bar.ts` routes a `dock: "bottom"` rail button through
 * `toggleBottomTab` instead of `toggleActivityTab`.
 */

import { html, nothing } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { activeRegistry } from "../commands/active-registry";
import { clearProblems, dismiss, problemCount, problems } from "../services/notify";
import { registerPanel } from "./panel-registry";
import { renderEmptyState } from "./empty-state";
import type { Notification, Severity } from "../services/notify";
import type { PanelBody } from "./panel-registry";
import type { TemplateResult } from "lit-html";

/** The severity glyphs — the same four `ui/layers.ts` gives the toasts, for the same reason. */
const SEVERITY_ICON: Readonly<Record<Severity, string>> = {
  error: "✕",
  info: "ℹ",
  success: "✓",
  warn: "!",
};

/** Problems with no `source` are grouped under this heading rather than under an empty one. */
export const UNGROUPED_SOURCE = "Elsewhere";

/** One heading and the rows under it, in first-seen order. */
export interface ProblemGroup {
  source: string;
  records: Notification[];
}

/**
 * Group the list by `source`, keeping first-seen order.
 *
 * Grouped rather than sorted by severity: a reader who has just saved wants the save's failures
 * together, and the severity is already the glyph on every row. First-seen order also means a new
 * problem never reorders the rows above it, which is what makes the list readable while it grows.
 */
export function groupProblems(records: readonly Notification[] = problems): ProblemGroup[] {
  const groups: ProblemGroup[] = [];
  for (const record of records) {
    const source = record.source ?? UNGROUPED_SOURCE;
    const group = groups.find((candidate) => candidate.source === source);
    if (group) {
      group.records.push(record);
    } else {
      groups.push({ records: [record], source });
    }
  }
  return groups;
}

/**
 * Open the file a problem names.
 *
 * Lazily imported for the reason `panels/properties-panel.ts` and `panels/empty-state.ts` already
 * are: this module is on `shell.ts`'s static import path (the Bottom dock is mounted from there),
 * and a static edge would drag the file browser and the format host into the shell's own graph.
 */
function openProblemPath(path: string): void {
  void import("../files/files.js").then((m) => m.openFileInTab(path));
}

/** The recovery button, or `nothing` when the record named no command or the registry lacks it. */
function actionTpl(record: Notification): TemplateResult | typeof nothing {
  const id = record.action;
  const registry = id === undefined ? null : activeRegistry();
  if (!registry || id === undefined || !registry.get(id) || !registry.isVisible(id)) {
    return nothing;
  }
  const command = registry.get(id)!;
  const reason = registry.disabledReason(id);
  return html`<button
    class="problem-action"
    ?disabled=${reason !== undefined}
    title=${reason === undefined ? command.title : `${command.title} — requires ${reason}`}
    @click=${() => {
      void registry.run(id, record.actionArgs);
    }}
  >
    ${command.title}
  </button>`;
}

/** One problem. */
function problemTpl(record: Notification): TemplateResult {
  return html`
    <li class="problem-row problem-row--${record.severity}">
      <span class="problem-icon" aria-hidden="true">${SEVERITY_ICON[record.severity]}</span>
      <div class="problem-body">
        <div class="problem-message">${record.message}</div>
        ${
          record.path
            ? html`<button
                class="problem-path"
                title=${`Open ${record.path}`}
                @click=${() => {
                  openProblemPath(record.path!);
                }}
              >
                ${record.path}
              </button>`
            : nothing
        }
        ${record.detail ? html`<pre class="problem-detail">${record.detail}</pre>` : nothing}
      </div>
      ${actionTpl(record)}
      <button
        class="problem-dismiss"
        title="Dismiss"
        aria-label=${`Dismiss: ${record.message}`}
        @click=${() => {
          dismiss(record.id);
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  `;
}

/**
 * The Problems body — the Bottom dock's first tab, and the only place this list is drawn.
 *
 * Exported separately from the record so a test (and the empty state below it) can be rendered
 * without a dock: the record's `render` is this function with the panel context thrown away,
 * because a list of problems reads nothing about the focused document.
 */
export function renderProblemsList(): PanelBody {
  if (problems.length === 0) {
    return renderEmptyState({
      detail: "Failed writes, validation errors and render failures are listed here until fixed.",
      message: "Nothing needs fixing.",
    });
  }
  return html`
    <div class="problems-panel">
      <div class="problems-actions">
        <button
          class="problems-clear"
          @click=${() => {
            clearProblems();
          }}
        >
          Clear ${problemCount()}
        </button>
      </div>
      ${groupProblems().map(
        (group) => html`
          <section class="problem-group">
            <h3 class="problem-group-title">${group.source}</h3>
            <ul class="problem-list">
              ${repeat(
                group.records,
                (record) => record.id,
                (record) => problemTpl(record),
              )}
            </ul>
          </section>
        `,
      )}
    </div>
  `;
}

/**
 * Define the Problems panel — the P3 placeholder, built.
 *
 * P3 registered this id with `when: () => false` and a `render` that threw: "declared in the design
 * and not yet in the app", holding the rail slot §3.2 ② had already spent so the budget counted it
 * from the day it was named. This is the edit that phase described — the predicate is gone, the
 * body is real, and the badge is live.
 *
 * One caller: `panels/bottom-dock.ts`'s {@link import("./bottom-dock").registerBottomPanels}, which
 * is the module that owns the dock this record is drawn in. `registerPanel` throws on a duplicate
 * id and there is no guard here, because a second call IS a second definition site.
 */
export function registerProblemsPanel(): void {
  registerPanel({
    id: "problems",
    title: "Problems",
    level: "project",
    dock: "bottom",
    icon: "sp-icon-alert",
    badge: () => problemCount() || null,
    render: () => renderProblemsList(),
  });
}
