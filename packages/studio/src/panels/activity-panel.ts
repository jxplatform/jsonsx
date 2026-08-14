/// <reference lib="dom" />
/**
 * Activity — where a long operation lives while it runs, and what it leaves behind (plan §7.3).
 *
 * What this replaces: `ui/progress-modal.ts` was **the only surface in Studio with a real error
 * view** — a red headline, the captured log in a `<pre>`, an explicit Close — and it had four call
 * sites, all package operations. It blocked the whole app, offered no cancel, and vanished
 * completely on success, so a `bun install` that hung had no exit and one that failed had a log you
 * could read exactly once. Every OTHER long operation — git clone, publish, media upload, site
 * import, project open — got a three-second grey line or nothing at all.
 *
 * An activity is a **record**, like a notification and a command:
 *
 * - It is **persistent** — a finished operation stays on the list, with its log, until the list is
 *   cleared, so "what did the import actually do?" is answerable after the fact;
 * - It is **inspectable** — the log is the same captured output the modal used to show, and it is
 *   attached to the entry rather than to a modal that is about to close;
 * - It can be **cancelled** — an operation that hands over a `cancel` callback gets a Cancel button
 *   on its row, which is the affordance a hung install has never had;
 * - And it **fails into Problems** — {@link ActivityHandle.fail} raises a `notify.error` carrying the
 *   log as its `detail`, so the failure outlives the run and carries a Retry command. That is
 *   §7.3's "the progress modal's error view is promoted into Problems", in one function.
 *
 * **Nothing here blocks.** `showProgressModal` still exists for the four dependency-install sites
 * §7.3 keeps blocking, and it is now a thin front end over {@link beginActivity} — so even the
 * blocking case leaves an inspectable entry behind, and closing the modal no longer loses it.
 *
 * `services/idle.ts` reads {@link activityIdleBlockers}: an open operation means the app is not
 * settled, which is the §13.6 S4 obligation every phase's checklist carries.
 */

import { html, nothing } from "lit-html";
import { renderDeployChecklist } from "../publish/deploy-checklist";
import { repeat } from "lit-html/directives/repeat.js";
import { reactive } from "../reactivity";
import { now } from "../services/clock";
import { notify } from "../services/notify";
import { registerPanel } from "./panel-registry";
import { renderEmptyState } from "./empty-state";
import type { PanelBody } from "./panel-registry";
import type { TemplateResult } from "lit-html";

/** How an operation ended, or that it has not. */
export const ACTIVITY_STATES = ["running", "done", "failed", "cancelled"] as const;

export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** One named phase of an operation — "Install dependencies", "Sync with the remote". */
export interface ActivityStep {
  label: string;
  state: "pending" | "running" | "done" | "failed";
}

/**
 * One operation, as recorded.
 *
 * Mutable and reactive on purpose: an activity is the one record in the app that CHANGES while you
 * watch it, which is the whole difference between it and a
 * {@link import("../services/notify") .Notification}. A host repaints by reading it.
 */
export interface ActivityEntry {
  readonly id: string;
  readonly title: string;
  /** The line under the title — what the operation is doing right now. */
  status: string;
  state: ActivityState;
  /** The captured output, one entry per chunk. Rendered in the expanded row. */
  log: string[];
  steps: ActivityStep[];
  /** Epoch ms from {@link now}, so a pinned clock pins the duration a row prints. */
  readonly startedAt: number;
  endedAt: number | null;
  /** Who is running it: "Packages", "Source Control", "Publish". Printed beside the title. */
  readonly source?: string;
  /** Whether a `cancel` callback was handed over — the row draws Cancel iff this is true. */
  cancellable: boolean;
  /** Whether this row's log is unfolded. A view flag, on the record, so a repaint keeps it. */
  expanded: boolean;
}

/**
 * Every operation this session, oldest first — running and finished alike.
 *
 * Exported as the array rather than behind a getter for the same reason `notify`'s stores are: that
 * is what makes it trackable, so a lit render effect that reads it re-runs when an operation
 * starts, logs a line or ends, with no subscription to remember to release.
 */
export const activities: ActivityEntry[] = reactive([]);

/**
 * How many FINISHED entries are kept. Running ones are never retired — an operation the app is
 * still doing is not history, and dropping it would take its Cancel button with it.
 */
export const MAX_FINISHED_ACTIVITIES = 20;

/**
 * Entry id → the callback that stops it.
 *
 * Held beside the record rather than on it: a closure inside a reactive proxy is a value effects
 * would track and nothing would ever compare, and the record is otherwise plain data. The record
 * carries `cancellable` so a renderer never needs this map.
 */
const _cancels = new Map<string, () => void>();

let _seq = 0;

/** Monotonic within a page load, and stable enough to be a lit `repeat` key. */
function nextId(): string {
  _seq += 1;
  return `a${_seq}`;
}

/** Whether an entry has stopped. */
export function isFinished(entry: ActivityEntry): boolean {
  return entry.state !== "running";
}

/** Drop the oldest finished entries once there are more than {@link MAX_FINISHED_ACTIVITIES}. */
function retireOldest(): void {
  let excess = activities.filter((entry) => isFinished(entry)).length - MAX_FINISHED_ACTIVITIES;
  while (excess > 0) {
    const at = activities.findIndex((entry) => isFinished(entry));
    if (at === -1) {
      return;
    }
    _cancels.delete(activities[at]!.id);
    activities.splice(at, 1);
    excess -= 1;
  }
}

/** What {@link beginActivity} is told about an operation up front. */
export interface ActivityOptions {
  /** What the operation IS — "Open project", "Update dependencies". Never changes. */
  title: string;
  /** What it is doing right now. Changes as it goes. */
  status?: string;
  /** Who is running it — "Packages", "Source Control". Groups nothing yet; printed on the row. */
  source?: string;
  /** The plan, declared up front so the row shows how far along it is. */
  steps?: readonly string[];
  /**
   * Stop the operation.
   *
   * Its presence is what draws the Cancel button, so an operation that cannot honestly be stopped
   * must not pass one — a Cancel that does nothing is the failure §7 exists to end, restated as a
   * button.
   */
  cancel?: () => void;
}

/** The live handle an operation drives its own entry through. */
export interface ActivityHandle {
  readonly id: string;
  /** The record itself, for a caller that wants to read its own log back. */
  readonly entry: ActivityEntry;
  /** Replace the line under the title. */
  setStatus: (text: string) => void;
  /** Append captured output. Blank chunks are dropped, so a trailing newline is not a log line. */
  log: (chunk: string) => void;
  /** Mark `label` as the running step; every step before it is done. Appends an unplanned one. */
  step: (label: string) => void;
  /** Finish successfully. */
  done: (status?: string) => void;
  /**
   * Finish with a failure — and raise the Problem that outlives it.
   *
   * The log goes into the notification's `detail`, so the persistent, inspectable error view §7.3
   * asks for is the Problems row, not a modal that has to stay open to be read.
   */
  fail: (message: string, opts?: { action?: string; path?: string }) => void;
}

/**
 * Start recording an operation.
 *
 * @param {ActivityOptions} options
 * @returns {ActivityHandle}
 */
export function beginActivity(options: ActivityOptions): ActivityHandle {
  const entry: ActivityEntry = {
    cancellable: options.cancel !== undefined,
    endedAt: null,
    expanded: false,
    id: nextId(),
    log: [],
    startedAt: now(),
    state: "running",
    status: options.status ?? "",
    steps: (options.steps ?? []).map((label) => ({ label, state: "pending" as const })),
    title: options.title,
    ...(options.source === undefined ? {} : { source: options.source }),
  };
  if (options.cancel) {
    _cancels.set(entry.id, options.cancel);
  }
  activities.push(entry);
  // The PROXY, not the literal: writing through the raw object a `reactive()` array was handed
  // Skips every effect depending on it, which is the one bug that would make a running operation
  // Look frozen. Read back before anything is retired, so the reference is unambiguous.
  const live = activities.at(-1) as ActivityEntry;
  retireOldest();

  const finish = (state: ActivityState, status?: string) => {
    if (isFinished(live)) {
      return;
    }
    live.state = state;
    live.endedAt = now();
    if (status !== undefined) {
      live.status = status;
    }
    for (const step of live.steps) {
      step.state = step.state === "done" ? "done" : state === "done" ? "done" : "failed";
    }
    live.cancellable = false;
    _cancels.delete(live.id);
    retireOldest();
  };

  return {
    done(status?: string) {
      finish("done", status);
    },
    entry: live,
    fail(message: string, opts: { action?: string; path?: string } = {}) {
      // An operation that has already ended does not get to raise a Problem: the first outcome is
      // The one that happened, and a late `fail()` after a successful `done()` would put a failure
      // On a list whose whole promise is that everything on it still needs fixing.
      if (isFinished(live)) {
        return;
      }
      const detail = live.log.join("\n");
      finish("failed", message);
      notify.error(message, {
        source: live.source ?? live.title,
        ...(detail === "" ? {} : { detail }),
        ...(opts.action === undefined ? {} : { action: opts.action }),
        ...(opts.path === undefined ? {} : { path: opts.path }),
      });
    },
    id: live.id,
    log(chunk: string) {
      const text = chunk.replace(/\s+$/, "");
      if (text !== "") {
        live.log.push(text);
      }
    },
    setStatus(text: string) {
      if (!isFinished(live)) {
        live.status = text;
      }
    },
    step(label: string) {
      let at = live.steps.findIndex((step) => step.label === label);
      if (at === -1) {
        live.steps.push({ label, state: "pending" });
        at = live.steps.length - 1;
      }
      for (const [index, step] of live.steps.entries()) {
        step.state = index < at ? "done" : index === at ? "running" : step.state;
      }
      live.status = label;
    },
  };
}

/** One entry by id, or `undefined`. */
export function activityById(id: string): ActivityEntry | undefined {
  return activities.find((entry) => entry.id === id);
}

/** Everything still running, oldest first — what the badge counts and idle waits on. */
export function runningActivities(): ActivityEntry[] {
  return activities.filter((entry) => !isFinished(entry));
}

/**
 * Stop an operation: run its callback, mark it cancelled. Returns whether anything was stopped.
 *
 * The callback runs BEFORE the state changes, so an implementation that throws leaves the entry
 * honestly still running rather than claiming a cancellation that did not happen.
 */
export function cancelActivity(id: string): boolean {
  const entry = activityById(id);
  const stop = _cancels.get(id);
  if (!entry || !stop || isFinished(entry)) {
    return false;
  }
  stop();
  _cancels.delete(id);
  entry.state = "cancelled";
  entry.endedAt = now();
  entry.cancellable = false;
  entry.status = "Cancelled";
  return true;
}

/** Drop every finished entry. Returns how many went. Running operations are kept. */
export function clearFinishedActivities(): number {
  const kept = activities.filter((entry) => !isFinished(entry));
  const removed = activities.length - kept.length;
  activities.splice(0, activities.length, ...kept);
  return removed;
}

/** Clear the whole list — tests, and the "close project" path. */
export function resetActivities(): void {
  activities.splice(0);
  _cancels.clear();
}

/**
 * What is still running, as `services/idle.ts` phrases it.
 *
 * §13.6 S4 puts this on every phase's checklist: an app with an operation in flight has not
 * finished reacting, so a screenshot taken now photographs a half-done import. A FINISHED entry is
 * not a blocker — the list stays on screen forever and waiting for it to empty would never settle.
 */
export function activityIdleBlockers(): readonly string[] {
  return runningActivities().map(
    (entry) => `activity: ${entry.title} — ${entry.status || "running"}`,
  );
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/** The state glyphs. One character each: the row's job is a line of text, not an illustration. */
const STATE_ICON: Readonly<Record<ActivityState, string>> = {
  cancelled: "⊘",
  done: "✓",
  failed: "✕",
  running: "⋯",
};

const STEP_ICON: Readonly<Record<ActivityStep["state"], string>> = {
  done: "✓",
  failed: "✕",
  pending: "·",
  running: "⋯",
};

/** How long it took, in the coarsest unit that is still true. */
export function activityDuration(entry: ActivityEntry, at: number = now()): string {
  const ms = Math.max(0, (entry.endedAt ?? at) - entry.startedAt);
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stepsTpl(entry: ActivityEntry): TemplateResult | typeof nothing {
  if (entry.steps.length === 0) {
    return nothing;
  }
  return html`<ol class="activity-steps">
    ${entry.steps.map(
      (step) => html`<li class="activity-step activity-step--${step.state}">
        <span class="activity-step-icon" aria-hidden="true">${STEP_ICON[step.state]}</span>
        ${step.label}
      </li>`,
    )}
  </ol>`;
}

function logTpl(entry: ActivityEntry): TemplateResult | typeof nothing {
  if (entry.log.length === 0) {
    return nothing;
  }
  return html`<button
      class="activity-log-toggle"
      aria-expanded=${entry.expanded ? "true" : "false"}
      @click=${() => {
        entry.expanded = !entry.expanded;
      }}
    >
      ${entry.expanded ? "Hide log" : `Show log (${entry.log.length} line(s))`}
    </button>
    ${entry.expanded ? html`<pre class="activity-log">${entry.log.join("\n")}</pre>` : nothing}`;
}

/** One operation. */
function activityTpl(entry: ActivityEntry): TemplateResult {
  return html`
    <li class="activity-row activity-row--${entry.state}">
      <span class="activity-icon" aria-hidden="true">${STATE_ICON[entry.state]}</span>
      <div class="activity-body">
        <div class="activity-head">
          <span class="activity-title">${entry.title}</span>
          ${entry.source ? html`<span class="activity-source">${entry.source}</span>` : nothing}
          <span class="activity-duration">${activityDuration(entry)}</span>
        </div>
        ${entry.status ? html`<div class="activity-status">${entry.status}</div>` : nothing}
        ${stepsTpl(entry)} ${logTpl(entry)}
      </div>
      ${
        entry.cancellable
          ? html`<button
              class="activity-cancel"
              title="Stop this operation"
              @click=${() => {
                cancelActivity(entry.id);
              }}
            >
              Cancel
            </button>`
          : nothing
      }
    </li>
  `;
}

/**
 * The Activity tab's body.
 *
 * Newest LAST, like a log and unlike a menu: an operation that starts while you are reading one
 * that is already running must not push it off the top.
 */
export function renderActivityList(): PanelBody {
  // The Deploy checklist lives here because a deploy IS a long operation with a log — which is why
  // P4 folded Deploy into Activity rather than giving it a fifth dock tab. It renders above the
  // Run log and before any operation has started, because its whole job is to say what is missing
  // BEFORE you begin.
  const checklist = renderDeployChecklist();
  if (activities.length === 0) {
    return html`${checklist}${renderEmptyState({
      detail: "Installs, clones, publishes and imports report here while they run.",
      message: "Long operations show their progress, their log and their Cancel button here.",
    })}`;
  }
  const finished = activities.filter((entry) => isFinished(entry)).length;
  return html`
    ${checklist}
    <div class="activity-panel">
      ${
        finished > 0
          ? html`<div class="activity-actions">
              <button
                class="activity-clear"
                @click=${() => {
                  clearFinishedActivities();
                }}
              >
                Clear ${finished} finished
              </button>
            </div>`
          : nothing
      }
      <ul class="activity-list">
        ${repeat(
          activities,
          (entry) => entry.id,
          (entry) => activityTpl(entry),
        )}
      </ul>
    </div>
  `;
}

/**
 * Define the Activity panel. Called by `panels/bottom-dock.ts`, beside the state it writes.
 *
 * `level: "project"` because an operation is a thing done TO a project — an install, a clone, a
 * publish — and the list must not empty itself when the last document closes, which is the same
 * rule that hoisted source control off `TabUi`.
 */
export function registerActivityPanel(): void {
  registerPanel({
    id: "activity",
    title: "Activity",
    level: "project",
    dock: "bottom",
    icon: "sp-icon-data",
    // No rail button: the Bottom dock's tabs are reached by ⌘J and `view.setBottomTab`, and a
    // Fifth rail slot for a surface with no steady state would spend chrome §2 principle 9 caps.
    rail: false,
    badge: () => (runningActivities().length > 0 ? runningActivities().length : null),
    render: () => renderActivityList(),
  });
}
