/**
 * Notify.ts — the third record type (plan §1), and the app's only way to say what happened.
 *
 * What this replaces: 78 `statusMessage()` call sites — 26 failures and 52 successes — rendered in
 * identical 11px grey text in a 24px strip and destroyed after 3000 ms. A failure and a save looked
 * the same, neither could be acted on, and both were gone before a reader who had looked away could
 * read them. `statusMessage` is deleted, not wrapped; `scripts/check-styles.ts` bans the name from
 * `src/` so it cannot regrow.
 *
 * **A notification is a record, and its lifetime is chosen by the action it requires** (§7.1):
 *
 * | Tier      | Host                       | Lifetime           | Use when                       |
 * | --------- | -------------------------- | ------------------ | ------------------------------ |
 * | `toast`   | the fourth overlay layer   | timed, dismissible | reversible, or needs no action |
 * | `problem` | the Bottom dock's Problems | until it is fixed  | it must be fixed               |
 *
 * §7.1 names a third tier — **inline**, the `error` slot on `ui/field-row.ts`'s `renderFieldRow`.
 * It is deliberately NOT a member of {@link NotificationTier}: an inline error is a value a control
 * renders next to the field the user is editing, not a record the app posts to a host, and it has
 * no store to live in. Declaring a tier here whose only possible outcome is being dropped on the
 * floor would be exactly the silence this module exists to end, so the union has two members and
 * the third tier arrives as `renderFieldRow`'s own parameter (P4.4).
 *
 * **Recovery is a command id, not a per-call-site closure.** `notify.error("Save failed", { action:
 * "file.save" })` gives the toast and the Problems row a Retry button whose label, availability,
 * disabled reason and keyboard chord all come off the command record — which is why this lives
 * beside the registry rather than inside any one surface. A call site that wanted a Retry used to
 * have to invent a button; now it names a capability that already exists.
 *
 * Nothing here renders. `ui/layers.ts` hosts the toasts and the Bottom dock hosts the Problems
 * list; both read the two reactive arrays below, so a new surface can render notifications without
 * this module learning it exists.
 */

import { reactive } from "../reactivity";
import { announce } from "./announce";
import { now } from "./clock";

/** How bad it is. Chooses the icon, the colour, and the default tier. */
export const SEVERITIES = ["success", "info", "warn", "error"] as const;

export type Severity = (typeof SEVERITIES)[number];

/**
 * The two hosted lifetimes.
 *
 * A tier is a HOST, not a rendering preference: a record whose tier is `problem` is one the app
 * promises to keep until somebody fixes it, and a record whose tier is `toast` is one it promises
 * to take away. See the module doc for why `inline` is not here.
 */
export const TIERS = ["toast", "problem"] as const;

export type NotificationTier = (typeof TIERS)[number];

/** The default tier per severity. A failure must be fixed; everything else may be taken away. */
const DEFAULT_TIER: Readonly<Record<Severity, NotificationTier>> = {
  error: "problem",
  info: "toast",
  success: "toast",
  warn: "toast",
};

/**
 * How long a toast rests before it is taken away, by severity.
 *
 * §7.1 caps the band at 4–8s. A warning that nobody has to act on still deserves the long end of
 * it, because it is the one a reader is most likely to have looked away from.
 */
export const TOAST_LIFETIME_MS: Readonly<Record<Severity, number>> = {
  error: 8000,
  info: 4000,
  success: 4000,
  warn: 8000,
};

/** What a caller may say about an outcome beyond its severity and its one line. */
export interface NotifyOptions {
  /**
   * Command id offering recovery — the Retry / Fix button.
   *
   * A command id rather than a callback so the button's LABEL is the command's title, its enabled
   * state is the command's `enablement`, and its refusal sentence is the command's `requires`. Four
   * facts a closure could carry none of.
   */
  action?: string;
  /** Args passed to {@link NotifyOptions.action} when it runs. */
  actionArgs?: Record<string, unknown>;
  /** The long form — a stack, a captured log, a validator's output. Rendered in Problems only. */
  detail?: string;
  /** Who reported it: "Save", "Source Control", "Canvas", "Assistant". Groups the Problems list. */
  source?: string;
  /** The file or document the outcome is about, so Problems can click through to it. */
  path?: string;
  /** Override the tier {@link DEFAULT_TIER} would pick — a warning that MUST be fixed. */
  tier?: NotificationTier;
  /**
   * Deduplication key. A second notification with the same key REPLACES the first rather than
   * stacking beside it — the file watcher that fails once a second is one problem, not sixty.
   */
  key?: string;
  /** Override the toast's rest time. Ignored for the `problem` tier, which has no timer. */
  timeoutMs?: number;
}

/** One outcome, as recorded. Frozen: a host renders it, nothing edits it after the fact. */
export interface Notification {
  readonly id: string;
  readonly severity: Severity;
  readonly message: string;
  readonly tier: NotificationTier;
  /** Epoch ms from {@link now}, so a pinned clock pins the "2m ago" a Problems row renders. */
  readonly at: number;
  readonly action?: string;
  readonly actionArgs?: Record<string, unknown>;
  readonly detail?: string;
  readonly source?: string;
  readonly path?: string;
  readonly key?: string;
  /** Rest time for a toast; `0` means "hold until dismissed". Absent on a problem. */
  readonly timeoutMs?: number;
}

let _seq = 0;

/** Monotonic within a page load, and stable enough to be a lit `repeat` key. */
function nextId(): string {
  _seq += 1;
  return `n${_seq}`;
}

/**
 * The live toast stack, oldest first. Reactive, so the host repaints by reading it.
 *
 * Exported as the array rather than behind a getter because that is what makes it trackable: a lit
 * render effect that reads `toasts.length` re-runs when one arrives, with no subscription to
 * remember to release.
 */
export const toasts: Notification[] = reactive([]);

/**
 * Everything that must be fixed, oldest first — what the Bottom dock's Problems tab renders and
 * what the rail badge and the status bar count.
 *
 * The shape is the contract for that surface: each entry has an `id` to key on, a `severity` to
 * sort and colour by, a `source` to group by, a `path` to click through to, an optional `detail`
 * for the expanded row, and an optional `action` command id for its Fix / Retry button.
 */
export const problems: Notification[] = reactive([]);

/** The most toasts on screen at once; the oldest is retired to make room. */
export const MAX_TOASTS = 4;

/** Which array a tier lives in. */
function storeFor(tier: NotificationTier): Notification[] {
  return tier === "problem" ? problems : toasts;
}

/**
 * Record an outcome and return it.
 *
 * The record is returned so a caller that owns the outcome's life — an operation that retries and
 * succeeds — can {@link dismiss} its own problem instead of leaving a fixed thing on the list.
 */
export function notify(
  severity: Severity,
  message: string,
  options: NotifyOptions = {},
): Notification {
  const tier = options.tier ?? DEFAULT_TIER[severity];
  const record: Notification = {
    at: now(),
    id: nextId(),
    message,
    severity,
    tier,
    ...(options.action === undefined ? {} : { action: options.action }),
    ...(options.actionArgs === undefined ? {} : { actionArgs: options.actionArgs }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.key === undefined ? {} : { key: options.key }),
    ...(tier === "toast" ? { timeoutMs: options.timeoutMs ?? TOAST_LIFETIME_MS[severity] } : {}),
  };

  const store = storeFor(tier);
  if (record.key !== undefined) {
    const at = store.findIndex((existing) => existing.key === record.key);
    if (at !== -1) {
      store.splice(at, 1);
    }
  }
  store.push(record);
  if (tier === "toast") {
    while (toasts.length > MAX_TOASTS) {
      toasts.shift();
    }
  }
  /*
   * Announce from HERE, not from a host.
   *
   * The `role="status"` region lived on the toast host, and `error` defaults to the `problem` tier —
   * so a failure reached no live region at all, and a Problems-panel region would still announce
   * nothing while another Bottom-dock tab was showing. One call site is what makes "posted" and
   * "announced" the same event: a new host gets announcements without knowing this module exists.
   *
   * `source` is included because a screen-reader user has no visual grouping to tell them where the
   * message came from, which is exactly what the panel's own column shows everyone else.
   */
  announce(
    record.source === undefined ? record.message : `${record.source}: ${record.message}`,
    severity === "error" ? "assertive" : "polite",
  );
  return record;
}

/** `notify.success(msg, opts)` and its three siblings — the shape §7.1 names. */
function severityHelper(severity: Severity) {
  return (message: string, options: NotifyOptions = {}) => notify(severity, message, options);
}

notify.success = severityHelper("success");
notify.info = severityHelper("info");
notify.warn = severityHelper("warn");
notify.error = severityHelper("error");

/**
 * Take one notification off whichever list holds it. Returns whether it was there.
 *
 * One function for both stores because a caller holding a record should not have to remember which
 * tier it landed in — the record says so.
 */
export function dismiss(id: string): boolean {
  for (const store of [toasts, problems]) {
    const at = store.findIndex((record) => record.id === id);
    if (at !== -1) {
      store.splice(at, 1);
      return true;
    }
  }
  return false;
}

/**
 * Drop every problem a predicate accepts (all of them with no predicate). Returns how many went.
 *
 * The predicate form is what lets an operation clear its own previous failures when it starts again
 * — `clearProblems((p) => p.source === "Save")` — so a fixed problem stops being listed without the
 * fixer having kept the record's id.
 */
export function clearProblems(match?: (record: Notification) => boolean): number {
  const kept = match ? problems.filter((record) => !match(record)) : [];
  const removed = problems.length - kept.length;
  problems.splice(0, problems.length, ...kept);
  return removed;
}

/** How many problems are outstanding, optionally of one severity — the badge and the status bar. */
export function problemCount(severity?: Severity): number {
  return severity === undefined
    ? problems.length
    : problems.filter((record) => record.severity === severity).length;
}

/**
 * Clear both stores. For tests and for the "close project" path — a problem is about a project, and
 * carrying one across a project switch would attribute it to the wrong repository.
 */
export function resetNotifications(): void {
  toasts.splice(0);
  problems.splice(0);
}
