/// <reference lib="dom" />
/**
 * Canvas patcher — applies recorded document mutations (patch ops) surgically to the live canvas
 * DOM instead of re-rendering everything. Registered as the patch consumer for transactDoc.
 *
 * Safety model: classify() admits only changes it can prove are safe to patch in the current canvas
 * state; everything else (and any exception during apply) escalates to the existing full-render
 * path. The failure mode of any patcher bug is a full render — today's behavior — never a corrupt
 * canvas.
 *
 * Patching is only attempted in design/edit canvas modes, where the canvas renders through
 * prepareForEditMode: runtime reactive bindings are inert there, so the patcher is the only writer
 * to the patched DOM.
 *
 * Every question here is asked of ONE PANE — the one showing the edited tab (`canvas-surface.ts`).
 * The mode, the panel list, the readiness test and the render an escalation schedules are all
 * properties of a stage, and reading them globally is how a second pane mid-mount would refuse an
 * edit typed into the first, and how one failed patch would rebuild both.
 */

import { getNodeAtPath, parentElementPath } from "../store";
import { canvasModeOfPane, surfacesShowingTab } from "./canvas-surface";
import { toRaw } from "../reactivity";
import { postPatchToHosts } from "./iframe-host";
import { canvasPerf, recordEscalation, SPAN_PATCH_BATCH, timeSpan } from "./canvas-perf";
import { setPatchConsumer } from "../tabs/patch-ops";

import type { CanvasSurface } from "./surface-registry";
import type { JxPatchOp, TransactionRecord } from "../tabs/patch-ops";
import type { Tab } from "../tabs/tab.js";
import type { JxPath } from "../state";

/** Render-side callbacks injected at init so this module stays free of heavy canvas imports. */
interface CanvasPatcherCtx {
  /** Schedule ONE pane's full render — never "the canvas". See {@link escalateToFullRender}. */
  scheduleCanvasRender: (paneId: string) => void;
  renderOverlays: () => void;
}

let _ctx: CanvasPatcherCtx | null = null;

/**
 * Document root references whose change was applied surgically, and the PANES it reached.
 *
 * A `WeakSet` of references, until one document could be displayed in two panes. Each pane runs its
 * own doc-effect, both fire on the same root-reference swap, and the first to arrive consumed the
 * one mark — so the second pane full-rendered every surgically patched edit while
 * `skippedFullRenders` reported a single skip. That inverts workstream 1's whole result in exactly
 * the configuration workstream 3 introduces, and reports it as a win. The mark is per pane now, and
 * each pane deletes only its own.
 */
const _consumed = new WeakMap<object, Set<string>>();

/**
 * Initialize the canvas patcher and register it as the transactDoc patch consumer.
 *
 * @param {CanvasPatcherCtx} ctx
 */
export function initCanvasPatcher(ctx: CanvasPatcherCtx) {
  _ctx = ctx;
  setPatchConsumer({
    apply: applyPatchBatch,
    classify: classifyOps,
    escalate: escalateToFullRender,
    markConsumed: (docRef: object, tab: Tab) => {
      markConsumed(
        docRef,
        patchableSurfaces(tab).map((surface) => surface.paneId),
      );
    },
  });
}

/**
 * The stages that can actually TAKE a patch: showing the tab, and drawing an editable canvas.
 *
 * **One function, because two of them disagreed and the disagreement lost edits.**
 * {@link classifyOps} SKIPS a showing stage that cannot patch — that is what lets a Code lens open
 * beside a page without killing surgical patching for the page. `markConsumed` marked every stage
 * DISPLAYING the tab. So opening Code beside a page and typing marked the lens as patched, its
 * doc-effect returned before `scheduleCanvasRender`, and `canvas-render.ts`'s source fast path —
 * the only thing that refreshes a source-mode Monaco — never ran. The Code view sat frozen while
 * `skippedFullRenders` counted it as a win.
 *
 * The panel/readiness half of `classifyOps`' gate is deliberately NOT repeated here: a batch only
 * reaches `markConsumed` after that gate passed, so every surface this returns had ready panels
 * when the verdict was taken.
 *
 * @param {Tab | null} tab
 * @returns {CanvasSurface[]}
 */
function patchableSurfaces(tab: Tab | null): CanvasSurface[] {
  return surfacesShowingTab(tab).filter((candidate) => {
    const mode = canvasModeOfPane(candidate.paneId);
    return mode === "design" || mode === "edit";
  });
}

/**
 * Record that `docRef`'s change has been applied surgically in each of `paneIds`.
 *
 * No empty-list guard, because the list cannot be empty here: `transactDoc` marks only a batch
 * {@link classifyOps} called patchable, and that function rejects `patchableSurfaces(tab).length
 * === 0` before it can say so. A guard on an unreachable value is a branch no test can enter — the
 * gate's own rule — and `_consumed` is a `WeakMap` keyed on a reference `transactDoc` mints fresh
 * per transaction, so there is nothing for one to protect either.
 *
 * @param {object} docRef
 * @param {readonly string[]} paneIds
 */
function markConsumed(docRef: object, paneIds: readonly string[]) {
  _consumed.set(toRaw(docRef) as object, new Set(paneIds));
}

/**
 * One-shot check used by ONE PANE's canvas doc-effect: returns true (and clears that pane's mark)
 * when the given document reference was already applied to that pane's stage surgically, so its
 * full render can be skipped. One-shot so tab switches and repeat triggers still render fully.
 *
 * @param {object} doc
 * @param {string} paneId
 */
export function consumePatchedDocument(doc: object, paneId: string): boolean {
  const raw = toRaw(doc) as object;
  const panes = _consumed.get(raw);
  if (!panes?.has(paneId)) {
    return false;
  }
  panes.delete(paneId);
  if (panes.size === 0) {
    _consumed.delete(raw);
  }
  canvasPerf.skippedFullRenders += 1;
  return true;
}

/**
 * Schedule the fallback full render of every pane showing `tab`, and record why.
 *
 * An escalation is a statement about a stage whose DOM no longer matches its document, and only a
 * stage that was handed the patch can be in that state — a global schedule would rebuild the other
 * pane's iframes (reloading them, losing their scroll and any live edit) because a document it is
 * not showing failed to patch. That is why this resolves stages from the tab rather than scheduling
 * "the canvas"; it is now PLURAL for the other half of the same reason: a document displayed in two
 * panes was handed the patch in both, so both are out of date when it fails.
 *
 * With no pane showing the tab (a `patchError` arriving after the pane's tab changed, or an apply
 * failure on a tab no pane is showing) there is nothing to re-render, so nothing is scheduled — the
 * reason is still recorded, because a swallowed escalation that no counter saw is exactly the class
 * of bug `__jxCanvasPerf` exists to make visible.
 *
 * @param {string} reason
 * @param {Tab | null} tab
 */
export function escalateToFullRender(reason: string, tab: Tab | null = null) {
  recordEscalation(reason);
  for (const surface of surfacesShowingTab(tab)) {
    _ctx?.scheduleCanvasRender(surface.paneId);
  }
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * $switch cases render as a substituted first-case placeholder in edit mode, so their element paths
 * don't correspond to document paths — edits through "cases" escalate to a full render. (Non-
 * structural edits to a repeater template — text/style/prop on a `…/map` path — DO patch, since the
 * template renders as a single 1:1 instance inside its perimeter; structural edits inside a
 * template escalate via {@link containerVerdict}.)
 */
function pathHasDynamicSegment(path: JxPath) {
  return path.includes("cases");
}

/**
 * Whether a children array at parentPath can be structurally patched: no $switch/template segments,
 * no custom-element ancestors (slot redistribution breaks doc↔DOM child correspondence), no
 * innerHTML on the parent, and a real children array.
 *
 * @param {Tab} tab
 * @param {JxPath} parentPath
 */
function containerVerdict(tab: Tab, parentPath: JxPath, requireArray = true): string | null {
  if (pathHasDynamicSegment(parentPath)) {
    return "structure-on-cases-path";
  }
  // Structural edits inside a repeater template (a "map" segment) escalate: the edit-mode perimeter
  // Holds one template instance, so changing the template's child count can't be spliced 1:1.
  if (parentPath.includes("map")) {
    return "structure-on-map-path";
  }
  const doc = tab.doc.document;
  const parent = getNodeAtPath(doc, parentPath);
  if (!parent) {
    return "node-not-found";
  }
  /*
   * Only the IMMEDIATE parent's tag matters, not every ancestor's.
   *
   * These ops locate their target by its stamped `data-jx-path` (iframe-patch's `requireElement`);
   * the one place DOM child-index correspondence is consulted is `domChildReference`, which indexes
   * `parentEl.childNodes` to pick the insertion reference. That is a property of the immediate
   * parent alone — a custom element further up the chain projects its own light-DOM children through
   * slots, which changes where they RENDER, not the child order of some plain container beneath it.
   *
   * Scanning every ancestor rejected the common case instead: markdown class-directive pages put
   * every editable block inside a component, so pressing Enter there forced a full render (reloading
   * embedded iframes) on a correspondence that was never actually at risk. This mirrors the
   * reasoning `replaceVerdict` already documents — and if the element turns out to be un-queryable
   * after all, the iframe throws `element-not-found` and the parent escalates, reaching the same
   * outcome without the false positives.
   *
   * The immediate parent stays conservative: when it IS a component INSTANCE, its children may be
   * rendered by the component rather than as light DOM, and an insert would land at the wrong
   * position rather than fail loudly.
   *
   * Except at the document root — the same carve-out `isIslandBoundary` makes for the caret
   * (iframe-position.ts). A component DEFINITION opened as its own document has a hyphenated tagName,
   * but its subtree IS the document: the canvas renders the definition's own body, not an instance of
   * it, so those children are ordinary light DOM. Without this, every structural edit to any component
   * definition escalated to a full render — in a component-heavy project, the most common authoring
   * action there is.
   */
  if (parentPath.length > 0 && typeof parent.tagName === "string" && parent.tagName.includes("-")) {
    return "structure-in-custom-element";
  }
  if (parent.innerHTML) {
    return "structure-with-innerhtml";
  }
  // Index-based splicing needs a real children array. An array (repeater) node itself has no
  // Children array (its content is the `map` template), so inserts/moves targeting it escalate.
  if (requireArray && !Array.isArray(parent.children)) {
    return "structure-children-not-array";
  }
  return null;
}

/**
 * Verdict for ops applied as a subtree replace at `path`. Unlike the structural splices
 * (insert/remove/move), a replace locates its target DIRECTLY by its stamped `data-jx-path`
 * (iframe-patch `requireElement`) and swaps it in place — doc↔DOM child-index correspondence is
 * never consulted, so a custom-element ancestor (slot redistribution) cannot break it and is NOT a
 * reason to escalate. That matters for real content: markdown class-directive pages put every
 * editable block inside a component, and rejecting those forced a full render (reloading embedded
 * iframes) on every text commit. Should the element be un-queryable after all (e.g. a component
 * rendered its children into shadow DOM), the iframe throws element-not-found and the parent
 * escalates — the same outcome as rejecting here, without the false positives.
 */
function replaceVerdict(tab: Tab, path: JxPath): string | null {
  if (path.length === 0) {
    return "replace-root";
  }
  if (pathHasDynamicSegment(path)) {
    return "replace-on-cases-path";
  }
  const parentPath = parentElementPath(path) as JxPath | null;
  if (!parentPath) {
    return "replace-no-parent";
  }
  // A subtree re-render inside a repeater template can't be re-rendered 1:1 in the edit-mode
  // Perimeter (mirrors containerVerdict's map rule).
  if (parentPath.includes("map")) {
    return "structure-on-map-path";
  }
  const parent = getNodeAtPath(tab.doc.document, parentPath);
  if (!parent) {
    return "node-not-found";
  }
  // An innerHTML parent renders opaque children — the target has no stamped element to swap.
  if (parent.innerHTML) {
    return "structure-with-innerhtml";
  }
  return getNodeAtPath(tab.doc.document, path) === undefined ? "node-not-found" : null;
}

/**
 * Per-op patchability in the current document. Returns null when patchable, else the reason.
 *
 * @param {Tab} tab
 * @param {JxPatchOp} op
 */
function opVerdict(tab: Tab, op: JxPatchOp): string | null {
  switch (op.op) {
    case "set-style": {
      if (pathHasDynamicSegment(op.path)) {
        return "style-on-cases-path";
      }
      return getNodeAtPath(tab.doc.document, op.path) ? null : "node-not-found";
    }
    case "set-text": {
      if (pathHasDynamicSegment(op.path)) {
        return "text-on-cases-path";
      }
      const node = getNodeAtPath(tab.doc.document, op.path);
      if (!node) {
        return "node-not-found";
      }
      if (typeof node.tagName === "string" && node.tagName.includes("-")) {
        return "text-on-custom-element";
      }
      if (node.innerHTML) {
        return "text-with-innerhtml";
      }
      const kids = node.children;
      if (Array.isArray(kids) ? kids.length > 0 : kids != null) {
        return "text-with-children";
      }
      return null;
    }
    case "set-prop": {
      // Event bindings are stripped from design/edit renders — editing them is a canvas no-op.
      // Other property changes re-render the node's subtree in place.
      return op.isEvent ? null : replaceVerdict(tab, op.path);
    }
    case "set-attr":
    case "replace": {
      return replaceVerdict(tab, op.path);
    }
    case "insert": {
      return containerVerdict(tab, op.parentPath);
    }
    case "remove": {
      const parentPath = parentElementPath(op.path) as JxPath | null;
      return parentPath === null ? "remove-no-parent" : containerVerdict(tab, parentPath);
    }
    case "move": {
      if (pathHasDynamicSegment(op.fromPath)) {
        return "structure-on-cases-path";
      }
      const fromParentPath = parentElementPath(op.fromPath) as JxPath | null;
      if (fromParentPath === null) {
        return "move-no-parent";
      }
      // The from-parent's children array was already verified by the mutation itself; its
      // Custom-element/innerHTML constraints still need checking on both ends.
      return containerVerdict(tab, fromParentPath) ?? containerVerdict(tab, op.toParentPath);
    }
    default: {
      return `${op.op}-unsupported`;
    }
  }
}

/**
 * Decide whether a recorded batch can be applied surgically right now.
 *
 * @param {Tab} tab
 * @param {JxPatchOp[]} ops
 */
export function classifyOps(tab: Tab, ops: JxPatchOp[]): { patchable: boolean; reason: string } {
  const reject = (reason: string) => {
    recordEscalation(reason);
    return { patchable: false, reason };
  };

  /*
   * Every gate below is asked of the PANES showing this tab — not of the app.
   *
   * A tab is OWNED by one pane and may be DISPLAYED by two (a derived pane projects the pane it
   * derives from), so the stages that could apply the patch are exactly those, and their readiness,
   * their modes and their panel lists are the only ones that can decide the question. Read
   * globally, the readiness test made the other pane's mid-mount canvas refuse an edit typed into
   * this one, and the mode test asked what the FOCUSED pane was doing about a document it may not
   * even be showing.
   */
  const showing = surfacesShowingTab(tab);
  if (showing.length === 0) {
    return reject("inactive-tab");
  }
  /* A stage not drawing an editable canvas is SKIPPED, not counted as a rejection — and that is the
     difference between opening a Code lens beside a page and killing surgical patching for the page
     itself. A Code lens has no artboards and is in no patchable mode; folding it into `every` would
     have rejected the batch as `mode-source`/`no-panels` and full-rendered both stages on every
     keystroke. Only when NO showing stage can take the patch is the mode a rejection.
     The SAME predicate decides what `markConsumed` marks — see {@link patchableSurfaces} for what
     it cost when these were two filters that had drifted apart. */
  const patchable = patchableSurfaces(tab);
  if (patchable.length === 0) {
    const canvasMode = canvasModeOfPane(showing[0]!.paneId);
    return reject(`mode-${canvasMode || "unknown"}`);
  }
  for (const surface of patchable) {
    const { panels } = surface;
    if (panels.length === 0) {
      return reject("no-panels");
    }
    // The iframe canvas keeps its render context inside the iframe, so a panel is patchable as soon
    // As it has rendered (`ready`) — there is no parent-side `liveCtx`.
    if (!panels.every((p) => p.ready)) {
      return reject("panels-not-ready");
    }
  }
  // A `set-text` on a node whose CHILDREN are replaced in the same batch is subsumed by that
  // Subtree re-render (the iframe folds every forward op into the shadow doc first, then the
  // Trailing children re-render draws the node from the final state — see iframe-patch.ts). This is
  // The rich-text inline-commit shape (clear text + set children), which opVerdict alone would
  // Reject as "text-with-children" because classification runs POST-mutation — the node already has
  // Its new children by the time we look.
  const subtreeReplacedPaths = new Set<string>();
  for (const op of ops) {
    if ((op.op === "set-prop" && op.key === "children") || op.op === "replace") {
      subtreeReplacedPaths.add(JSON.stringify(op.path));
    }
  }
  // Inline editing now lives inside the iframe canvas, which the parent patcher can't observe; the
  // Iframe escalates to a full render itself if a posted patch can't apply mid-edit. So there is no
  // Parent-side inline-edit guard here anymore.
  for (const op of ops) {
    if (op.op === "set-text" && subtreeReplacedPaths.has(JSON.stringify(op.path))) {
      continue;
    }
    const reason = opVerdict(tab, op);
    if (reason) {
      return reject(reason);
    }
  }
  // Classification is host-agnostic: the iframe canvas applies the SAME op set surgically as the
  // Legacy DOM patcher (in-place style/text, structural relocation, and subtree re-renders for
  // Insert/replace/attr/prop — see iframe-patch.ts). An op the iframe somehow can't apply throws and
  // The parent escalates to a full render — so a stricter gate here would only forgo optimization.
  return { patchable: true, reason: "" };
}

// ─── Application ─────────────────────────────────────────────────────────────

/**
 * Apply a classified batch to every canvas panel. Throws on any failure; transactDoc catches and
 * escalates to a full render.
 *
 * @param {Tab} tab
 * @param {JxPatchOp[]} ops
 * @param {TransactionRecord} [record] Value-carrying ops, used by the iframe host.
 */
export function applyPatchBatch(tab: Tab, _ops: JxPatchOp[], record?: TransactionRecord) {
  // The canvas renders inside the iframe — the parent has no DOM to mutate. Post the value-carrying
  // Forward ops over the bridge for the iframe to apply against its shadow doc — only to hosts
  // Rendering THIS tab's document (a background tab's iframe must never fold a foreign edit into
  // Its shadow doc). Throwing when no host received it escalates to a full render (the suppressed
  // Render then runs), so an edit is never dropped.
  timeSpan(SPAN_PATCH_BATCH, () => {
    const forwardOps = (record?.docOps ?? []).map((pair) => pair.forward);
    /* ONE call, and no generation. Each host checks the patch against the generation of the stage
       it is mounted on, resolved inside `postPatchToHosts` — see the note there on why a single
       number for a multi-pane fan-out is the bug rather than a parameter needing a better value.
       Posting once per showing surface would post the same patch to the same host twice, because
       that loop spans stages by design.
       And no `surfacesShowingTab(tab).length > 0` guard in front of it. There was one, and it was
       a condition with no false branch: `tabs/transact.ts` calls `apply` only when `classify`
       returned patchable in the statement above it, and {@link classifyOps} rejects
       `inactive-tab` for exactly the case the guard was checking. A tab no pane is showing posts
       to no host anyway, `hosts` falls to 0, and the throw below escalates the batch. */
    const hosts = postPatchToHosts(forwardOps, tab.id);
    if (hosts === 0) {
      throw new Error("no-ready-iframe-host");
    }
    // The counter the escalation count is read against: `patchedOps` versus `escalations` is how
    // Much of an authoring session avoided a render at all. It is the OPS, not ops×hosts — one
    // Mutation posted to six artboards is one mutation, and counting the fan-out here would make
    // A wide canvas look like it was doing more work than a narrow one.
    canvasPerf.patchedOps += forwardOps.length;
  });
}
