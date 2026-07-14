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
  setSkipServerFunctions,
  setStampPropBindings,
  transposeCanvasUnits,
} from "@jxsuite/runtime";
import { classifyRenderNode, serializeJxPath } from "./path-mapping";
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
[contenteditable="true"]:empty::after {
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
  content: "Empty \\2014  double-click to edit";
  color: color-mix(in srgb, #808080 40%, transparent);
  font-style: italic;
  font-size: 13px;
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

/** Apply the project's site style: custom properties on :root, plain properties on <body>. */
export function applySiteStyle(siteStyle: Record<string, unknown> | null | undefined): void {
  if (!siteStyle || typeof siteStyle !== "object") {
    return;
  }
  const rootStyle = document.documentElement.style;
  const bodyStyle = document.body.style as unknown as Record<string, string>;
  for (const [key, value] of Object.entries(siteStyle)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      continue;
    }
    if (key.startsWith("--")) {
      rootStyle.setProperty(key, transposeCanvasUnits(String(value)));
    } else {
      bodyStyle[key] = transposeCanvasUnits(String(value));
    }
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

/** Build the `onNodeCreated` hook that stamps `data-jx-path` / `data-jx-layout` on rendered nodes. */
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
    if (path.length === 0 && (def as { tagName?: string } | null)?.tagName?.includes("-")) {
      created.dataset.jxDefinitionRoot = "";
    }
    const classified = classifyRenderNode(path, def, ctx);
    if (classified.kind === "layout") {
      created.dataset.jxLayout = "";
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
}): Promise<RenderHandle> {
  setSkipServerFunctions(opts.mode !== "preview");
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
  applySiteStyle(opts.siteStyle);
  injectHead(opts.doc);
  syncEditModeCss(opts.container.ownerDocument, opts.mode);
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
  return {
    ctx: { defs: $defs, docBase: opts.docBase, mapperCtx: opts.mapperCtx, mode: opts.mode },
    dispose: stop,
  };
}
