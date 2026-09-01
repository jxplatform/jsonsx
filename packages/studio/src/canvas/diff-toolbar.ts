/// <reference lib="dom" />
/**
 * The diff stage's own chrome: how many changes there are, and how to walk them.
 *
 * **It owns its own reactivity from here**, the way `renderGridMode` does. A step must not go
 * through `renderCanvas(paneId)`: that rebuilds the stage and remounts both artboard iframes, so
 * pressing "next change" would tear down and reload the very documents it is trying to move you
 * through. The toolbar keeps a host element per pane and re-renders only itself.
 *
 * **It is an absolutely-positioned SIBLING of `.panzoom-wrap`, never a child and never in flow.** A
 * child would be scaled and panned along with the artboards; a flow sibling would shift the origin
 * `applyTransform` and `centerCanvas` compute against, so entering the mode would centre the boards
 * somewhere other than where the pan maths says they are.
 */

import { html, render as litRender, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { argsSchema, enumArg, enumProperty, stringProperty } from "../commands/command-args";
import type { CommandArgValues } from "../commands/command-args";
import type { AnyCommand } from "../commands/registry";
import {
  diffChangeCount,
  diffChangeMapOf,
  diffStepOf,
  diffViewOf,
  setDiffView,
  stepDiff,
} from "./diff-view";
import type { DiffView } from "./diff-view";
import type { ChangeStep } from "./diff-marks";
import { panToParentRect } from "./canvas-utils";
import { surfaceForPane } from "./canvas-surface";
import { announce } from "../services/announce";
import { workspace } from "../workspace/workspace";

/** Where each pane's toolbar draws. Module-local and pane-keyed, like the rest of the diff state. */
const _hosts = new Map<string, HTMLElement>();

/** Record (or forget) the element a pane's toolbar renders into. */
export function setDiffToolbarHost(paneId: string, host: HTMLElement | null): void {
  if (host) {
    _hosts.set(paneId, host);
  } else {
    _hosts.delete(paneId);
  }
}

/**
 * How this module asks a pane to redraw, injected by `canvas-render.ts`.
 *
 * **By injection rather than by import**, the same idiom `setSurfaceTeardown` uses and for the same
 * reason: `canvas-render.ts` imports THIS module, so an edge back would close a cycle. A dynamic
 * import would break the cycle too, and it was tried — but a dynamic import of a module that is
 * otherwise statically reachable makes the bundler hoist it into a shared chunk, which moved 664 KB
 * out of `studio.js` and pushed `chunks` past its budget. An injected function costs nothing.
 */
let _repaint: (paneId: string) => void = () => {};

/** Register the repaint. Called once, from `canvas-render.ts`. */
export function setDiffRepaint(repaint: (paneId: string) => void): void {
  _repaint = repaint;
}

/**
 * Rebuild the whole stage, because Visual and Code are different renders rather than different
 * styling: one draws two artboards on a pan/zoom surface, the other one Monaco.
 *
 * `prevCanvasMode` is nulled first — the documented "this stage's structure is stale" signal, the
 * same one `resetCanvasView` ends on. Without it the repaint sees `modeChanged === false` (the
 * canvas mode did not move; only the view within it did) and skips the setup the new branch needs.
 */
function repaintDiffStage(paneId: string): void {
  surfaceForPane(paneId).prevCanvasMode = null;
  _repaint(paneId);
}

/** Redraw one pane's toolbar in place, without touching its artboards. */
export function renderDiffToolbar(paneId: string): void {
  const host = _hosts.get(paneId);
  if (host) {
    litRender(diffToolbarTpl(paneId), host);
  }
}

/** How a change reads aloud, for the step announcement. */
function describeStep(step: ChangeStep, index: number, total: number): string {
  const kind = step.kind === "modified" ? "changed" : step.kind;
  return `Change ${index + 1} of ${total}, ${kind}.`;
}

/**
 * A stepper button's click.
 *
 * One handler for both directions, so the failure path is written once. A rejection here is not an
 * outcome to raise: the cursor has already moved and the toolbar has already redrawn to say where
 * it is, so a reveal that could not measure leaves a correct toolbar over an unmoved canvas.
 */
function onStepClick(paneId: string, delta: 1 | -1): void {
  stepDiffAndReveal(paneId, delta).catch((error: unknown) => {
    console.warn("stepDiffAndReveal:", error);
  });
}

/**
 * Move to the next or previous change and bring it on screen on BOTH artboards.
 *
 * The two boards share one `.panzoom-wrap` and therefore one vertical offset, so this pans to the
 * UNION of the two rects rather than centring either: a node that sits at a different height on the
 * two sides is only fully readable if the move accounts for both. A change that exists on one side
 * only — a removal has no counterpart to the right of it, an addition none to the left — pans to
 * the one rect there is, so the step never becomes a no-op just because it is one-sided.
 */
export async function stepDiffAndReveal(paneId: string, delta: 1 | -1): Promise<void> {
  const landed = stepDiff(paneId, delta);
  if (landed === null) {
    return;
  }
  renderDiffToolbar(paneId);
  const step = diffChangeMapOf(paneId)?.steps[landed];
  const { panels } = surfaceForPane(paneId);
  const original = panels[0]?.canvas as HTMLElement | undefined;
  const current = panels[1]?.canvas as HTMLElement | undefined;
  if (!step) {
    return;
  }
  /* DYNAMICALLY, and not for size. `iframe-host.ts` is one of the most-mocked modules in the
     suite — a dozen files replace it with a partial stub — and a partial mock of a module the
     static graph reaches is a LOAD error, not a missing stub at call time. A static import here
     would have made every one of those files grow three exports it never calls. The step is
     already async, so this costs nothing, and it is the same idiom `canvas-render.ts` uses for
     the collab binding. */
  const { hostForCanvas, measureInCanvas, revealCanvasPathIn } = await import("./iframe-host");
  const measured = await Promise.all([
    step.originalPath && original ? measureInCanvas(original, step.originalPath) : null,
    step.currentPath && current ? measureInCanvas(current, step.currentPath) : null,
  ]);
  const rects = measured.filter((rect) => rect !== null);
  const sentence = describeStep(step, landed, diffChangeCount(paneId));
  if (rects.length === 0) {
    // The node is real but unstamped — a component's internals, or a repeater row past the first.
    // The count still names it, and the Code view still shows it; there is simply nowhere to pan.
    announce(`${sentence} Not shown on the canvas.`);
    return;
  }
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  /* Pan only. The two artboards sit side by side at a fixed 800px each and `fitOnCanvasEntry`
     framed both horizontally on arrival; moving X per step would read as the canvas being dragged
     sideways under the reader. */
  panToParentRect({ height: bottom - top, top }, surfaceForPane(paneId));
  // Re-measure through the reveal so the ring (and any caller acting on the point) sees where the
  // Node ended up, not where it was before the move — `revealCanvasPath`'s own rule.
  const host = step.currentPath && current ? hostForCanvas(current) : null;
  if (host && step.currentPath) {
    await revealCanvasPathIn(host, step.currentPath);
  }
  announce(sentence);
}

/** The Visual/Code radio pair, or a static label when this comparison has no visual half. */
function viewTpl(paneId: string, hasVisual: boolean): TemplateResult {
  if (!hasVisual) {
    // A control that cannot move is not drawn as a control — the rule `editorKindTpl` states for a
    // Document with one editor kind. The Visual button is never drawn disabled.
    return html`<span class="diff-view-static">Code</span>`;
  }
  const view = diffViewOf(paneId);
  const button = (value: DiffView, label: string, title: string) => html`
    <sp-action-button
      size="s"
      role="radio"
      title=${title}
      aria-checked=${view === value ? "true" : "false"}
      ?selected=${view === value}
      @click=${() => {
        if (diffViewOf(paneId) === value) {
          return;
        }
        setDiffView(paneId, value);
        repaintDiffStage(paneId);
      }}
      >${label}</sp-action-button
    >
  `;
  return html`
    <sp-action-group compact size="s" class="diff-view" role="radiogroup" aria-label="Diff view">
      ${button("visual", "Visual", "Show the change on the page")}
      ${button("code", "Code", "Show the change in the file's text")}
    </sp-action-group>
  `;
}

/**
 * The toolbar: what changed, and the stepper.
 *
 * The counter is a static span rather than a button because it has no verb — `.pc-zoom-label` is a
 * button only because clicking it resets the zoom. Before the first step it reads "12 changes"
 * rather than "0 of 12", because the author is not on a change yet.
 */
export function diffToolbarTpl(paneId: string): TemplateResult {
  const map = diffChangeMapOf(paneId);
  /* THE COUNT BELONGS TO THE VIEW THAT IS SHOWING, and the two views count different things. The
     change map counts NODES, which is the right answer for the artboards and the wrong one for a
     text comparison: a `package.json` whose dependency versions moved has no node change at all —
     its keys are the ROOT's, and a root key is reported in words rather than tinted — so the Code
     view sat over a screenful of red and green saying "No changes, document settings changed".
     Monaco owns the line diff and its own navigation there, so the toolbar states what it is
     showing and steps out of the way. */
  const code = diffViewOf(paneId) === "code" || map === null;
  const total = code ? 0 : diffChangeCount(paneId);
  const index = code ? -1 : diffStepOf(paneId);
  const label = code
    ? "Changed lines are marked"
    : total === 0
      ? "No changes"
      : index < 0
        ? `${total} ${total === 1 ? "change" : "changes"}`
        : `${index + 1} of ${total}`;
  const stepper =
    total === 0
      ? nothing
      : html`
          <sp-action-button
            size="s"
            quiet
            title="Previous change"
            ?disabled=${index <= 0}
            @click=${() => onStepClick(paneId, -1)}
          >
            <sp-icon-chevron-up slot="icon" size="s"></sp-icon-chevron-up>
          </sp-action-button>
          <span class="diff-step-count">${label}</span>
          <sp-action-button
            size="s"
            quiet
            title="Next change"
            ?disabled=${index >= total - 1}
            @click=${() => onStepClick(paneId, 1)}
          >
            <sp-icon-chevron-down slot="icon" size="s"></sp-icon-chevron-down>
          </sp-action-button>
        `;
  return html`
    <div class="diff-toolbar-inner" role="group" aria-label="Changes against HEAD">
      ${viewTpl(paneId, map !== null)}
      ${total === 0 ? html`<span class="diff-step-count">${label}</span>` : stepper}
      ${
        !code && map?.degraded
          ? html`<span class="diff-note" title="A group of siblings was too large to pair up"
              >some shown as add/remove</span
            >`
          : nothing
      }
      ${
        !code && map?.rootKeys.length
          ? html`<span class="diff-note" title=${`Changed: ${map.rootKeys.join(", ")}`}
              >document settings changed</span
            >`
          : nothing
      }
    </div>
  `;
}

/** The pane a diff verb addresses: named, or the focused one. */
function paneOfArgs(args: CommandArgValues): string {
  const { pane } = args as { pane?: unknown };
  return typeof pane === "string" ? pane : workspace.activePaneId;
}

const paneProperty = stringProperty("Which pane to act on. Defaults to the focused one.");

/**
 * Walking a comparison, and choosing which half of it to read.
 *
 * **`keyScope` is `global`, not `canvas`**, and that is not a preference. `keyScopeStack` switches
 * on `ctx.editor.kind`, and `diff` falls through to the default arm — its own docstring says so:
 * "Preview and the non-editing surfaces (the diff view, the media library, the stylebook) get the
 * bare `global` stack." A chord declared in the canvas scope would never fire here.
 *
 * `f7` / `shift+f7` are VSCode's own next/previous-difference chords and are free in this keymap
 * (`f6` / `shift+f6` are region cycling).
 */
export function diffCommands(): AnyCommand[] {
  const onDiff = (paneId: string) => diffChangeCount(paneId) > 0;
  return [
    {
      args: argsSchema({ pane: paneProperty }),
      category: "View",
      group: "3_canvas",
      id: "diff.nextChange",
      keybinding: "f7",
      keyScope: "global",
      level: "document",
      menus: ["palette"],
      requires: "a pane showing a comparison with changes",
      title: "Next Change",
      undo: "none",
      when: (ctx) => ctx.editor.kind === "diff",
      // The FOCUSED pane, because that is what a command's subject is. The toolbar's own buttons
      // Call `stepDiffAndReveal(paneId, …)` with the pane they were drawn for instead — one
      // Implementation, two subjects, which is the split `check-pane-singletons.ts` looks for.
      enablement: () => onDiff(workspace.activePaneId),
      run: (_ctx, args) => stepDiffAndReveal(paneOfArgs(args), 1),
    },
    {
      args: argsSchema({ pane: paneProperty }),
      category: "View",
      group: "3_canvas",
      id: "diff.previousChange",
      keybinding: "shift+f7",
      keyScope: "global",
      level: "document",
      menus: ["palette"],
      requires: "a pane showing a comparison with changes",
      title: "Previous Change",
      undo: "none",
      when: (ctx) => ctx.editor.kind === "diff",
      // The FOCUSED pane, because that is what a command's subject is. The toolbar's own buttons
      // Call `stepDiffAndReveal(paneId, …)` with the pane they were drawn for instead — one
      // Implementation, two subjects, which is the split `check-pane-singletons.ts` looks for.
      enablement: () => onDiff(workspace.activePaneId),
      run: (_ctx, args) => stepDiffAndReveal(paneOfArgs(args), -1),
    },
    {
      args: argsSchema(
        {
          pane: paneProperty,
          view: enumProperty(["visual", "code"], "Which half of the comparison to show."),
        },
        ["view"],
      ),
      category: "View",
      group: "3_canvas",
      id: "diff.setView",
      level: "document",
      menus: ["palette"],
      requires: "a pane showing a comparison",
      title: "Set Diff View",
      undo: "none",
      when: (ctx) => ctx.editor.kind === "diff",
      aiTool: {
        description:
          "Show a comparison as the rendered page (visual) or as its file text (code). Idempotent.",
        name: "set_diff_view",
      },
      run: (_ctx, args) => {
        // An idempotent SETTER, never a toggle: the screenshot contract refuses a `toggle*` id, and
        // A verb whose result depends on the state it is called in cannot be photographed honestly.
        const view = enumArg("diff.setView", args, "view", ["visual", "code"] as const);
        const paneId = paneOfArgs(args);
        if (diffViewOf(paneId) === view) {
          return;
        }
        setDiffView(paneId, view);
        repaintDiffStage(paneId);
      },
    },
  ];
}
