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
 */

import { canvasPanels, getNodeAtPath, parentElementPath } from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { toRaw } from "../reactivity";
import { postPatchToHosts } from "./iframe-host";
import { canvasPerf, recordEscalation } from "./canvas-perf";
import { setPatchConsumer } from "../tabs/patch-ops";

import type { JxPatchOp, TransactionRecord } from "../tabs/patch-ops";
import type { Tab } from "../tabs/tab.js";
import type { JxPath } from "../state";

/** Render-side callbacks injected at init so this module stays free of heavy canvas imports. */
interface CanvasPatcherCtx {
  getCanvasMode: () => string;
  scheduleCanvasRender: () => void;
  applyCanvasMediaOverrides: (canvasEl: Element, activeBreakpoints: Set<string>) => void;
  renderOverlays: () => void;
  updateForcedPseudoPreview: () => void;
}

let _ctx: CanvasPatcherCtx | null = null;

/** Document root references whose change was applied surgically (checked by the doc-effect). */
const _consumed = new WeakSet<object>();

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
    markConsumed: (docRef: object) => {
      _consumed.add(toRaw(docRef) as object);
    },
  });
}

/**
 * One-shot check used by the canvas doc-effect: returns true (and clears the mark) when the given
 * document reference was already applied to the canvas surgically, so the full render can be
 * skipped. One-shot so tab switches and repeat triggers still render fully.
 *
 * @param {object} doc
 */
export function consumePatchedDocument(doc: object): boolean {
  const raw = toRaw(doc) as object;
  if (_consumed.has(raw)) {
    _consumed.delete(raw);
    canvasPerf.skippedFullRenders += 1;
    return true;
  }
  return false;
}

/** Schedule the fallback full render and record why. */
export function escalateToFullRender(reason: string) {
  recordEscalation(reason);
  _ctx?.scheduleCanvasRender();
}

// ─── Classification ──────────────────────────────────────────────────────────

/** Identity check that survives reactive proxy wrapping (activeTab.value is a proxy). */
function isActiveTab(tab: Tab) {
  const active = activeTab.value;
  return active !== null && toRaw(active as object) === toRaw(tab as unknown as object);
}

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
  for (let i = 0; i <= parentPath.length; i += 2) {
    const node = getNodeAtPath(doc, parentPath.slice(0, i));
    if (!node) {
      return "node-not-found";
    }
    if (typeof node.tagName === "string" && node.tagName.includes("-")) {
      return "structure-in-custom-element";
    }
  }
  const parent = getNodeAtPath(doc, parentPath);
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

/** Verdict for ops applied as a subtree replace at `path`. */
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
  const container = containerVerdict(tab, parentPath, false);
  if (container) {
    return container;
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

  if (!isActiveTab(tab)) {
    return reject("inactive-tab");
  }
  const canvasMode = _ctx ? _ctx.getCanvasMode() : "";
  if (canvasMode !== "design" && canvasMode !== "edit") {
    return reject(`mode-${canvasMode || "unknown"}`);
  }
  if (canvasPanels.length === 0) {
    return reject("no-panels");
  }
  // The iframe canvas keeps its render context inside the iframe, so a panel is patchable as soon as
  // It has rendered (`ready`) — there is no parent-side `liveCtx`.
  if (!canvasPanels.every((p) => p.ready)) {
    return reject("panels-not-ready");
  }
  // Inline editing now lives inside the iframe canvas, which the parent patcher can't observe; the
  // Iframe escalates to a full render itself if a posted patch can't apply mid-edit. So there is no
  // Parent-side inline-edit guard here anymore.
  for (const op of ops) {
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
export function applyPatchBatch(_tab: Tab, _ops: JxPatchOp[], record?: TransactionRecord) {
  // The canvas renders inside the iframe — the parent has no DOM to mutate. Post the value-carrying
  // Forward ops over the bridge for the iframe to apply against its shadow doc. Throwing when no host
  // Received it escalates to a full render (the suppressed render then runs), so an edit is never
  // Dropped.
  const forwardOps = (record?.docOps ?? []).map((pair) => pair.forward);
  if (postPatchToHosts(forwardOps, view.renderGeneration) === 0) {
    throw new Error("no-ready-iframe-host");
  }
}
