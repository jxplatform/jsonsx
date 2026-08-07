/// <reference lib="dom" />
/**
 * The pane grid — `workspace.panes`, given a visual counterpart.
 *
 * `workspace.panes` has been a real data model since P3: an ordered list, a focused id, a split, an
 * unsplit. Nothing drew it. `index.html` declared ONE each of `#tab-strip`, `#jump-bar`,
 * `#pane-chrome` and `#canvas-wrap` as flat siblings in `#app`'s grid — four surfaces that belong
 * to a PANE, laid out as rows and columns of the APPLICATION — so the shell could model two panes
 * and had somewhere to put exactly one. §18.3's stage handover was the workaround: one stage, taken
 * by whichever pane had focus, releasing the loser's artboards on the way past. This module is what
 * that scaffolding was standing in for, and the handover is deleted with it.
 *
 * **Lit owns the frame; imperative code owns the leaves.** `panels/bottom-dock.ts` is the
 * precedent. The cells, their four boxes and the splitter between them are a keyed `repeat` over
 * `workspace.panes`; everything a cell CONTAINS arrives through a `ref()` and is built by the
 * module that owns it — `canvas/canvas-render.ts` is the manual lit render root of `.pane-stage`
 * and this template puts nothing inside it, `panels/jump-bar.ts` and `panels/pane-context.ts` are
 * handed `.pane-jump` and `.pane-chrome`, and `panels/tab-strip.ts` is handed `.pane-strip`.
 *
 * This was an imperative reconciler until the splitter proved why it could not be. `layout()` runs
 * on every `shell.paneSplit` write — every `pointermove` of a drag — and it re-ran
 * `cells[1].root.before(splitter)`, which on an already-positioned node is a REMOVE plus an insert:
 * Chrome fires `lostpointercapture` on move #1, the rest of the gesture goes to whatever is under
 * the cursor, and a drag asking for +0.20 lands +0.03. The old file carried "never touches an
 * existing cell's children" as a comment; a **keyed** `repeat` makes it structural — lit MOVES an
 * existing cell rather than recreating it, and re-parenting is not a move for the things inside a
 * stage: an `<iframe>` that changes parent reloads, dropping its `iframe-channel` connection, its
 * shadow document and every `ready` panel with it.
 *
 * **§18.1's three rules, structurally:**
 *
 * 1. _A pane is complete before it is published._ lit clones a template into a `DocumentFragment`,
 *    commits every part into it — which is where the `ref()` callbacks below run — and only then
 *    inserts the fragment. So the stamping, the surface record and the gestures all happen while
 *    the cell is still detached, exactly as the hand-built fragment used to. There is no frame in
 *    which a `.pane` exists with no stage inside it.
 * 2. _A pane is never observable without existing._ One effect over `workspace.panes` is the only
 *    writer of pane DOM. Vue batches, so no intermediate state is samplable.
 * 3. _A pane with nothing in it is a hole in the grid._ Enforced in `workspace/workspace.ts`, where
 *    the tabs are. This module ASSERTS rather than repairs: repairing inside a reactive effect that
 *    writes `workspace.panes` is an effect that triggers itself.
 */

import { html, render as litRender, nothing } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { ref } from "lit-html/directives/ref.js";
import { effect, effectScope } from "../reactivity";
import { persistDocks, registerShellSurface, setPaneSplit, shell } from "../shell";
import {
  STAGE_CLASS,
  createPaneSurface,
  disposePaneSurface,
  registerCanvasSurface,
} from "../canvas/canvas-surface";
import { releaseCanvasHosts } from "../canvas/iframe-host";
import { installStageGestures } from "../editor/shortcuts";
import { scheduleCanvasRender } from "../canvas/canvas-render";
import { paneRegion, paneStripRegion } from "../ui/regions";
import { attachJumpBarHost } from "./jump-bar";
import { attachPaneChromeHost } from "./pane-context";
import { focusPane, workspace } from "../workspace/workspace";
import { setupHandle } from "../ui/panel-resize";
import type { EffectScope } from "@vue/reactivity";
import type { CanvasSurface } from "../canvas/canvas-surface";
import type { TemplateResult } from "lit-html";

/** One drawn pane: its root and the four surfaces inside it. */
export interface PaneCell {
  paneId: string;
  root: HTMLElement;
  strip: HTMLElement;
  jump: HTMLElement;
  chrome: HTMLElement;
  stage: HTMLElement;
  surface: CanvasSurface;
}

/**
 * A cell's record and the five `ref` callbacks that fill it in.
 *
 * The callbacks are MEMOISED per pane id, and that is not an optimisation. lit's `ref` directive
 * compares the callback by identity: hand it a fresh closure on a re-render and it calls the old
 * one with `undefined` and the new one with the element — a detach and a re-attach of a live host,
 * on every pass. Stable callbacks mean an unchanged cell's refs are never called again at all.
 */
interface CellRefs extends PaneCell {
  onRoot: (el?: Element) => void;
  onStrip: (el?: Element) => void;
  onJump: (el?: Element) => void;
  onChrome: (el?: Element) => void;
  onStage: (el?: Element) => void;
  /** Capture-phase `pointerdown` on the cell root — see {@link cellRefs}. */
  onPointerDown: { handleEvent: () => void; capture: true };
  /** Stage-gesture disposer, live between the stage's attach and its detach. */
  releaseGestures: (() => void) | null;
}

const _cells = new Map<string, CellRefs>();

let _grid: HTMLElement | null = null;

let _scope: EffectScope | null = null;

/** The cell a pane is drawn in, or null. Test-visible, and the bootstrap's handle on the primary. */
export function cellForPane(paneId: string): PaneCell | null {
  return _cells.get(paneId) ?? null;
}

/** Every drawn cell, in grid order. */
export function paneCells(): PaneCell[] {
  return workspace.panes
    .map((pane) => _cells.get(pane.id))
    .filter((cell): cell is CellRefs => cell !== undefined);
}

/**
 * The record for a pane, created on first render and reused for the life of the cell.
 *
 * Every element field is typed non-null and starts null, the same bargain `CanvasSurface` makes:
 * lit commits the refs inside `litRender`, synchronously, before any caller can hold the record.
 */
function cellRefs(paneId: string): CellRefs {
  const existing = _cells.get(paneId);
  if (existing) {
    return existing;
  }
  /* Declared in ONE literal, callbacks and all, closing over the very binding being declared. The
     bodies only run when lit commits a part, so there is no temporal-dead-zone read — and a record
     that is complete on the line it is created cannot be half-wired by an early return later. */
  const cell: CellRefs = {
    chrome: null as unknown as HTMLElement,
    jump: null as unknown as HTMLElement,
    /* The two bars are HANDED their host rather than resolving a region, the same way
       `panels/frontmatter-panel.ts` is handed the stage. They cannot resolve one the way the tab
       strip does: the strip's host carries `pane.<id>/tabs` and nothing inside it re-stamps that
       id, while the jump bar and the context bar both stamp `pane.<id>/jump` and
       `pane.<id>/context` on markup they render INSIDE these two divs — so a region on the wrapper
       as well would put the same id on two nested elements, and `resolveRegion` takes the LAST
       match. Sixty shots crop `pane.primary/context`; a second, larger element carrying it is a
       silently widened crop. */
    onChrome: (el?: Element) => {
      if (el) {
        cell.chrome = el as HTMLElement;
      }
      attachPaneChromeHost(paneId, (el as HTMLElement | undefined) ?? null);
    },
    onJump: (el?: Element) => {
      if (el) {
        cell.jump = el as HTMLElement;
      }
      attachJumpBarHost(paneId, (el as HTMLElement | undefined) ?? null);
    },
    /**
     * **A pointer landing anywhere in this cell puts the keyboard in this pane.**
     *
     * Before this, `panels/tab-strip.ts`'s strip row was the ONLY thing in the app that moved
     * `workspace.activePaneId` by pointer, so a click on the side pane's canvas, its context bar,
     * its Library, its Code editor or its entry form selected and edited that pane's document while
     * every keyboard command, the Inspector, the block action bar and the overlay effect went on
     * answering for the other one.
     *
     * ONE listener, on the cell, because the cell is the only thing that knows which pane a click
     * is IN. The alternative — a `focusPane` call in each of the seven surfaces a pane can contain
     * — is a list that a new surface joins by being remembered.
     *
     * Three properties it needs, and where each comes from:
     *
     * 1. _It must not disturb a control mid-interaction._ It moves the pane focus, never the DOM
     *    focus, so a text field in the context bar keeps its caret and its selection; and it fires
     *    on `pointerdown`, before any gesture has begun. The pane SPLITTER is a sibling of the
     *    cells rather than a child of one, so a splitter drag never reaches this at all.
     * 2. _It must reach clicks inside the canvas._ It cannot: those land in a cross-origin iframe and
     *    never surface as a parent-realm pointer event. `canvas/iframe-host.ts`'s `hit` /
     *    `layoutHit` handlers are that seam and call {@link focusPane} themselves, from the pane
     *    that mounted the artboard.
     * 3. _It must cost nothing when the pane is already focused._ {@link focusPane} returns early in
     *    that case — the guard is in the module that owns focus, because a function handed a
     *    `paneId` may not read the focus (`scripts/check-pane-singletons.ts` rule 4).
     *
     * CAPTURE phase, so a surface inside the cell that stops propagation cannot silently take the
     * pane's focus with it. `studio.ts`'s commit-on-parent-click listener is on `document`, so it
     * still runs first and the outgoing inline-edit session is committed before focus moves.
     */
    onPointerDown: {
      capture: true,
      handleEvent: () => {
        focusPane(paneId);
      },
    },
    /* Every element field is written on ATTACH and left alone on detach. A caller holding the
       record when its pane goes away — `studio.ts`'s primary cell, three tests — asks it what the
       cell WAS, and `root.isConnected === false` is the honest answer to that where `root === null`
       is a `TypeError`. `_cells` forgetting the pane is what makes the cell gone. */
    onRoot: (el?: Element) => {
      if (el) {
        cell.root = el as HTMLElement;
      }
    },
    onStage: (el?: Element) => {
      if (el) {
        attachStage(cell, el as HTMLElement);
        return;
      }
      detachStage(cell);
    },
    onStrip: (el?: Element) => {
      if (el) {
        cell.strip = el as HTMLElement;
      }
    },
    paneId,
    releaseGestures: null,
    root: null as unknown as HTMLElement,
    stage: null as unknown as HTMLElement,
    strip: null as unknown as HTMLElement,
    surface: null as unknown as CanvasSurface,
  };
  _cells.set(paneId, cell);
  return cell;
}

/**
 * Furnish a pane's stage: its surface record, its host registration and its gestures.
 *
 * Runs while the cell is still inside lit's fragment (§18.1 rule 1). The render is SCHEDULED here
 * rather than by the caller because nothing else is keyed on a pane appearing — both canvas effects
 * key on the active TAB, which a split does not change — and by the time the frame runs, the cell
 * is in the document.
 */
function attachStage(cell: CellRefs, stage: HTMLElement): void {
  cell.stage = stage;
  cell.surface = createPaneSurface(cell.paneId);
  registerCanvasSurface(cell.paneId, stage);
  cell.releaseGestures = installStageGestures(cell.surface);
  scheduleCanvasRender(cell.paneId);
}

/**
 * Take a pane's stage apart, in the one order that works.
 *
 * The frames go BEFORE the DOM does. lit notifies a part of its disconnection through
 * `_$notifyConnectionChanged` and only then removes the nodes, so `stage` still has its children
 * here — which is the whole reason `releaseCanvasHosts` can find them. A frame detached first is
 * otherwise noticed only by whichever lazy `liveHosts` walk runs next, so its channel's `window`
 * "message" listener and its overlay would outlive the pane. `disposePaneSurface` comes after,
 * because it is what stops the artboards' render scopes and clears the record the hosts resolve
 * through.
 */
function detachStage(cell: CellRefs): void {
  cell.releaseGestures?.();
  cell.releaseGestures = null;
  if (cell.stage) {
    releaseCanvasHosts(cell.stage);
  }
  disposePaneSurface(cell.paneId);
  _cells.delete(cell.paneId);
}

/**
 * One pane's cell.
 *
 * `pane.<id>` goes on the STAGE, not on the cell root. Nine shots crop `pane.primary` meaning "the
 * canvas"; moving the id up one level would silently widen all nine to include the strip and the
 * two bars, and no gate can tell a wider crop from an intended one.
 *
 * Nothing lit renders may go INSIDE `.pane-stage`: the canvas host mounts iframes there and
 * `canvas/canvas-render.ts` is that element's lit render root — a node cannot have two owners of
 * its child list.
 */
function cellTpl(paneId: string): TemplateResult {
  const cell = cellRefs(paneId);
  return html`
    <div class="pane" data-pane-id=${paneId} @pointerdown=${cell.onPointerDown} ${ref(cell.onRoot)}>
      <div class="pane-strip" data-jx-region=${paneStripRegion(paneId)} ${ref(cell.onStrip)}></div>
      <div class="pane-jump" ${ref(cell.onJump)}></div>
      <div class="pane-chrome" ${ref(cell.onChrome)}></div>
      <div class=${STAGE_CLASS} data-jx-region=${paneRegion(paneId)} ${ref(cell.onStage)}></div>
    </div>
  `;
}

/**
 * Remember the splitter and wire it, once.
 *
 * A module-level function, so lit's `ref` sees the same callback on every pass and never re-runs
 * it. That is the whole of defect S2's fix: a node the template owns is created when the second
 * cell appears and removed when it goes, and NOTHING in between re-inserts it — so a pointer
 * capture taken on `pointerdown` survives the drag that writes `shell.paneSplit` five times.
 */
const onSplitter = (el?: Element): void => {
  if (!el) {
    return;
  }
  setupHandle(el as HTMLElement, {
    axis: "x",
    // The floor is a pane, not a sliver: 320px is the narrowest an Inspector-less editor is
    // Usable at, and the same number on both sides is what makes a drag symmetrical.
    max: () => Math.max(0.2, 1 - 320 / Math.max(1, gridWidth())),
    min: () => Math.min(0.8, 320 / Math.max(1, gridWidth())),
    read: () => shell.paneSplit,
    reset: () => 0.5,
    // A drag is px against the measured grid; the stored value is a RATIO, so the same layout
    // Survives a window resize.
    scale: () => 1 / Math.max(1, gridWidth()),
    settle: () => persistDocks(),
    write: (value) => setPaneSplit(value),
  });
};

/** The splitter, as a template. */
function splitterTpl(): TemplateResult {
  return html`<div class="resize-handle pane-splitter" ${ref(onSplitter)}></div>`;
}

/**
 * The grid: every pane's cell, keyed by pane id, with a splitter before every cell but the first.
 *
 * Keyed on `pane.id` because the key is what makes lit MOVE a cell instead of rebuilding it. Every
 * item renders the SAME template — the splitter slot is a child value that is `nothing` at index 0
 * — so a reordering could only ever swap two values, never re-commit a different template over a
 * live cell. `workspace.panes[0]` is always the primary and `MAX_PANES` is 2, so in practice no
 * item ever moves.
 */
function gridTemplate(): TemplateResult {
  return html`${repeat(
    workspace.panes,
    (pane) => pane.id,
    (pane, index) => html`${index > 0 ? splitterTpl() : nothing}${cellTpl(pane.id)}`,
  )}`;
}

/**
 * Bring the drawn cells into line with `workspace.panes`. Idempotent by construction.
 *
 * Exported for the tests, which need to drive it without a reactive tick.
 */
export function reconcile(): void {
  if (!_grid) {
    return;
  }
  litRender(gridTemplate(), _grid);
  layout();
}

/**
 * Write the grid's own tracks.
 *
 * The TRACK COUNT lives here rather than in `shell.ts`'s layout effect because it depends on
 * `workspace.panes.length`, and the shell effect must not read the workspace — a dock resize would
 * then re-run on every tab change. The shell owns `--pane-split`; the grid owns what it means.
 *
 * It writes ONE style property and touches no child, which is the other half of S2: a `pointermove`
 * that lands here can move a track edge but can never move a node.
 */
function layout(): void {
  if (!_grid) {
    return;
  }
  if (paneCells().length < 2) {
    _grid.style.gridTemplateColumns = "minmax(0, 1fr)";
    return;
  }
  const split = shell.paneSplit;
  _grid.style.gridTemplateColumns = `minmax(0, ${split}fr) 5px minmax(0, ${1 - split}fr)`;
}

function gridWidth(): number {
  return _grid?.clientWidth ?? 0;
}

/** Mount the grid. Called by `shell.ts`'s `mountShell()`, like every other shell surface. */
export function mount(): void {
  if (_scope) {
    return;
  }
  _grid = document.querySelector<HTMLElement>("#pane-grid");
  if (!_grid) {
    return;
  }
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      // The one dependency: the pane list itself, by identity and by member id.
      for (const pane of workspace.panes) {
        void pane.id;
      }
      void shell.paneSplit;
      reconcile();
    });
  });
}

export function unmount(): void {
  _scope?.stop();
  _scope = null;
  if (_grid) {
    /* One statement takes every cell apart. Rendering `nothing` disconnects the template's parts —
       which runs every `ref` detach above, in document order, while the nodes are still in place —
       and then removes them. Doing it by hand would be a second teardown path to keep in step. */
    litRender(nothing, _grid);
  }
  _cells.clear();
  _grid = null;
}

registerShellSurface({ mount, unmount });
