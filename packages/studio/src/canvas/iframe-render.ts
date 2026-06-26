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

import { buildScope, defineElement, renderNode, setSkipServerFunctions } from "@jxsuite/runtime";
import { effectScope } from "../reactivity";
import { classifyRenderNode, serializeJxPath } from "./path-mapping";
import type { CanvasMode } from "./iframe-protocol";
import type { EffectScope } from "../reactivity";
import type { JxDocument } from "@jxsuite/schema/types";
import type { PathMapCtx } from "./path-mapping";

export interface RenderHandle {
  /** Stop the render's reactive effect scope (call before re-rendering to avoid effect leaks). */
  dispose: () => void;
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
      rootStyle.setProperty(key, String(value));
    } else {
      bodyStyle[key] = String(value);
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
    const classified = classifyRenderNode(path, def, ctx);
    if (classified.kind === "layout") {
      created.dataset.jxLayout = "";
      return;
    }
    created.dataset.jxPath = serializeJxPath(classified.path);
  };
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
  applySiteStyle(opts.siteStyle);
  injectHead(opts.doc);
  const scope: EffectScope = effectScope(true);
  const $defs = await buildScope(opts.doc, {}, opts.docBase);
  const onNodeCreated = makeStamper(opts.mapperCtx);
  const el = scope.run(() =>
    renderNode(opts.doc, $defs, { _path: [], onNodeCreated }),
  ) as HTMLElement;
  opts.container.replaceChildren(el);
  // Register components AFTER the first paint so a slow/recursive/hanging component graph never
  // Blocks the render — custom elements auto-upgrade in place once defined.
  void registerElements(opts.doc, opts.docBase);
  return {
    dispose: () => scope.stop(),
  };
}
