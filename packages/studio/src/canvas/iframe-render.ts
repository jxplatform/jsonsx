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
  defineElement,
  renderNode,
  runScoped,
  setCanvasDelinkAnchors,
  setCanvasViewportTranspose,
  setRootMedia,
  setSkipAutoRequests,
  setSkipServerFunctions,
  setStampPropBindings,
  transposeCanvasUnits,
} from "@jxsuite/runtime";
import { classifyRenderNode, serializeJxPath } from "./path-mapping";
import { SITE_STYLE_ID, buildSiteStyleCSS } from "./site-style-css";
import type { CanvasMode } from "./iframe-protocol";
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
 * is still removed there (belt and braces). The `[contenteditable="true"]:empty` hint is new: it
 * marks the caret's empty paragraph (e.g. right after an Enter split) and advertises the slash
 * menu.
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
.empty-text-placeholder:not([contenteditable])::after {
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
[data-jx-active-block]:empty::after {
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
  const css = buildSiteStyleCSS(siteStyle, mediaQueries, transposeCanvasUnits);
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

/** Inject the document's `$head` (link/meta/script) into the iframe's <head>, de-duped by href/src. */
export function injectHead(doc: JxDocument): void {
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
      if (
        typeof val === "string" &&
        !val.startsWith("/") &&
        !val.startsWith(".") &&
        !val.startsWith("http")
      ) {
        attrs[key] = `/node_modules/${val}`;
      }
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
    if (!isDefinitionRoot && created.tagName.includes("-") && isEditableMode(ctx.canvasMode)) {
      created.contentEditable = "false";
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
  /** This render may fetch automatic `Request` entries even outside preview (Data-panel Refresh). */
  allowAutoRequests?: boolean;
}): Promise<RenderHandle> {
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
  // Stamp `data-jx-bound-prop` on component-internal invertible text bindings in design/edit only —
  // The inline prop-edit affordance. Set every render so a preview/stylebook render in the same
  // Iframe clears it (page-level templates are inert in design/edit via prepareForEditMode, so only
  // Component internals get stamped).
  setStampPropBindings(opts.mode === "design" || opts.mode === "edit");
  applySiteStyle(opts.siteStyle, (opts.doc as { $media?: Record<string, string> }).$media ?? {});
  injectHead(opts.doc);
  syncEditModeCss(opts.container.ownerDocument, opts.mode);
  syncPreviewShell(opts.container.ownerDocument, opts.mode);
  syncStylebookCss(opts.container.ownerDocument, opts.mode);
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
  // Claim (or release) the editing host AFTER the tree lands, so the browser computes editability
  // Against the final DOM rather than an empty container.
  syncEditableRoot(opts.container, opts.mode);
  return {
    ctx: { defs: $defs, docBase: opts.docBase, mapperCtx: opts.mapperCtx, mode: opts.mode },
    dispose: stop,
  };
}
