/// <reference lib="dom" />
/**
 * Jx — JSON-native reactive web component runtime
 * @version 3.0.0
 * @license MIT
 *
 * Four-step pipeline:
 *   1. resolve    — fetch JSON source (or accept raw object)
 *   2. buildScope — state detection + reactive proxy construction
 *   3. render     — walk resolved tree, build DOM, wire reactive effects
 *   4. output     — append to target
 *
 * @module jx
 */

import {
  computed,
  effect,
  effectScope,
  isRef,
  onEffectCleanup,
  reactive,
  ref,
  toRaw,
} from "@vue/reactivity";
import {
  camelToKebab,
  isDeclarationAtRule,
  pureSchemeOf,
  resolveAtQuery,
  resolveNestedSelector,
  schemeSelectors,
  transposeCanvasPopoverSelector,
} from "./css.ts";
import { evaluateExpression, evaluateOperand, isMutating } from "./expression.ts";
import { readPath } from "./pointer.ts";
import type { DynamicClass, JxEventHandler, JxPath, JxRenderOptions, JxScope } from "./types.ts";
import {
  bodyReturnsValue,
  hasStructuredBody,
  isExpressionDef,
  isFunctionDef,
  isJsonObject,
  isMappedArray,
  isNamedFormulaDef,
  isPrivateStateKey,
  isPrototypeDef,
  isRef as isRefValue,
  isServerFnDef,
  isTagExpression,
  isTemplateString,
  paramNames,
} from "@jxsuite/schema/guards";
import { formatSrcset, parseSrcset } from "@jxsuite/schema/asset-paths";
import { runStatements } from "./statements.ts";
import { readCookie, serializeCookie } from "./cookie.ts";
import type {
  JxAttributeValue,
  JxClassDef,
  JxDocument,
  JxElement,
  JxFunctionDef,
  JxHeadEntry,
  JxMappedArray,
  JxPrototypeDef,
  JxRef,
  JxServerFnDef,
  JxStyle,
} from "@jxsuite/schema/types";
import type { Ref } from "@vue/reactivity";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Mount a Jx document into a DOM container.
 *
 * @example
 *   import { Jx } from "@jxsuite/runtime";
 *   const state = await Jx("./counter.json", document.getElementById("app"));
 *
 * @param {string | JxDocument} source - Path to .json file, URL, or raw document object
 * @param {HTMLElement} [target] Default is `document.body`
 * @param {JxRenderOptions} [options]
 * @returns {Promise<JxScope>} Resolves with the live component scope (state reactive
 * proxy)
 */
/** The document-schema version this runtime understands (the `/schema/vN` in a hosted `$schema`). */
export const SUPPORTED_SCHEMA_VERSION = 1;
let _schemaVersionWarned = false;

/**
 * Warn once when a document declares a hosted `$schema` whose version differs from the one this
 * runtime supports. A relative or non-hosted `$schema` (local dev schema paths) is ignored. This is
 * a diagnostic only — there is no document-format migration story yet (see spec §3.2 / §21.4).
 */
function checkSchemaVersion($schema: unknown): void {
  if (_schemaVersionWarned || typeof $schema !== "string") {
    return;
  }
  const match = $schema.match(/\/schema\/v(\d+)\b/);
  if (match && Number(match[1]) !== SUPPORTED_SCHEMA_VERSION) {
    _schemaVersionWarned = true;
    console.warn(
      `Jx: document $schema is version v${match[1]} but this runtime supports ` +
        `v${SUPPORTED_SCHEMA_VERSION}. Behavior may be undefined; there is no format migrator yet.`,
    );
  }
}

export async function Jx(
  source: string | JxDocument,
  target: HTMLElement = document.body,
  options?: JxRenderOptions,
) {
  const base = options?.base
    ? new URL(options.base, location.href).href
    : typeof source === "string"
      ? new URL(source, location.href).href
      : location.href;
  const doc = await resolve(source);
  checkSchemaVersion(doc.$schema);

  // Register custom elements declared in $elements (depth-first)
  if (doc.$elements) {
    await registerElements(doc.$elements, base);
  }

  // Inject <head> elements declared in $head (link, meta, script, etc.)
  if (doc.$head) {
    injectHead(doc.$head, base);
  }

  if (doc.$media) {
    _rootMedia = doc.$media;
  }

  const state = await buildScope(doc, {}, base);
  target.append(renderNode(doc, state, options));
  if (typeof state.onMount === "function") {
    (state.onMount as (s: JxScope) => unknown)(state);
  }
  return state;
}

// ─── Step 1: Resolve ──────────────────────────────────────────────────────────

const _resolveCache = new Map<string, Promise<JxDocument>>();

export async function resolve(source: string | JxDocument): Promise<JxDocument> {
  if (typeof source !== "string") {
    return source;
  }
  if (_resolveCache.has(source)) {
    return _resolveCache.get(source)!;
  }
  const p = fetch(source).then(async (res) => {
    if (!res.ok) {
      throw new Error(`Jx: failed to fetch ${source} (${res.status})`);
    }
    /*
     * `res.ok` is not enough on a single-page host. A static host configured with an SPA fallback
     * answers a path it does not have with the APPLICATION SHELL at HTTP 200, so a missing document
     * arrives looking like a successful fetch and dies inside `res.json()` as
     * `Unexpected token '<', "<!doctype "... is not valid JSON` — a parser error for what is
     * actually a 404. Jx Cloud did this to every component `$ref` in the canvas.
     *
     * Checked on the content type rather than by sniffing the body: a host that says `text/html`
     * has told us plainly, and saying so costs nothing.
     */
    // Optional-chained: a response that carries no headers at all is one we have no EVIDENCE
    // About, and guessing is worse than proceeding. Every real `Response` has them.
    const contentType = res.headers?.get("Content-Type") ?? "";
    if (contentType.includes("text/html")) {
      throw new Error(
        `Jx: ${source} returned HTML, not a document — the host answered a missing file with its ` +
          `app shell (a single-page fallback), so this path is not served.`,
      );
    }
    // Trust boundary: fetched sources are Jx documents by contract.
    return (await res.json()) as JxDocument;
  });
  _resolveCache.set(source, p);
  return p;
}

// ─── Step 2: Build scope ──────────────────────────────────────────────────────

/** JSON Schema keywords used to identify pure type definitions (Shape 2b). */
const SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "required",
  "examples",
]);

/** /** @type {{ skip: boolean }} */
const _serverFnConfig = { skip: false };
/** Set to true to suppress timing: "server" resolution (used by Studio edit mode). */
export function setSkipServerFunctions(v: boolean) {
  _serverFnConfig.skip = v;
}

/** @type {{ skip: boolean }} */
const _autoRequestConfig = { skip: false };
/**
 * Set to true to suppress AUTOMATIC `$prototype: "Request"` fetches — the sibling of
 * {@link setSkipServerFunctions}, and used by Studio for the same reason.
 *
 * `buildScope` re-resolves every `state` entry on each full canvas render, so an auto-request
 * re-issued its HTTP call every time the canvas rebuilt. In edit/design mode that meant authoring
 * actions — a signal edit, or pressing Enter inside component-wrapped content, both of which force
 * a full render — fired network requests. Live data belongs to preview and to the deployed site.
 *
 * Only non-`manual` requests are gated: a `manual` one fires from an event handler, and edit mode
 * strips handlers before rendering. The returned ref is unchanged either way — it simply stays at
 * its initial `null`, which is the same state bindings observe before any fetch resolves.
 */
export function setSkipAutoRequests(v: boolean) {
  _autoRequestConfig.skip = v;
}

// ─── Dev-proxy auth token (Studio cross-origin canvas) ────────────────────────
// The Studio canvas iframe is served from a token-gated loopback origin (createProjectServer): its
// POST /__jx_resolve__ + /__jx_server__ routes 403 without ?token=<rpcToken>. The iframe boot reads
// The token from its URL and calls setResolveToken so these dev-proxy fetches authenticate. Unset by
// Default, leaving production + same-origin dev untouched (bare path, no query appended).
let _resolveToken: string | null = null;
export function setResolveToken(token: string | null) {
  _resolveToken = token || null;
}
/** Append the dev-proxy auth token to a privileged resolve path when one is configured. */
function resolveProxyPath(path: string): string {
  return _resolveToken ? `${path}?token=${encodeURIComponent(_resolveToken)}` : path;
}

/** @deprecated No longer needed — ContentCollection/ContentEntry resolve via generic class path */
export function setSkipContentResolution(_v: boolean) {
  // No-op retained for API compatibility
}

/**
 * Observe runtime-created reactive values: runs `fn` immediately inside a reactive effect and
 * re-runs it whenever a tracked value changes; returns a disposer. Dep tracking in @vue/reactivity
 * is per module INSTANCE, so an effect created from another copy of the package (e.g. the studio's
 * own pin) can never track a ref/reactive created here — consumers that want to observe
 * runtime-resolved scope values (the Studio canvas iframe's dataScope re-post) must use this.
 *
 * @param {() => void} fn - Read the reactive values to observe inside this callback.
 * @returns {() => void} Disposer — stops the effect and its scope.
 */
export function observeScope(fn: () => void): () => void {
  const scope = effectScope(true);
  scope.run(() => {
    effect(fn);
  });
  return () => scope.stop();
}

/**
 * Run `fn` inside a detached reactive scope of THIS module's reactivity instance, returning its
 * result plus a disposer that stops every effect `fn` created. Callers that render via
 * {@link renderNode} and later tear the render down (the Studio canvas full render and its surgical
 * subtree re-renders) MUST use this instead of their own effectScope: scope collection is per
 * vue-reactivity module instance, so a scope from another copy of the package collects NOTHING and
 * its stop() silently leaks every binding effect of the superseded render.
 *
 * @param {() => T} fn - Work that may create reactive effects (typically a renderNode call).
 * @returns {{ result: T; stop: () => void }} The callback result and the scope disposer.
 */
export function runScoped<T>(fn: () => T): { result: T; stop: () => void } {
  const scope = effectScope(true);
  try {
    const result = scope.run(fn) as T;
    return { result, stop: () => scope.stop() };
  } catch (error) {
    // A throwing fn would otherwise leak the effects it created before failing.
    scope.stop();
    throw error;
  }
}

/**
 * Studio-canvas viewport-unit transpose. The canvas iframe is sized to its document's height, so
 * any viewport unit (`vh`/`vw`/`vmin`/`vmax`/`svh`/…) — which resolves against the iframe ELEMENT —
 * would feed back into an ever-growing height. When this is on, the runtime transposes them to
 * CONTAINER units (`cqh`/`cqw`/…) that resolve against the canvas's fixed-size query container (see
 * `canvas.html`): a predictable, feedback-free stand-in for the viewport. Off (the default) leaves
 * CSS untouched for real production rendering.
 */
let _canvasViewportTranspose = false;
export function setCanvasViewportTranspose(on: boolean) {
  _canvasViewportTranspose = on;
}

const VIEWPORT_UNIT_RE = /(-?\d*\.?\d+)(?:s|l|d)?v(h|w|min|max|i|b)\b/gi;
const VIEWPORT_UNIT_MAP: Record<string, string> = {
  b: "cqb",
  h: "cqh",
  i: "cqi",
  max: "cqmax",
  min: "cqmin",
  w: "cqw",
};

/**
 * Transpose CSS viewport units → container-query units in a value string, but only when the
 * studio-canvas flag is set (otherwise the value is returned untouched). `100vh` → `100cqh`,
 * `50svw` → `50cqw`, `10vmin` → `10cqmin`, etc.
 */
export function transposeCanvasUnits(value: string): string {
  if (!_canvasViewportTranspose || !value.includes("v")) {
    return value;
  }
  return value.replace(
    VIEWPORT_UNIT_RE,
    (_m, num: string, dim: string) => `${num}${VIEWPORT_UNIT_MAP[dim.toLowerCase()] ?? `cq${dim}`}`,
  );
}

/**
 * Studio-canvas anchor de-linking. In the editor canvas a rendered `<a href>` would navigate the
 * iframe when clicked, fighting element selection. When this is on, the runtime stamps the value on
 * `data-jx-href` instead of `href` so the anchor is inert (selectable, not a live link) while the
 * original target stays recoverable for richer link handling later. Off (the default) leaves
 * production rendering untouched; the studio sets it for design/edit (not preview — see
 * iframe-render).
 */
let _canvasDelinkAnchors = false;
export function setCanvasDelinkAnchors(on: boolean) {
  _canvasDelinkAnchors = on;
}

/**
 * Studio-canvas popover de-linking — `setCanvasDelinkAnchors`'s rule applied to `popover`.
 *
 * An OPEN popover is in the top layer, and CSS Position 4 §3.1 gives a top-layer element the
 * VIEWPORT as its containing block whatever its ancestors say. In the editor canvas that viewport
 * is a fiction: the frame is sized to its own content height, so a drawer pinned with `inset: 0`
 * lands halfway down a 6000px page, and a panel taller than a short component frame is clipped by
 * the `overflow: hidden` the canvas document needs. Worse, a top-layer box contributes nothing to
 * any ancestor's scrollable overflow, so the artboard can never grow to fit one.
 *
 * When this is on, the runtime stamps `popover` on `data-jx-popover` for nodes the studio can
 * ADDRESS — those carrying a stamped `data-jx-path`. That drops every `[popover]` UA rule at once,
 * and the one that matters most is `position: fixed`: with it gone the panel lays out in NORMAL
 * FLOW at its document position, which is what makes it contribute to `#jx-canvas-root`'s
 * scrollHeight so the host can grow the artboard to fit it. Leaving the top layer is necessary but
 * not sufficient — a fixed box contributes nothing to an ancestor's overflow either.
 *
 * It is worth saying what does NOT rescue this, because it is the intuitive answer and it is wrong:
 * `container-type: size` on the canvas's query container does NOT make it a containing block for
 * fixed descendants. Measured in Chrome 151 — `getComputedStyle(container).contain` is `none`, and
 * a `position: fixed` child inside it measures the WINDOW, not the container. So a panel that stays
 * fixed stays laid out against the frame's own viewport, which in an editable mode is the
 * document's full height. `iframe-render.ts` therefore FORCES `position` on the open panel rather
 * than relying on any containment.
 *
 * The studio re-supplies the one UA rule that matters — `display: none` while closed — inside a
 * cascade LAYER, so author declarations still beat it exactly as they beat the real UA rule on the
 * shipped page. That is deliberate: a popover whose base rule sets `display` is broken in
 * production, and the canvas has to show that rather than paper over it.
 *
 * The gate on `data-jx-path` is what keeps this out of documents the studio does not own: a popover
 * rendered inside a component's own template is never stamped, so it keeps its native behaviour.
 *
 * It also drives {@link transposeCanvasPopoverSelector}. The two are one transform — an attribute
 * renamed without its selectors transposed is a popover that can never be styled open.
 *
 * @docs framework/concepts/overlays
 */
let _canvasDelinkPopovers = false;
export function setCanvasDelinkPopovers(on: boolean) {
  _canvasDelinkPopovers = on;
}

/** The attribute name to stamp `key` on `el` under — `href` → `data-jx-href` on de-linked anchors. */
function canvasAttrName(el: HTMLElement, key: string): string {
  if (_canvasDelinkAnchors && key === "href" && (el.tagName === "A" || el.tagName === "AREA")) {
    return "data-jx-href";
  }
  /* `dataset.jxPath` is already stamped here: `onNodeCreated` fires before `applyAttributes` in
     `renderNode`, and the studio's stamper writes the attribute synchronously inside it. That
     ordering is an unwritten contract between two packages, so `runtime-canvas.test.ts` asserts it
     directly rather than trusting it. */
  if (_canvasDelinkPopovers && key === "popover" && el.dataset.jxPath !== undefined) {
    return "data-jx-popover";
  }
  return key;
}

/**
 * Rewrite one asset reference for a host that does not serve the site's own URL space.
 *
 * The runtime writes a reference VERBATIM — `el.src = "/hero.jpg"` — so the browser resolves it
 * against the document, and the document is whatever page the renderer happens to be running in. On
 * a real site and on an editing server that serves the project tree, that is correct and this hook
 * stays null. On a multi-tenant editor origin it is not: `/hero.jpg` resolves against the editor,
 * misses, and — behind a single-page-app fallback — comes back as HTML at HTTP 200, so the image
 * renders broken and nothing is logged.
 *
 * A function rather than data because it cannot be one: the values it must fix are produced INSIDE
 * reactive effects (`{"$ref": "#/state/hero"}` is not a string until the effect runs), so no
 * document walk can see them. The Studio canvas iframe sets this at render time.
 *
 * Returning null leaves the value exactly as written, and a null resolver makes every call site
 * below the identity — so production rendering is byte-identical.
 *
 * @param {CanvasAssetResolver | null} fn - The resolver, or null to restore verbatim rendering
 */
export type CanvasAssetResolver = (value: string, key: string) => string | null;

let _canvasAssetResolver: CanvasAssetResolver | null = null;
export function setCanvasAssetResolver(fn: CanvasAssetResolver | null) {
  _canvasAssetResolver = fn;
}

/** Attribute/property names whose value is an asset reference, on any element. */
const ASSET_KEYS = new Set(["src", "poster", "data"]);

/** Names whose value is a `srcset`-shaped candidate list rather than one reference. */
const SRCSET_KEYS = new Set(["srcset", "imagesrcset"]);

/**
 * Elements on which `href` names an ASSET rather than a destination.
 *
 * `<a href>` and `<area href>` are places to go, not files to load; rewriting one would send a
 * click at the file that backs the page instead of at the page. `<link href>` is the opposite — a
 * stylesheet, an icon, a preload — and is the reason `$head` needs this at all.
 */
const HREF_ASSET_TAGS = new Set(["LINK"]);

/** True when writing `key` on a `<tagName>` writes an asset reference. */
function isAssetKey(tagName: string, key: string): boolean {
  return ASSET_KEYS.has(key) || (key === "href" && HREF_ASSET_TAGS.has(tagName));
}

/**
 * The value to actually write for `key` on a `<tagName>` — resolved when it is an asset reference,
 * and the input itself in every other case, including whenever no resolver is installed.
 *
 * `srcset` is split into its candidates and resolved one at a time, because it is N references in
 * one attribute and a resolver handed the whole string would have to re-implement HTML's parser to
 * find them.
 */
function canvasAssetValue(tagName: string, key: string, value: string): string {
  if (!_canvasAssetResolver || value === "") {
    return value;
  }
  const name = key.toLowerCase();
  if (SRCSET_KEYS.has(name)) {
    const candidates = parseSrcset(value);
    let changed = false;
    const next = candidates.map((candidate) => {
      const resolved = _canvasAssetResolver?.(candidate.url, name) ?? null;
      if (resolved === null || resolved === candidate.url) {
        return candidate;
      }
      changed = true;
      return { descriptor: candidate.descriptor, url: resolved };
    });
    return changed ? formatSrcset(next) : value;
  }
  if (!isAssetKey(tagName, name)) {
    return value;
  }
  return _canvasAssetResolver(value, name) ?? value;
}

/** Every `url(...)` inside a CSS value, unquoted or quoted with either quote. */
const CSS_URL_RE = /\burl\(\s*(?<q>["']?)(?<u>[^"')]*)\k<q>\s*\)/g;

/**
 * Resolve every `url()` inside a CSS value.
 *
 * Applied to CSS rather than to a list of properties because in CSS a `url()` is ALWAYS a resource
 * reference — `background-image`, `mask`, `cursor`, `@font-face src`, `list-style-image` and every
 * shorthand that contains them — so enumerating the properties would be a list that goes stale
 * while the syntax does not.
 */
function canvasStyleUrls(value: string): string {
  if (!_canvasAssetResolver || !value.includes("url(")) {
    return value;
  }
  return value.replaceAll(CSS_URL_RE, (whole, quote: string, url: string) => {
    const resolved = url === "" ? null : (_canvasAssetResolver?.(url, "url()") ?? null);
    return resolved === null ? whole : `url(${quote}${resolved}${quote})`;
  });
}

/**
 * A style scalar as the canvas wants it written: assets resolved, then viewport units transposed.
 *
 * Exported because the canvas emits some CSS itself — the site-level `style` block, which never
 * passes through {@link applyStyle} — and a second implementation of "what the canvas does to a
 * style value" is a second thing to keep in step.
 *
 * @param {string} value - A CSS declaration value
 * @returns {string} The value as the canvas should write it
 */
export function canvasStyleValue(value: string): string {
  return transposeCanvasUnits(canvasStyleUrls(value));
}

/**
 * Studio-canvas prop-binding markers. When on, `bindProperty` stamps `data-jx-bound-prop="<key>"`
 * on elements whose `textContent` is an invertible single-key state binding — the pure template
 * `"${state.key}"` or `{ "$ref": "#/state/key" }`. The studio canvas uses the marker to offer
 * inline editing of component-instance prop values; the rendered text must BE the prop value
 * verbatim, so mixed templates and deep paths are never stamped. Off (the default) leaves
 * production rendering untouched; the studio sets it for design/edit (not preview — see
 * iframe-render).
 */
let _stampPropBindings = false;
export function setStampPropBindings(on: boolean) {
  _stampPropBindings = on;
}

/** The single invertible template form: the whole string is exactly one `${state.key}` access. */
const PURE_STATE_TEMPLATE = /^\s*\$\{\s*state\.(\w+)\s*\}\s*$/;

/** The state key of an invertible `textContent` binding, or null (mixed template, deep path). */
function boundPropKey(key: string, val: unknown, state: JxScope): string | null {
  if (!_stampPropBindings || key !== "textContent") {
    return null;
  }
  let sub: string | null = null;
  if (isRefObj(val)) {
    if (!val.$ref.startsWith("#/state/")) {
      return null;
    }
    const rest = val.$ref.slice("#/state/".length);
    sub = rest && !rest.includes("/") ? rest : null;
  } else if (typeof val === "string") {
    sub = PURE_STATE_TEMPLATE.exec(val)?.[1] ?? null;
  }
  if (!sub) {
    return null;
  }
  // Only plain writable data entries are per-instance props. Computed/signal entries live as refs
  // In the raw scope (auto-unwrapped by the reactive proxy), and function/object entries (handlers,
  // $prototype instances) are not prop-overridable either — an instance $props write against any of
  // Them would clobber the definition's behavior, so their bindings are never marked editable.
  const stored = (toRaw(state) as Record<string, unknown>)[sub];
  if (isRef(stored) || typeof stored === "function") {
    return null;
  }
  if (typeof stored === "object" && stored !== null) {
    return null;
  }
  return sub;
}

/**
 * Build the reactive scope (state) from the document using the five-shape detection algorithm.
 *
 * @param {JxDocument} doc
 * @param {JxScope} [parentScope] Default is `{}`
 * @param {string} [base] Base URL for resolving $src imports. Default is `location.href`
 * @returns {Promise<JxScope>} Reactive proxy (state)
 */
export async function buildScope(
  doc: JxDocument,
  parentScope: JxScope = {},
  base: string = location.href,
) {
  const raw: JxScope = {};

  // Merge parent scope properties
  for (const [key, val] of Object.entries(parentScope)) {
    raw[key] = val;
  }

  const defs = doc.state ?? {};

  // Pass 0: resolve bare $prototype names via import map
  const imports = doc.imports ?? {};
  for (const [, def] of Object.entries(defs)) {
    if (isPrototypeDef(def) && !def.$src) {
      const mapped = imports[def.$prototype];
      if (mapped) {
        if (!mapped.endsWith(".class.json")) {
          console.warn(
            `Jx: import "${def.$prototype}" must map to a .class.json path, got "${mapped}"`,
          );
          continue;
        }
        def.$src = mapped;
      }
    }
  }

  // First pass: collect naked values, expanded defaults, plain objects
  for (const [key, def] of Object.entries(defs)) {
    // 1. String value
    if (typeof def === "string") {
      if (!def.includes("${")) {
        raw[key] = def;
      } // Shape 1: naked string
      continue; // Template strings handled in second pass
    }

    // 2. Number, boolean, null
    if (typeof def === "number" || typeof def === "boolean" || def === null) {
      raw[key] = def;
      continue;
    }

    // 3. Array
    if (Array.isArray(def)) {
      raw[key] = def;
      continue;
    }

    // 4. Object
    if (typeof def === "object") {
      if (def.$prototype) {
        continue;
      } // Handled in later passes
      if (isExpressionDef(def)) {
        continue;
      } // Handled in pass 2.5
      if (isServerFnDef(def)) {
        continue;
      } // Handled in fifth pass
      if ("default" in def) {
        raw[key] = def.default;
        continue;
      } // Shape 2: expanded signal
      if (hasSchemaKeywords(def)) {
        continue;
      } // Shape 2b: pure type def
      raw[key] = def; // Shape 1: plain object
    }
  }

  // Wrap in Vue reactive proxy — deep reactivity from this point on
  const state = reactive(raw);

  // Second pass: template strings → computed
  for (const [key, def] of Object.entries(defs)) {
    if (typeof def === "string" && def.includes("${")) {
      state[key] = computed(() => evaluateTemplate(def, state));
    }
  }

  // Pass 2.5: $expression entries (Shape 5)
  for (const [key, def] of Object.entries(defs)) {
    if (isExpressionDef(def)) {
      const node = def.$expression;
      if (isNamedFormulaDef(def)) {
        // A named formula: callable with positional args mapped onto its declared parameters.
        const params = def.parameters as (string | { name?: string; default?: unknown })[];
        state[key] = (...argValues: unknown[]) => {
          const args: Record<string, unknown> = {};
          for (const [i, p] of params.entries()) {
            const name = typeof p === "string" ? p : (p?.name ?? "");
            if (!name) {
              continue;
            }
            args[name] =
              argValues[i] === undefined && typeof p === "object" && p !== null && "default" in p
                ? p.default
                : argValues[i];
          }
          return evaluateExpression(node, state, null, { args });
        };
      } else if (isMutating(node.operator)) {
        const handler: JxEventHandler = (s, event) => evaluateExpression(node, s, event);
        state[key] = handler;
      } else {
        state[key] = computed(() => evaluateExpression(node, state, null));
      }
    }
  }

  // Third pass: $prototype: "Function" entries
  for (const [key, def] of Object.entries(defs)) {
    if (hasStructuredBody(def)) {
      // Structured body (spec §20): with parameters → a callable mapping positional args onto
      // $args names (invoked via the call operator); without → an event handler.
      const { body } = def;
      if (Array.isArray(def.parameters) && def.parameters.length > 0) {
        const params = def.parameters as (string | { name?: string; default?: unknown })[];
        state[key] = (...argValues: unknown[]) => {
          const args: Record<string, unknown> = {};
          for (const [i, p] of params.entries()) {
            const name = typeof p === "string" ? p : (p?.name ?? "");
            if (!name) {
              continue;
            }
            args[name] =
              argValues[i] === undefined && typeof p === "object" && p !== null && "default" in p
                ? p.default
                : argValues[i];
          }
          return runStatements(body, state, null, { args });
        };
      } else {
        const handler: JxEventHandler = (s, event) => {
          void runStatements(body, s, event ?? null);
        };
        state[key] = handler;
      }
    } else if (isFunctionDef(def)) {
      state[key] = await resolveFunction(def, state, key, base);
    }
  }

  // Fourth pass: other $prototype entries (Request, Set, Map, etc.)
  for (const [key, def] of Object.entries(defs)) {
    if (isPrototypeDef(def)) {
      state[key] = await resolvePrototype(def, state, key, base);
    }
  }

  // Fifth pass: timing: "server" entries (dev mode — execute client-side, boundary unenforced)
  if (!_serverFnConfig.skip) {
    for (const [key, def] of Object.entries(defs)) {
      if (isServerFnDef(def)) {
        state[key] = await resolveServerFunction(def, state, key, base);
      }
    }
  }

  if (doc.$media) {
    state["$media"] = doc.$media;
  } else if (!state["$media"] && Object.keys(_rootMedia).length > 0) {
    state["$media"] = _rootMedia;
  }

  return state;
}

/**
 * Check whether an object contains any JSON Schema keywords. Used to discriminate Shape 2b (pure
 * type definition) from Shape 1 (naked object).
 *
 * @param {JxScope} obj
 * @returns {boolean}
 */
function hasSchemaKeywords(obj: object) {
  for (const k of Object.keys(obj)) {
    if (SCHEMA_KEYWORDS.has(k)) {
      return true;
    }
  }
  return false;
}
export { hasSchemaKeywords };

/**
 * Evaluate a template string in the context of state and optional $map. Templates use
 * `state.varName` and `$map.item` syntax.
 *
 * @param {string} str
 * @param {JxScope} state
 * @returns {string}
 */
function evaluateTemplate(str: string, state: JxScope): string {
  const $map = state?.$map as { item?: unknown; index?: number } | undefined;
  const fn = new Function("state", "$map", "item", "index", `return \`${str}\``) as (
    state: JxScope,
    $map: unknown,
    item: unknown,
    index: number | undefined,
  ) => string;
  return fn(state, $map, $map?.item, $map?.index);
}

/**
 * Whether a template is ONE expression end to end — `"${a.b}"` rather than `"a ${b}"` or
 * `"${a}${b}"`.
 *
 * Depth-counted rather than pattern-matched. A greedy `/^\$\{(.+)\}$/` also matched `"${a} /
 * ${b}"`, spliced the interior into `return (a} / ${b)`, and the SyntaxError became a silent null:
 * the node rendered empty and a `$head` entry shipped its own template text. A brace scan is exact
 * where a tightened regex is not — `"${`${a}-x`}"` is still one expression, and must keep its raw
 * value.
 *
 * Lives here rather than in the compiler because both renderers must draw the line in the same
 * place. It is what decides whether a value keeps its own type, and a value that is a boolean in
 * one renderer and the string `"false"` in the other is a page that changes meaning as it
 * hydrates.
 *
 * @param {string} str - Template source
 * @returns {boolean} True when the whole string is a single `${…}`
 */
export function isSingleExpression(str: string): boolean {
  if (!str.startsWith("${") || !str.endsWith("}")) {
    return false;
  }
  let depth = 0;
  for (let i = 1; i < str.length; i += 1) {
    const c = str[i];
    if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return i === str.length - 1;
      }
    }
  }
  return false;
}

/**
 * Evaluate a template for an ATTRIBUTE, keeping the expression's own type.
 *
 * `evaluateTemplate` interpolates into a string, which is what text wants and what an attribute
 * cannot afford: `"${state.expanded}"` has to arrive as the boolean `false`, or `booleanAttrValue`
 * never sees a boolean, `open="false"` is written, and HTML reads that as open. Only a single
 * expression can carry a type at all — `"a ${b}"` is text by construction — which is the same line
 * `evaluateStaticTemplate` draws in the compiler, and drawing it identically is what keeps a
 * prerendered page and the same document rendered live in agreement.
 *
 * @param {string} str - Template source
 * @param {JxScope} state - Reactive scope
 * @returns {unknown} The expression's value, or the interpolated string
 */
function evaluateAttrTemplate(str: string, state: JxScope): unknown {
  if (!isSingleExpression(str)) {
    return evaluateTemplate(str, state);
  }
  const $map = state?.$map as { item?: unknown; index?: number } | undefined;
  const fn = new Function("state", "$map", "item", "index", `return (${str.slice(2, -1)})`) as (
    state: JxScope,
    $map: unknown,
    item: unknown,
    index: number | undefined,
  ) => unknown;
  return fn(state, $map, $map?.item, $map?.index);
}

// ─── Step 2b: Function resolution (Shape 4) ─────────────────────────────────

/** Shape of a dynamically imported module: named exports plus an optional default. */
type ImportedModule = Record<string, unknown> & { default?: Record<string, unknown> };

/** Minimal contract an externally-imported resolver class may implement. */
interface ExternalClassInstance {
  value?: unknown;
  resolve?: () => unknown;
  subscribe?: (cb: (newVal: unknown) => void) => void;
}

/** Module cache for $src imports (shared with external class resolution). */
const _moduleCache = new Map<string, ImportedModule>();

/**
 * Resolve a $prototype: "Function" entry into a function or computed.
 *
 * Functions receive state as their first parameter at call time. Functions with a return statement
 * in their body are wrapped in computed() for reactive evaluation.
 *
 * @param {JxFunctionDef} def - State entry with $prototype: "Function"
 * @param {JxScope} state - Reactive scope proxy
 * @param {string} key - Def key name
 * @param {string} [base] - Base URL for resolving $src imports
 * @returns {Promise<unknown>}
 */
async function resolveFunction(def: JxFunctionDef, state: JxScope, key: string, base?: string) {
  if (def.body && def.$src) {
    throw new Error(`Jx: '${key}' declares both body and $src — these are mutually exclusive`);
  }
  if (!def.body && !def.$src) {
    const params = resolveParamNames(def);
    const noop = new Function(...params, "");
    Object.defineProperty(noop, "name", {
      configurable: true,
      value: def.name ?? key,
    });
    return noop;
  }

  let fn: ((...args: unknown[]) => unknown) | undefined;

  if (typeof def.body === "string") {
    const params = resolveParamNames(def);
    fn = new Function(...params, def.body) as (...args: unknown[]) => unknown;
    Object.defineProperty(fn, "name", {
      configurable: true,
      value: def.name ?? key,
    });
  } else {
    // $src: dynamic import (the body/$src dichotomy was validated above)
    const src = def.$src;
    if (!src) {
      throw new Error(`Jx: '${key}' has neither body nor $src`);
    }
    const exportName = def.$export ?? key;
    let mod: ImportedModule;
    if (_moduleCache.has(src)) {
      mod = _moduleCache.get(src)!;
    } else {
      if (base) {
        const resolvedSrc = new URL(src, base).href;
        try {
          mod = (await import(resolvedSrc)) as ImportedModule;
        } catch {
          mod = (await import(src)) as ImportedModule;
        }
      } else {
        mod = (await import(src)) as ImportedModule;
      }
      _moduleCache.set(src, mod);
    }
    const candidate = mod[exportName] ?? mod.default?.[exportName];
    if (typeof candidate !== "function") {
      throw new TypeError(`Jx: export "${exportName}" not found or not a function in "${src}"`);
    }
    fn = candidate as (...args: unknown[]) => unknown;
  }

  // Detect computed: body contains a return statement, or $src function introspection.
  // Functions with parameters (event handlers, callbacks) are never computed.
  const hasParams = (def.parameters ?? def.arguments ?? []).length > 0;
  let isComputed = false;
  if (!hasParams) {
    if (typeof def.body === "string") {
      isComputed = bodyReturnsValue(def.body);
    } else if (fn) {
      isComputed = fn.length <= 1 && bodyReturnsValue(fn.toString());
    }
  }
  if (isComputed) {
    return computed(() => fn(state));
  }

  return fn;
}

// ─── Step 3: Render ───────────────────────────────────────────────────────────

/**
 * Extract parameter names from a function definition. Supports both legacy "arguments" (string
 * array) and CEM-compatible "parameters" (object array). Always ensures "state" is the first
 * parameter.
 *
 * @param {JxFunctionDef | JxPrototypeDef} def
 * @returns {string[]}
 */
function resolveParamNames(def: JxFunctionDef | JxPrototypeDef) {
  const names = def.parameters ? paramNames(def.parameters) : (def.arguments ?? []);
  return names.length > 0 && names[0] === "state" ? names : ["state", ...names];
}

/**
 * Reserved Jx keys — never set as DOM properties.
 *
 * @type {Set<string>}
 */
export const RESERVED_KEYS = new Set([
  "$schema",
  "$id",
  "$defs",
  "state",
  "$ref",
  "$props",
  "$elements",
  "$title",
  "$description",
  "$switch",
  "$prototype",
  "$src",
  "$export",
  "$media",
  "$map",
  "timing",
  "default",
  "description",
  "body",
  "parameters",
  "arguments",
  "name",
  "tagName",
  "children",
  "style",
  "attributes",
  "items",
  "map",
  "filter",
  "sort",
  "cases",
  "observedAttributes",
]);

/**
 * Recursively render a Jx element definition into a DOM element.
 *
 * @param {JxElement | string | number | boolean} def
 * @param {JxScope} state - Reactive scope proxy (or child scope via Object.create)
 * @param {JxRenderOptions} [options]
 * @returns {HTMLElement | Text}
 */
/** Refs already warned about, so the §13 diagnostic fires once per distinct target. */
const warnedRefChildren = new Set<string>();

/** Foreign-content namespaces the HTML parser switches into, and the runtime must too. */
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/**
 * The namespace an element belongs in, given the one its parent established.
 *
 * The static build emits markup text, so the HTML parser applied foreign-content rules for it and
 * SVG worked there. The runtime built every node with `document.createElement`, which is HTML-only,
 * so the same document rendered blank in the Studio canvas and in any hydrated component — the
 * editor and the deployed site disagreeing, with only the editor wrong.
 *
 * @param {string} tagName
 * @param {string | null | undefined} inherited - The namespace the parent element established
 * @returns {string | null} Null means HTML
 */
function elementNamespace(tagName: string, inherited: string | null | undefined): string | null {
  if (tagName === "svg") {
    return SVG_NS;
  }
  if (tagName === "math") {
    return MATHML_NS;
  }
  return inherited ?? null;
}

export function renderNode(
  def: JxElement | string | number | boolean,
  state: JxScope,
  options?: JxRenderOptions,
): HTMLElement | Text {
  const path = options?._path ?? [];

  // Text node children: bare strings/numbers/booleans produce DOM Text nodes
  if (typeof def === "string" || typeof def === "number" || typeof def === "boolean") {
    const textNode = document.createTextNode(String(def));
    if (typeof def === "string" && isTemplateString(def)) {
      effect(() => {
        textNode.textContent = evaluateTemplate(def, state);
      });
    }
    return textNode;
  }

  // Extend scope with any $-prefixed local bindings declared on this node
  let localState: JxScope = state;
  for (const [key, val] of Object.entries(def)) {
    if (key.startsWith("$") && !RESERVED_KEYS.has(key)) {
      if (localState === state) {
        localState = Object.create(state) as JxScope;
      }
      localState[key] = isRefObj(val) ? resolveRef(val.$ref, state) : val;
    }
  }

  /*
   * §13 diagnostic: a node-level external `$ref` (the withdrawn component-instance syntax) has no
   * tagName and silently renders an empty <div>. Warn once per target instead of failing silently —
   * the supported mechanism is $elements + a custom-element tag (see spec §13).
   */
  if ("$ref" in def && !def.tagName) {
    const refTarget = String((def as { $ref?: unknown }).$ref ?? "");
    if (!warnedRefChildren.has(refTarget)) {
      warnedRefChildren.add(refTarget);
      console.warn(
        `Jx: a $ref child ("${refTarget}") is not a supported component instance; register the ` +
          `component in $elements and use its custom-element tag instead (spec §13).`,
      );
    }
  }

  /* RESOLVED ONCE, HERE, before anything branches on it.
     A tag may be a name or a choice between names (`ElementTagName`). Resolving at the top means
     every test below — the hyphen check that routes to the custom-element path, `customElements.get`,
     `createElement` itself — sees a literal, exactly as it did when a tag could only be written out.

     It is not tracked. `tagName` is in RESERVED_KEYS so no binding sweep reaches it, and a tag that
     changed after mount would mean replacing the node: the subtree's listeners, its focus, its typed
     input values and its component instances all go with it, and this runtime has no dispose walk to
     pay that bill (renderSwitch, two hundred lines up, still leaks its previous case's effects).
     `jx validate` warns when a tag discriminant is also an assignment target, so the case where this
     rule bites is caught before it ships rather than found as a `<div>` that never became an `<a>`. */
  const tagName = resolveTagName(def.tagName, localState);
  const isCustomEl = tagName.includes("-") && customElements.get(tagName);

  if (def.$props && isCustomEl) {
    return renderCustomElementWithProps(def, localState, options, path);
  }

  if (def.$props) {
    // A hyphenated tag carrying $props is a component instance whose definition has not finished
    // Registering yet (async defineElement — e.g. the Studio desktop canvas, where the component
    // Fetch can land after this node renders). Render via the property-first path anyway: it sets
    // The instance props as JS properties on the bare element, which the eventual upgrade's
    // ConnectedCallback reads back off `this` (see the def.state merge below), so the instance's
    // Props win. The old branch stripped the props here, so a late upgrade painted the component's
    // State DEFAULTS instead ("0"/"DESCRIPTION" for every instance). A non-custom tag can never
    // Upgrade, so it keeps the historical mergeProps-into-scope behavior.
    if (tagName.includes("-")) {
      return renderCustomElementWithProps(def, localState, options, path);
    }
    const { $props: _$props, ...rest } = def;
    return renderNode(rest, mergeProps(def, localState), options);
  }
  if (def.$switch) {
    return renderSwitch(def, localState, options);
  }

  const ns = elementNamespace(tagName, options?._ns);
  /*
   * `foreignObject` is itself an SVG element, and is the documented way back into HTML: its
   * DESCENDANTS are HTML, so the element and its children carry different namespaces.
   */
  const childNs = tagName === "foreignObject" ? null : ns;
  /*
   * A namespaced node comes back as Element; every apply* helper below is typed for HTMLElement
   * and touches only members both share (style, dataset, setAttribute, append).
   */
  const el = (ns
    ? document.createElementNS(ns, tagName)
    : document.createElement(tagName)) as unknown as HTMLElement;

  if (options?.onNodeCreated) {
    options.onNodeCreated(el, path, def, localState);
  }

  applyProperties(el, def, localState);
  applyStyle(
    el,
    def.style ?? {},
    (localState["$media"] as Record<string, string>) ?? {},
    localState,
  );
  applyAttributes(el, def.attributes ?? {}, localState);

  const kids = def.children;
  if (isMappedArray(kids)) {
    // Legacy whole-children repeater: the items render directly into `el` (which keeps its own
    // TagName, e.g. <ul>), with no extra wrapper element.
    const arrOpts =
      options || childNs ? { ...options, _ns: childNs, _path: [...path, "children"] } : undefined;
    renderMappedArrayInto(el, kids, localState, arrOpts);
  } else if (Array.isArray(kids)) {
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      const childOpts =
        options || childNs
          ? { ...options, _ns: childNs, _path: [...path, "children", i] }
          : undefined;
      if (isMappedArray(child)) {
        // Array pseudo-element among siblings: expand inline, no wrapper.
        renderMappedArrayInto(el, child, localState, childOpts);
      } else {
        el.append(renderNode(child, localState, childOpts));
      }
    }
  }

  return el;
}

// ─── Template string utilities ────────────────────────────────────────────────

/**
 * Check if a value is a template string (contains ${}).
 *
 * @param {unknown} val
 * @returns {boolean}
 */
// ─── Property / style / attribute application ─────────────────────────────────

/**
 * @param {HTMLElement} el
 * @param {JxElement} def
 * @param {JxScope} state
 */
function applyProperties(el: HTMLElement, def: JxElement, state: JxScope) {
  for (const [key, val] of Object.entries(def)) {
    if (RESERVED_KEYS.has(key)) {
      continue;
    }
    if (key.startsWith("$")) {
      continue;
    } // Scope bindings — handled in renderNode

    if (key.startsWith("on")) {
      // Event handler: $ref to a function
      if (isRefObj(val)) {
        const handler = resolveRef(val.$ref, state);
        if (typeof handler === "function") {
          const scope = state;
          const handlerFn = handler as (s: JxScope, e: Event) => unknown;
          el.addEventListener(key.slice(2), (e) => handlerFn(scope, e));
        }
        continue;
      }
      // Event handler: inline $prototype: "Function" with a structured body (spec §20)
      if (hasStructuredBody(val)) {
        const { body } = val;
        const scope = state;
        el.addEventListener(key.slice(2), (e) => {
          void runStatements(body, scope, e);
        });
        continue;
      }
      // Event handler: inline $prototype: "Function"
      if (isFunctionDef(val) && typeof val.body === "string") {
        const params = resolveParamNames(val);
        const fn = new Function(...params, val.body) as (s: JxScope, e: Event) => unknown;
        const scope = state;
        el.addEventListener(key.slice(2), (e) => fn(scope, e));
        continue;
      }
      // Event handler: inline $expression
      if (isExpressionDef(val)) {
        const node = val.$expression;
        const scope = state;
        el.addEventListener(key.slice(2), (e) => evaluateExpression(node, scope, e));
        continue;
      }
    }

    bindProperty(el, key, val, state);
  }
}

/**
 * @param {HTMLElement} el
 * @param {string} key
 * @param {unknown} val
 * @param {JxScope} state
 */
function bindProperty(el: HTMLElement, key: string, val: unknown, state: JxScope) {
  const target = el as unknown as Record<string, unknown>;
  const boundProp = boundPropKey(key, val, state);
  if (boundProp) {
    el.dataset.jxBoundProp = boundProp;
  }
  /* An `<img>` in a document says `{"tagName": "img", "src": "/hero.jpg"}`, so `src` arrives HERE
     as a top-level key and is written as a DOM PROPERTY — `attributes: { src }` is the rarer
     spelling. Both are the same reference and both need the same resolution. */
  const asAsset = (resolved: unknown): unknown =>
    typeof resolved === "string" ? canvasAssetValue(el.tagName, key, resolved) : resolved;
  /*
   * `className` on an SVGElement is a read-only SVGAnimatedString, so assigning it throws in the
   * strict mode an ES module always runs under. It is the most common Jx element property, so the
   * attribute form is the only one that works on both.
   */
  const write = (resolved: unknown): void => {
    const node = el as unknown as Element;
    if (key === "className" && !(node instanceof HTMLElement)) {
      node.setAttribute("class", resolved == null ? "" : String(resolved));
      return;
    }
    target[key] = resolved;
  };
  if (isRefObj(val)) {
    const refVal = val as { $ref: string };
    if (key === "id") {
      target[key] = resolveRef(refVal.$ref, state) as string;
      return;
    }
    effect(() => {
      write(asAsset(resolveRef(refVal.$ref, state)));
    });
    return;
  }

  // Universal ${} reactivity — template strings in element properties
  if (isTemplateString(val)) {
    effect(() => {
      write(asAsset(evaluateTemplate(val as string, state)));
    });
    return;
  }

  write(asAsset(val));
}

/**
 * Apply inline styles and emit a scoped <style> block for nested CSS selectors and @custom-media
 * breakpoint rules.
 *
 * @param {HTMLElement} el
 * @param {JxStyle} styleDef
 * @param {Record<string, string>} [mediaQueries] Named breakpoints from root $media. Default is
 *   `{}`
 * @param {JxScope} [state] Component scope for template string evaluation. Default is `{}`
 */
export function applyStyle(
  el: HTMLElement,
  styleDef: JxStyle,
  mediaQueries: Record<string, string> = {},
  state: JxScope = {},
) {
  const nested: Record<string, JxStyle> = {};
  const media: Record<string, JxStyle> = {};
  const baseDecls: Record<string, string> = {};

  // Collect properties overridden by media queries so we can avoid inline styles for them
  const mediaOverriddenProps = new Set<string>();
  for (const [prop, val] of Object.entries(styleDef)) {
    if (prop.startsWith("@") && val && typeof val === "object") {
      for (const k of Object.keys(val)) {
        if (
          !k.startsWith(":") &&
          !k.startsWith(".") &&
          !k.startsWith("&") &&
          !k.startsWith("[") &&
          !k.startsWith("@")
        ) {
          mediaOverriddenProps.add(k);
        }
      }
    }
  }

  for (const [prop, val] of Object.entries(styleDef)) {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      if (prop.startsWith("@")) {
        media[prop] = val;
      } else {
        nested[prop] = val;
      }
      continue;
    }
    if (prop.startsWith("@") || isNestedSelector(prop)) {
      // Scalar under a selector/media key — invalid style shape, drop it.
      continue;
    }
    if (val === undefined) {
      continue;
    }
    const scalar = String(val);
    if (prop.startsWith("--")) {
      if (isTemplateString(val)) {
        effect(() => {
          el.style.setProperty(prop, canvasStyleValue(evaluateTemplate(val, state)));
        });
      } else {
        el.style.setProperty(prop, canvasStyleValue(scalar));
      }
    } else if (isTemplateString(val)) {
      effect(() => {
        (el.style as unknown as Record<string, string>)[prop] = canvasStyleValue(
          evaluateTemplate(val, state),
        );
      });
    } else if (mediaOverriddenProps.has(prop)) {
      // Goes through toCSSText (which resolves and transposes) — don't do either twice here.
      baseDecls[prop] = scalar;
    } else {
      (el.style as unknown as Record<string, string>)[prop] = canvasStyleValue(scalar);
    }
  }

  const hasNested = Object.keys(nested).length > 0;
  const hasMedia = Object.keys(media).length > 0;
  const hasBaseDecls = Object.keys(baseDecls).length > 0;
  if (!hasNested && !hasMedia && !hasBaseDecls) {
    return;
  }

  const uid = `jx-${Math.random().toString(36).slice(2, 7)}`;
  el.dataset.jx = uid;

  let css = "";
  const baseCSS = toCSSText(baseDecls);
  if (baseCSS) {
    css += `[data-jx="${uid}"] { ${baseCSS} }\n`;
  }

  /* One gate for the whole call, so `reapplyStyle` and every recursion answer alike. Off in
     production and in preview, where the selector is written exactly as authored. */
  const transpose = _canvasDelinkPopovers && el.dataset.jxPath !== undefined;
  /** The selector to emit for `scope`, or null when this rule must not be emitted at all. */
  const emittable = (scope: string): string | null =>
    transpose ? transposeCanvasPopoverSelector(scope) : scope;

  function emitNested(scope: string, rules: JxStyle) {
    const selector = emittable(scope);
    const props = toCSSText(rules);
    if (selector !== null && props) {
      css += `${selector} { ${props} }\n`;
    }
    for (const [sel, sub] of Object.entries(rules)) {
      if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
        continue;
      }
      if (sel.startsWith("@")) {
        continue;
      }
      emitNested(resolveNestedSelector(scope, sel), sub);
    }
  }

  for (const [sel, rules] of Object.entries(nested)) {
    emitNested(resolveNestedSelector(`[data-jx="${uid}"]`, sel), rules);
  }

  function emitMediaNested(atRule: string, parentSel: string, obj: JxStyle) {
    for (const [sel, sub] of Object.entries(obj)) {
      if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
        continue;
      }
      if (sel.startsWith("@")) {
        continue;
      }
      const resolved = resolveNestedSelector(parentSel, sel);
      const selector = emittable(resolved);
      const props = toCSSText(sub);
      if (selector !== null && props) {
        css += `${atRule} { ${selector} { ${props} } }\n`;
      }
      emitMediaNested(atRule, resolved, sub);
    }
  }

  for (const [key, rules] of Object.entries(media)) {
    if (key === "@--") {
      continue;
    } // Base canvas width, not a real media query
    /* A declaration-body at-rule has no selector to scope: `@position-try --flip { … }` IS the
       body. Emitted verbatim and NOT scoped to this element, because the name it declares is
       document-global — which is also why it is written where it is used rather than somewhere
       central, exactly as an author writes one in a plain stylesheet. */
    if (isDeclarationAtRule(key)) {
      const decls = toCSSText(rules);
      if (decls) {
        css += `${key} { ${decls} }\n`;
      }
      continue;
    }
    const query = resolveAtQuery(key, mediaQueries);
    const atRule = query === null ? key : `@media ${query}`;
    const scope = `[data-jx="${uid}"]`;
    const scheme = query === null ? null : pureSchemeOf(query);
    if (scheme) {
      // Dual-emit scheme rules: a media-guarded copy for auto plus a forced-attribute copy.
      // The forced root attribute wins over the OS preference.
      const { auto, forced } = schemeSelectors(scope, scheme);
      css += `${atRule} { ${auto} { ${toCSSText(rules)} } }\n`;
      emitMediaNested(atRule, auto, rules);
      emitNested(forced, rules);
    } else {
      css += `${atRule} { ${scope} { ${toCSSText(rules)} } }\n`;
      emitMediaNested(atRule, scope, rules);
    }
  }

  const tag = document.createElement("style");
  tag.textContent = css;
  tag.dataset.jxOwner = uid;
  document.head.append(tag);
  elementStyleTags.set(el, tag);
}

/**
 * Scoped <style> tags emitted per element by applyStyle (latest wins). Lets callers replace an
 * element's emitted styles instead of accumulating orphaned tags.
 */
export const elementStyleTags = new WeakMap<HTMLElement, HTMLStyleElement>();

/**
 * Re-apply an element's style definition in place: removes the previously emitted scoped <style>
 * tag (if any), clears inline styles, and applies the new definition.
 *
 * @param {HTMLElement} el
 * @param {JxStyle | undefined} styleDef
 * @param {Record<string, string>} [mediaQueries]
 * @param {JxScope} [state]
 */
export function reapplyStyle(
  el: HTMLElement,
  styleDef: JxStyle | undefined,
  mediaQueries: Record<string, string> = {},
  state: JxScope = {},
) {
  const prev = elementStyleTags.get(el);
  if (prev) {
    prev.remove();
    elementStyleTags.delete(el);
  }
  el.style.cssText = "";
  delete el.dataset.jx;
  applyStyle(el, styleDef ?? {}, mediaQueries, state);
}

/*
 * HTML carries a boolean two incompatible ways, and writing one as the other inverts it in silence.
 *
 * A *boolean attribute* — `open`, `disabled`, `hidden`, `required` — is read by PRESENCE. Any value
 * at all counts as true, `"false"` included, so `<details open="false">` is an OPEN `<details>`.
 * The value must never be written; absence is the only way to say false.
 *
 * An *enumerated* attribute carries the word in its own text and reads an empty value as unset, so
 * the presence form is the broken one here: bare `aria-hidden` is NOT hidden, and a dropped
 * `contenteditable` means "inherit from the parent" rather than `false`. Every `aria-*` is in this
 * family — ARIA has no presence attributes at all — along with the three HTML attributes below.
 *
 * **`popover` is enumerated and is deliberately NOT in this set**, which looks like an oversight
 * and is not. Its keywords are `auto`, `manual` and `hint`; its MISSING-value default is `auto`, so
 * a bare `popover` and `popover=""` are both auto popovers — which is what the presence branch
 * below already produces for `true`, correctly. Its INVALID-value default is `manual`, so moving it
 * here would emit `popover="true"`, which is not a keyword, and every popover written as a boolean
 * would silently stop light-dismissing and stop answering Escape. The right answer to a boolean
 * `popover` is not a different emission, it is not writing one: `@jxsuite/schema/overlays` reports
 * it as `invalid-mode`, and the house spelling is `"auto"`.
 *
 * That also corrects the paragraph above for this one attribute: a presence attribute counts any
 * value as true, but `popover="false"` is a *manual* popover rather than a true-ish one, because it
 * is enumerated even though it is emitted through the presence branch.
 *
 * @docs framework/concepts/elements
 */
const ENUMERATED_ATTRS = new Set(["contenteditable", "draggable", "spellcheck"]);

/**
 * The enumerated-attribute names, for a code generator that cannot import this module.
 *
 * The compiler's element and client targets emit standalone ES modules that a built site loads
 * without `@jxsuite/runtime`, so they inline the boolean decision instead of calling it. They
 * serialize THIS array into that inlined helper, and `compile-element.test.ts` asserts the emitted
 * literal still equals it — which is what keeps the four writers of the rule one decision rather
 * than four, in the one place a shared function could not reach.
 *
 * @returns {string[]} The names, sorted, so the emitted output is stable.
 */
export function enumeratedAttrNames(): string[] {
  return [...ENUMERATED_ATTRS].toSorted();
}

/**
 * The text an attribute's boolean value must be written with, or `null` when saying it means
 * removing the attribute instead.
 *
 * An empty string is the bare form: `setAttribute(name, "")` is how the DOM spells the `open` that
 * HTML source writes with no `=`.
 *
 * Shared rather than restated because two renderers must agree. The compiler writes attributes into
 * a string of HTML and this file writes them onto live elements; were they to disagree about which
 * family an attribute belongs to, a prerendered page would change meaning as it hydrated.
 *
 * @param {string} name - Attribute name, already resolved to what will be written
 * @param {boolean} value - The resolved boolean
 * @returns {string | null} Text to write, or null to omit the attribute
 */
export function booleanAttrValue(name: string, value: boolean): string | null {
  const lower = name.toLowerCase();
  if (lower.startsWith("aria-") || ENUMERATED_ATTRS.has(lower)) {
    return String(value);
  }
  return value ? "" : null;
}

/**
 * @param {HTMLElement} el
 * @param {Record<string, import("@jxsuite/schema/types").JxAttributeValue>} attrs
 * @param {JxScope} state
 */
function applyAttributes(el: HTMLElement, attrs: Record<string, JxAttributeValue>, state: JxScope) {
  for (const [k, v] of Object.entries(attrs)) {
    const attr = canvasAttrName(el, k);
    /* Inside the effects, not before them. A `$ref` or `${…}` value is not a string until the
       effect runs — which is exactly why the document walk this replaced could never see it. */
    const write = (resolved: unknown) => {
      if (typeof resolved === "boolean") {
        const text = booleanAttrValue(attr, resolved);
        /* `removeAttribute`, not `setAttribute(attr, "false")`. A binding that flips back has to
           take the attribute WITH it: the element is being re-used, so anything left behind is the
           state the page just said it had left. Asset rewriting is skipped because a boolean names
           no asset — `canvasAssetValue` reads `src`/`href` values, which are never booleans. */
        if (text === null) {
          el.removeAttribute(attr);
        } else {
          el.setAttribute(attr, text);
        }
        return;
      }
      el.setAttribute(attr, canvasAssetValue(el.tagName, k, String(resolved ?? "")));
    };
    if (isRefObj(v)) {
      effect(() => write(resolveRef(v.$ref, state)));
    } else if (isTemplateString(v)) {
      effect(() => write(evaluateAttrTemplate(v, state)));
    } else {
      write(v);
    }
  }
}

// ─── Array mapping ────────────────────────────────────────────────────────────

/**
 * Render a mapped array (repeater) wrapper-less: its item instances are inserted directly into
 * `parentEl`, in place, ahead of an anchor comment that marks the array's position among the
 * parent's other children. Re-renders reactively when `items` (or the filter/sort sources) change;
 * each generation's item renders live in their own detached effect scope so nested arrays and
 * template bindings are disposed — not leaked or double-fired — on the next change.
 *
 * `options._path` is the array node's own document path (`[…, "children", i]`, or `[…, "children"]`
 * for a legacy whole-children repeater); item instances render at `[…that…, "map", index]`.
 *
 * @param {HTMLElement} parentEl
 * @param {import("@jxsuite/schema/types").JxMappedArray} arrayDef
 * @param {JxScope} state
 * @param {JxRenderOptions} [options]
 */
function renderMappedArrayInto(
  parentEl: HTMLElement,
  arrayDef: JxMappedArray,
  state: JxScope,
  options?: JxRenderOptions,
) {
  const path = options?._path ?? [];
  const anchor = document.createComment("jx-array");
  parentEl.append(anchor);
  const { items: itemsSrc, map: mapDef, filter: filterRef, sort: sortRef } = arrayDef;

  effect(() => {
    let items: unknown = isRefObj(itemsSrc) ? resolveRef(itemsSrc.$ref, state) : itemsSrc;
    if (Array.isArray(items) && isRefObj(filterRef)) {
      const fn = resolveRef(filterRef.$ref, state);
      if (typeof fn === "function") {
        items = items.filter(fn as (v: unknown) => boolean);
      }
    }
    if (Array.isArray(items) && isRefObj(sortRef)) {
      const fn = resolveRef(sortRef.$ref, state);
      if (typeof fn === "function") {
        items = [...(items as unknown[])].toSorted(fn as (a: unknown, b: unknown) => number);
      }
    }
    if (!Array.isArray(items) || !mapDef) {
      return;
    }

    // Render this generation's items inside a detached scope; the cleanup (run before the next
    // Re-render and when the enclosing render scope stops) tears it down and removes its nodes.
    const scope = effectScope(true);
    const nodes: ChildNode[] = [];
    scope.run(() => {
      for (const [index, item] of (items as unknown[]).entries()) {
        const child = Object.create(state) as JxScope;
        child.$map = { index, item };
        child["$map/item"] = item;
        child["$map/index"] = index;
        const childOpts = options ? { ...options, _path: [...path, "map", index] } : undefined;
        const node = renderNode(mapDef, child, childOpts);
        anchor.before(node);
        nodes.push(node);
      }
    });
    onEffectCleanup(() => {
      scope.stop();
      for (const n of nodes) {
        n.remove();
      }
    });
  });
}

/**
 * An element's tag: a name, or the branch of a {@link JxTagExpression} the state selects.
 *
 * Every branch of the expression is itself a `TagName`, so this can only ever return something the
 * schema already held to the tag-name pattern — the property that lets the compiler enumerate the
 * candidates and lets `createElement` be called without a second thought here.
 *
 * @param {unknown} tagName The element's declared tag.
 * @param {JxScope} scope The state the discriminant reads.
 * @returns {string} A literal tag name; `"div"` when nothing is declared.
 */
export function resolveTagName(tagName: unknown, scope: JxScope): string {
  if (typeof tagName === "string") {
    return tagName;
  }
  if (!isTagExpression(tagName)) {
    return "div";
  }
  const expression = tagName.$expression;
  if (expression.operator === "?:") {
    // `evaluateOperand`, not `evaluateExpression`: the discriminant is an OPERAND — a pointer, a
    // Literal or a nested node — exactly as it is for a `$switch`, whose docstring names this.
    return evaluateOperand(expression.target, scope, null) ? expression.value : expression.initial;
  }
  const key = evaluateOperand(expression.target, scope, null);
  return expression.cases[String(key)] ?? expression.default;
}

// ─── $switch ──────────────────────────────────────────────────────────────────

/**
 * @param {JxElement} def
 * @param {JxScope} state
 * @param {JxRenderOptions} [options]
 * @returns {HTMLElement}
 */
function renderSwitch(def: JxElement, state: JxScope, options?: JxRenderOptions) {
  const path = options?._path ?? [];
  const container = document.createElement(resolveTagName(def.tagName, state));

  if (options?.onNodeCreated) {
    options.onNodeCreated(container, path, def, state);
  }

  applyProperties(container, def, state);
  applyStyle(container, def.style ?? {}, (state["$media"] as Record<string, string>) ?? {}, state);
  applyAttributes(container, def.attributes ?? {}, state);
  let generation = 0;

  effect(() => {
    /* `replaceChildren()` rather than `innerHTML = ""`: identical semantics, and it is not a
       Trusted Types injection sink — under `require-trusted-types-for 'script'` an innerHTML write
       needs a policy even when the string is empty. Four sinks that were never injecting anything
       is four fewer things a policy has to be permissive about. */
    container.replaceChildren();
    if (!isRefObj(def.$switch)) {
      return;
    }
    const key = resolveRef(def.$switch.$ref, state) as string;
    const caseDef = def.cases?.[key];
    if (!caseDef) {
      return;
    }

    if (isRefObj(caseDef)) {
      // External $ref — fetch and render asynchronously
      generation += 1;
      const gen = generation;
      const { href } = new URL(caseDef.$ref, location.href);
      resolve(href)
        .then(async (doc) => {
          if (gen !== generation) {
            return;
          }
          const childScope = await buildScope(doc, {}, href);
          if (gen !== generation) {
            return;
          }
          container.replaceChildren();
          const childOpts = options ? { ...options, _path: [...path, "cases", key] } : undefined;
          container.append(renderNode(doc, childScope, childOpts));
        })
        .catch((error: unknown) =>
          console.error("Jx $switch: failed to load external case", caseDef.$ref, error),
        );
      return;
    }

    const childOpts = options ? { ...options, _path: [...path, "cases", key] } : undefined;
    container.append(renderNode(caseDef, state, childOpts));
  });

  return container;
}

// ─── Prototype namespaces (Shape 5) ──────────────────────────────────────────

/**
 * Resolve a $prototype definition into a value for the reactive scope.
 *
 * Returns a ref() for async/persistent entries (Request, Storage, Cookie, IndexedDB), or a plain
 * value for simple entries (Set, Map, FormData, Blob).
 *
 * @param {JxPrototypeDef} def - State entry with $prototype
 * @param {JxScope} state - Reactive scope proxy
 * @param {string} key - Def key (for diagnostics)
 * @param {string} [base] - Base URL for resolving $src imports
 * @returns {Promise<unknown>}
 */
export async function resolvePrototype(
  def: JxPrototypeDef,
  state: JxScope,
  key: string,
  base?: string,
) {
  // ── External class via $src ─────────────────────────────────────────────────
  if (def.$src) {
    return resolveExternalPrototype(def, state, key, base);
  }

  switch (def.$prototype) {
    case "Request": {
      const s: Ref<unknown> = ref(null);
      const debounceMs = def.debounce ?? 0;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      if (!def.manual && !_autoRequestConfig.skip) {
        effect(() => {
          let url: string | undefined;
          if (isTemplateString(def.url)) {
            url = evaluateTemplate(def.url, state);
          } else {
            ({ url } = def);
          }
          if (!url || url === "undefined" || url.includes("undefined")) {
            return;
          }

          const controller = new AbortController();
          onEffectCleanup(() => {
            controller.abort();
            if (debounceTimer !== null) {
              clearTimeout(debounceTimer);
            }
          });

          const doFetch = () =>
            fetch(url, {
              method: def.method ?? "GET",
              signal: controller.signal,
              ...(def.headers && { headers: def.headers }),
              ...(def.body && {
                body: typeof def.body === "object" ? JSON.stringify(def.body) : def.body,
              }),
            })
              .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
              .then((d) => {
                s.value = d;
              })
              .catch((error: unknown) => {
                if (!(error instanceof Error && error.name === "AbortError")) {
                  s.value = { error: String(error) };
                }
              });

          if (debounceMs > 0) {
            debounceTimer = setTimeout(doFetch, debounceMs);
          } else {
            void doFetch();
          }
        });
      }

      return s;
    }

    case "URLSearchParams": {
      return computed(() => {
        const p: Record<string, string> = {};
        for (const [k, v] of Object.entries(def)) {
          if (k !== "$prototype") {
            p[k] = (
              isRefObj(v)
                ? resolveRef(v.$ref, state)
                : isTemplateString(v)
                  ? evaluateTemplate(v, state)
                  : v
            ) as string;
          }
        }
        return new URLSearchParams(p).toString();
      });
    }

    case "LocalStorage":
    case "SessionStorage": {
      const store = def.$prototype === "LocalStorage" ? localStorage : sessionStorage;
      const k = def.key ?? key;
      let init: unknown;
      try {
        const s = store.getItem(k);
        init = s !== null ? (JSON.parse(s) as unknown) : (def.default ?? null);
      } catch {
        init = def.default ?? null;
      }
      const storageState: Ref<unknown> = ref(init);
      // Persist on change
      effect(() => {
        const v = storageState.value;
        if (v === null) {
          try {
            store.removeItem(k);
          } catch {}
        } else {
          try {
            store.setItem(k, JSON.stringify(v));
          } catch {}
        }
      });
      return storageState;
    }

    case "Cookie": {
      const name = def.name ?? key;
      const read = () => {
        const raw = readCookie(document.cookie, name);
        if (raw === null) {
          return null;
        }
        try {
          return JSON.parse(decodeURIComponent(raw));
        } catch {
          return raw;
        }
      };
      const cookieState: Ref<unknown> = ref(read() ?? def.default ?? null);
      // Persist on change
      effect(() => {
        // oxlint-disable-next-line unicorn/no-document-cookie -- the Cookie $prototype IS the cookie store binding
        document.cookie = serializeCookie(name, cookieState.value, def);
      });
      return cookieState;
    }

    case "IndexedDB": {
      const idbState: Ref<unknown> = ref(null);
      const {
        database,
        store,
        version = 1,
        keyPath = "id",
        autoIncrement = true,
        indexes = [],
      } = def;
      if (!database || !store) {
        throw new Error(`Jx: IndexedDB entry '${key}' requires database and store`);
      }
      const req = indexedDB.open(database, version);
      req.addEventListener("upgradeneeded", (e) => {
        const db: IDBDatabase = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(store)) {
          const os = db.createObjectStore(store, { autoIncrement, keyPath });
          for (const i of indexes) {
            os.createIndex(i.name, i.keyPath, { unique: i.unique ?? false });
          }
        }
      });
      req.addEventListener("success", (e) => {
        const db: IDBDatabase = (e.target as IDBOpenDBRequest).result;
        idbState.value = {
          database,
          getStore: (mode: IDBTransactionMode = "readwrite") =>
            Promise.resolve(db.transaction(store, mode).objectStore(store)),
          isReady: true,
          store,
          version,
        };
      });
      req.addEventListener("error", () => {
        idbState.value = { error: req.error?.message };
      });
      return idbState;
    }

    case "Set": {
      return new Set(Array.isArray(def.default) ? def.default : []);
    }

    case "Map": {
      return new Map(Object.entries(isJsonObject(def.default) ? def.default : {}));
    }

    case "FormData": {
      const fd = new FormData();
      for (const [k, v] of Object.entries(def.fields ?? {})) {
        fd.append(k, v as string);
      }
      return fd;
    }

    case "Blob": {
      return new Blob((def.parts as BlobPart[]) ?? [], {
        type: typeof def.type === "string" ? def.type : "text/plain",
      });
    }

    case "ReadableStream": {
      return null;
    }

    default: {
      console.warn(
        `Jx: unknown $prototype "${def.$prototype}" for "${key}". Did you mean to add '$src'?`,
      );
      return ref(null);
    }
  }
}

// ─── External class resolution ────────────────────────────────────────────────

/** Reserved keys stripped from the config object passed to external class constructors. */
const EXTERNAL_RESERVED = new Set([
  "$prototype",
  "$src",
  "$export",
  "timing",
  "default",
  "description",
  "body",
  "parameters",
  "arguments",
  "name",
]);

/**
 * Resolve an external class prototype via $src.
 *
 * @param {JxPrototypeDef} def
 * @param {JxScope} state
 * @param {string} key
 * @param {string} [base]
 * @returns {Promise<unknown>}
 */
async function resolveExternalPrototype(
  def: JxPrototypeDef,
  state: JxScope,
  key: string,
  base?: string,
) {
  const src = def.$src;

  // Non-Function $prototype must use .class.json as entrypoint
  if (!src || !src.endsWith(".class.json")) {
    throw new Error(
      `Jx: $prototype "${def.$prototype}" requires a .class.json $src, got "${src}". ` +
        `Wrap the class in a .class.json schema with $implementation.`,
    );
  }

  return resolveClassJson(def, state, key, base);
}

/**
 * Import a JS module and instantiate a class from it. Internal helper used by resolveClassJson for
 * $implementation.
 *
 * @param {JxScope} def - Original state entry (for config extraction)
 * @param {string} src - JS module URL to import
 * @param {string} exportName - Export name to look up
 * @param {string} [base] - Base URL for resolution
 * @returns {Promise<unknown>}
 */
async function importAndInstantiate(def: JxScope, src: string, exportName: string, base?: string) {
  let mod: ImportedModule;
  if (_moduleCache.has(src)) {
    mod = _moduleCache.get(src)!;
  } else {
    try {
      mod = (await import(src)) as ImportedModule;
    } catch {
      if (base) {
        const resolvedSrc = new URL(src, base).href;
        mod = (await import(resolvedSrc)) as ImportedModule;
      } else {
        throw new Error(`Failed to import "${src}"`);
      }
    }
    _moduleCache.set(src, mod);
  }

  const ExportedClass = mod[exportName] ?? mod.default?.[exportName];
  if (!ExportedClass) {
    throw new Error(`Jx: export "${exportName}" not found in "${src}"`);
  }
  if (typeof ExportedClass !== "function") {
    throw new TypeError(`Jx: "${exportName}" from "${src}" is not a class`);
  }

  const config: JxScope = {};
  for (const [k, v] of Object.entries(def)) {
    if (!EXTERNAL_RESERVED.has(k)) {
      config[k] = v;
    }
  }

  const Ctor = ExportedClass as new (config: JxScope) => ExternalClassInstance;
  const instance = new Ctor(config);

  let value: unknown;
  if (typeof instance.resolve === "function") {
    value = await instance.resolve();
  } else if ("value" in instance) {
    ({ value } = instance);
  } else {
    value = instance;
  }

  // Always wrap in ref for reactivity with external classes
  const s: Ref<unknown> = ref(value);
  if (typeof instance.subscribe === "function") {
    instance.subscribe((newVal: unknown) => {
      s.value = newVal;
    });
  }
  return s;
}

/**
 * Resolve a .class.json schema-defined class. Fetches the schema, follows $implementation if
 * hybrid, or constructs dynamically if self-contained.
 *
 * @param {JxPrototypeDef} def
 * @param {JxScope} state
 * @param {string} key
 * @param {string} [base]
 * @returns {Promise<unknown>}
 */
async function resolveClassJson(def: JxPrototypeDef, state: JxScope, key: string, base?: string) {
  const src = def.$src;
  if (!src) {
    throw new Error(`Jx: class entry '${key}' has no $src`);
  }
  let classDef: JxClassDef;

  // Bare specifiers (package references like @scope/pkg/file) can't be fetched directly —
  // Go straight to dev proxy which can resolve them via node_modules.
  const isBareSpecifier =
    !src.startsWith(".") &&
    !src.startsWith("/") &&
    !src.startsWith("http") &&
    !src.startsWith("file:");
  if (isBareSpecifier) {
    return resolveViaDevProxy(def, state, key, base);
  }

  // Try fetching the .class.json file directly
  try {
    const url = base ? new URL(src, base).href : src;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    // Trust boundary: fetched .class.json sources are class definitions by contract.
    classDef = (await res.json()) as JxClassDef;
  } catch {
    // Fall back to dev proxy (server will handle .class.json resolution)
    return resolveViaDevProxy(def, state, key, base);
  }

  // Hybrid mode: $implementation points to the real JS module
  if (classDef.$implementation) {
    // If the schema references $context (e.g. content types), the browser cannot provide
    // The required server-side context — go directly to dev proxy.
    const schemaStr = JSON.stringify(classDef);
    if (schemaStr.includes('"#/$context/')) {
      return resolveViaDevProxy(def, state, key, base);
    }
    const schemaUrl = base ? new URL(src, base).href : new URL(src, location.href).href;
    const implSrc = new URL(classDef.$implementation, schemaUrl).href;
    const exportName = def.$export ?? classDef.title ?? def.$prototype;
    try {
      return await importAndInstantiate(def, implSrc, exportName, base);
    } catch {
      return resolveViaDevProxy(def, state, key, base);
    }
  }

  // Self-contained: construct class dynamically from schema
  const DynClass = classFromSchema(classDef);
  const config: JxScope = {};
  for (const [k, v] of Object.entries(def)) {
    if (!EXTERNAL_RESERVED.has(k)) {
      config[k] = v;
    }
  }
  const instance = new DynClass(config) as ExternalClassInstance;

  let value: unknown;
  if (typeof instance.resolve === "function") {
    value = await instance.resolve();
  } else if ("value" in instance) {
    ({ value } = instance);
  } else {
    value = instance;
  }

  // Always wrap in ref for reactivity
  const s: Ref<unknown> = ref(value);
  if (typeof instance.subscribe === "function") {
    instance.subscribe((newVal: unknown) => {
      s.value = newVal;
    });
  }
  return s;
}

/**
 * Dynamically construct a class from a .class.json schema definition. Browser-side: maps private
 * fields to _-prefixed public fields.
 *
 * @param {import("@jxsuite/schema/types").JxClassDef} classDef
 * @returns {DynamicClass}
 */
function classFromSchema(classDef: JxClassDef) {
  const fields = classDef.$defs?.fields ?? {};
  // JSON objects inherit Object.prototype.constructor — only an own object value counts.
  const rawCtor = classDef.$defs?.constructor;
  const ctor = typeof rawCtor === "object" ? rawCtor : undefined;
  const methods = classDef.$defs?.methods ?? {};

  // oxlint-disable-next-line typescript/no-extraneous-class -- methods are attached to the prototype dynamically below
  class DynClass {
    constructor(config: Record<string, unknown> = {}) {
      for (const [key, typedField] of Object.entries(fields)) {
        const id = typedField.identifier ?? key;
        const propName = typedField.access === "private" ? `_${id}` : id;
        if (config[id] !== undefined) {
          (this as Record<string, unknown>)[propName] = config[id];
        } else if (typedField.initializer !== undefined) {
          (this as Record<string, unknown>)[propName] = typedField.initializer;
        } else if (typedField.default !== undefined) {
          (this as Record<string, unknown>)[propName] = structuredClone(typedField.default);
        } else {
          (this as Record<string, unknown>)[propName] = null;
        }
      }
      if (ctor?.body) {
        const bodyStr = Array.isArray(ctor.body) ? ctor.body.join("\n") : ctor.body;
        (
          new Function("config", bodyStr) as (
            this: unknown,
            config: Record<string, unknown>,
          ) => void
        ).call(this, config);
      }
    }
  }

  for (const [key, typedMethod] of Object.entries(methods)) {
    const name = typedMethod.identifier ?? key;
    const params = (typedMethod.parameters ?? []).map((p) => {
      if (p.$ref) {
        return p.$ref.split("/").pop() as string;
      }
      const n = p.identifier ?? p.name;
      return typeof n === "string" ? n : "arg";
    });
    const bodyStr = Array.isArray(typedMethod.body)
      ? typedMethod.body.join("\n")
      : (typedMethod.body ?? "");

    if (typedMethod.role === "accessor") {
      const descriptor: PropertyDescriptor = {};
      if (typedMethod.getter) {
        descriptor.get = new Function(typedMethod.getter.body ?? "") as () => unknown;
      }
      if (typedMethod.setter) {
        const sp = (typedMethod.setter.parameters ?? []).map(
          (p) => p.$ref?.split("/").pop() ?? "v",
        );
        descriptor.set = new Function(...sp, typedMethod.setter.body ?? "") as (v: unknown) => void;
      }
      Object.defineProperty(DynClass.prototype, name, {
        ...descriptor,
        configurable: true,
      });
    } else if (typedMethod.scope === "static") {
      (DynClass as unknown as DynamicClass)[name] = new Function(...params, bodyStr);
    } else {
      (DynClass as unknown as DynamicClass).prototype[name] = new Function(...params, bodyStr);
    }
  }

  Object.defineProperty(DynClass, "name", {
    configurable: true,
    value: classDef.title,
  });
  const dynCtor = DynClass as unknown as DynamicClass;
  return dynCtor;
}

/**
 * Dev-mode fallback: when an $src module cannot run in the browser, proxy the resolve() call
 * through the Jx dev server (POST /**jx_resolve**). Supports reactive template strings in config
 * values via Vue effect().
 *
 * @param {JxPrototypeDef} def
 * @param {JxScope} state
 * @param {string} key
 * @param {string} [base]
 * @returns {Promise<unknown>}
 */
async function resolveViaDevProxy(def: JxPrototypeDef, state: JxScope, key: string, base?: string) {
  const config: JxScope = {};
  for (const [k, v] of Object.entries(def)) {
    if (!EXTERNAL_RESERVED.has(k)) {
      config[k] = v;
    }
  }

  const hasTemplates = Object.values(config).some((v: unknown) => isTemplateString(v));

  /** @param {JxScope} resolvedConfig */
  const doResolve = (resolvedConfig: JxScope) =>
    fetch(resolveProxyPath("/__jx_resolve__"), {
      body: JSON.stringify({
        $base: base,
        $export: def.$export,
        $prototype: def.$prototype,
        $src: def.$src,
        ...resolvedConfig,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).then((r) => {
      if (!r.ok) {
        throw new Error(`Jx dev proxy ${r.status} for "${key}"`);
      }
      return r.json();
    });

  // Always wrap in ref for reactivity
  const s: Ref<unknown> = ref(null);
  if (hasTemplates) {
    effect(() => {
      const resolvedConfig: JxScope = {};
      for (const [k, v] of Object.entries(config)) {
        resolvedConfig[k] = isTemplateString(v) ? evaluateTemplate(v, state) : v;
      }
      doResolve(resolvedConfig)
        .then((value: unknown) => {
          s.value = value;
        })
        .catch((error: unknown) => console.error("Jx dev proxy:", error));
    });
  } else {
    doResolve(config)
      .then((value: unknown) => {
        s.value = value;
      })
      .catch((error: unknown) => console.error("Jx dev proxy:", error));
  }
  return s;
}

// ─── Server function resolution (dev mode) ────────────────────────────────────

/**
 * Resolve a timing: "server" entry in dev mode by executing the function client-side. In
 * production, the compiler replaces this with a fetch to the generated server handler.
 *
 * @param {JxScope} def
 * @param {JxScope} state
 * @param {string} key
 * @param {string} [base]
 * @returns {Promise<unknown>}
 */
async function resolveServerFunction(
  def: JxServerFnDef,
  state: JxScope,
  key: string,
  base?: string,
) {
  const src = def.$src;
  const exportName = def.$export;

  let mod: ImportedModule;
  if (_moduleCache.has(src)) {
    mod = _moduleCache.get(src)!;
  } else {
    try {
      mod = (await import(src)) as ImportedModule;
    } catch {
      if (base) {
        try {
          const resolvedSrc = new URL(src, base).href;
          mod = (await import(resolvedSrc)) as ImportedModule;
        } catch {
          // Module cannot run in the browser — fall back to dev server proxy
          return resolveServerFunctionViaProxy(def, state, key, base);
        }
      } else {
        return resolveServerFunctionViaProxy(def, state, key, base);
      }
    }
    _moduleCache.set(src, mod);
  }

  const candidate = mod[exportName] ?? mod.default?.[exportName];
  if (!candidate) {
    throw new Error(`Jx: export "${exportName}" not found in "${src}" for "${key}"`);
  }
  if (typeof candidate !== "function") {
    throw new TypeError(`Jx: "${exportName}" from "${src}" is not a function`);
  }
  const fn = candidate as (args: JxScope) => Promise<unknown>;

  const rawArgs = def.arguments ?? {};
  const hasReactiveArg = Object.values(rawArgs).some((v: unknown) => isRefObj(v));
  const resolveArgs = () => {
    const args: JxScope = {};
    for (const [k, v] of Object.entries(rawArgs)) {
      args[k] = isRefObj(v) ? resolveRef(v.$ref, state) : v;
    }
    return args;
  };

  // Always wrap in ref for reactivity
  const s: Ref<unknown> = ref(null);
  if (hasReactiveArg) {
    effect(() => {
      const args = resolveArgs();
      onEffectCleanup(() => {});
      fn(args)
        .then((result: unknown) => {
          s.value = result;
        })
        .catch(() => {});
    });
  } else {
    s.value = await fn(resolveArgs());
  }
  return s;
}

/**
 * Dev-mode fallback: when a timing: "server" module cannot run in the browser, proxy the function
 * call through the Jx dev server (POST /**jx_server**). Supports reactive $ref arguments via Vue
 * effect().
 *
 * @param {JxScope} def
 * @param {JxScope} state
 * @param {string} key
 * @param {string} [base]
 * @returns {Promise<unknown>}
 */
async function resolveServerFunctionViaProxy(
  def: JxScope,
  state: JxScope,
  key: string,
  base?: string,
) {
  const rawArgs = def.arguments ?? {};
  const hasReactiveArg = Object.values(rawArgs).some((v: unknown) => isRefObj(v));

  const resolveArgs = () => {
    const args: JxScope = {};
    for (const [k, v] of Object.entries(rawArgs)) {
      args[k] = isRefObj(v) ? resolveRef((v as { $ref: string }).$ref, state) : v;
    }
    return args;
  };

  /** @param {JxScope} args */
  const doResolve = (args: JxScope) =>
    fetch(resolveProxyPath("/__jx_server__"), {
      body: JSON.stringify({
        $base: base,
        $export: def.$export,
        $src: def.$src,
        arguments: args,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).then((r) => {
      if (!r.ok) {
        throw new Error(`Jx server proxy ${r.status} for "${key}"`);
      }
      return r.json();
    });

  // Always wrap in ref for reactivity
  const s: Ref<unknown> = ref(null);
  if (hasReactiveArg) {
    effect(() => {
      const args = resolveArgs();
      onEffectCleanup(() => {});
      doResolve(args)
        .then((result: unknown) => {
          s.value = result;
        })
        .catch((error: unknown) => console.error("Jx server proxy:", error));
    });
  } else {
    doResolve(resolveArgs())
      .then((result: unknown) => {
        s.value = result;
      })
      .catch((error: unknown) => console.error("Jx server proxy:", error));
  }
  return s;
}

/**
 * Resolve a $ref string to a value in scope.
 *
 * With Vue reactivity, this reads directly from the reactive proxy. When called inside a effect or
 * computed, the read is tracked.
 *
 * @param {string} ref
 * @param {JxScope} state - Reactive scope proxy (or child scope)
 * @returns {unknown}
 */
export function resolveRef(refPath: string, state: JxScope) {
  if (typeof refPath !== "string") {
    return refPath;
  }
  if (refPath.startsWith("$map/")) {
    const parts = refPath.split("/");
    const [, key] = parts; // "item" or "index"
    const map = state.$map as Record<string, unknown> | undefined;
    const base = map?.[key!] ?? state[`$map/${key}`];
    return parts.length > 2 ? getPath(base, parts.slice(2).join("/")) : base;
  }
  if (refPath.startsWith("#/state/")) {
    // One call, not a hand-split leading token: slicing at the first `/` skipped unescaping it, so
    // `#/state/a~1b/c` looked for a member called `a~1b` rather than `a/b`.
    return readPath(state, refPath.slice("#/state/".length));
  }
  if (refPath.startsWith("parent#/")) {
    /*
     * A prop name may be a path into the prop. This read the whole path as one key and returned
     * undefined for `parent#/user/name`, while the compiler lowered it to a walk.
     */
    return readPath(state, refPath.slice("parent#/".length));
  }
  if (refPath.startsWith("window#/")) {
    return getPath(globalThis.window, refPath.slice("window#/".length));
  }
  if (refPath.startsWith("document#/")) {
    return getPath(globalThis.document, refPath.slice("document#/".length));
  }
  return readPath(state, refPath) ?? null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Check if v is a Vue ref (including computed).
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isSignal(v: unknown) {
  return isRef(v);
}

/**
 * @param {unknown} v
 * @returns {v is import("@jxsuite/schema/types").JxRef}
 */
function isRefObj(v: unknown): v is JxRef {
  return isRefValue(v);
}

/**
 * @param {string} k
 * @returns {boolean}
 */
function isNestedSelector(k: string) {
  return k.startsWith(":") || k.startsWith(".") || k.startsWith("&") || k.startsWith("[");
}

/**
 * Walk a path off a value. Delegates to the one tokenizer (`pointer.ts`) — this used to split on
 * `/[./]/`, which no other path in the codebase agreed with.
 *
 * @param {unknown} obj
 * @param {string} path
 * @returns {unknown}
 */
function getPath(obj: unknown, path: string) {
  return readPath(obj, path);
}

/** Keys already reported, so a component rendered in a loop warns once rather than per instance. */
const _privatePropWarned = new Set<string>();

/**
 * Refuse a `$props` write against a private (`#`) state key — `spec.md` §5.6.
 *
 * Ignored rather than thrown. A `$props` block naming a private entry is an authoring mistake, not
 * a broken document: the rest of the instance is well-formed and refusing to render it would turn a
 * typo into a blank page. But silence was the previous behavior and it is the wrong kind — the
 * author sees a prop that looks accepted and does nothing — so the write is dropped and named.
 *
 * @param {string} key
 * @param {string} [where] - The site refusing it, for a message that points somewhere
 * @returns {boolean} True when the key is private and the caller must skip it
 */
/**
 * Whether the instance genuinely CARRIES `key`, rather than the prototype merely having an accessor
 * for it.
 *
 * `key in el` cannot tell those apart, and for a REFLECTED DOM property — `title`, `role`, `id`,
 * `lang`, `dir`, `slot`, `hidden` — the accessor answers `""` when nothing is set. `"" !==
 * undefined`, so a component declaring `state.title` never rendered its own default: the empty
 * string won. `quote` next to it kept its default, which is what made the bug look like bad
 * content.
 *
 * The test is NOT `Object.hasOwn` alone, and that distinction is the whole subtlety. Assigning a
 * reflected name goes through the prototype accessor and creates no own property, so a legitimate
 * `$props.title` would be discarded by an own-property test — silently, for every component that
 * declares one. What the accessor DOES do is write the attribute, so the attribute is the evidence
 * that somebody set it, whether that was `$props` before connection or the author in the document.
 *
 * @param {HTMLElement} el - The instance being connected.
 * @param {string} key - A state key declared by the component definition.
 * @returns {boolean}
 */
function instanceSupplies(el: HTMLElement, key: string): boolean {
  if (Object.hasOwn(el, key)) {
    return true;
  }
  if (el.hasAttribute(key)) {
    return true;
  }
  // ARIA-style reflections carry a kebab attribute for a camelCase property (`ariaLabel` →
  // `aria-label`), so the direct name lookup above would miss a value that really was set.
  const kebab = key.replaceAll(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`);
  return kebab !== key && el.hasAttribute(kebab);
}

function refusePrivateProp(key: string, where?: string): boolean {
  if (!isPrivateStateKey(key)) {
    return false;
  }
  const seen = where === undefined ? key : `${where}:${key}`;
  if (!_privatePropWarned.has(seen)) {
    _privatePropWarned.add(seen);
    console.warn(
      `Jx: "${key}" is private state (spec.md §5.6) and cannot be set through $props` +
        `${where === undefined ? "" : ` (${where})`}. The write was ignored; rename the entry ` +
        "without the leading # to make it part of the component's interface.",
    );
  }
  return true;
}

/** Tests only — the warn-once set outlives a single render by design. */
export function _resetPrivatePropWarnings(): void {
  _privatePropWarned.clear();
}

/**
 * @param {JxElement} def
 * @param {JxScope} parentState
 * @returns {JxScope}
 */
function mergeProps(def: JxElement, parentState: JxScope): JxScope {
  const child = Object.create(parentState) as JxScope;
  for (const [k, v] of Object.entries(def.$props ?? {})) {
    if (refusePrivateProp(k, "$props")) {
      continue;
    }
    child[k] = isRefObj(v) ? resolveRef(v.$ref, parentState) : v;
  }
  return child;
}

/*
 * The CSS-authoring rules live in `./css.ts`, which imports nothing at all. They are re-exported
 * here because they always were part of this module's surface and moving them must not break a
 * consumer; a host that cannot afford the DOM runtime imports `@jxsuite/runtime/css` instead.
 */
export {
  camelToKebab,
  COLOR_SCHEME_ATTR,
  COLOR_SCHEME_STORAGE_KEY,
  isDeclarationAtRule,
  pureSchemeOf,
  resolveAtQuery,
  resolveNestedSelector,
  schemeSelectors,
  transposeCanvasPopoverSelector,
} from "./css.ts";

/**
 * Convert a style rules object to a CSS text string (skipping nested selectors).
 *
 * @param {Record<string, unknown> | object} rules
 * @returns {string}
 */
export function toCSSText(rules: Record<string, unknown> | object) {
  return Object.entries(rules)
    .filter(([k, v]) => !isNestedSelector(k) && (v === null || typeof v !== "object"))
    .map(([p, v]) => `${camelToKebab(p)}: ${canvasStyleValue(String(v))}`)
    .join("; ");
}

// ─── Custom Element Registration ──────────────────────────────────────────────

let _rootMedia: Record<string, string> = {};
const _elementDefs = new Map();

/**
 * Seed the module-level root `$media` map used as the fallback for components that declare their
 * own `@--name` style blocks but carry no own `$media` (buildScope ~279-280). `Jx()` sets this from
 * the document during a full top-level render, but the Studio iframe canvas calls `buildScope`/
 * `renderNode` directly (never `Jx()`), so without seeding it a component's `@--md` would resolve
 * to the invalid `@media md`. Callers on the direct path MUST set it (with the merged `$media`)
 * before `buildScope`, and re-set it every render so a stale map from a previous document cannot
 * leak.
 *
 * @param {Record<string, string>} map
 */
export function setRootMedia(map: Record<string, string>): void {
  _rootMedia = map ?? {};
}

/**
 * Resolve and register $elements entries (depth-first).
 *
 * @param {JxDocument["$elements"]} elements
 * @param {string} base
 * @returns {Promise<void>}
 */
async function registerElements(elements: NonNullable<JxDocument["$elements"]>, base: string) {
  for (const entry of elements) {
    // Bare string: npm package side-effect import (registers custom elements)
    if (typeof entry === "string") {
      try {
        // Bare specifiers need a URL path for the browser; the dev server resolves
        // /node_modules/<pkg> to the package entry point via exports/module/main.
        const specifier =
          entry.startsWith("/") || entry.startsWith(".") ? entry : `/node_modules/${entry}`;
        await import(specifier);
      } catch (error) {
        console.warn(`Jx: failed to import package "${entry}"`, error);
      }
      continue;
    }
    if (!isRefObj(entry)) {
      continue;
    }
    const { href } = new URL(entry.$ref, base);
    const doc = await resolve(href);
    if (!doc.tagName || !doc.tagName.includes("-")) {
      continue;
    }
    if (customElements.get(doc.tagName)) {
      continue;
    }

    // Depth-first: register sub-dependencies first
    if (doc.$elements) {
      await registerElements(doc.$elements, href);
    }

    await defineElement(doc, href);
  }
}

/**
 * Inject head elements from $head declarations. Each entry is { tagName, attributes } — bare npm
 * specifiers in href/src are rewritten to /node_modules/ paths for the dev server.
 *
 * @param {import("@jxsuite/schema/types").JxHeadEntry[]} entries
 * @param {string} _base - Document base URL for resolving relative paths
 */
function injectHead(entries: JxHeadEntry[], _base: string) {
  for (const entry of entries) {
    if (!entry || !entry.tagName) {
      continue;
    }
    const tag = entry.tagName.toLowerCase();
    const attrs = { ...entry.attributes };
    // Resolve href/src: bare npm specifiers -> /node_modules/ path
    for (const key of ["href", "src"] as const) {
      const v = attrs[key];
      if (typeof v !== "string" || v === "") {
        continue;
      }
      if (!v.startsWith("/") && !v.startsWith(".") && !v.startsWith("http")) {
        /* The bare-specifier lane owns `/node_modules/<pkg>`, which is the HOST's URL space and
           not the project's. A canvas resolver must never claim it: the file is not in the
           repository, so there is nothing for it to resolve to. */
        attrs[key] = `/node_modules/${v}`;
        continue;
      }
      attrs[key] = canvasAssetValue(tag.toUpperCase(), key, v);
    }

    // Deduplicate: skip if an identical element already exists
    const selector = `${tag}${attrs.href ? `[href="${attrs.href}"]` : ""}${attrs.src ? `[src="${attrs.src}"]` : ""}`;
    if (selector !== tag && document.head.querySelector(selector)) {
      continue;
    }

    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
    if (entry.textContent) {
      // An object is a structured data block (JSON-LD, site-architecture.md §8.5). The compiler
      // Serializes it the same way, so the interpreted page and the built page agree.
      el.textContent =
        typeof entry.textContent === "object"
          ? JSON.stringify(entry.textContent, null, 2)
          : entry.textContent;
    }
    document.head.append(el);
  }
}

/**
 * Register a custom element from a Jx document.
 *
 * @param {string | JxDocument} source - URL to .json file, or raw document object
 * @param {string} [base] - Base URL for resolving $src imports
 * @returns {Promise<void>}
 */
const _definedSources = new Set<string>();

export async function defineElement(source: string | JxDocument, baseUrl?: string) {
  let base = baseUrl;
  let doc = source;
  if (typeof source === "string") {
    base = new URL(source, base ?? location.href).href;
    if (_definedSources.has(base)) {
      return;
    }
    _definedSources.add(base);
    doc = await resolve(source);
  }
  base ??= location.href;

  const source_: JxDocument = doc as JxDocument;

  const { tagName } = source_;
  if (!tagName || !tagName.includes("-")) {
    throw new Error(`Jx defineElement: tagName "${tagName}" must contain a hyphen`);
  }
  if (customElements.get(tagName)) {
    return;
  }

  // Register sub-dependencies first
  if (source_.$elements) {
    await registerElements(source_.$elements, base);
  }

  _elementDefs.set(tagName, { base, doc: source_ });

  const def = source_;
  const observedAttrs = def.observedAttributes ?? [];

  const ElementClass = class extends HTMLElement {
    _jxInitialized = false;
    _state: JxScope | null = null;

    static get observedAttributes() {
      return observedAttrs;
    }

    async connectedCallback() {
      // An element carrying `data-jx-definition-root` IS the definition being rendered by an
      // External renderer (the studio canvas editing this component's own document) — its subtree
      // Is authored DOM, not an instantiation site. Self-initializing here would wipe that tree
      // And re-render it with default state (the "component editor shows a live instance" bug).
      if (this.dataset.jxDefinitionRoot !== undefined) {
        return;
      }
      if (this._jxInitialized) {
        return;
      }
      this._jxInitialized = true;

      const state = await buildScope(def, {}, base);

      // Read properties from the data-jx-props payload the site build writes on a
      // Non-static instance, so an upgrade re-renders with the authored props, not the defaults.
      const propsAttr = this.dataset.jxProps;
      if (propsAttr) {
        try {
          const props = JSON.parse(propsAttr) as Record<string, unknown>;
          for (const [key, val] of Object.entries(props)) {
            if (refusePrivateProp(key, "data-jx-props")) {
              continue;
            }
            if (key in (def.state ?? {})) {
              state[key] = val;
            }
          }
        } catch {}
        delete this.dataset.jxProps;
      }

      // Read literal `props.*` attributes (JSON-authored instances pass props this way; the
      // Compiler lifts them into $props at build, and this is the live-render mirror). String
      // Values only — HTML lowercases attribute names, so state keys must be lowercase to match.
      // Collect first: removing while iterating the live NamedNodeMap skips entries.
      const propAttrNames = this.getAttributeNames().filter(
        (name) => name.startsWith("props.") && name.length > "props.".length,
      );
      for (const name of propAttrNames) {
        const key = name.slice("props.".length);
        if (refusePrivateProp(key, "props.* attribute")) {
          this.removeAttribute(name);
          continue;
        }
        if (key in (def.state ?? {})) {
          state[key] = this.getAttribute(name);
          this.removeAttribute(name);
        }
      }

      // Merge $props set as JS properties by parent before connection
      for (const key of Object.keys(def.state ?? {})) {
        if (isPrivateStateKey(key)) {
          continue;
        }
        if (
          key in this &&
          (this as Record<string, unknown>)[key] !== undefined &&
          instanceSupplies(this, key)
        ) {
          state[key] = (this as Record<string, unknown>)[key];
        }
      }
      /*
       * Set up property getters/setters that forward into reactive state. Private entries get NO
       * accessor: the property-first interface IS the props mechanism, so defining one would leave
       * `el["#cache"] = x` writing straight through everything above.
       */
      for (const key of Object.keys(def.state ?? {})) {
        if (isPrivateStateKey(key)) {
          continue;
        }
        if (!(key in HTMLElement.prototype)) {
          Object.defineProperty(this, key, {
            configurable: true,
            get: () => state[key],
            set: (v: unknown) => {
              state[key] = v;
            },
          });
        }
      }

      this._state = state;

      // Capture light DOM children (for slot distribution) before rendering
      const slottedChildren = [...this.childNodes];
      this.replaceChildren();

      // Custom elements default to display:inline — use block so they behave as
      // Containers (matching <div> semantics).  The component's own style can
      // Override this if needed.
      if (!this.style.display) {
        this.style.display = "block";
      }

      // Render template into light DOM (once, not in effect — inner effects handle reactivity)
      applyStyle(this, def.style ?? {}, (state["$media"] as Record<string, string>) ?? {}, state);
      applyAttributes(this, def.attributes ?? {}, state);

      /*
       * Root-level `textContent` is a definition's content just as much as `children` is — it is
       * the shape spec.md §17.2 recommends when every child would be a bare string — and it was
       * dropped here, so such a component rendered empty everywhere the interpreter runs.
       */
      if (!Array.isArray(def.children) && def.textContent !== undefined) {
        bindProperty(this, "textContent", def.textContent, state);
      }
      const children = Array.isArray(def.children) ? def.children : [];
      for (const childDef of children) {
        this.append(renderNode(childDef, state));
      }

      // Slot distribution (light DOM)
      distributeSlots(this, slottedChildren);

      // Lifecycle: onMount
      const { onMount } = state;
      if (typeof onMount === "function") {
        queueMicrotask(() => (onMount as (s: JxScope) => unknown)(state));
      }
    }

    disconnectedCallback() {
      if (typeof this._state?.onUnmount === "function") {
        (this._state.onUnmount as (s: JxScope) => unknown)(this._state);
      }
    }

    adoptedCallback() {
      if (typeof this._state?.onAdopted === "function") {
        (this._state.onAdopted as (s: JxScope) => unknown)(this._state);
      }
    }

    attributeChangedCallback(name: string, oldVal: string | null, newVal: string | null) {
      if (!this._state || oldVal === newVal) {
        return;
      }
      const camelKey = name.replaceAll(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
      const current = this._state[camelKey];
      if (typeof current === "number") {
        this._state[camelKey] = Number(newVal);
      } else if (typeof current === "boolean") {
        this._state[camelKey] = newVal !== null && newVal !== "false";
      } else {
        this._state[camelKey] = newVal;
      }
    }
  };

  customElements.define(tagName, ElementClass);
}

/**
 * Render a registered custom element with $props (property-first interface).
 *
 * @param {JxElement} def
 * @param {JxScope} state
 * @param {JxRenderOptions} [options]
 * @param {JxPath} [path]
 * @returns {HTMLElement}
 */
function renderCustomElementWithProps(
  def: JxElement,
  state: JxScope,
  options?: JxRenderOptions,
  path?: JxPath,
) {
  const el = document.createElement(resolveTagName(def.tagName, state));

  if (options?.onNodeCreated) {
    options.onNodeCreated(el, path ?? [], def, state);
  }

  // Set JS properties from $props (before connection)
  for (const [key, val] of Object.entries(def.$props ?? {})) {
    if (refusePrivateProp(key, "$props")) {
      continue;
    }
    /* The same resolution `bindProperty` gives an ordinary element. A `$props: { src }` on a custom
       element is an asset reference authored at the USAGE site, so it belongs to the document that
       wrote it — a media prop the component forwards into its own `<img>` is resolved separately,
       inside the component's render, against the same context. */
    const write = (resolved: unknown): void => {
      (el as unknown as Record<string, unknown>)[key] =
        typeof resolved === "string" ? canvasAssetValue(el.tagName, key, resolved) : resolved;
    };
    if (isRefObj(val)) {
      const refVal = val;
      write(resolveRef(refVal.$ref, state));
      // Reactive forwarding: re-set the property when the source changes
      effect(() => {
        write(resolveRef(refVal.$ref, state));
      });
    } else if (isTemplateString(val)) {
      effect(() => {
        write(evaluateTemplate(val, state));
      });
    } else {
      write(val);
    }
  }

  // Apply host-level style and attributes from the usage site
  applyStyle(el, def.style ?? {}, (state["$media"] as Record<string, string>) ?? {}, state);
  applyAttributes(el, def.attributes ?? {}, state);

  // Append slotted children
  const children = Array.isArray(def.children) ? def.children : [];
  for (let i = 0; i < children.length; i++) {
    const childOpts = options && path ? { ...options, _path: [...path, "children", i] } : undefined;
    el.append(renderNode(children[i]!, state, childOpts));
  }

  return el;
}

/**
 * Light DOM slot distribution.
 *
 * @param {HTMLElement} host
 * @param {ChildNode[]} slottedChildren
 */
function distributeSlots(host: HTMLElement, slottedChildren: ChildNode[]) {
  if (slottedChildren.length === 0) {
    return;
  }

  const slots = host.querySelectorAll("slot");
  if (slots.length === 0) {
    return;
  }

  const named = new Map<string | null, ChildNode[]>();
  const unnamed: ChildNode[] = [];

  for (const child of slottedChildren) {
    if (child.nodeType === Node.ELEMENT_NODE && (child as Element).getAttribute("slot")) {
      const name = (child as Element).getAttribute("slot");
      if (!named.has(name)) {
        named.set(name, []);
      }
      (named.get(name) as ChildNode[]).push(child);
    } else {
      unnamed.push(child);
    }
  }

  for (const slot of slots) {
    const name = slot.getAttribute("name");
    const matches = name ? (named.get(name) ?? []) : unnamed;
    if (matches.length > 0) {
      slot.replaceChildren();
      for (const child of matches) {
        slot.append(child);
      }
    }
  }
}
