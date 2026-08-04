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
 * name · branch ↑n↓n · problems  ‖ path · view · save state       ‖ ancestor breadcrumb
 * ```
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
import { getNodeAtPath, nodeLabel, projectState, statusbarEl } from "../store";
import { shell } from "../shell";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import { activeRegistry } from "../commands/active-registry";
import { collabState } from "../collab/collab-state";
import { problemCount, problems } from "../services/notify";
import { now } from "../services/clock";
import { relativeTime } from "./ai-chat/sessions-view";
import type { CommandRegistry } from "../commands/registry";
import type { EditorKind } from "../commands/context";
import type { JxPath } from "../state";
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
  const peers = activeTab.value ? collabState(activeTab.value).peers.length : 0;
  return fieldTpl("statusbar/project", [
    project
      ? itemTpl(registry, { command: "project.openRecent", label: project.name })
      : itemTpl(registry, { command: "project.open", label: "No project" }),
    status?.isRepo === true && status.branch
      ? itemTpl(registry, {
          command: "panel.focus.git",
          label: `⑂ ${status.branch}${aheadBehindLabel(status.ahead, status.behind)}`,
          title: `${status.files.length} changed file(s)`,
        })
      : nothing,
    count > 0
      ? itemTpl(registry, {
          command: "panel.focus.problems",
          label: `⚠ ${count}`,
          title: `${count} problem(s)`,
        })
      : nothing,
    // No `collab.*` command is registered yet — the `Collaborate:` family lands with P4.8 — so this
    // Item is invisible today and appears the day it is, with no edit to this file.
    peers > 0
      ? itemTpl(registry, {
          command: "collab.share",
          label: `${peers} peer${peers === 1 ? "" : "s"}`,
        })
      : nothing,
  ]);
}

// ─── ⑫b DOCUMENT ─────────────────────────────────────────────────────────────

/** The editor kinds that are not the Canvas, named as a reader would name them. */
const KIND_LABEL: Readonly<Record<Exclude<EditorKind, "canvas" | "none">, string>> = {
  code: "Code",
  config: "Stylebook",
  diff: "Diff",
  grid: "Grid",
  library: "Library",
};

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
    return KIND_LABEL[kind];
  }
  return view.charAt(0).toUpperCase() + view.slice(1);
}

/** The document's path with the project root taken off — the root is already field one. */
export function documentLabel(path: string | null): string {
  if (!path) {
    return "Untitled";
  }
  const root = projectState?.projectRoot;
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
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

/** One crumb of the ancestor breadcrumb: what to call the node, and the path that selects it. */
export interface SelectionCrumb {
  label: string;
  path: JxPath;
}

/**
 * Walk the selection path one STRUCTURAL step at a time.
 *
 * Most steps are `["children", index]` or `["cases", name]` pairs, but a repeater template is
 * reached by a lone `"map"` segment — so the step width varies. Emitting a crumb per node keeps the
 * array pseudo-element ("Repeater") and its template both visible instead of collapsing the array
 * into a bare `[index]`.
 */
export function selectionCrumbs(document: unknown, selection: JxPath): SelectionCrumb[] {
  const crumbs: SelectionCrumb[] = [];
  for (let i = 0; i < selection.length;) {
    const seg = selection[i];
    const step = seg === "map" ? 1 : 2;
    const path = selection.slice(0, i + step) as JxPath;
    const node = getNodeAtPath(document as never, path);
    const fallbackTag = node?.tag;
    const label =
      node?.$prototype === "Array"
        ? "Repeater"
        : node?.tagName ||
          (typeof fallbackTag === "string" ? fallbackTag : "") ||
          (seg === "cases" ? String(selection[i + 1]) : `[${selection[i + 1]}]`);
    crumbs.push({ label, path });
    i += step;
  }
  return crumbs;
}

function selectionFieldTpl(registry: CommandRegistry | null) {
  const tab = activeTab.value;
  const selection = tab?.session.selection as JxPath | null | undefined;
  if (tab && selection?.length) {
    const node = getNodeAtPath(tab.doc.document, selection);
    const crumbs = selectionCrumbs(tab.doc.document, selection);
    return fieldTpl("statusbar/selection", [
      // The last crumb IS the selected element, and its label is the TAG while this one prefers
      // `$id` — so the two say different things and both earn their place, except when they say the
      // Same thing. An element whose id matches its tag rendered "re-hero  re-hero".
      nodeLabel(node) === crumbs.at(-1)?.label
        ? nothing
        : itemTpl(registry, {
            command: null,
            label: nodeLabel(node),
            title: "The selected element",
          }),
      ...crumbs.flatMap<ItemResult>((crumb, index) => [
        index === 0 ? nothing : html`<span class="sb-sep" aria-hidden="true">›</span>`,
        itemTpl(registry, {
          args: { path: crumb.path },
          command: "selection.set",
          label: crumb.label,
        }),
      ]),
    ]);
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
        void tab.session.selection;
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
