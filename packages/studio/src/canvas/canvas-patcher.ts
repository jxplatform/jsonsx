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

import {
  canvasPanels,
  childIndex,
  elToPath,
  elToRenderScope,
  getNodeAtPath,
  parentElementPath,
} from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { toRaw } from "../reactivity";
import { elementStyleTags, reapplyStyle } from "@jxsuite/runtime";
import { getEffectiveMedia } from "../site-context";
import { findCanvasElement } from "./canvas-helpers";
import { isIframeCanvas } from "./canvas-host";
import { postPatchToHosts } from "./iframe-host";
import { domChildReference, renderSubtree } from "./canvas-subtree-render";
import { canvasPerf, perfLog, recordEscalation } from "./canvas-perf";
import {
  computeEmptyPlaceholderClass,
  EMPTY_PLACEHOLDER_CLASSES,
  templateToEditDisplay,
} from "../utils/edit-display";
import { getActiveElement } from "../editor/inline-edit";
import { setPatchConsumer } from "../tabs/patch-ops";

import type { JxPatchOp, TransactionRecord } from "../tabs/patch-ops";
import type { Tab } from "../tabs/tab.js";
import type { JxPath } from "../state";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";
import type { CanvasPanel, InlineEditDef } from "../types";

/** Render-side callbacks injected at init so this module stays free of heavy canvas imports. */
interface CanvasPatcherCtx {
  getCanvasMode: () => string;
  scheduleCanvasRender: () => void;
  applyCanvasMediaOverrides: (canvasEl: Element, activeBreakpoints: Set<string>) => void;
  renderOverlays: () => void;
  updateForcedPseudoPreview: () => void;
  enterComponentInlineEdit: (el: HTMLElement, path: JxPath) => void;
  registerSubtreeDnD: (rootEl: HTMLElement) => void;
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

const STRUCTURAL_OPS = new Set(["insert", "move", "remove", "replace", "set-attr", "set-prop"]);

/** Whether an op changes DOM structure (vs in-place style/text writes). */
function isStructuralOp(op: JxPatchOp) {
  return STRUCTURAL_OPS.has(op.op) && !(op.op === "set-prop" && op.isEvent);
}

/**
 * Whether the iframe canvas can apply this op surgically TODAY. Phase 3a: pure in-place writes
 * (style/text/inert events). Phase 3b-1: structural ops that need no rendering — `remove` and
 * `move` are pure DOM relocation + `data-jx-path` remap in the iframe. Still rejected (→ full
 * render): `insert`/`replace`/`set-attr`/`set-prop` (need a subtree re-render — Phase 3b-2).
 */
function isIframePatchable(op: JxPatchOp) {
  return (
    op.op === "set-style" ||
    op.op === "set-text" ||
    op.op === "remove" ||
    op.op === "move" ||
    (op.op === "set-prop" && op.isEvent === true)
  );
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
  if (!canvasPanels.every((p) => p.ready && p.liveCtx)) {
    return reject("panels-not-ready");
  }
  // Structural changes while an inline edit session is live would pull the DOM out from under
  // The editor — rare (commit flows tear down first), so escalate conservatively.
  if (view.componentInlineEdit && ops.some((op) => isStructuralOp(op))) {
    return reject("inline-edit-active");
  }
  for (const op of ops) {
    const reason = opVerdict(tab, op);
    if (reason) {
      return reject(reason);
    }
  }
  // The iframe canvas applies a narrower op set surgically than the legacy DOM patcher; the rest
  // Full-render (until Phase 3b). Gating here means the iframe only ever receives patchable ops, so
  // No wasted patch→patchError→render round-trip.
  if (isIframeCanvas()) {
    for (const op of ops) {
      if (!isIframePatchable(op)) {
        return reject(`iframe-unsupported-${op.op}`);
      }
    }
  }
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
export function applyPatchBatch(tab: Tab, ops: JxPatchOp[], record?: TransactionRecord) {
  // Iframe canvas host: the parent has no DOM to mutate — post the value-carrying forward ops over
  // The bridge for the iframe to apply against its shadow doc. Throwing when no host received it
  // Escalates to a full render (the suppressed render then runs), so an edit is never dropped.
  if (isIframeCanvas()) {
    const forwardOps = (record?.docOps ?? []).map((pair) => pair.forward);
    if (postPatchToHosts(forwardOps, view.renderGeneration) === 0) {
      throw new Error("no-ready-iframe-host");
    }
    return;
  }

  const doc = toRaw(tab.doc.document) as JxMutableNode;
  const mediaQueries = getEffectiveMedia(doc.$media || {});

  for (const op of ops) {
    for (const panel of canvasPanels) {
      applyOpToPanel(panel, doc, op, mediaQueries);
    }
    canvasPerf.patchedOps += 1;
    perfLog("patched", op);
  }

  // Hover targets may have moved or vanished after structural changes; the next mousemove
  // Recomputes it. (Selection is path-adjusted by the mutators themselves.)
  if (tab.session.hover && ops.some((op) => isStructuralOp(op))) {
    tab.session.hover = null;
  }

  _ctx?.renderOverlays();
  _ctx?.updateForcedPseudoPreview();
  schedulePendingInlineEditConsumption(tab);
}

/**
 * @param {CanvasPanel} panel
 * @param {JxMutableNode} doc
 * @param {JxPatchOp} op
 * @param {Record<string, string>} mediaQueries
 */
function applyOpToPanel(
  panel: CanvasPanel,
  doc: JxMutableNode,
  op: JxPatchOp,
  mediaQueries: Record<string, string>,
) {
  switch (op.op) {
    case "set-style": {
      const el = requireElement(op.path, panel);
      const node = getNodeAtPath(doc, op.path);
      reapplyStyle(el, editModeStyle(node?.style), mediaQueries, {});
      restoreEditModePointerEvents(el);
      if (panel.activeBreakpoints && panel.activeBreakpoints.size > 0) {
        _ctx?.applyCanvasMediaOverrides(panel.canvas as HTMLElement, panel.activeBreakpoints);
      }
      return;
    }
    case "set-text": {
      const el = requireElement(op.path, panel);
      // The element being inline-edited already shows the committed text — don't clobber the
      // User's live DOM (this replaces the old destroy-and-restore full-render cycle).
      if (isBeingInlineEdited(el)) {
        return;
      }
      const node = getNodeAtPath(doc, op.path);
      el.textContent = textDisplayValue(node);
      for (const cls of EMPTY_PLACEHOLDER_CLASSES) {
        el.classList.remove(cls);
      }
      const placeholder = node ? computeEmptyPlaceholderClass(node) : null;
      if (placeholder) {
        el.classList.add(placeholder);
      }
      restoreEditModePointerEvents(el);
      return;
    }
    case "set-prop": {
      if (op.isEvent) {
        // Event bindings are stripped from design/edit renders — nothing to do.
        return;
      }
      replaceSubtree(panel, doc, op.path);
      return;
    }
    case "set-attr":
    case "replace": {
      replaceSubtree(panel, doc, op.path);
      return;
    }
    case "insert": {
      insertChild(panel, doc, op.parentPath, op.index);
      return;
    }
    case "remove": {
      removeChild(panel, doc, op.path);
      return;
    }
    case "move": {
      moveChild(panel, doc, op.fromPath, op.toParentPath, op.toIndex);
      return;
    }
    default: {
      throw new Error(`unsupported-op:${(op as JxPatchOp).op}`);
    }
  }
}

// ─── Structural patching ─────────────────────────────────────────────────────

/** Re-render the node at path and swap it into the DOM in place. */
function replaceSubtree(panel: CanvasPanel, doc: JxMutableNode, path: JxPath) {
  const oldEl = requireElement(path, panel);
  const parentEl = oldEl.parentElement;
  if (!parentEl) {
    throw new Error("replace-missing-parent-element");
  }
  const newEl = renderSubtree(panel, doc, path, parentEl);
  disposeSubtree(oldEl);
  oldEl.replaceWith(newEl);
  afterSubtreeInserted(panel, newEl);
}

/** Render the inserted node and splice it into the parent's DOM, shifting sibling paths up. */
function insertChild(panel: CanvasPanel, doc: JxMutableNode, parentPath: JxPath, index: number) {
  const parentEl = requireElement(parentPath, panel);
  const parentNode = getNodeAtPath(doc, parentPath);
  const newEl = renderSubtree(panel, doc, [...parentPath, "children", index], parentEl);
  // Remap existing siblings before attaching the new subtree so it isn't itself remapped.
  remapChildPaths(parentEl, parentPath, index, 1);
  insertAt(parentEl, newEl, domChildReference(parentEl, parentNode, index));
  syncContainerPlaceholder(parentEl, parentNode);
  afterSubtreeInserted(panel, newEl);
}

/** Remove the node's DOM and shift following sibling paths down. */
function removeChild(panel: CanvasPanel, doc: JxMutableNode, path: JxPath) {
  const parentPath = parentElementPath(path) as JxPath;
  const idx = childIndex(path) as number;
  const el = requireElement(path, panel);
  const parentEl = el.parentElement;
  if (!parentEl) {
    throw new Error("remove-missing-parent-element");
  }
  disposeSubtree(el);
  el.remove();
  remapChildPaths(parentEl, parentPath, idx + 1, -1);
  syncContainerPlaceholder(parentEl, getNodeAtPath(doc, parentPath));
}

/**
 * Move = detach + path-shift both parents + rewrite the moved subtree's path prefix + reinsert.
 * fromPath is in pre-mutation coordinates (matching the DOM); toIndex is the post-mutation index
 * recorded by the mutator.
 */
function moveChild(
  panel: CanvasPanel,
  doc: JxMutableNode,
  fromPath: JxPath,
  toParentPath: JxPath,
  toIndex: number,
) {
  const fromParentPath = parentElementPath(fromPath) as JxPath;
  const fromIdx = childIndex(fromPath) as number;
  // Resolve both elements against the pre-mutation DOM mappings before touching anything.
  const el = requireElement(fromPath, panel);
  const toParentEl = requireElement(toParentPath, panel);
  const fromParentEl = el.parentElement;
  if (!fromParentEl) {
    throw new Error("move-missing-parent-element");
  }

  el.remove();
  remapChildPaths(fromParentEl, fromParentPath, fromIdx + 1, -1);
  // The to-parent's own path may have shifted by the detach remap — read it fresh.
  const toPrefix = (elToPath.get(toParentEl) as JxPath | undefined) ?? toParentPath;
  remapChildPaths(toParentEl, toPrefix, toIndex, 1);
  rewriteSubtreePathPrefix(el, fromPath, [...toPrefix, "children", toIndex]);

  const toParentNode = getNodeAtPath(doc, toPrefix);
  insertAt(toParentEl, el, domChildReference(toParentEl, toParentNode, toIndex));
  syncContainerPlaceholder(
    fromParentEl,
    getNodeAtPath(doc, elToPath.get(fromParentEl) ?? fromParentPath),
  );
  syncContainerPlaceholder(toParentEl, toParentNode);
}

/** Insert before the reference node, or append when inserting at the end. */
function insertAt(parentEl: Element, node: Node, ref: ChildNode | null) {
  if (ref) {
    ref.before(node);
  } else {
    parentEl.append(node);
  }
}

/**
 * Shift the child-index segment of elToPath entries for every element under parentEl whose path is
 * `[...parentPath, "children", i, ...]` with `i >= fromIndex`. Descendants of shifted siblings
 * carry the same segment and are rewritten too.
 */
function remapChildPaths(parentEl: Element, parentPath: JxPath, fromIndex: number, delta: number) {
  const depth = parentPath.length;
  for (const el of parentEl.querySelectorAll("*")) {
    const p = elToPath.get(el);
    if (!p || p.length < depth + 2 || p[depth] !== "children") {
      continue;
    }
    const idx = p[depth + 1];
    if (typeof idx !== "number" || idx < fromIndex) {
      continue;
    }
    if (!parentPath.every((seg, i) => p[i] === seg)) {
      continue;
    }
    const np = [...p];
    np[depth + 1] = idx + delta;
    elToPath.set(el, np);
  }
}

/** Rewrite elToPath entries of el and its descendants, replacing oldPrefix with newPrefix. */
function rewriteSubtreePathPrefix(el: Element, oldPrefix: JxPath, newPrefix: JxPath) {
  const targets = [el, ...el.querySelectorAll("*")];
  for (const t of targets) {
    const p = elToPath.get(t);
    if (!p || p.length < oldPrefix.length) {
      continue;
    }
    if (!oldPrefix.every((seg, i) => p[i] === seg)) {
      continue;
    }
    elToPath.set(t, [...newPrefix, ...p.slice(oldPrefix.length)]);
  }
}

/**
 * Release resources owned by a removed/replaced subtree: the scoped <style> tags the runtime
 * emitted for its elements, and the effect scopes of any surgical renders rooted inside it.
 */
function disposeSubtree(el: Element) {
  const targets = [el, ...el.querySelectorAll("*")];
  for (const t of targets) {
    if (t instanceof HTMLElement) {
      const tag = elementStyleTags.get(t);
      if (tag) {
        tag.remove();
        elementStyleTags.delete(t);
      }
    }
    const scope = elToRenderScope.get(t);
    if (scope) {
      scope.stop();
      elToRenderScope.delete(t);
    }
  }
}

/** Keep the parent's empty-placeholder class in sync after its children changed. */
function syncContainerPlaceholder(parentEl: Element, parentNode: JxMutableNode | undefined) {
  for (const cls of EMPTY_PLACEHOLDER_CLASSES) {
    parentEl.classList.remove(cls);
  }
  const placeholder = parentNode ? computeEmptyPlaceholderClass(parentNode) : null;
  if (placeholder) {
    parentEl.classList.add(placeholder);
  }
}

/** Post-insertion bookkeeping for a freshly rendered subtree: DnD targets + media overrides. */
function afterSubtreeInserted(panel: CanvasPanel, newEl: HTMLElement | Text) {
  if (newEl instanceof HTMLElement) {
    _ctx?.registerSubtreeDnD(newEl);
  }
  if (panel.activeBreakpoints && panel.activeBreakpoints.size > 0) {
    _ctx?.applyCanvasMediaOverrides(panel.canvas as HTMLElement, panel.activeBreakpoints);
  }
}

/**
 * @param {JxPath} path
 * @param {CanvasPanel} panel
 */
function requireElement(path: JxPath, panel: CanvasPanel): HTMLElement {
  const el = findCanvasElement(path, panel.canvas as HTMLElement);
  if (!el) {
    throw new Error(`element-not-found:${path.join("/")}`);
  }
  return el;
}

/** Whether this element is the live target of an inline editing session. */
function isBeingInlineEdited(el: HTMLElement) {
  return view.componentInlineEdit?.el === el || getActiveElement() === el;
}

/** Re-disable pointer events after a patch (full renders set this on every canvas element). */
function restoreEditModePointerEvents(el: HTMLElement) {
  if (!isBeingInlineEdited(el)) {
    el.style.pointerEvents = "none";
  }
}

/**
 * Edit-mode style transform — mirrors prepareForEditMode's style rule: top-level template-string
 * values are blanked so no reactive bindings are created for them.
 *
 * @param {JxStyle | undefined} style
 */
function editModeStyle(style: JxStyle | undefined): JxStyle | undefined {
  if (!style || typeof style !== "object") {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(style)) {
    out[k] = typeof v === "string" && v.includes("${") ? "" : v;
  }
  return out as JxStyle;
}

/**
 * Display text for a node's textContent in design/edit mode — mirrors prepareForEditMode's
 * template-string and $ref display rules.
 *
 * @param {JxMutableNode | undefined} node
 */
function textDisplayValue(node: JxMutableNode | undefined): string {
  const v = node?.textContent as unknown;
  if (v == null) {
    return "";
  }
  if (typeof v === "string") {
    return v.includes("${") ? templateToEditDisplay(v) : v;
  }
  if (typeof v === "object" && (v as Record<string, unknown>).$ref) {
    const ref = String((v as Record<string, unknown>).$ref);
    const label = ref.startsWith("#/state/") ? ref.slice(8) : ref;
    return `{${label}}`;
  }
  return String(v);
}

/**
 * Consume a pendingInlineEdit after patches apply. The full render that used to consume it was
 * skipped, and some flows (splitParagraph) set it right after transactDoc returns — so consume in a
 * microtask, after the calling handler finished.
 *
 * @param {Tab} tab
 */
function schedulePendingInlineEditConsumption(tab: Tab) {
  queueMicrotask(() => {
    if (!isActiveTab(tab) || !tab.session.ui?.pendingInlineEdit) {
      return;
    }
    const { path, mediaName } = tab.session.ui.pendingInlineEdit as InlineEditDef;
    tab.session.ui.pendingInlineEdit = null;
    const targetPanel = canvasPanels.find((p) => p.mediaName === mediaName) || canvasPanels[0];
    if (!targetPanel) {
      return;
    }
    const el = findCanvasElement(path, targetPanel.canvas as HTMLElement);
    if (el) {
      _ctx?.enterComponentInlineEdit(el, path);
    }
  });
}
