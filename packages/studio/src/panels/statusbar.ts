/// <reference lib="dom" />
/**
 * ⑫ The status bar — ambient state, in scope order, and nothing else.
 *
 * What this replaces: a bar built by `innerHTML` string concatenation with a three-character
 * escaper, carrying whatever the last of 78 `statusMessage()` calls had said, for three seconds.
 * Transient messages have left entirely for the toast host (`ui/layers.ts`) and the Problems list
 * (`services/notify.ts`); what remains here is state that is TRUE for as long as it is shown.
 *
 * **Three fixed fields, in the shell's own left-to-right level order** (plan §3.2 ⑫), so the bar
 * restates the containment model on every glance:
 *
 * ```text
 * PROJECT                        ‖ DOCUMENT                       ‖ SELECTION
 * name · branch ↑n↓n · problems  ‖ path · view · save state       ‖ count · style rule
 * ```
 *
 * The SELECTION field held an ancestor breadcrumb until region ⑥ landed. The trail is an ADDRESS,
 * not ambient state, and it now lives once — in the jump bar (`panels/jump-bar.ts`), which merged
 * it with the pane context bar's document-stack chain. What is left here is the count and the
 * Stylebook's rule, neither of which is a path.
 *
 * `statusbar/project`, `statusbar/document` and `statusbar/selection` are three placements the
 * level × placement matrix already declares, each admitting exactly one level — so the bar's
 * mixedness is structural rather than an exemption.
 *
 * **The effective view, not a mode string.** The bar used to print "Content Mode" from
 * `tab.doc.mode` while the Command Bar printed "Design" from `canvasMode` — two surfaces reading
 * two fields to answer one question. Both now read `registry.context()`, which is the same record
 * every `when` predicate reads, so they cannot disagree again.
 *
 * **Every interactive item is a command.** There are no click handlers in this file: an item names
 * a command id, and renders as a button only when the registry has that command and its `when`
 * holds. That is what lets an item that has no command yet — the peers count, whose `Collaborate:`
 * family lands with P4.8 — sit in the template today and start rendering the day it is registered,
 * with no edit here. The three readouts that are NOT buttons are marked: the view name (its control
 * is the pane context bar ⑦; a second mode picker in 24px would be the chrome duplication §2
 * principle 9 exists to prevent), the save wording once a document IS saved, and the stylebook
 * selector.
 */

import { html, render as litRender, nothing } from "lit-html";
import { projectState, statusbarEl } from "../store";
import { documentLabel } from "./jump-bar";
import { shell } from "../shell";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import { EDITOR_KIND_LABELS } from "../commands/context";
import { activeRegistry } from "../commands/active-registry";
import { deployStatusItem } from "../publish/deploy-checklist";
import { collabState } from "../collab/collab-state";
import { problemCount, problems } from "../services/notify";
import { now } from "../services/clock";
import { relativeTime } from "./ai-chat/sessions-view";
import type { CommandRegistry } from "../commands/registry";
import type { EditorKind } from "../commands/context";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

let _scope: EffectScope | null = null;

/**
 * Document path → when it was last written, from the {@link now} seam.
 *
 * Kept here rather than on the `Tab` record for one reason: a save time is something the STATUS BAR
 * observes, not something a document is. `files/file-ops.ts` reports it after a successful write —
 * the same place the old `statusMessage("Saved …")` was raised from, so the fact has not moved, it
 * has only stopped being a message that erases itself.
 */
const _savedAt = new Map<string, number>();

/** Record a successful write. Called by the save path; keyed by document path. */
export function noteDocumentSaved(path: string | null | undefined): void {
  if (path) {
    _savedAt.set(path, now());
  }
}

/** Forget every recorded save. Project close and the tests both want a clean slate. */
export function forgetSavedTimes(): void {
  _savedAt.clear();
}

// ─── Items ───────────────────────────────────────────────────────────────────

/** One thing the bar can show. A `command` makes it a button; without one it is a readout. */
interface StatusItem {
  /** Command id, or `null` for a pure readout. */
  command: string | null;
  label: string;
  /** Extra context for the tooltip. The command's own title and chord are added to it. */
  title?: string;
  args?: Record<string, unknown>;
}

/**
 * Render one item.
 *
 * A named command that the registry does not have, or whose `when` is false, renders NOTHING — the
 * item disappears rather than becoming a dead label. That is the whole mechanism by which the bar
 * stays a rendering of the registry instead of a second place capabilities are decided.
 */
function itemTpl(registry: CommandRegistry | null, item: StatusItem) {
  if (item.command === null) {
    return html`<span class="sb-item sb-state" title=${item.title ?? item.label}
      >${item.label}</span
    >`;
  }
  const id = item.command;
  if (!registry?.get(id) || !registry.isVisible(id)) {
    return nothing;
  }
  const command = registry.get(id)!;
  const reason = registry.disabledReason(id);
  const chord = registry.keymap.formatBinding(id);
  const suffix = reason
    ? `${command.title} — requires ${reason}`
    : chord
      ? `${command.title} (${chord})`
      : command.title;
  return html`<button
    class="sb-item"
    ?disabled=${reason !== undefined}
    title=${item.title ? `${item.title} · ${suffix}` : suffix}
    @click=${() => {
      void registry.run(id, item.args);
    }}
  >
    ${item.label}
  </button>`;
}

/** What {@link itemTpl} returns: a rendered item, or the absence of one. */
type ItemResult = TemplateResult | typeof nothing;

/** A field, with its region stamp. Renders nothing at all when it has no items. */
function fieldTpl(region: string, items: readonly ItemResult[]) {
  const live = items.filter((item): item is TemplateResult => item !== nothing);
  if (live.length === 0) {
    return nothing;
  }
  return html`<div class="sb-field" data-jx-region=${region}>${live}</div>`;
}

// ─── ⑫a PROJECT ──────────────────────────────────────────────────────────────

/** `↑2↓1`, or "" when the branch is level with its upstream. */
export function aheadBehindLabel(ahead: number, behind: number): string {
  return `${ahead > 0 ? ` ↑${ahead}` : ""}${behind > 0 ? ` ↓${behind}` : ""}`;
}

function projectFieldTpl(registry: CommandRegistry | null) {
  const project = projectState;
  const { status } = shell.git;
  const count = problemCount();
  const deploy = deployStatusItem();
  const peers = activeTab.value ? collabState(activeTab.value).peers.length : 0;
  return fieldTpl("statusbar/project", [
    project
      ? itemTpl(registry, { command: "project.openRecent", label: project.name })
      : itemTpl(registry, { command: "project.open", label: "No project" }),
    /* WHICH branch, when there is one — and deliberately no "not tracked" twin, though plan §12 P1
       workstream 9's "repo state becomes a persistent status-bar field" reads like a request for
       one. An untracked project already states itself in this field, one item along:
       `deployStatusItem()`'s first link is `repo`, whose label is "Track this project with git" and
       whose command is `git.init`. A second item beside it would carry no fact the first does not
       — "Not tracked" and "Track this project with git" answer the same question with the same verb
       — and adjacent duplicate chrome is what §2 principle 9 forbids. `tests/statusbar.test.ts`
       pins the pairing from both ends, so deleting the checklist's repo step fails there rather
       than quietly taking the state off the bar. */
    status?.isRepo === true && status.branch
      ? itemTpl(registry, {
          command: "panel.focus.git",
          label: `⑂ ${status.branch}${aheadBehindLabel(status.ahead, status.behind)}`,
          title: `${status.files.length} changed file(s)`,
        })
      : nothing,
    // Where the project stands with shipping — ambient state, so it belongs beside the branch and
    // The problem count rather than in a toast. `deployStatusItem` names the NEXT missing step
    // While anything is missing, and the deployment itself once nothing is.
    deploy
      ? itemTpl(registry, {
          command: deploy.command,
          label: deploy.label,
          title: deploy.title,
        })
      : nothing,
    // `view.setBottomTab`, not `panel.focus.problems`: the latter is generated from the rail
    // Roster, and Problems left the rail. That is the same verb Diff, Logic and Activity are
    // Addressed by — one door per bottom tab — and it is what keeps this readout the ONLY standing
    // Mention of problems in the chrome, which is the point of taking the rail button away.
    count > 0
      ? itemTpl(registry, {
          args: { tab: "problems" },
          command: "view.setBottomTab",
          label: `⚠ ${count}`,
          title: `${count} problem(s)`,
        })
      : nothing,
    /* `collab.showStatus` — "what is happening in this document?" — because that is the question a
       peer count raises.

       This said `collab.share` and carried a comment promising the item would "appear the day the
       `Collaborate:` family lands, with no edit to this file". The family landed, under five ids,
       and `share` was renamed `collab.setEnabled` on the way (the set*-not-toggle* rule). `itemTpl`
       renders `nothing` for an id the registry does not have, so the readout was permanently blank
       and the comment said it was fine. An id is not a stable interface between two files unless
       something checks it, which is what `tests/statusbar.test.ts` now does. */
    peers > 0
      ? itemTpl(registry, {
          command: "collab.showStatus",
          label: `${peers} peer${peers === 1 ? "" : "s"}`,
          title: `${peers} peer${peers === 1 ? "" : "s"} in this document`,
        })
      : nothing,
  ]);
}

// ─── ⑫b DOCUMENT ─────────────────────────────────────────────────────────────

/**
 * What the pane is showing, in the words the pane context bar uses.
 *
 * Derived from the command context — `editor.kind` and `canvas.view` — so it is the SAME two facts
 * the Command Bar, the keyboard scope stack and every `when` predicate read.
 */
export function viewLabel(kind: EditorKind, view: string): string {
  if (kind === "none") {
    return "";
  }
  if (kind !== "canvas") {
    return EDITOR_KIND_LABELS[kind];
  }
  return view.charAt(0).toUpperCase() + view.slice(1);
}

/**
 * The save state, in words.
 *
 * A dot glyph said one bit and required a legend nobody has. These four sentences say which of the
 * four states the document is in, and the one that needs an action IS the action: "Unsaved changes"
 * renders as the `file.save` button.
 */
function saveItem(dirty: boolean, readOnly: boolean, savedAt: number | undefined): StatusItem {
  if (readOnly) {
    return { command: null, label: "Read-only", title: "A collaborator owns this session's file" };
  }
  if (dirty) {
    return { command: "file.save", label: "Unsaved changes" };
  }
  return savedAt === undefined
    ? { command: null, label: "Saved" }
    : { command: null, label: `Saved ${relativeTime(savedAt)}` };
}

function documentFieldTpl(registry: CommandRegistry | null) {
  const tab = activeTab.value;
  if (!tab) {
    return nothing;
  }
  const ctx = registry?.context() ?? null;
  const view = ctx ? viewLabel(ctx.editor.kind, ctx.canvas.view) : "";
  const collab = collabState(tab);
  const savedAt = tab.documentPath === null ? undefined : _savedAt.get(tab.documentPath);
  return fieldTpl("statusbar/document", [
    itemTpl(registry, {
      command: "palette.openFiles",
      label: documentLabel(tab.documentPath),
      title: tab.documentPath ?? "Not saved to disk yet",
    }),
    view
      ? itemTpl(registry, {
          command: null,
          label: view,
          title: "The pane's view — change it on the pane context bar",
        })
      : nothing,
    itemTpl(registry, saveItem(tab.doc.dirty, collab.readOnly, savedAt)),
  ]);
}

// ─── ⑫c SELECTION ────────────────────────────────────────────────────────────

/**
 * What is selected — the COUNT, and nothing that is an address.
 *
 * This field used to carry a clickable ancestor trail, one `selection.set` per crumb. That trail
 * has moved whole to the jump bar (⑥, `panels/jump-bar.ts`), which is region ⑥'s entire reason to
 * exist: Studio had two half-breadcrumbs — that one, and the pane context bar's document-stack
 * chain — and neither ever rendered the whole address. Leaving a copy here would have made three.
 *
 * What is left is what the jump bar CANNOT say, and both are ambient state in the §16.2 sense: how
 * many things are selected (a count is not a path, and the jump bar names only the primary), and
 * which style rule the Stylebook is editing (a CSS selector is not a node in this document).
 *
 * A single selection therefore leaves this field empty. That is deliberate — the jump bar's leaf
 * segment states it permanently, with its ancestors, and a second copy at 11px says nothing new.
 */
function selectionFieldTpl(registry: CommandRegistry | null) {
  const paths = activeTab.value?.session.selection ?? [];
  if (paths.length > 0) {
    // A document selection owns the field even when it prints nothing: the Stylebook's selector
    // Below would otherwise appear while an element is picked, which is two answers to one question.
    return paths.length > 1
      ? fieldTpl("statusbar/selection", [
          itemTpl(registry, {
            command: null,
            label: `${paths.length} selected`,
            title: `${paths.length} elements are selected; the jump bar names the primary`,
          }),
        ])
      : nothing;
  }
  // The stylebook's own selection is a selection: it is what the Style panel is editing, and it is
  // The only thing in this field when no document node is picked.
  return shell.stylebook.selection
    ? fieldTpl("statusbar/selection", [
        itemTpl(registry, {
          command: null,
          label: shell.stylebook.selection.replaceAll(" ", " › "),
          title: "The style rule being edited",
        }),
      ])
    : nothing;
}

// ─── The bar ─────────────────────────────────────────────────────────────────

/** The whole bar, as one template. There is no second variant for the empty states. */
export function statusbarTemplate() {
  const registry = activeRegistry();
  return html`${projectFieldTpl(registry)}${documentFieldTpl(registry)}${selectionFieldTpl(
    registry,
  )}`;
}

/** Paint the bar. Exported because the bootstrap paints once before mounting the effect. */
export function renderStatusbar(): void {
  if (statusbarEl) {
    litRender(statusbarTemplate(), statusbarEl);
  }
}

/** Subscribe the bar to the state it renders. Idempotent. */
export function mountStatusbar(): void {
  unmountStatusbar();
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      // The registry is composed AFTER the bootstrap mounts this, and it is a reactive holder —
      // Reading it here is what repaints the bar from a skeleton into the real thing.
      void activeRegistry();
      void shell.stylebook.selection;
      void shell.git.status;
      void problems.length;
      const tab = activeTab.value;
      if (tab) {
        void tab.doc.document;
        void tab.doc.dirty;
        void tab.doc.mode;
        void tab.documentPath;
        void tab.session.selection.map((path) => path.join("/")).join("|");
        void tab.session.ui.canvasMode;
        void tab.session.ui.preview;
        void collabState(tab).peers.length;
        void collabState(tab).readOnly;
      }
      renderStatusbar();
    });
  });
}

export function unmountStatusbar(): void {
  _scope?.stop();
  _scope = null;
}
