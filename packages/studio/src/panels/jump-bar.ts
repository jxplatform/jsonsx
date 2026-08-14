/// <reference lib="dom" />
/**
 * ⑥ The jump bar — the pane's address, and every place you can go from it.
 *
 * **The two half-breadcrumbs this replaces.** Studio grew two trails, neither of which could say
 * where you were:
 *
 * 1. `panels/pane-context.ts`'s `navTpl()` (the old `#tab-bar` breadcrumb, plan §3.2 ⑥ names it as
 *    `tab-bar.ts:129-185`) — a `Back` button plus one span per `session.documentStack` frame. It
 *    appeared ONLY while you were inside a sub-document, printed the frame's file basename (which
 *    is the SAME basename for a `$map` template, so it read `index.json › index.json`), and knew
 *    nothing about the project above it or the selection below it. It is deleted, and so is the
 *    stack it walked: nothing ever pushed a frame, so it could only ever draw its empty branch.
 * 2. `panels/statusbar.ts`'s selection field — a clickable ancestor trail, `selection.set` per crumb.
 *    It appeared ONLY while something was selected, and knew nothing about the document it was
 *    inside.
 *
 * Between them they never rendered at the same time as each other and never rendered the whole
 * address, so neither one was a place to look. **This bar is the whole chain**, always:
 *
 * ```text
 * ◈ Site › pages/blog/[slug].json › article › h1 ⌄
 *   project        file              selection ancestors
 * ```
 *
 * **The status bar keeps only what an address cannot say.** Plan §3.2 ⑫ and `studio.md` §16.2 give
 * the bar AMBIENT STATE, and an ancestor trail in a second place is exactly the duplication the
 * shell redesign exists to remove — three breadcrumbs would be worse than the two we started with.
 * So the trail moves here whole, and `statusbar/selection` keeps the two facts this bar cannot
 * state: HOW MANY things are selected (a count is not a path) and which Stylebook rule the Style
 * panel is editing (a selector is not a node).
 *
 * **Every interactive item is a command, resolved from the registry.** There is no click handler in
 * this file that names behaviour: a segment names a command id and its args, and the registry
 * supplies the title, the chord, the enablement and the run. Three ids carry the whole bar —
 * `project.openRecent`, `palette.openFiles` and `selection.set` — and this file declares none of
 * them. It did declare a fourth, `document.setStackLevel`, for the sub-document stack; the stack
 * had no way in and both are gone.
 *
 * **A segment whose command the registry does not have becomes a readout, it does not disappear.**
 * That is the one place this bar deliberately differs from the status bar, where an unavailable
 * item vanishes. An address with a hole in it is a lie about containment; a readout is merely a
 * step you cannot take.
 */

import { html, render as litRender, nothing } from "lit-html";
import { displayTagName } from "@jxsuite/schema/guards";
import { childList, getNodeAtPath, nodeLabel, pathsEqual, projectState } from "../store";
import { effect, effectScope } from "../reactivity";
import { PRIMARY_PANE, workspace } from "../workspace/workspace";
import { derivationOfPane, tabOfPane } from "../canvas/canvas-surface";
import { paneRegion } from "../ui/regions";
import { primarySelection } from "../tabs/selection";
import { activeRegistry } from "../commands/active-registry";
import { renderPopover } from "../ui/layers";
import { rectOf } from "../utils/geometry";
import type { CommandArgs, CommandRegistry } from "../commands/registry";
import type { FormulaEditDef, FunctionEditDef } from "../types";
import type { JxPath } from "../state";
import type { Tab } from "../tabs/tab";
import type { PaneDerivation } from "../workspace/workspace";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

/** The CSS variable the stage is offset by while the jump bar is on screen. */
export const JUMP_BAR_VAR = "--jump-bar-h";

/** The bar's height. Declared here because the offset projection and the stylesheet must agree. */
const JUMP_BAR_HEIGHT = 24;

// ─── The model ───────────────────────────────────────────────────────────────

/**
 * What a segment addresses. The kind is stamped on the element so a test — and a shot — can name a
 * step of the address without matching its rendered text, which is derived (§13 R1).
 */
export type JumpSegmentKind = "project" | "file" | "editor" | "node";

/** One alternative in a segment's dropdown. Each is a command, exactly like the segment itself. */
export interface JumpChoice {
  label: string;
  command: string;
  args?: CommandArgs;
  /** The choice you are already on. Marked, never hidden — a menu that omits it loses its place. */
  current?: boolean;
}

/** One step of the address. */
export interface JumpSegment {
  kind: JumpSegmentKind;
  label: string;
  /** Extra tooltip context. The command's own title and chord are appended to it. */
  title?: string;
  /** The command that MOVES you here, or `null` when you are already here. */
  command: string | null;
  args?: CommandArgs;
  /** Where else this step could go. Fewer than two is not a choice, and renders no control. */
  choices: readonly JumpChoice[];
}

// ─── Labels ──────────────────────────────────────────────────────────────────

/**
 * The document's path with the project root taken off — the root is the segment before it.
 *
 * Lives here rather than in `statusbar.ts`, where it started: the jump bar is the surface whose
 * whole job is naming the containment chain, and the status bar's DOCUMENT field is a second reader
 * of the same fact. Having the reader own it also kept `mock.module("panels/statusbar")` — which
 * six bootstrap tests do — from deciding whether the jump bar can name a file.
 */
export function documentLabel(path: string | null): string {
  if (!path) {
    return "Untitled";
  }
  const root = projectState?.projectRoot;
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

// ─── The selection trail (moved here from statusbar.ts) ──────────────────────

/** One crumb of the ancestor trail: what to call the node, and the path that selects it. */
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
        : displayTagName(node?.tagName) ||
          (typeof fallbackTag === "string" ? fallbackTag : "") ||
          (seg === "cases" ? String(selection[i + 1]) : `[${selection[i + 1]}]`);
    crumbs.push({ label, path });
    i += step;
  }
  return crumbs;
}

/**
 * The siblings of one crumb, as choices — the dropdown that makes a segment a way to MOVE.
 *
 * Labels are `nodeLabel()`, the SAME strings the Outline prints, because a menu of alternatives is
 * a list of rows and the reader has already learned those words there. The crumb itself keeps its
 * compact tag label: a crumb is an address, a row is a choice.
 *
 * A `map` step has no siblings (a repeater holds exactly one template), and a text child is not
 * addressable, so both drop out and the segment renders no control at all.
 */
export function crumbSiblings(
  document: unknown,
  crumbs: readonly SelectionCrumb[],
  index: number,
): JumpChoice[] {
  const crumb = crumbs[index];
  if (!crumb) {
    return [];
  }
  const parentPath = (index === 0 ? [] : crumbs[index - 1]!.path) as JxPath;
  const parent = getNodeAtPath(document as never, parentPath);
  const key = crumb.path.at(-2);
  const own = crumb.path;
  if (key === "cases") {
    const cases = parent?.cases;
    if (!cases || typeof cases !== "object") {
      return [];
    }
    return Object.keys(cases).map((name) => {
      const path = [...parentPath, "cases", name] as JxPath;
      return choiceFor(document, path, name, own);
    });
  }
  if (key !== "children") {
    return [];
  }
  const choices: JumpChoice[] = [];
  for (const [i, child] of childList(parent).entries()) {
    if (typeof child === "string") {
      continue;
    }
    const path = [...parentPath, "children", i] as JxPath;
    choices.push(choiceFor(document, path, nodeLabel(child), own));
  }
  return choices;
}

function choiceFor(document: unknown, path: JxPath, fallback: string, own: JxPath): JumpChoice {
  const node = getNodeAtPath(document as never, path);
  const label = node ? nodeLabel(node) : fallback;
  const choice: JumpChoice = { args: { path }, command: "selection.set", label };
  // `pathsEqual`, not a joined key: a separator is a guess about what a segment cannot contain,
  // And the one this reached for was a literal NUL byte that made the whole file read as binary.
  return pathsEqual(path, own) ? { ...choice, current: true } : choice;
}

// ─── Building the address ────────────────────────────────────────────────────

/**
 * The whole address, as data. Pure: no registry, no DOM — the template decides what is renderable.
 *
 * Order is containment order, outermost first, which is the same left-to-right order the status bar
 * puts its three fields in. Nothing here reads the registry, so a segment is produced whether or
 * not its command happens to be registered; {@link segmentTpl} is where that difference shows.
 */
export function jumpSegments(
  tab: Tab | null,
  derived: PaneDerivation | null = null,
): JumpSegment[] {
  if (!tab) {
    return [];
  }
  const segments: JumpSegment[] = [];
  const project = projectState;
  if (project) {
    segments.push({
      choices: [],
      command: "project.openRecent",
      kind: "project",
      label: project.name,
      title: project.projectRoot,
    });
  }

  // ONE document per tab. This used to walk `session.documentStack` and emit a `subdocument`
  // Segment per frame, each one a `document.setStackLevel` you could click back to — but nothing
  // In `src/` ever pushed a frame, so the loop had exactly one iteration in the shipped app and the
  // Address it drew was always this line. A tab holds a document; drilling in opens another tab.
  /* In a DERIVED pane the leading verb is Keep, not Open.
     The address is still the document — a lens draws the source pane's, a companion its own — but
     the question an author has about a pane that is following something is "can I stop it
     following and just keep this open". `pane.pin` answers it, and answers it with a REFUSAL for a
     lens: `segmentTpl` already renders a crumb whose command is disabled as a disabled button with
     `disabledReason` in the tooltip, so the sentence explaining why Code, Diff and breakpoint views
     cannot be pinned arrives for free. */
  segments.push({
    choices: [],
    command: derived ? "pane.pin" : "palette.openFiles",
    kind: "file",
    label: documentLabel(tab.documentPath),
    title: tab.documentPath ?? "Not saved to disk yet",
  });

  // A logic editor is the leaf of the address, and it has no selection under it: the Monaco buffer
  // And the formula workspace are editing a definition, not a node of the document tree.
  const editingFunction = tab.session.ui.editingFunction as FunctionEditDef | null;
  const editingFormula = tab.session.ui.editingFormula as FormulaEditDef | null;
  if (editingFunction) {
    segments.push(editorSegment("ƒ", editingFunction));
    return segments;
  }
  if (editingFormula) {
    segments.push(editorSegment("fx", editingFormula));
    return segments;
  }

  const selection = primarySelection(tab.session.selection);
  if (selection && selection.length > 0) {
    const crumbs = selectionCrumbs(tab.doc.document, selection);
    for (const [i, crumb] of crumbs.entries()) {
      const node = getNodeAtPath(tab.doc.document, crumb.path);
      segments.push({
        args: { path: crumb.path },
        choices: crumbSiblings(tab.doc.document, crumbs, i),
        // The leaf prints the Outline's label — the `$title` / `$id` an author gave the node — and
        // An ancestor prints its compact tag, so a deep address stays readable at 24px.
        command: "selection.set",
        kind: "node",
        label: i === crumbs.length - 1 && node ? nodeLabel(node) : crumb.label,
        title: crumb.path.join(" / "),
      });
    }
  }
  return segments;
}

function editorSegment(sigil: string, def: FunctionEditDef | FormulaEditDef): JumpSegment {
  return {
    choices: [],
    // No command, and none is missing: the Logic tab's own header carries the Close (P8.5), which
    // Is where a reader looking at the editor already is. A second exit up here would be a button
    // Beside the address that means "stop being at this address" — and the pane context bar drew
    // Exactly that, a Back of its own, until this excision removed it.
    command: null,
    kind: "editor",
    label: `${sigil} ${def.defName ?? def.eventKey ?? "editor"}`,
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Where each pane's bar renders. One entry per drawn cell.
 *
 * A Map rather than a `let _host`, because the bar addresses a PANE: it prints where you are, and
 * with two panes on screen there are two answers. `panels/pane-grid.ts` attaches a cell's
 * `.pane-jump` as the cell is built and detaches it as the cell is disposed, which is the same
 * hand-over `panels/frontmatter-panel.ts` takes from the stage.
 */
const _hosts = new Map<string, HTMLElement>();

let _scope: EffectScope | null = null;

let _menu: { dismiss: () => void } | null = null;

/** Close the open segment menu, if any. Idempotent. */
export function dismissJumpMenu(): void {
  _menu?.dismiss();
  _menu = null;
}

/** Whether the registry can actually run this id right now. */
function runnable(registry: CommandRegistry | null, id: string | null): id is string {
  return id !== null && Boolean(registry?.get(id)) && registry!.isVisible(id);
}

/** The tooltip: the segment's own context, then the command's title and chord. */
function segmentTitle(registry: CommandRegistry, segment: JumpSegment, id: string): string {
  const command = registry.get(id)!;
  const reason = registry.disabledReason(id);
  const chord = registry.keymap.formatBinding(id);
  const suffix = reason
    ? `${command.title} — requires ${reason}`
    : chord
      ? `${command.title} (${chord})`
      : command.title;
  return segment.title ? `${segment.title} · ${suffix}` : suffix;
}

/**
 * Open a segment's alternatives.
 *
 * The menu is built from the segment's choices, and every row runs a command — the same command the
 * segment itself names, with a different path. Nothing here decides what selecting means.
 */
function openChoices(event: MouseEvent, registry: CommandRegistry, segment: JumpSegment): void {
  event.preventDefault();
  event.stopPropagation();
  dismissJumpMenu();
  const anchor = rectOf(event.currentTarget as HTMLElement);
  const left = Math.round(Math.min(anchor.left, window.innerWidth - 4));
  const top = Math.round(anchor.bottom);
  _menu = renderPopover(
    html`<sp-popover open style="position:fixed;z-index:10000;left:${left}px;top:${top}px">
      <sp-menu role="menu" aria-label=${`Go to a sibling of ${segment.label}`}>
        ${segment.choices.map(
          (choice) => html`<sp-menu-item
            role="menuitem"
            aria-current=${choice.current === true ? "true" : nothing}
            @click=${() => {
              dismissJumpMenu();
              void registry.run(choice.command, choice.args);
            }}
            >${choice.label}</sp-menu-item
          >`,
        )}
      </sp-menu>
    </sp-popover>`,
    {
      dismissOnOutsideClick: true,
      onDismiss: () => {
        _menu = null;
      },
      region: "jump-bar",
    },
  );
}

/** One step of the address, plus its alternatives control when it has any. */
function segmentTpl(
  registry: CommandRegistry | null,
  segment: JumpSegment,
  last: boolean,
): TemplateResult {
  const id = segment.command;
  const live = runnable(registry, id);
  const crumb = live
    ? html`<button
        class="jb-crumb"
        ?disabled=${registry!.disabledReason(id!) !== undefined}
        aria-current=${last ? "true" : nothing}
        title=${segmentTitle(registry!, segment, id!)}
        @click=${() => {
          void registry!.run(id!, segment.args);
        }}
      >
        ${segment.label}
      </button>`
    : html`<span
        class="jb-crumb jb-crumb--static"
        aria-current=${last ? "true" : nothing}
        title=${segment.title ?? segment.label}
        >${segment.label}</span
      >`;
  // One alternative is not a choice — the same judgement the pane context bar's editor-kind axis
  // Makes. Rendering a chevron that opens a menu of one is a control that cannot move.
  const alternatives =
    registry && segment.choices.length > 1
      ? html`<button
          class="jb-alts"
          aria-haspopup="menu"
          aria-label=${`Siblings of ${segment.label}`}
          title=${`Siblings of ${segment.label}`}
          @click=${(event: MouseEvent) => {
            openChoices(event, registry, segment);
          }}
        >
          ⌄
        </button>`
      : nothing;
  return html`<span class="jb-seg" data-jump-kind=${segment.kind}>${crumb}${alternatives}</span>`;
}

/**
 * The whole bar, as one template. There is no second variant for the empty states.
 *
 * @param {string} [paneId] Whose address to print. Defaults to the focused pane, which is what the
 *   answer was when the shell had one bar.
 */
export function jumpBarTemplate(
  paneId: string = workspace.activePaneId,
): TemplateResult | typeof nothing {
  const segments = jumpSegments(tabOfPane(paneId), derivationOfPane(paneId));
  if (segments.length === 0) {
    return nothing;
  }
  const registry = activeRegistry();
  return html`<nav
    class="jump-bar"
    data-jx-region=${paneRegion(paneId, "jump")}
    aria-label="Location"
  >
    ${segments.map(
      (segment, i) =>
        html`${i === 0 ? nothing : html`<span class="jb-sep" aria-hidden="true">›</span>`}${segmentTpl(
          registry,
          segment,
          i === segments.length - 1,
        )}`,
    )}
  </nav>`;
}

/**
 * Keep the stage clear of the bar.
 *
 * The same one-projection-one-variable shape `pane-context.ts` uses for its own band, and for the
 * same reason: the stage's offset is the SUM of the two, so a pane with no tab open (no bar) costs
 * the welcome screen no dead band.
 *
 * **The variable is written on the PANE, not on `:root`** — when there is a pane to write it on.
 * Two cells have two bars and two stages, and one document-level number would offset both by
 * whichever pane painted last: a side pane showing a document would push the primary's welcome
 * screen down by 24px, and closing the last tab in one pane would lift the other's document under
 * its own bar. `.pane-stage` reads it from its cell by cascade. A host outside a cell (the tests,
 * and the bare offset callers) still writes the root, which is exactly what it meant before.
 *
 * @param {number} height Bar height in px. `0` when the pane has no address to print.
 * @param {HTMLElement | null} [host] The bar's host. Its cell takes the variable when it has one.
 */
export function applyJumpBarOffset(height: number, host?: HTMLElement | null): void {
  const target = host?.closest<HTMLElement>(".pane") ?? document.documentElement;
  target.style.setProperty(JUMP_BAR_VAR, `${height}px`);
}

/**
 * Paint one pane's bar. Exported because the bootstrap paints once before mounting the effect.
 *
 * @param {string} [paneId] Defaults to every attached pane — what "render the jump bar" means when
 *   the caller is a lifecycle rather than a pane.
 */
export function renderJumpBar(paneId?: string): void {
  if (_hosts.size === 0) {
    return;
  }
  // The address changed, so an open menu is describing a place that may no longer be on the bar.
  // Repaints happen only when tracked state moves, so this cannot close a menu you are reading.
  dismissJumpMenu();
  for (const [id, host] of _hosts) {
    if (paneId !== undefined && id !== paneId) {
      continue;
    }
    const template = jumpBarTemplate(id);
    litRender(template, host);
    applyJumpBarOffset(template === nothing ? 0 : JUMP_BAR_HEIGHT, host);
  }
}

/**
 * Give a pane's bar somewhere to paint, or take it away.
 *
 * Called by `panels/pane-grid.ts` as a cell is built and as it is disposed. Detaching blanks the
 * host first: a cell being removed still has this bar's DOM in it, and the lit part that owns that
 * DOM is about to be unreachable.
 *
 * @param {string} paneId
 * @param {HTMLElement | null} host
 */
export function attachJumpBarHost(paneId: string, host: HTMLElement | null): void {
  const previous = _hosts.get(paneId);
  if (previous === host) {
    return;
  }
  if (previous) {
    litRender(nothing, previous);
    applyJumpBarOffset(0, previous);
  }
  if (host) {
    _hosts.set(paneId, host);
    renderJumpBar(paneId);
  } else {
    _hosts.delete(paneId);
  }
}

/**
 * Subscribe the bar to the state it renders. Idempotent.
 *
 * `host` is the PRIMARY pane's, the same bargain `panels/tab-strip.ts`'s `mount` makes: the
 * bootstrap holds the primary's cell and hands it over, and every other pane's host arrives from
 * the grid through {@link attachJumpBarHost}.
 *
 * @param {HTMLElement} host
 */
export function mountJumpBar(host: HTMLElement): void {
  unmountJumpBar();
  attachJumpBarHost(PRIMARY_PANE, host);
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      // The registry is composed AFTER the bootstrap mounts this, and it is a reactive holder —
      // Reading it here is what repaints the bar from a skeleton into the real thing.
      void activeRegistry();
      void projectState?.name;
      /* EVERY pane's tab, not the focused one's. Two bars print two addresses, and the side pane's
         has to repaint when its own document moves — an effect that tracked `activeTab` alone left
         the unfocused bar frozen on whatever it last said. */
      for (const pane of workspace.panes) {
        const tab = tabOfPane(pane.id);
        if (!tab) {
          continue;
        }
        void tab.doc.document;
        void tab.documentPath;
        void tab.session.selection.map((path) => path.join("/")).join("|");
        void tab.session.ui.editingFormula;
        void tab.session.ui.editingFunction;
      }
      renderJumpBar();
    });
  });
}

export function unmountJumpBar(): void {
  dismissJumpMenu();
  _scope?.stop();
  _scope = null;
  for (const host of _hosts.values()) {
    applyJumpBarOffset(0, host);
  }
  _hosts.clear();
  applyJumpBarOffset(0);
}

// ─── This bar contributes no commands ────────────────────────────────────────
// It declared one, `document.setStackLevel` — "leave a sub-document by naming the level you want to
// Be at". Its `enablement` read `session.documentStack.length > 0`, a stack nothing could ever push
// To, so the command was permanently disabled and its palette entry permanently unreachable. Every
// Id the bar renders now belongs to the surface that owns the behaviour: `project.openRecent`,
// `palette.openFiles`, `selection.set`.
