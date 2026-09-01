/// <reference lib="dom" />
/**
 * In-iframe surgical patcher — applies value-carrying forward ops to the iframe's shadow doc and
 * the live DOM, so an edit updates in place instead of re-rendering the whole document. This is the
 * cross-frame analog of `canvas-patcher.ts`: the parent classifies + records ops and posts the
 * forward (value-carrying) half; the iframe folds them into its non-reactive shadow doc and mutates
 * the DOM it owns.
 *
 * It applies the full op set the legacy patcher does: in-place `set-key` writes (`style`/
 * `textContent`, and inert event bindings); structural relocation (`remove-child`/`move-child`) as
 * pure DOM moves with `data-jx-path` remapping; and subtree re-renders (`insert-child`/`set-child`,
 * and any other `set-key` that changes rendered output) via {@link renderSubtreeIframe}. Any op it
 * can't apply throws, which the caller reports as `patchError` so the parent escalates to a full
 * render.
 */

import { reapplyStyle } from "@jxsuite/runtime";
import { getNodeAtPath } from "../state";
import { applyDocOpToDoc } from "../tabs/doc-op-apply";
import { parseJxPath, serializeJxPath } from "./path-mapping";
import { disposeSubtree, renderSubtreeIframe } from "./iframe-subtree";
import {
  computeEmptyPlaceholderClass,
  EMPTY_PLACEHOLDER_CLASSES,
  templateToEditDisplay,
} from "../utils/edit-display";
import type { IframeRenderCtx } from "./iframe-render";
import type { WireDocOp } from "./iframe-protocol";
import type { JxPath } from "../state";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";

/**
 * Apply a batch of forward ops. Every op is folded into the shadow doc first (so DOM reads see
 * post-mutation truth, mirroring the parent patcher reading its already-mutated reactive doc), then
 * each op patches the DOM. Throws on the first op it cannot apply surgically.
 */
export function applyIframePatch(
  shadowDoc: JxMutableNode,
  forwardOps: WireDocOp[],
  container: HTMLElement,
  ctx?: IframeRenderCtx,
  echoPaths?: JxPath[],
): void {
  for (const op of forwardOps) {
    applyDocOpToDoc(shadowDoc, op);
  }
  if (!echoPaths?.length) {
    for (const op of forwardOps) {
      applyOpToDom(shadowDoc, op, container, ctx);
    }
    return;
  }
  // An ECHO: these ops describe DOM this frame already has, because its own caret produced it.
  // The shadow doc still needs them (it is the patch source of truth), but re-rendering the
  // Subtree the user is typing in would destroy the caret and the selection inside it.
  const echoed = new Set(echoPaths.map((p) => serializeJxPath(p)));
  for (const op of forwardOps) {
    if (op.op === "set-key" && echoed.has(serializeJxPath(op.path))) {
      // The content is already right; only the model-derived placeholder class can be stale, and
      // Reconciling a class touches neither the caret nor the text under it.
      syncEchoedPlaceholder(shadowDoc, op.path, container);
      continue;
    }
    applyOpToDom(shadowDoc, op, container, ctx);
  }
}

/**
 * Re-derive the empty-placeholder class of an ECHOED node without writing its content.
 *
 * An echo is the author's own typing coming back as a patch, so the DOM already holds the text —
 * but `empty-text-placeholder` was stamped when the block was empty and nothing else would ever
 * take it off, because the write that would have (patchText) is exactly what echo suppression
 * skips. The CSS asks the DOM whether the block is empty, so nothing is misdrawn in the meantime;
 * this keeps the class itself honest, so the DOM does not carry a claim the document contradicts.
 *
 * Best-effort by design: a missing element is not an error worth escalating a full render (and the
 * caret with it) over a class.
 */
function syncEchoedPlaceholder(
  doc: JxMutableNode,
  path: (string | number)[],
  container: HTMLElement,
): void {
  const el = findElement(container, path);
  if (el) {
    syncPlaceholderClass(el, getNodeAtPath(doc, path));
  }
}

/** The render context, asserted present for ops that re-render a subtree (the caller always has it). */
function requireCtx(ctx: IframeRenderCtx | undefined): IframeRenderCtx {
  if (!ctx) {
    throw new Error("iframe-patch-no-render-ctx");
  }
  return ctx;
}

function applyOpToDom(
  doc: JxMutableNode,
  op: WireDocOp,
  container: HTMLElement,
  ctx: IframeRenderCtx | undefined,
): void {
  switch (op.op) {
    case "set-key": {
      if (op.key === "style") {
        patchStyle(doc, op.path, container, ctx);
        return;
      }
      if (op.key === "textContent") {
        patchText(doc, op.path, container);
        return;
      }
      // Event bindings are stripped from the design/edit render — nothing to patch.
      if (op.key.startsWith("on")) {
        return;
      }
      // Any other key (attributes / $props / cases / tagName / a non-event prop) changes rendered
      // Output, so re-render the node's subtree in place — mirrors the legacy patcher's replace.
      replaceSubtree(doc, op.path, container, requireCtx(ctx));
      return;
    }
    case "insert-child": {
      insertChild(doc, op.parentPath, op.index, container, requireCtx(ctx));
      return;
    }
    case "set-child": {
      replaceSubtree(doc, [...op.parentPath, "children", op.index], container, requireCtx(ctx));
      return;
    }
    case "remove-child": {
      removeChild(doc, op.parentPath, op.index, container);
      return;
    }
    case "move-child": {
      moveChild(doc, op.fromParentPath, op.fromIndex, op.toParentPath, op.toIndex, container);
      return;
    }
    default: {
      // The WireDocOp union is exhaustively handled above; this guards a future op kind.
      throw new Error(`iframe-patch-unsupported-op:${JSON.stringify(op)}`);
    }
  }
}

// ─── Structural ops needing a subtree render (Phase 3b-2) ───────────────────────

/** Render the inserted node and splice it into the parent's DOM, shifting later siblings up. */
function insertChild(
  doc: JxMutableNode,
  parentPath: JxPath,
  index: number,
  container: HTMLElement,
  ctx: IframeRenderCtx,
): void {
  const parentEl = requireElement(container, parentPath);
  const parentNode = getNodeAtPath(doc, parentPath);
  const newEl = renderSubtreeIframe(doc, [...parentPath, "children", index], ctx);
  // Remap existing siblings BEFORE attaching the new subtree so it isn't itself remapped.
  remapChildPaths(container, parentPath, index, 1);
  insertAt(parentEl, newEl, domChildReference(parentEl, parentNode, index));
  syncPlaceholderClass(parentEl, parentNode);
}

/** Re-render the node at `docPath` and swap it into the DOM in place (disposing the old subtree). */
function replaceSubtree(
  doc: JxMutableNode,
  docPath: JxPath,
  container: HTMLElement,
  ctx: IframeRenderCtx,
): void {
  const oldEl = requireElement(container, docPath);
  const newEl = renderSubtreeIframe(doc, docPath, ctx);
  disposeSubtree(oldEl);
  oldEl.replaceWith(newEl);
}

// ─── Structural ops (no subtree render: pure DOM move + data-jx-path remap) ──────

/** Remove the element at `parentPath/children/index`, shift later siblings down, dispose its scope. */
function removeChild(
  doc: JxMutableNode,
  parentPath: JxPath,
  index: number,
  container: HTMLElement,
): void {
  const el = requireElement(container, [...parentPath, "children", index]);
  const parentEl = el.parentElement;
  disposeSubtree(el);
  el.remove();
  remapChildPaths(container, parentPath, index + 1, -1);
  if (parentEl) {
    syncPlaceholderClass(parentEl, getNodeAtPath(doc, parentPath));
  }
}

/**
 * Move the element from `fromParentPath/children/fromIndex` to `toParentPath/children/toIndex`.
 * Detach first, shift the from-parent's later siblings down, then re-read the to-parent's (possibly
 * shifted) path, shift its siblings up, rewrite the moved subtree's path prefix, and reinsert. The
 * shadow doc is already folded, so `toIndex` and the to-parent's children reflect post-move truth.
 */
function moveChild(
  doc: JxMutableNode,
  fromParentPath: JxPath,
  fromIndex: number,
  toParentPath: JxPath,
  toIndex: number,
  container: HTMLElement,
): void {
  const fromPath = [...fromParentPath, "children", fromIndex];
  const el = requireElement(container, fromPath);
  const fromParentEl = el.parentElement;
  // Resolve the destination element before any remap renames it out from under us.
  const toParentEl = requireElement(container, toParentPath);

  el.remove();
  remapChildPaths(container, fromParentPath, fromIndex + 1, -1);
  // The detach remap may have shifted the to-parent's own path — read it fresh.
  const toPrefix = elementPath(toParentEl) ?? toParentPath;
  remapChildPaths(container, toPrefix, toIndex, 1);
  rewriteSubtreePathPrefix(el, fromPath, [...toPrefix, "children", toIndex]);

  const toParentNode = getNodeAtPath(doc, toPrefix);
  insertAt(toParentEl, el, domChildReference(toParentEl, toParentNode, toIndex));

  // Emptiness may have changed at either end (e.g. moved the last/only child out, or into an empty
  // Container) — keep both parents' placeholder classes in sync with the folded doc.
  if (fromParentEl) {
    syncPlaceholderClass(
      fromParentEl,
      getNodeAtPath(doc, elementPath(fromParentEl) ?? fromParentPath),
    );
  }
  syncPlaceholderClass(toParentEl, toParentNode);
}

/**
 * Put `el`'s empty-placeholder class back in step with its (folded) doc node — a container's after
 * a child change, a text block's after its content changed.
 */
function syncPlaceholderClass(el: Element, node: JxMutableNode | undefined): void {
  for (const cls of EMPTY_PLACEHOLDER_CLASSES) {
    el.classList.remove(cls);
  }
  const placeholder = node ? computeEmptyPlaceholderClass(node) : null;
  if (placeholder) {
    el.classList.add(placeholder);
  }
}

/** Insert `node` before `ref`, or append when `ref` is null (inserting at the end). */
function insertAt(parentEl: Element, node: Node, ref: ChildNode | null): void {
  if (ref) {
    ref.before(node);
  } else {
    parentEl.append(node);
  }
}

/**
 * The DOM node currently occupying `children[index]` of `parentEl`, or null to append. The runtime
 * renders an optional leading text node (when the parent has its own textContent) followed by one
 * node per child entry, in order — so the index is offset by that text node.
 */
function domChildReference(
  parentEl: Element,
  parentNode: JxMutableNode | undefined,
  index: number,
): ChildNode | null {
  const text = parentNode?.textContent;
  const textOffset = text != null && String(text) !== "" ? 1 : 0;
  return parentEl.childNodes[textOffset + index] ?? null;
}

/**
 * Shift the child-index segment of every `data-jx-path` under `container` whose path is
 * `[...parentPath, "children", i, ...]` with `i >= fromIndex`, by `delta`. Mirrors the legacy
 * patcher's `elToPath` remap, but the iframe stores paths as `data-jx-path` attributes.
 */
function remapChildPaths(
  container: HTMLElement,
  parentPath: JxPath,
  fromIndex: number,
  delta: number,
): void {
  const depth = parentPath.length;
  for (const el of container.querySelectorAll<HTMLElement>("[data-jx-path]")) {
    const p = elementPath(el);
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
    el.dataset.jxPath = serializeJxPath(np);
  }
}

/** Rewrite the `data-jx-path` of `el` and its descendants, replacing `oldPrefix` with `newPrefix`. */
function rewriteSubtreePathPrefix(el: HTMLElement, oldPrefix: JxPath, newPrefix: JxPath): void {
  const targets: HTMLElement[] = [el, ...el.querySelectorAll<HTMLElement>("[data-jx-path]")];
  for (const t of targets) {
    const p = elementPath(t);
    if (!p || p.length < oldPrefix.length || !oldPrefix.every((seg, i) => p[i] === seg)) {
      continue;
    }
    t.dataset.jxPath = serializeJxPath([...newPrefix, ...p.slice(oldPrefix.length)]);
  }
}

/** Read an element's stamped document path, or null when it carries no `data-jx-path`. */
function elementPath(el: HTMLElement): JxPath | null {
  const raw = el.dataset.jxPath;
  return raw === undefined ? null : parseJxPath(raw);
}

/**
 * Re-emit the node's style onto its element, matching the full render's edit-mode style transform.
 * Pass the document's merged `$media` map (the same one resolveCanvasDocument put on the render
 * doc, carried on the render ctx's built scope) through to reapplyStyle so an `@--name` block
 * resolves to its real `@media (min-width:…)` query — otherwise a surgical edit on a media-bearing
 * node would re-emit an invalid `@media name` and silently drop the responsive rule until the next
 * full render.
 */
function patchStyle(
  doc: JxMutableNode,
  path: (string | number)[],
  container: HTMLElement,
  ctx: IframeRenderCtx | undefined,
): void {
  const el = requireElement(container, path);
  const node = getNodeAtPath(doc, path);
  const mediaQueries = (ctx?.defs?.["$media"] as Record<string, string> | undefined) ?? {};
  reapplyStyle(el, editModeStyle(node?.style), mediaQueries);
}

/** Write the node's display text, syncing the empty-placeholder class like the full render. */
function patchText(doc: JxMutableNode, path: (string | number)[], container: HTMLElement): void {
  const el = requireElement(container, path);
  const node = getNodeAtPath(doc, path);
  el.textContent = textDisplayValue(node);
  syncPlaceholderClass(el, node);
}

/** Locate the rendered element for a document path via its stamped `data-jx-path` attribute. */
function requireElement(container: HTMLElement, path: (string | number)[]): HTMLElement {
  const el = findElement(container, path);
  if (!el) {
    throw new Error(`iframe-patch-element-not-found:${serializeJxPath(path)}`);
  }
  return el;
}

/** The rendered element for a document path, or null when this render has none. */
function findElement(container: HTMLElement, path: (string | number)[]): HTMLElement | null {
  const serialized = serializeJxPath(path);
  const esc = serialized.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`);
  const el = container.querySelector(`[data-jx-path='${esc}']`);
  return el instanceof HTMLElement ? el : null;
}

/**
 * Edit-mode style transform — mirrors prepareForEditMode (and the legacy patcher's editModeStyle):
 * top-level template-string values are blanked so no reactive bindings are created for them.
 */
function editModeStyle(style: JxStyle | undefined): JxStyle | undefined {
  if (!style || typeof style !== "object") {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(style)) {
    /* OMITTED, not blanked. It used to be written as `""`, which was a silent no-op while a
       declaration went to `el.style` and is a malformed declaration now that it goes into a rule.
       Dropping the key is what blanking always meant: the property falls back to the cascade. */
    if (typeof v === "string" && v.includes("${")) {
      continue;
    }
    out[k] = v;
  }
  return out as JxStyle;
}

/**
 * Display text for a node's textContent in design/edit mode — mirrors prepareForEditMode's
 * template-string and $ref display rules (and the legacy patcher's textDisplayValue).
 */
function textDisplayValue(node: JxMutableNode | undefined): string {
  const v = (node as { textContent?: unknown } | undefined)?.textContent;
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
