/// <reference lib="dom" />
/**
 * In-iframe render core — turns a fully-resolved document into live DOM via @jxsuite/runtime,
 * stamping `data-jx-path` so the editor can map nodes back to document paths across the frame
 * boundary. The parent does the heavy resolution (layout distribution, site-context, `$head`,
 * components, edit-mode transforms) and posts the result; this core stays dependency-light (runtime
 * + reactivity + the pure path-mapping helpers) so the iframe bundle is small.
 *
 * Because the iframe is served from the real project origin, the runtime's verbatim
 * `el.setAttribute("src", "/images/foo.jpg")` resolves natively — the fix that motivated the whole
 * migration, with no data: URL rewriting.
 */

import {
  buildScope,
  canvasStyleValue,
  defineElement,
  renderNode,
  runScoped,
  setCanvasAssetResolver,
  setCanvasDelinkAnchors,
  setCanvasDelinkPopovers,
  setCanvasViewportTranspose,
  setRootMedia,
  setSkipAutoRequests,
  setSkipServerFunctions,
  setStampPropBindings,
} from "@jxsuite/runtime";
import { resolveAssetRef } from "./asset-resolve";
import { classifyRenderNode, jxPathSelector, serializeJxPath } from "./path-mapping";
/* No cycle: `iframe-position.ts` imports only `path-mapping` and a type. It already owns the
   stamped-attribute lookup, escaping included, so a second query built here would be a second
   answer to "which element is this path". */
import { elementForPath } from "./iframe-position";
import type { AssetContext } from "./asset-resolve";
import { SITE_STYLE_ID, buildSiteStyleCSS } from "@jxsuite/site/site-style";
import type { CanvasMode, WireDiffMarks } from "./iframe-protocol";
import type { JxDocument } from "@jxsuite/schema/types";
import type { PathMapCtx } from "./path-mapping";

/**
 * The retained render context a full render leaves behind so the surgical patcher can re-render an
 * individual subtree (insert/replace/attr edits) with the SAME scope, doc base, path mapping, and
 * mode — making a patched subtree indistinguishable from a full re-render.
 */
export interface IframeRenderCtx {
  /** The `$defs` scope built for the document (resolves `$ref`/state/`$media` bindings). */
  defs: Awaited<ReturnType<typeof buildScope>>;
  docBase: string;
  mapperCtx: PathMapCtx;
  mode: CanvasMode;
}

export interface RenderHandle {
  /** Stop the render's reactive effect scope (call before re-rendering to avoid effect leaks). */
  dispose: () => void;
  /** Context for surgical subtree re-renders against this generation's scope/mapping. */
  ctx: IframeRenderCtx;
}

interface HeadEntry {
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
}

/**
 * Register the document's `$elements` (components) in this iframe realm so the runtime can render
 * them.
 */
export async function registerElements(doc: JxDocument, docBase: string): Promise<void> {
  const elements = (doc as { $elements?: unknown[] }).$elements;
  if (!Array.isArray(elements)) {
    return;
  }
  // Register in parallel, each guarded by a timeout so one slow/hanging component can't block the
  // Whole render (the document still renders; the unresolved tag just stays inert).
  await Promise.all(
    elements.map(async (entry) => {
      const task = (async () => {
        if (typeof entry === "string") {
          const specifier =
            entry.startsWith("/") || entry.startsWith(".") ? entry : `/node_modules/${entry}`;
          await import(specifier);
        } else if (entry && typeof entry === "object" && "$ref" in entry) {
          await defineElement(new URL(String((entry as { $ref: string }).$ref), docBase).href);
        } else if (entry && typeof entry === "object") {
          await defineElement(entry as JxDocument, docBase);
        }
      })();
      try {
        await Promise.race([
          task,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("register timeout")), 5000);
          }),
        ]);
      } catch (error) {
        console.warn("iframe canvas: failed to register element", JSON.stringify(entry), error);
      }
    }),
  );
}

/** Id of the injected design/edit-mode canvas stylesheet (placeholder affordances). */
export const EDIT_PLACEHOLDER_STYLE_ID = "jx-canvas-edit-css";

/**
 * The design/edit-mode canvas CSS, ported from the parent editor stylesheet (index.html) with
 * iframe-safe fallbacks — the parent theme variables (--fg-dim/--radius/--accent) don't exist in
 * the iframe document. The placeholder CLASSES are stamped by prepareForEditMode (parent-side
 * resolution + surgical subtree renders), so preview mode never matches these rules — but the sheet
 * is still removed there (belt and braces). The `[data-jx-active-block]` hint marks the caret's
 * empty paragraph (e.g. right after an Enter split) and advertises the slash menu.
 *
 * `.empty-text-placeholder` is gated on emptiness IN THE DOM because a CLASS cannot tell the truth
 * about a block the author is typing in. The class is stamped from the document, and the first
 * thing typed into an empty block reaches the DOM natively — the model learns of it a commit tick
 * later, and that patch comes back as an ECHO, which `applyIframePatch` deliberately does not
 * re-render (it would destroy the caret). So the class outlived its own meaning, and "Click here to
 * add text..." sat beside the text you had just typed until the next full render. The class now
 * selects WHICH affordance; the DOM answers whether the block is empty.
 *
 * "Empty" is `:empty` OR a lone `<br>`, because emptying a block by editing does not leave it
 * `:empty`: the engine drops in a filler `<br>` to keep the line visible (Chrome 151, verified —
 * `execCommand("delete")` over a `<p>`'s whole content leaves `<p><br></p>`). Without that arm the
 * affordance would go dark exactly when the block became empty again.
 *
 * `:not([data-jx-active-block])` keeps the slash hint winning on an empty block that HAS the caret:
 * both rules match the same element, and the emptiness test broke the specificity tie that used to
 * decide it by source order.
 */
/*
 * NOTE: this is a template literal, so a BACKTICK anywhere inside — including in a CSS comment —
 * ends the string and produces a syntax error several lines later. Quote property names bare.
 */
export const EDIT_PLACEHOLDER_CSS = `
.empty-media-placeholder {
  display: inline-block;
  min-width: 120px;
  min-height: 80px;
  border: 1px dashed color-mix(in srgb, #808080 30%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, #808080 5%, transparent)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' fill='none'%3E%3Crect x='4' y='8' width='32' height='24' rx='2' stroke='%23808080' stroke-opacity='.4' stroke-width='1.5'/%3E%3Ccircle cx='13' cy='16' r='3' stroke='%23808080' stroke-opacity='.4' stroke-width='1.5'/%3E%3Cpath d='M8 28l8-8 5 5 4-4 7 7' stroke='%23808080' stroke-opacity='.4' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
    center / 40px no-repeat;
  color: transparent;
  font-size: 0;
  overflow: hidden;
}
.empty-text-placeholder:is(:empty, :has(> br:only-child)):not([data-jx-active-block]):not([contenteditable])::after {
  content: "Click here to add text...";
  color: color-mix(in srgb, #808080 40%, transparent);
  font-style: italic;
  font-size: 13px;
  pointer-events: none;
}
.empty-container-placeholder {
  border: 1px dashed color-mix(in srgb, #808080 25%, transparent);
  border-radius: 4px;
  min-height: 32px;
  position: relative;
}
.empty-container-placeholder::after {
  content: "Drag elements here...";
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: color-mix(in srgb, #808080 40%, transparent);
  font-style: italic;
  font-size: 11px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  pointer-events: none;
  white-space: nowrap;
}
[data-jx-active-block]:is(:empty, :has(> br:only-child))::after {
  content: "Type / for commands";
  color: color-mix(in srgb, #808080 40%, transparent);
  font-style: italic;
  font-size: 13px;
  pointer-events: none;
}
[data-jx-bound-prop]:hover {
  cursor: text;
  outline: 1px dashed color-mix(in srgb, #808080 40%, transparent);
  outline-offset: 1px;
}
[data-jx-bound-prop]:empty:not([contenteditable="plaintext-only"]):not([contenteditable="true"])::after {
  content: "Empty \\2014  click to edit";
  color: color-mix(in srgb, #808080 40%, transparent);
  font-style: italic;
  font-size: 13px;
  pointer-events: none;
}
[data-jx-layout-region] {
  position: relative;
  opacity: 0.5;
  transition: opacity 120ms ease;
}
[data-jx-layout-region]:hover {
  opacity: 0.85;
  outline: 1px dashed color-mix(in srgb, #808080 55%, transparent);
  outline-offset: -1px;
}
[data-jx-layout-region] [data-jx-layout-region] {
  opacity: 1;
}
[data-jx-layout-region]::before {
  content: "LAYOUT \\00B7 " attr(data-jx-layout-file);
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  padding: 1px 5px;
  border-radius: 0 0 3px 0;
  background: color-mix(in srgb, #808080 78%, transparent);
  color: #fff;
  font: 700 9px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.08em;
  pointer-events: none;
}
[data-jx-layout-region] [data-jx-layout-region]::before {
  content: none;
}
/* The UA rule a de-popovered element lost, re-supplied at UA-EQUIVALENT PRECEDENCE.

   The cascade layer is the mechanism and it is the whole point. An unlayered author declaration
   beats a layered one whatever its specificity — and in the canvas a base declaration is written
   as an INLINE style by applyStyle, which beats it harder still. That is exactly how author origin
   beats UA origin on the shipped page, so the canvas reproduces the real cascade rather than an
   approximation of it.

   Deliberately NOT forced with a priority flag. A popover whose base rule sets display is laid out
   on every page whether open or not; that is a real defect, @jxsuite/schema/overlays reports it as
   base-display, and the canvas's job is to SHOW it, not to hide it behind a stronger rule. */
@layer jx-canvas-ua {
  [data-jx-popover]:not([data-jx-popover-open]) {
    display: none;
  }
}
/* SHOWN IN PLACE, and the position declaration is what makes that true.

   Dropping the popover attribute drops the UA rule that made the panel fixed, so a panel that never
   set position itself — every one in the fleet — lands in normal flow at its document position,
   contributes to #jx-canvas-root's scrollHeight, and the host grows the artboard to fit it. That is
   the whole geometry fix, and it is why an open panel is reachable at all.

   The two alignment declarations are the other half, and they were found by measuring rather than
   by reasoning. Every drawer in the fleet is declared inside its header's flex row, so in flow it
   becomes a FLEX ITEM: align-items:center on the row centres a 904px panel on a 64px header and
   half of it sits above the artboard at a negative offset, where it contributes nothing to the
   scrollable overflow the host measures. Pinned to the start and refused any flex sizing, the same
   panel hangs down from its own position and the artboard grows by its full height.

   Forced, because a panel that DOES set position: fixed would otherwise keep it and be laid out
   against the frame's own viewport — which in an editable mode is the document's full height, so a
   drawer pinned with inset: 0 lands halfway down a long page and a short component frame clips it.
   This is a presentation override for an editing affordance, the same kind as the layout-region
   dimming above, and it is NOT the same move as forcing display: that would hide a real defect in
   the document (base-display), while this hides nothing — Preview renders the panel natively, top
   layer and all. */
[data-jx-popover][data-jx-popover-open] {
  position: relative !important;
  inset: auto !important;
  align-self: start !important;
  flex: none !important;
  outline: 1px dashed color-mix(in srgb, #808080 55%, transparent);
  outline-offset: 2px;
}
[data-jx-popover][data-jx-popover-open]::before {
  content: "POPOVER \\00B7 SHOWN IN PLACE";
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  padding: 1px 5px;
  border-radius: 0 0 3px 0;
  background: color-mix(in srgb, #808080 78%, transparent);
  color: #fff;
  font: 700 9px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.08em;
  pointer-events: none;
}
`;

/**
 * Keep the design/edit canvas stylesheet in sync with the render mode: present (idempotently) for
 * design/edit, removed otherwise (preview must look live; stylebook specimens must not show "Click
 * here to add text..." placeholders).
 */
export function syncEditModeCss(doc: Document, mode: CanvasMode): void {
  const existing = doc.head.querySelector(`#${EDIT_PLACEHOLDER_STYLE_ID}`);
  if (mode !== "design" && mode !== "edit") {
    existing?.remove();
    return;
  }
  if (existing) {
    return;
  }
  const style = doc.createElement("style");
  style.id = EDIT_PLACEHOLDER_STYLE_ID;
  style.textContent = EDIT_PLACEHOLDER_CSS;
  doc.head.append(style);
}

/** Id of the injected git-diff change-mark stylesheet. */
export const DIFF_MARK_STYLE_ID = "jx-canvas-diff-css";

/**
 * Change marks for the diff artboards.
 *
 * **Colour is never the only encoding.** Each kind carries a distinct `border-left-style` and a
 * distinct gutter glyph, so the three states stay apart for a reader with a red/green deficiency in
 * the ordinary render, not only under forced colours. That is also what makes the forced-colours
 * block below cheap: it drops the wash and keeps style and glyph, which were already carrying the
 * meaning.
 *
 * **The forced-colours block has to live HERE, in the frame.** `styles/forced-colors.css` is chrome
 * and never reaches this document. The artboard's own opt-out (`forced-color-adjust: none` on
 * `iframe.canvas-iframe`) is about not repainting the AUTHOR'S palette, which is why these rules
 * add editor chrome through an attribute selector rather than restyling content.
 *
 * Hexes rather than custom properties for the reason `EDIT_PLACEHOLDER_CSS` gives: this is a
 * separate document where the parent's tokens do not exist. The pair is chosen against the white
 * artboard (`.canvas-panel-viewport` pins `background: white; color-scheme: light` whatever the
 * chrome theme is), so the dark chrome tints `--success`/`--danger` carry would be illegible here.
 */
export const DIFF_MARK_CSS = `
[data-jx-diff] {
  position: relative;
  border-left-width: 3px;
  border-left-color: currentColor;
}
[data-jx-diff]::before {
  position: absolute;
  top: 0;
  left: -3px;
  width: 3px;
  content: "";
}
[data-jx-diff="added"] {
  border-left-style: solid;
  border-left-color: #0a7c42;
  background: color-mix(in srgb, #0a7c42 12%, transparent);
}
[data-jx-diff="removed"] {
  border-left-style: double;
  border-left-color: #c9252d;
  background: color-mix(in srgb, #c9252d 12%, transparent);
}
[data-jx-diff="modified-before"] {
  border-left-style: dashed;
  border-left-color: #c9252d;
  background: color-mix(in srgb, #c9252d 8%, transparent);
}
[data-jx-diff="modified-after"] {
  border-left-style: dashed;
  border-left-color: #0a7c42;
  background: color-mix(in srgb, #0a7c42 8%, transparent);
}
[data-jx-diff-within] {
  border-left: 3px dotted color-mix(in srgb, #808080 60%, transparent);
}
@media (forced-colors: active) {
  [data-jx-diff],
  [data-jx-diff-within] {
    background: none;
    border-left-color: CanvasText;
  }
}
`;

/**
 * Keep the change-mark stylesheet in sync with whether this render carries marks.
 *
 * Gated on the MARKS, not on the mode. The decoration should depend on the payload the decoration
 * needs: a git-diff artboard whose comparison is still loading has no marks to show, and a mode
 * check would leave a stale sheet behind it.
 */
export function syncDiffCss(doc: Document, on: boolean): void {
  const existing = doc.head.querySelector(`#${DIFF_MARK_STYLE_ID}`);
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) {
    return;
  }
  const style = doc.createElement("style");
  style.id = DIFF_MARK_STYLE_ID;
  style.textContent = DIFF_MARK_CSS;
  doc.head.append(style);
}

/**
 * Stamp this artboard's change marks onto the rendered tree.
 *
 * Replaces the whole set: every previous `data-jx-diff` comes off first, so a render carrying no
 * marks clears the last one's rather than layering on it.
 *
 * **An unresolvable mark climbs to the nearest stamped ancestor** and lands there as
 * `data-jx-diff-within` — "something inside here changed that cannot be drawn here". Not every
 * document path reaches an element: a component's internals are created by its own
 * `connectedCallback` and never pass through {@link makeStamper}, and only the first expanded row
 * of a repeater carries the template's collapsed path. Dropping those marks silently would make the
 * artboard disagree with a count the header states out loud; climbing keeps the change locatable
 * and honest about its resolution.
 */
export function applyDiffMarks(container: HTMLElement, marks: WireDiffMarks | null): void {
  for (const stale of container.querySelectorAll("[data-jx-diff], [data-jx-diff-within]")) {
    if (stale instanceof HTMLElement) {
      delete stale.dataset.jxDiff;
      delete stale.dataset.jxDiffWithin;
    }
  }
  if (!marks?.length) {
    return;
  }
  for (const mark of marks) {
    const exact = elementForPath(container, mark.path);
    if (exact) {
      exact.dataset.jxDiff = mark.kind;
      continue;
    }
    /* Climb by whole `["children", i]` hops: a path's segments come in that pairing, so dropping
       one at a time would ask for `[..., "children"]`, which is never an address. */
    let { path } = mark;
    while (path.length >= 2) {
      path = path.slice(0, -2);
      const ancestor = elementForPath(container, path);
      if (ancestor) {
        ancestor.dataset.jxDiffWithin = "";
        break;
      }
    }
  }
}

/**
 * Flag the canvas document as a preview shell, so `canvas.html`'s preview rules apply.
 *
 * The document's default box is built for EDITING: `html, body { overflow: hidden }`, because the
 * host grows the iframe to its content height there and the parent canvas is what pans. Preview
 * inverts that — the frame stays at the pane's height and the document scrolls itself — and until
 * this existed nothing turned the clipping off, so preview showed the first screenful of every page
 * and no more. An attribute rather than an injected stylesheet: the rules it switches live beside
 * the ones they override, which is where a reader looks for them.
 *
 * Called on every render because one iframe is reused across modes.
 */
export function syncPreviewShell(doc: Document, mode: CanvasMode): void {
  doc.documentElement.toggleAttribute("data-jx-preview", mode === "preview");
}

/**
 * Whether a canvas mode gets a live caret. Design and edit are the interactive modes; preview must
 * look and behave like the shipped page, and stylebook specimens are not documents.
 */
export function isEditableMode(mode: CanvasMode | string): boolean {
  return mode === "design" || mode === "edit";
}

/**
 * Make the render container the document's single editing host (or take that back for preview /
 * stylebook renders).
 *
 * Putting `contenteditable` on the CONTAINER rather than on one block at a time is what buys the
 * fluid caret: click-to-caret, line-aware Up/Down across blocks, Home/End, IME, and cross-block
 * drag-select all become the browser's job. What the browser must NOT do is restructure the
 * document, and that is taken back at the `beforeinput` chokepoint — see
 * {@link file://./editable-actions.ts}.
 *
 * `spellcheck` is left on (it is a writing surface), but the native
 * `autocorrect`/`writingsuggestions` affordances are declined: they mutate text without a
 * `beforeinput` we can attribute to a user intent, which would desync the shadow doc.
 */
export function syncEditableRoot(container: HTMLElement, mode: CanvasMode): void {
  if (!isEditableMode(mode)) {
    container.removeAttribute("contenteditable");
    container.removeAttribute("spellcheck");
    container.removeAttribute("role");
    container.removeAttribute("aria-multiline");
    container.removeAttribute("aria-label");
    return;
  }
  container.contentEditable = "true";
  container.spellcheck = true;
  container.setAttribute("autocorrect", "off");
  container.setAttribute("writingsuggestions", "false");
  // The caret must never look like a drag handle: reordering is the block action bar's handle only.
  container.setAttribute("draggable", "false");
  /*
   * A bare `contenteditable` div announces as an unlabelled group in most screen readers, so the one
   * surface an author types into was the least described thing in the editor. `textbox` +
   * `aria-multiline` is the role the editable region actually plays, and the label names it — the
   * canvas is inside a cross-origin iframe, so a reader traversing in has no surrounding context to
   * infer it from.
   *
   * Scoped deliberately: this describes the editing REGION. Per-block landmarks and a
   * keyboard-reachable block action bar are still missing (see specs/studio.md §4.5).
   */
  container.setAttribute("role", "textbox");
  container.setAttribute("aria-multiline", "true");
  container.setAttribute("aria-label", "Document content");
}

/** Id of the injected stylebook-mode chrome stylesheet (section/card scaffolding). */
export const STYLEBOOK_STYLE_ID = "jx-canvas-stylebook-css";

/**
 * Card/section chrome for the stylebook specimen document, ported from the parent editor stylesheet
 * with self-contained fallback values (the parent theme vars don't exist in the iframe).
 * Deliberately OMITS the parent's `.element-card-preview { pointer-events: none }` — the iframe
 * owns hit-testing and needs real hits on the specimens.
 */
export const STYLEBOOK_CSS = `
.sb-root {
  padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.sb-section {
  margin-bottom: 24px;
}
.sb-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: color-mix(in srgb, #808080 70%, transparent);
  padding: 8px 0 4px;
  border-bottom: 1px solid color-mix(in srgb, #808080 25%, transparent);
  margin-bottom: 8px;
}
.sb-body {
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.element-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  border: 1px solid color-mix(in srgb, #808080 30%, transparent);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 6px;
}
.element-card-preview {
  background: #fff;
  padding: 6px 8px;
  min-height: 32px;
  display: flex;
  align-items: center;
  overflow: hidden;
}
.element-card-preview > * {
  max-width: 100%;
  margin: 0;
  padding: 0;
}
.element-card-preview > hr {
  width: 100%;
  border: none;
  border-top: 1px solid color-mix(in srgb, #808080 40%, transparent);
}
.element-card-preview > input,
.element-card-preview > textarea,
.element-card-preview > select,
.element-card-preview > button,
.element-card-preview > progress,
.element-card-preview > meter {
  font-size: 10px;
}
.element-card-label {
  padding: 2px 6px;
  font-size: 10px;
  color: color-mix(in srgb, #808080 70%, transparent);
  background: color-mix(in srgb, #808080 8%, transparent);
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.sb-fallback {
  padding: 12px;
  border: 1px dashed color-mix(in srgb, #808080 40%, transparent);
  border-radius: 4px;
  color: color-mix(in srgb, #808080 70%, transparent);
}
.sb-empty {
  padding: 48px;
  text-align: center;
  color: color-mix(in srgb, #808080 70%, transparent);
  font-size: 13px;
}
`;

/**
 * Keep the stylebook chrome stylesheet in sync with the render mode: present (idempotently) for
 * stylebook, removed otherwise.
 */
export function syncStylebookCss(doc: Document, mode: CanvasMode): void {
  const existing = doc.head.querySelector(`#${STYLEBOOK_STYLE_ID}`);
  if (mode !== "stylebook") {
    existing?.remove();
    return;
  }
  if (existing) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLEBOOK_STYLE_ID;
  style.textContent = STYLEBOOK_CSS;
  doc.head.append(style);
}

/**
 * Apply the project's site style as a real stylesheet (replace-in-place): custom properties on
 * `:root`, plain properties on `body`, conditional blocks dual-emitted per the forced-scheme
 * contract. A stylesheet — not inline root properties — so `:root[data-color-scheme]` override
 * selectors can win (spec §9.5), and so removed tokens can't linger on reused iframes.
 */
export function applySiteStyle(
  siteStyle: Record<string, unknown> | null | undefined,
  mediaQueries: Record<string, string> = {},
): void {
  const existing = document.head.querySelector(`#${SITE_STYLE_ID}`);
  if (!siteStyle || typeof siteStyle !== "object") {
    existing?.remove();
    return;
  }
  /* `canvasStyleValue`, not `transposeCanvasUnits`: the site style block is CSS the canvas emits
     itself, so a `url()` in it needs the same asset resolution every other declaration gets. */
  const css = buildSiteStyleCSS(siteStyle, mediaQueries, canvasStyleValue);
  if (existing) {
    existing.textContent = css;
    return;
  }
  const tag = document.createElement("style");
  tag.id = SITE_STYLE_ID;
  tag.textContent = css;
  document.head.append(tag);
}

/**
 * Force or clear the color-scheme preview on the iframe's root element (the platform's
 * data-color-scheme contract, spec §9.5). Survives re-renders and patches — renders only replace
 * the container's children, never the root element.
 */
export function applyPreviewColorScheme(doc: Document, scheme: "light" | "dark" | null): void {
  if (scheme) {
    doc.documentElement.dataset.colorScheme = scheme;
  } else {
    delete doc.documentElement.dataset.colorScheme;
  }
}

/**
 * Draw the popover at `path` open, and every other one closed.
 *
 * The canvas-only twin of `showPopover()` — one attribute, no top layer, no light dismiss, and
 * idempotent, so the parent may post the same value as often as it likes. Re-applied after every
 * render AND after every patch: an `attributes` op routes through `replaceSubtree`, which rebuilds
 * the element and takes the attribute with it.
 *
 * A path naming a node that is not a de-popovered panel opens nothing rather than throwing — the
 * frame's copy of a value the host may have computed against a document it has since changed.
 *
 * @param root The render container (`#jx-canvas-root`).
 * @param path Serialized document path of the popover to open, or null to close them all.
 * @docs studio/interface/canvas
 */
export function applyCanvasPopoverOpen(root: ParentNode, path: string | null): void {
  for (const el of root.querySelectorAll("[data-jx-popover-open]")) {
    delete (el as HTMLElement).dataset.jxPopoverOpen;
  }
  if (path === null) {
    return;
  }
  const target = root.querySelector(`[data-jx-popover]${jxPathSelector(path)}`);
  if (target) {
    (target as HTMLElement).dataset.jxPopoverOpen = "";
  }
}

/** Inject the document's `$head` (link/meta/script) into the iframe's <head>, de-duped by href/src. */
export function injectHead(doc: JxDocument, assets: AssetContext | null = null): void {
  const head = (doc as { $head?: HeadEntry[] }).$head;
  if (!Array.isArray(head)) {
    return;
  }
  for (const entry of head) {
    if (!entry?.tagName) {
      continue;
    }
    const tag = String(entry.tagName).toLowerCase();
    // Skip inline scripts in design/edit; they're for the live page, not the editor canvas.
    if (tag === "script" && !entry.attributes?.src) {
      continue;
    }
    const attrs = { ...entry.attributes } as Record<string, unknown>;
    for (const key of ["href", "src"]) {
      const val = attrs[key];
      if (typeof val !== "string" || val === "") {
        continue;
      }
      if (!val.startsWith("/") && !val.startsWith(".") && !val.startsWith("http")) {
        /* The bare-specifier lane owns `/node_modules/<pkg>` — the HOST's URL space, not the
           project's. A project resolver has nothing to resolve it to, so it never sees it. */
        attrs[key] = `/node_modules/${val}`;
        continue;
      }
      attrs[key] = resolveAssetRef(val, assets) ?? val;
    }
    const sel = `${tag}${attrs.href ? `[href="${String(attrs.href)}"]` : ""}${attrs.src ? `[src="${String(attrs.src)}"]` : ""}`;
    if (sel !== tag && document.head.querySelector(sel)) {
      continue;
    }
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
    if (entry.textContent) {
      el.textContent = entry.textContent;
    }
    document.head.append(el);
  }
}

/**
 * Build the `onNodeCreated` hook that stamps `data-jx-path` (page content) or `data-jx-layout-path`
 * + `data-jx-layout-file` (layout-originated nodes) on rendered nodes.
 */
export function makeStamper(ctx: PathMapCtx) {
  /*
   * Paths of the component instances frozen below. Nodes arrive parent-first and `onNodeCreated`
   * fires straight after `createElement`, BEFORE the node is attached — so there is no ancestor to
   * walk at stamp time, and the path is the only way to know a node landed inside an island.
   */
  const islands: (string | number)[][] = [];
  const insideIsland = (path: (string | number)[]): boolean =>
    islands.some(
      (island) => path.length > island.length && island.every((seg, i) => path[i] === seg),
    );

  return (created: Node, path: (string | number)[], def: unknown) => {
    if (!(created instanceof HTMLElement)) {
      return;
    }
    // The OPENED document's root can itself be a component definition (`tagName: "eer-cta"`). If
    // That tag is already registered in this realm (a previously-rendered page instantiated it —
    // Hosts persist across tab switches), the upgrade's connectedCallback would wipe the stamped
    // Editable tree and re-render a live instance with default state. Mark the root so the
    // Runtime's element class leaves it alone (see defineElement's connectedCallback guard).
    const isDefinitionRoot =
      path.length === 0 && (def as { tagName?: string } | null)?.tagName?.includes("-");
    if (isDefinitionRoot) {
      created.dataset.jxDefinitionRoot = "";
    }
    // A component INSTANCE is an atomic island inside the editing host: its internals are rendered
    // By the component's own connectedCallback from another document, so a caret must never wander
    // Into them and native editing must never restructure them. `contenteditable="false"` makes the
    // Browser treat the whole instance as one uneditable unit — arrow past it, select it whole,
    // Delete it whole — which is exactly the desired behaviour. The prop-bound text INSIDE it stays
    // Editable via a nested editing host (see iframe-editable-root's prop-bound activation).
    //
    // The opened document's own root is excluded: when a component definition is the file being
    // Edited, its subtree IS the document and must stay editable.
    const isIsland =
      !isDefinitionRoot && created.tagName.includes("-") && isEditableMode(ctx.canvasMode);
    if (isIsland) {
      created.contentEditable = "false";
      islands.push(path);
    }
    const classified = classifyRenderNode(path, def, ctx);
    if (classified.kind === "layout") {
      // A layout node has no page-document path, but it is NOT anonymous: stamp where it came from
      // So a click on it can select it and offer to open the layout at that node. Without this the
      // Two most clickable strings on a brand-new project ("My Site", "Built with Jx") answered a
      // Click with nothing at all.
      created.dataset.jxLayoutPath = serializeJxPath(classified.layoutPath);
      if (classified.layoutFile) {
        created.dataset.jxLayoutFile = classified.layoutFile;
      }
      if (classified.chrome) {
        // Chrome — a region of the layout that does NOT wrap the page content. Marked so the canvas
        // Can dim and label it, and frozen so no caret can land there. The container is permanently
        // `contenteditable`, so without this the browser happily put a caret in the site header and
        // Then dropped every keystroke on the floor at the `beforeinput` chokepoint: the one place a
        // New author is most likely to click looked editable and silently was not.
        created.dataset.jxLayoutRegion = "";
        if (isEditableMode(ctx.canvasMode)) {
          created.contentEditable = "false";
        }
      }
      return;
    }
    created.dataset.jxPath = serializeJxPath(classified.path);
    /*
     * SLOTTED PAGE CONTENT IS NOT COMPONENT INTERNALS.
     *
     * The island above exists to keep the caret out of what a component renders for itself. But a
     * component's CHILDREN are the author's own document — in jx-markdown,
     *
     *     :::eer-intro
     *     If you need reliable rental equipment fast, request a quote today!
     *     :::
     *
     * is a paragraph the author typed, stamped here with its own `data-jx-path`. Inheriting the
     * island's `contenteditable="false"` made every such paragraph uneditable: on a page written
     * this way — which is most component-using pages — the caret could not be placed anywhere at
     * all, and the only route to the text was the properties sidebar.
     *
     * Re-opening on the STAMPED node alone is what keeps the distinction. Component internals are
     * created by the component's own `connectedCallback` in another document and never pass through
     * this stamper, so they stay frozen; prop-bound internals keep their nested-host activation
     * (see iframe-editable-root's `onPointerDownCapture`).
     */
    if (!isIsland && isEditableMode(ctx.canvasMode) && insideIsland(path)) {
      created.contentEditable = "true";
    }
  };
}

/**
 * Recover canvas images that fail their first load. Registered components create their <img> in
 * connectedCallback AFTER async registration, so on a cold first render those requests can fire
 * before the loopback server is warm and 404 — which the browser then caches as a
 * permanently-broken <img>. This re-fires a failed request a few times with backoff (exactly what
 * the manual canvas re-render does), recovering the image without a full re-render. Bounded
 * per-image so a genuinely missing file settles broken. Intentional data: placeholders never error,
 * so they're untouched. Returns a teardown that removes the listener. <img> error events don't
 * bubble, so listen in CAPTURE.
 */
export function installCanvasImageRetry(root: HTMLElement, maxAttempts = 3): () => void {
  const attempts = new WeakMap<HTMLImageElement, number>();
  const onError = (event: Event): void => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) {
      return;
    }
    // A data: URL never errors (and an empty src isn't a real request) — nothing to retry.
    if (!img.src || img.src.startsWith("data:")) {
      return;
    }
    const attempt = (attempts.get(img) ?? 0) + 1;
    if (attempt > maxAttempts) {
      // Bounded: a genuinely missing file settles broken instead of retrying forever.
      return;
    }
    attempts.set(img, attempt);
    setTimeout(() => {
      // Re-fire the request by clearing then re-assigning the same src (mirrors the manual re-render).
      const s = img.src;
      img.src = "";
      img.src = s;
    }, 150 * attempt);
  };
  root.addEventListener("error", onError, true);
  return () => root.removeEventListener("error", onError, true);
}

/**
 * Render a resolved document into `container`, replacing its current children. `mode` controls
 * whether server functions run (live in `preview`; skipped in `design`/`edit`). Returns a handle
 * whose `dispose()` stops the reactive scope.
 */
export async function renderResolvedDocument(opts: {
  container: HTMLElement;
  doc: JxDocument;
  docBase: string;
  mode: CanvasMode;
  mapperCtx: PathMapCtx;
  siteStyle?: Record<string, unknown> | null;
  /**
   * How this host addresses project media, or null when the canvas origin serves the site's own URL
   * space (desktop, `jx dev`) and references need no resolution at all.
   */
  assets?: AssetContext | null;
  /** This render may fetch automatic `Request` entries even outside preview (Data-panel Refresh). */
  allowAutoRequests?: boolean;
  /** Change marks for a git-diff artboard, in this side's own document coordinates. */
  diffMarks?: WireDiffMarks | null;
  /** Serialized path of the popover to draw open, or null/absent for none. */
  popoverOpen?: string | null;
}): Promise<RenderHandle> {
  /* FIRST, before anything emits CSS or an attribute. The resolver is module-global in the runtime,
     so it is set on every render — including to null — or a previous document's context would
     resolve this one's references. It cannot cross the realm as a function, which is why the parent
     posts the plain-data context and the resolver is closed over it here. */
  const assets = opts.assets ?? null;
  setCanvasAssetResolver(assets ? (value) => resolveAssetRef(value, assets) : null);
  setSkipServerFunctions(opts.mode !== "preview");
  // Same gate for automatic `$prototype: "Request"` state entries. `buildScope` re-resolves every
  // State entry on each full render, so without this an escalating authoring action (a signals-panel
  // Edit, or Enter inside component-wrapped content) issued an HTTP request per render. Edit/design
  // Render the pre-fetch (null) state; preview fetches, and so does a render the Data activity's
  // Refresh armed (`allowAutoRequests`) — re-firing fetches on demand is that button's purpose.
  setSkipAutoRequests(opts.mode !== "preview" && !opts.allowAutoRequests);
  // Transpose viewport units (vh/vw/…) → container units (cqh/cqw/…) so they resolve against the
  // Canvas's fixed-size query container (canvas.html) instead of the iframe element. That decouples
  // Them from the iframe height, letting the host size the iframe to its content without `100vh`
  // Sections feeding back into an ever-growing height. Set every render (the iframe always wants it).
  setCanvasViewportTranspose(true);
  // De-link `<a href>` in design/edit so clicks select the anchor instead of navigating the iframe;
  // Preview keeps real links live (mirrors the server-function gate above).
  setCanvasDelinkAnchors(opts.mode !== "preview");
  /* De-popover in the same modes and for the same reason: an OPEN popover is in the top layer,
     whose containing block is the viewport — a fiction here, since the frame is sized to its own
     content — and which contributes to no ancestor's scrollable overflow, so the artboard could
     never grow to fit one. Preview keeps the real top layer, backdrop and all. */
  setCanvasDelinkPopovers(opts.mode !== "preview");
  // Stamp `data-jx-bound-prop` on component-internal invertible text bindings in design/edit only —
  // The inline prop-edit affordance. Set every render so a preview/stylebook render in the same
  // Iframe clears it (page-level templates are inert in design/edit via prepareForEditMode, so only
  // Component internals get stamped).
  setStampPropBindings(opts.mode === "design" || opts.mode === "edit");
  applySiteStyle(opts.siteStyle, (opts.doc as { $media?: Record<string, string> }).$media ?? {});
  injectHead(opts.doc, assets);
  syncEditModeCss(opts.container.ownerDocument, opts.mode);
  syncPreviewShell(opts.container.ownerDocument, opts.mode);
  syncStylebookCss(opts.container.ownerDocument, opts.mode);
  syncDiffCss(opts.container.ownerDocument, Boolean(opts.diffMarks?.length));
  // Seed the runtime's root $media before buildScope so a COMPONENT with its own `@--name` blocks
  // But no own `$media` resolves the breakpoint to its real query (the iframe path calls buildScope
  // Directly and never the runtime's `Jx()` entry, which is the only other place _rootMedia is set).
  // Set it every render (even to `{}`) so a stale map from a previous document cannot leak.
  setRootMedia((opts.doc as { $media?: Record<string, string> }).$media ?? {});
  // Register components BEFORE renderNode. The runtime only applies a custom element's `$props` when
  // That element is ALREADY defined (renderNode gates renderCustomElementWithProps on a truthy
  // `customElements.get(tagName)`); if we register after render, every component paints with its
  // Props dropped — it upgrades in place to the empty default state (<img src="">) — which was the
  // Empty-render regression. `registerElements` wraps each element in a per-element 5s Promise.race
  // Timeout and swallows failures internally, so awaiting it can't block the render indefinitely on
  // A slow/hanging component (the document still renders; an unresolved tag just stays inert).
  await registerElements(opts.doc, opts.docBase);
  const $defs = await buildScope(opts.doc, {}, opts.docBase);
  const onNodeCreated = makeStamper(opts.mapperCtx);
  // The scope MUST be the runtime's (runScoped): renderNode creates its binding effects with the
  // Runtime's copy of @vue/reactivity, and scope collection is per module instance — a studio
  // EffectScope here collects nothing and dispose() would leak every effect of this render.
  const { result: el, stop } = runScoped(
    () => renderNode(opts.doc, $defs, { _path: [], onNodeCreated }) as HTMLElement,
  );
  opts.container.replaceChildren(el);
  applyCanvasPopoverOpen(opts.container, opts.popoverOpen ?? null);
  // Claim (or release) the editing host AFTER the tree lands, so the browser computes editability
  // Against the final DOM rather than an empty container.
  syncEditableRoot(opts.container, opts.mode);
  // Marks last, and for the same reason: they are resolved by querying stamped attributes, which
  // Only exist once the tree the stamper walked is actually in the container.
  applyDiffMarks(opts.container, opts.diffMarks ?? null);
  return {
    ctx: { defs: $defs, docBase: opts.docBase, mapperCtx: opts.mapperCtx, mode: opts.mode },
    dispose: stop,
  };
}
