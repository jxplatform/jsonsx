/// <reference lib="dom" />
/**
 * Dynamic route-param helpers for the tab-bar's $params picker.
 *
 * A page like `pages/products/[sku].json` declares its candidate values in a `$paths` block (spec
 * §4.3). At build time the compiler expands those into concrete routes (`resolvePathEntries` in
 * `@jxsuite/compiler`); in the studio the same shapes are resolved live so the author can pick one
 * value to render. The chosen values are substituted into the canvas render document
 * (`substitutePreviewParams`), which mirrors what the compiler's context injection produces for the
 * matching built page.
 */

import { documentUrlPattern as routePattern } from "@jxsuite/schema/routes";
import { getPlatform } from "./platform";
import { loadExtensions } from "./format/format-host";
import type { JxMutableNode, JxPathsDef } from "@jxsuite/schema/types";

/** Param name → candidate values, in `$paths` declaration order. */
export type ParamValues = Record<string, string[]>;

/**
 * Route derivation is `@jxsuite/schema/routes`, re-exported so this module stays the studio's one
 * import for everything `$params`.
 *
 * These two used to be written out here, under a docblock admitting they mirrored the compiler's
 * `fileToRoute`. A mirror is a copy that nothing checks, and a route is the worst place to keep
 * one: a disagreement is a page that renders on the canvas and 404s in a browser. The studio cannot
 * import `@jxsuite/compiler` (its graph carries `sharp` and `esbuild`, and this bundles for a
 * browser), so the rules moved down to the package both CAN import.
 */
export { documentUrlPattern, dynamicRouteParams } from "@jxsuite/schema/routes";

/**
 * The `$paths` declaration of an open document. JSON pages carry it on the document root;
 * format-class pages (markdown) keep it in the frontmatter.
 *
 * @param {{ document?: unknown; frontmatter?: Record<string, unknown> }} doc
 * @returns {JxPathsDef | null}
 */
export function pagePathsDef(doc: {
  document?: JxMutableNode | null;
  frontmatter?: Record<string, unknown> | null;
}) {
  const fromDoc = (doc.document as { $paths?: JxPathsDef } | null | undefined)?.$paths;
  const fromFrontmatter = doc.frontmatter?.$paths as JxPathsDef | undefined;
  return fromDoc ?? fromFrontmatter ?? null;
}

const valueCache = new Map<string, Promise<ParamValues>>();

/** Drop all cached enumerations (e.g. after content files change). */
export function invalidateParamValues() {
  valueCache.clear();
}

/**
 * Enumerate candidate values for each param declared by a `$paths` block. Results are cached per
 * (documentPath, $paths) pair; failures are not cached so a transient backend error retries on the
 * next call.
 *
 * @param {string | null | undefined} documentPath - Cache key component
 * @param {JxPathsDef | null} pathsDef
 * @returns {Promise<ParamValues>}
 */
export function loadParamValues(
  documentPath: string | null | undefined,
  pathsDef: JxPathsDef | null,
) {
  if (!pathsDef) {
    return Promise.resolve({} as ParamValues);
  }
  const key = `${documentPath ?? ""}::${JSON.stringify(pathsDef)}`;
  let pending = valueCache.get(key);
  if (!pending) {
    pending = resolveParamValues(pathsDef).catch((error: unknown) => {
      valueCache.delete(key);
      console.warn("page-params: failed to enumerate $paths values:", error);
      return {} as ParamValues;
    });
    valueCache.set(key, pending);
  }
  return pending;
}

/**
 * Resolve one `$paths` shape to values, mirroring the compiler's `resolvePathEntries`.
 *
 * @param {JxPathsDef} pathsDef
 * @returns {Promise<ParamValues>}
 */
async function resolveParamValues(pathsDef: JxPathsDef): Promise<ParamValues> {
  // Legacy: array of param objects — group values per param key
  if (Array.isArray(pathsDef)) {
    const out: ParamValues = {};
    for (const entry of pathsDef) {
      for (const [param, value] of Object.entries(entry)) {
        pushValue(out, param, value);
      }
    }
    return out;
  }

  // Content type-based: { contentType: "blog", param: "slug", field: "id" } — an open extension
  // Discriminator member on JxPathsDef, so narrow to string. Resolved through the backend's
  // ContentCollection pipeline (the same one the canvas's ContentEntry uses), so every offered
  // Value is guaranteed to resolve in preview.
  if (
    "contentType" in pathsDef &&
    typeof pathsDef.contentType === "string" &&
    pathsDef.contentType
  ) {
    const param = pathsDef.param ?? "slug";
    const field = pathsDef.field ?? "id";
    const entries = (await resolveContentCollection(pathsDef.contentType)) as {
      id?: unknown;
      data?: Record<string, unknown>;
    }[];
    const out: ParamValues = { [param]: [] };
    if (!Array.isArray(entries)) {
      return out;
    }
    for (const entry of entries) {
      pushValue(out, param, field === "id" ? entry.id : (entry.data?.[field] ?? entry.id));
    }
    return out;
  }

  // Explicit values: { values: ["en", "fr"], param: "lang" }
  if ("values" in pathsDef && Array.isArray(pathsDef.values)) {
    const param = pathsDef.param ?? "value";
    const out: ParamValues = { [param]: [] };
    for (const value of pathsDef.values) {
      pushValue(out, param, value);
    }
    return out;
  }

  // Data file ref: { "$ref": "./data/products.json", param: "id", field: "sku" } — `$ref` also
  // Reaches here as an open discriminator key, so narrow to a non-empty string.
  if ("$ref" in pathsDef && typeof pathsDef.$ref === "string" && pathsDef.$ref) {
    const param = pathsDef.param ?? "id";
    const field = pathsDef.field ?? "id";
    const content = await getPlatform().readFile(pathsDef.$ref.replace(/^\.\//, ""));
    const data = JSON.parse(content) as unknown;
    const out: ParamValues = { [param]: [] };
    if (!Array.isArray(data)) {
      return out;
    }
    for (const item of data as Record<string, unknown>[]) {
      pushValue(out, param, item?.[field] ?? item?.id ?? item);
    }
    return out;
  }

  return {};
}

/**
 * The `$src` of the ContentCollection class from the enabled extensions payload — whichever
 * extension's manifest declares a class named `ContentCollection` (its backend-resolved descriptor
 * path feeds `/__jx_resolve__` directly). Platforms without an extensions payload fall back to the
 * historical parser-package specifier.
 *
 * @returns {Promise<string>}
 */
async function contentCollectionSrc(): Promise<string> {
  const extensions = await loadExtensions();
  for (const ext of extensions) {
    const cls = ext.classes?.find((c) => c.name === "ContentCollection");
    if (cls) {
      return cls.path;
    }
  }
  return "@jxsuite/parser/ContentCollection.class.json";
}

/**
 * Resolve a ContentCollection for a content type via the PAL, falling back to a plain dev-proxy
 * fetch on platforms that predate `resolveClass`.
 *
 * @param {string} contentType
 * @returns {Promise<unknown>}
 */
async function resolveContentCollection(contentType: string) {
  const body = {
    $prototype: "ContentCollection",
    $src: await contentCollectionSrc(),
    contentType,
  };
  const platform = getPlatform();
  if (platform.resolveClass) {
    return platform.resolveClass(body);
  }
  return fetch("/__jx_resolve__", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((res) => {
    if (!res.ok) {
      throw new Error(`Class resolution failed: ${res.status}`);
    }
    return res.json() as Promise<unknown>;
  });
}

/**
 * @param {ParamValues} out
 * @param {string} param
 * @param {unknown} value
 */
function pushValue(out: ParamValues, param: string, value: unknown) {
  if (value === null || value === undefined || value === "") {
    return;
  }
  const str = String(value);
  out[param] ??= [];
  const list = out[param];
  if (!list.includes(str)) {
    list.push(str);
  }
}

/**
 * Substitute chosen param values into a canvas render document:
 *
 * - Every `{ "$ref": "#/$params/<name>" }` value with a chosen `<name>` becomes the literal string
 *   (the exact dereference `ContentEntry.resolve()` performs against `route._pathParams`), and
 * - `state.$page` is injected mirroring the compiler's `injectContext`, so `${state.$page.params.x}`
 *   template expressions render.
 *
 * Pure: returns a rebuilt tree. The design/edit render doc shares node references with the tab's
 * source document (stripEventHandlers/prepareForEditMode shallow-rebuild), so in-place mutation
 * here would corrupt the document being edited and saved.
 *
 * @param {JxMutableNode} renderDoc
 * @param {Record<string, string>} params
 * @param {string | null | undefined} documentPath
 * @returns {JxMutableNode}
 */
export function substitutePreviewParams(
  renderDoc: JxMutableNode,
  params: Record<string, string>,
  documentPath: string | null | undefined,
): JxMutableNode {
  if (Object.keys(params).length === 0) {
    return renderDoc;
  }
  const doc = substituteParamRefs(renderDoc, params) as JxMutableNode & {
    state?: Record<string, unknown>;
    title?: unknown;
  };
  doc.state ??= {};
  doc.state.$page = {
    params: { ...params },
    title: typeof doc.title === "string" ? doc.title : "",
    url: routePattern(documentPath),
  };
  return doc;
}

/**
 * State keys whose entries are class prototypes ($prototype + $src) referencing a route param.
 * These are the entries `substitutePreviewParams` rewrites, and the ones `resolveParamBoundState`
 * bakes.
 *
 * @param {Record<string, unknown> | null | undefined} state - The ORIGINAL document state (with
 *   `$ref`s intact — substitution removes the marker)
 * @returns {string[]}
 */
export function paramBoundStateKeys(state: Record<string, unknown> | null | undefined) {
  if (!state) {
    return [];
  }
  return Object.keys(state).filter((key) => {
    const entry = state[key] as Record<string, unknown> | null;
    return (
      entry &&
      typeof entry === "object" &&
      typeof entry.$prototype === "string" &&
      typeof entry.$src === "string" &&
      JSON.stringify(entry).includes('"#/$params/')
    );
  });
}

/**
 * Resolve substituted class-prototype state entries through the backend and bake the values into
 * `renderDoc.state` — compiler parity: the built site resolves ContentEntry/ContentCollection
 * BEFORE templates run. Without baking, the iframe runtime resolves these entries asynchronously
 * (null on the first render pass), so preview templates like `${state.product.data.title}`
 * dereference null and abort the whole render.
 *
 * Failures leave the entry in place (the runtime's own async resolution remains the fallback).
 *
 * @param {JxMutableNode} renderDoc - The substituted render doc (mutated in place — it is the fresh
 *   rebuild from substitutePreviewParams, never the source doc)
 * @param {string[]} keys - From paramBoundStateKeys(originalDoc.state)
 * @param {string | undefined} docBase - Document base URL for relative-$src rebasing
 */
export async function resolveParamBoundState(
  renderDoc: JxMutableNode,
  keys: string[],
  docBase?: string,
) {
  if (keys.length === 0) {
    return;
  }
  const platform = getPlatform();
  if (!platform.resolveClass) {
    return;
  }
  const { state } = renderDoc as { state?: Record<string, unknown> };
  if (!state) {
    return;
  }
  await Promise.all(
    keys.map(async (key) => {
      const entry = state[key];
      if (!entry || typeof entry !== "object") {
        return;
      }
      try {
        state[key] = await platform.resolveClass!({
          ...(entry as Record<string, unknown>),
          ...(docBase ? { $base: docBase } : {}),
        });
      } catch (error) {
        console.warn(`page-params: failed to resolve state.${key} for preview:`, error);
      }
    }),
  );
}

/**
 * @param {unknown} node
 * @param {Record<string, string>} params
 * @returns {unknown} — a rebuilt copy with matched param refs replaced by literals
 */
function substituteParamRefs(node: unknown, params: Record<string, string>): unknown {
  const replaced = paramRefValue(node, params);
  if (replaced !== null) {
    return replaced;
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => substituteParamRefs(item, params));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = substituteParamRefs(value, params);
  }
  return out;
}

/**
 * The chosen literal for a `{ "$ref": "#/$params/<name>" }` value, or null when the value is not a
 * param ref (or no value was chosen for it).
 *
 * @param {unknown} value
 * @param {Record<string, string>} params
 * @returns {string | null}
 */
function paramRefValue(value: unknown, params: Record<string, string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/$params/")) {
    return null;
  }
  return params[ref.slice("#/$params/".length)] ?? null;
}
