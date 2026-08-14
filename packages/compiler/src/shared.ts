/// <reference lib="dom" />
/**
 * Shared.js — Shared compiler utilities
 *
 * Detection, scope resolution, HTML building, CSS extraction, and naming utilities used across all
 * compilation targets (static, client, element, server).
 */

import {
  COLOR_SCHEME_ATTR,
  COLOR_SCHEME_STORAGE_KEY,
  RESERVED_KEYS,
  camelToKebab,
  pureSchemeOf,
  schemeSelectors,
  toCSSText,
} from "@jxsuite/runtime";
import { evaluateExpression, isMutating } from "@jxsuite/runtime/expression";
import { runStatements } from "@jxsuite/runtime/statements";
import {
  bodyReturnsValue,
  childrenContainArray,
  hasStructuredBody,
  isExpressionDef,
  isFunctionDef,
  isMappedArray,
  isNamedFormulaDef,
  isPrototypeDef,
  isRef,
  isSchemaOnlyDef as isSchemaOnly,
  isServerFnDef,
  isTagExpression,
  isTemplateString,
  paramNames,
  tagNameCandidates,
} from "@jxsuite/schema/guards";
import type { ExpressionNode } from "@jxsuite/runtime/expression";
import type {
  JsonValue,
  JxElement,
  JxMutableNode,
  JxPrototypeDef,
  JxRef,
  JxStateDefinition,
  JxStateObject,
  JxStyle,
} from "@jxsuite/schema/types";

// Re-export runtime utilities used by submodules
export {
  COLOR_SCHEME_ATTR,
  COLOR_SCHEME_STORAGE_KEY,
  RESERVED_KEYS,
  camelToKebab,
  pureSchemeOf,
  schemeSelectors,
  toCSSText,
} from "@jxsuite/runtime";
export {
  compileExpression,
  compileOperandSource,
  evaluateExpression,
  evaluateOperand,
  isMutating,
} from "@jxsuite/runtime/expression";
export { compileStatements, runStatements } from "@jxsuite/runtime/statements";

/**
 * Emit the JS source of a named formula's scope callable: positional arguments are mapped onto the
 * declared parameter names (honoring CemParameter defaults) as the `_args` object the compiled
 * body's `$args/` refs read from. Call sites stay positional, matching the interpreter.
 */
export function emitFormulaFn(def: { parameters?: unknown[] }, compiledBody: string): string {
  const entries: string[] = [];
  for (const [i, p] of (def.parameters ?? []).entries()) {
    const name = typeof p === "string" ? p : ((p as { name?: string } | null)?.name ?? "");
    if (!name) {
      continue;
    }
    const hasDefault = typeof p === "object" && p !== null && "default" in p;
    const arg = hasDefault
      ? `_a[${i}] === undefined ? ${JSON.stringify((p as { default?: unknown }).default)} : _a[${i}]`
      : `_a[${i}]`;
    entries.push(`${JSON.stringify(name)}: ${arg}`);
  }
  return `(..._a) => { const _args = { ${entries.join(", ")} }; return ${compiledBody}; }`;
}

/**
 * Emit the import-clause binding for one Function-def `$src` entry.
 *
 * `$export` names the export inside the module and defaults to the state key (spec.md §5.3 4d).
 * When the two differ the clause has to alias, because the local name the rest of the generated
 * module calls is the state key — importing the bare key instead requests an export the module does
 * not have, and the browser rejects the whole module at link time.
 *
 * Aliasing rather than renaming call sites is what makes the awkward cases work: two keys may alias
 * the same export, a key may collide with another entry's export name, and `$export: "default"` is
 * only reachable as `default as key`.
 *
 * @param {string} key - State key, and the local binding name
 * @param {unknown} def - The Function definition
 * @returns {string}
 */
export function srcImportBinding(key: string, def: unknown) {
  const declared = (def as { $export?: unknown } | null | undefined)?.$export;
  const exportName = typeof declared === "string" && declared !== "" ? declared : key;
  return exportName === key ? key : `${exportName} as ${key}`;
}

/**
 * Emit the auto-fetch `effect()` for a `$prototype: "Request"` state entry.
 *
 * Shared by the client and element targets so both honour `manual`, template URLs and
 * `method`/`headers`/`body` the same way. They diverged once: the element target emitted no fetch
 * at all, leaving every Request entry permanently `null` with nothing thrown.
 *
 * A template `url` is read inside the effect, so the fetch re-runs whenever the interpolated state
 * changes; an URL that still interpolates to `undefined` is skipped rather than fetched.
 *
 * @param {string} key - State key receiving the response
 * @param {JxPrototypeDef} def - The Request definition
 * @param {{ statePrefix?: string; indent?: string; collect?: string }} [opts] - `statePrefix` is
 *   the expression the emitted code assigns through (`state` for the client module scope,
 *   `this.state` inside a custom element); `indent` prefixes every emitted line; `collect`, when
 *   given, is an array expression the effect runner is pushed onto so the caller can `stop()` it on
 *   teardown.
 * @returns {string}
 */
export function emitRequestFetch(
  key: string,
  def: JxPrototypeDef,
  opts: { statePrefix?: string; indent?: string; collect?: string } = {},
) {
  const { statePrefix = "state", indent = "", collect } = opts;
  const { url } = def;
  const isTemplateUrl = isTemplateString(url);
  const method = def.method ?? "GET";

  if (def.manual) {
    return `${indent}// ${key}: manual Request — fetch triggered by user action`;
  }

  const lines: string[] = [
    `// ${key}: auto-fetch from ${isTemplateUrl ? "(dynamic URL)" : url}`,
    collect ? `${collect}.push(effect(() => {` : "effect(() => {",
  ];

  if (isTemplateUrl) {
    lines.push(
      `  const url = \`${withStatePrefix(url as string, statePrefix)}\`;`,
      '  if (!url || url === "undefined" || url.includes("undefined")) return;',
    );
  } else {
    lines.push(`  const url = ${JSON.stringify(url)};`);
  }

  const fetchOpts: string[] = [];
  if (method !== "GET") {
    fetchOpts.push(`method: ${JSON.stringify(method)}`);
  }
  if (def.headers) {
    fetchOpts.push(`headers: ${JSON.stringify(def.headers)}`);
  }
  if (def.body) {
    const bodyStr =
      typeof def.body === "object"
        ? JSON.stringify(JSON.stringify(def.body))
        : JSON.stringify(def.body);
    fetchOpts.push(`body: ${bodyStr}`);
  }

  const optsStr = fetchOpts.length > 0 ? `, { ${fetchOpts.join(", ")} }` : "";
  lines.push(
    `  fetch(url${optsStr})`,
    "    .then(r => r.ok ? r.json() : Promise.reject(r.statusText))",
    `    .then(d => { ${statePrefix}.${key} = d; })`,
    `    .catch(e => { ${statePrefix}.${key} = { error: String(e) }; });`,
    collect ? "}));" : "});",
  );

  return lines.map((line) => `${indent}${line}`).join("\n");
}

/**
 * Rebase the bare `state.` reads in a template string onto `statePrefix`.
 *
 * Only the `${…}` interpolation holes are rewritten. A blanket replace would corrupt the literal
 * text around them — `/api/state.json?q=${state.q}` would request `/api/this.state.json` — and the
 * `\b` guard keeps an identifier that merely ends in `state` (`substate.z`) intact. Reads already
 * carrying the prefix are left alone.
 *
 * @param {string} str
 * @param {string} statePrefix
 * @returns {string}
 */
function withStatePrefix(str: string, statePrefix: string) {
  if (statePrefix === "state") {
    return str;
  }
  return str.replaceAll(
    /\$\{([^}]*)\}/g,
    (_match: string, expr: string) =>
      `\${${expr.replaceAll(/(?<!this\.)\bstate\./g, `${statePrefix}.`)}}`,
  );
}
export type { ExpressionNode } from "@jxsuite/runtime/expression";

/**
 * Non-enumerable marker on a build-time scope listing the state keys that hold no build-time value.
 * Non-enumerable so it stays out of `Object.entries(scope)` and out of template evaluation.
 */
const RUNTIME_ONLY_KEYS = Symbol("jx.runtimeOnlyStateKeys");

// CDN defaults
export const DEFAULT_REACTIVITY_SRC = "https://esm.sh/@vue/reactivity@3.5.40";
export const DEFAULT_LIT_HTML_SRC = "https://esm.sh/lit-html@3.3.0";

// ─── Schema keywords & detection ─────────────────────────────────────────────
// Centralized in @jxsuite/schema/guards; re-exported here for existing callers.

export {
  SCHEMA_KEYWORDS,
  isSchemaOnlyDef as isSchemaOnly,
  isTemplateString,
} from "@jxsuite/schema/guards";

/**
 * Returns true if a $src path points to a .class.json schema-defined class.
 *
 * @param {unknown} src
 * @returns {boolean}
 */
export function isClassJsonSrc(src?: unknown): src is string {
  return typeof src === "string" && src.endsWith(".class.json");
}

/**
 * Determine whether a node (or any of its descendants) requires client-side JavaScript.
 *
 * @param {JxElement | JxMutableNode | string} def
 * @returns {boolean}
 */
export function isDynamic(def: JxElement | JxMutableNode | string) {
  if (!def || typeof def !== "object") {
    return false;
  }

  if (def.state) {
    for (const [k, d] of Object.entries(def.state)) {
      // Skip injected context (read-only, not reactive)
      if (k === "$site" || k === "$page") {
        continue;
      }
      // Skip timing: "compiler" entries — resolved at build time, baked into static HTML
      if (
        d &&
        typeof d === "object" &&
        !Array.isArray(d) &&
        (d as JxPrototypeDef).timing === "compiler"
      ) {
        continue;
      }
      if (typeof d !== "object" || d === null || Array.isArray(d)) {
        return true;
      }
      if ((d as JxPrototypeDef).$prototype) {
        return true;
      }
      if ("default" in /** @type {object} */ d) {
        return true;
      }
      if (isSchemaOnly(d)) {
        continue;
      }
      return true;
    }
  }

  if (def.$switch) {
    return true;
  }
  if (isMappedArray(def) || childrenContainArray(def.children)) {
    return true;
  }

  if (Array.isArray(def.children) && def.children.some((c) => isDynamic(c))) {
    return true;
  }

  for (const [key, val] of Object.entries(def)) {
    if (RESERVED_KEYS.has(key)) {
      continue;
    }
    if (
      val !== null &&
      typeof val === "object" &&
      typeof (val as JxMutableNode).$ref === "string"
    ) {
      return true;
    }
    if (isTemplateString(val)) {
      return true;
    }
  }

  if (def.style && typeof def.style === "object") {
    for (const val of Object.values(def.style)) {
      if (isTemplateString(val)) {
        return true;
      }
    }
  }

  if (def.attributes && typeof def.attributes === "object") {
    for (const val of Object.values(def.attributes)) {
      if (isTemplateString(val)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Shallow variant of isDynamic — checks only this node's own properties, not its children.
 *
 * @param {JxElement | JxMutableNode | string} def
 * @returns {boolean}
 */
export function isNodeDynamic(def: JxElement | JxMutableNode | string) {
  if (!def || typeof def !== "object") {
    return false;
  }

  if (def.$switch) {
    return true;
  }
  if (isMappedArray(def) || childrenContainArray(def.children)) {
    return true;
  }

  for (const [key, val] of Object.entries(def)) {
    if (RESERVED_KEYS.has(key)) {
      continue;
    }
    if (
      val !== null &&
      typeof val === "object" &&
      typeof (val as JxMutableNode).$ref === "string"
    ) {
      return true;
    }
    if (isTemplateString(val)) {
      return true;
    }
  }

  if (def.style && typeof def.style === "object") {
    for (const val of Object.values(def.style)) {
      if (isTemplateString(val)) {
        return true;
      }
    }
  }

  if (def.attributes && typeof def.attributes === "object") {
    for (const val of Object.values(def.attributes)) {
      if (isTemplateString(val)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns true if any node in the tree will need dynamic handling.
 *
 * @param {JxElement | JxMutableNode | string} def
 * @returns {boolean}
 */
export function hasAnyIsland(def: JxElement | JxMutableNode | string): boolean {
  if (!def || typeof def !== "object") {
    return false;
  }
  if (isDynamic(def)) {
    return true;
  }
  if (Array.isArray(def.children)) {
    return def.children.some((c): boolean => hasAnyIsland(c));
  }
  return false;
}

// ─── Scope / value resolution ─────────────────────────────────────────────────

/**
 * @param {JxElement | JxMutableNode | null} raw
 * @param {Record<string, unknown> | null} [parentScope]
 * @param {Record<string, unknown>} [scopeDefs]
 * @param {Record<string, string>} [media]
 * @returns {CompileContext}
 */
export interface CompileContext {
  scope: Record<string, unknown>;
  scopeDefs: Record<string, unknown>;
  media: Record<string, string>;
  /** True inside a `<pre>`-like subtree, where emitters must not indent nested children. */
  preformatted?: boolean;
}

export function createCompileContext(
  raw: JxElement | JxMutableNode | null,
  parentScope: Record<string, unknown> | null = null,
  scopeDefs: Record<string, unknown> = {},
  media: Record<string, string> = {},
): CompileContext {
  const scope: Record<string, unknown> = raw?.state
    ? buildInitialScope(raw.state, parentScope)
    : (parentScope ?? (Object.create(null) as Record<string, unknown>));
  return { media, scope, scopeDefs };
}

/**
 * `state.x = …`, `state.x += …`, `state.x++` — every form a string handler body can use to write a
 * state entry. `===`/`!==`/`<=`/`>=` are excluded by the `(?!=)` guard and by the operator set.
 */
const STATE_ASSIGNMENT_RE =
  /\bstate\.([A-Za-z_$][\w$]*)\s*(?:\+\+|--|(?:\*\*|\|\||&&|\?\?|<<|>>>|>>|[-+*/%&|^])?=(?!=))/g;

/** `state.list.push(…)` and friends mutate in place without ever assigning to the entry. */
const STATE_MUTATING_METHOD_RE =
  /\bstate\.([A-Za-z_$][\w$]*)\s*\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\s*\(/g;

/**
 * Collect every state key a handler writes to, across all the forms a body can take: a string body,
 * a structured body (spec §20), and an `$expression` node with a mutating operator.
 *
 * Used to keep prerender from baking a binding over an entry that changes after hydration. A plain
 * `{ "type": "string" }` entry holds a perfectly ordinary build-time value, so nothing else
 * distinguishes it from a constant — but if a handler assigns to it, interpolating it at build time
 * replaces the template in the emitted output and the element is dead for the life of the page.
 *
 * @param {unknown} node
 * @param {Set<string>} into
 */
function collectAssignedStateKeys(node: unknown, into: Set<string>) {
  if (typeof node === "string") {
    for (const m of node.matchAll(STATE_ASSIGNMENT_RE)) {
      into.add(m[1] as string);
    }
    for (const m of node.matchAll(STATE_MUTATING_METHOD_RE)) {
      into.add(m[1] as string);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectAssignedStateKeys(entry, into);
    }
    return;
  }
  const rec = node as Record<string, unknown>;
  // A mutating expression names its destination as `target: { $ref: "#/state/x" }`.
  const op = rec.operator;
  if (typeof op === "string" && isMutating(op)) {
    const target = rec.target as { $ref?: string } | undefined;
    if (target && typeof target.$ref === "string" && target.$ref.startsWith("#/state/")) {
      into.add(target.$ref.slice("#/state/".length).split("/")[0] as string);
    }
  }
  for (const value of Object.values(rec)) {
    collectAssignedStateKeys(value, into);
  }
}

/**
 * @param {Record<string, JxStateDefinition>} [defs]
 * @param {Record<string, unknown> | null} [parentScope]
 * @returns {Record<string, unknown>}
 */
export function buildInitialScope(
  defs: Record<string, JxStateDefinition> = {},
  parentScope: Record<string, unknown> | null = null,
) {
  const scope = Object.create(parentScope ?? null) as Record<string, unknown>;
  // Keys whose real value only exists after hydration, so prerender must not interpolate them —
  // See `readsRuntimeOnlyState`. Seeded from the parent so nested scopes inherit the marks.
  const inherited = (parentScope as Record<PropertyKey, unknown> | null)?.[RUNTIME_ONLY_KEYS];
  const runtimeOnly = new Set<string>(inherited instanceof Set ? (inherited as Set<string>) : []);
  // Attached up front, and mutated in place by the passes below, so the template pass at the end can
  // Consult the marks the earlier passes added.
  Object.defineProperty(scope, RUNTIME_ONLY_KEYS, {
    configurable: true,
    enumerable: false,
    value: runtimeOnly,
    writable: true,
  });

  // Pass 0: every entry some handler in this document writes to is mutable, so prerender must not
  // Bake a binding over it. Narrow on purpose — an entry nothing ever writes stays bakeable, so
  // Prerendered content is preserved for SEO. A `$src` handler's assignments live in a JS file this
  // Builder cannot open, so a write that only happens there is still missed (issue #125).
  const assigned = new Set<string>();
  for (const def of Object.values(defs)) {
    if (def && typeof def === "object" && (isFunctionDef(def) || isExpressionDef(def))) {
      collectAssignedStateKeys(
        (def as { body?: unknown; $expression?: unknown }).body ??
          (def as { $expression?: unknown }).$expression,
        assigned,
      );
    }
  }
  for (const key of assigned) {
    if (key in defs) {
      runtimeOnly.add(key);
    }
  }

  for (const [key, def] of Object.entries(defs)) {
    if (typeof def !== "object" || def === null || Array.isArray(def)) {
      setOwnScopeValue(scope, key, cloneValue(def));
      continue;
    }
    const d = def as JxStateObject & JxPrototypeDef;
    if ("default" in d) {
      setOwnScopeValue(scope, key, cloneValue(d.default));
      continue;
    }
    if (!d.$prototype && !("$expression" in d) && !isSchemaOnly(d)) {
      setOwnScopeValue(scope, key, cloneValue(d));
    }
  }

  // Template-string entries are deferred to a third pass: whether one is resolvable depends on the
  // Runtime-only marks the loop below adds, and key order must not decide the answer.
  const templateDefs: [string, string][] = [];
  // Computed (`bodyReturnsValue`) entries are deferred for the same reason. A computed is stored in
  // The scope as its already-evaluated *result*, so a template reading it sees an ordinary string
  // And prerender bakes it — destroying the binding rather than merely staling it (issue #124).
  const computedBodies: [string, string][] = [];

  for (const [key, def] of Object.entries(defs)) {
    if (typeof def === "string" && isTemplateString(def)) {
      templateDefs.push([key, def]);
      continue;
    }
    if (!def || typeof def !== "object") {
      continue;
    }
    if (isExpressionDef(def)) {
      const node = def.$expression as ExpressionNode;
      if (isNamedFormulaDef(def)) {
        // Named formula: callable, positional args mapped onto its declared parameters.
        const params = def.parameters as (string | { name?: string; default?: unknown })[];
        setOwnScopeValue(scope, key, (...argValues: unknown[]) => {
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
          return evaluateExpression(node, scope, null, { args });
        });
      } else if (isMutating(node.operator)) {
        setOwnScopeValue(scope, key, (s: Record<string, unknown>, event: Event) =>
          evaluateExpression(node, s, event),
        );
      } else {
        defineLazyScopeValue(scope, key, () => evaluateExpression(node, scope, null));
      }
      continue;
    }
    if (isFunctionDef(def)) {
      if (hasStructuredBody(def)) {
        // Structured body (spec §20): a side-effecting handler in the build-time scope.
        const { body } = def;
        setOwnScopeValue(scope, key, (s: Record<string, unknown>, event?: Event) => {
          void runStatements(body, s ?? scope, event ?? null);
        });
      } else if (typeof def.body === "string") {
        const declared = def.parameters ? paramNames(def.parameters) : (def.arguments ?? []);
        const { body } = def;
        // Declared names bind by name, not by position (spec.md §5.3 4d): a parameter literally
        // Named `state` receives the scope, anything else receives the event. `state` is prepended
        // When undeclared so a body may always reference it. Unconditionally prepending it instead —
        // The older behaviour here — produced a duplicate parameter for the `["state", "event"]`
        // Form that examples/components/task-manager.json uses, leaving `state` undefined.
        const params = declared.includes("state") ? declared : ["state", ...declared];
        const fn = new Function(...params, body) as (...args: unknown[]) => unknown;
        const invoke = (state: Record<string, unknown>, event?: unknown) =>
          fn(...params.map((name) => (name === "state" ? state : event)));
        if (bodyReturnsValue(body)) {
          defineLazyScopeValue(scope, key, () => invoke(scope));
          computedBodies.push([key, body]);
        } else {
          setOwnScopeValue(scope, key, invoke);
        }
      } else {
        // Bodyless `$src` Function — the real implementation is only loaded in the browser, so this
        // Is a placeholder standing in for its callable shape, never its value.
        setOwnScopeValue(scope, key, () => {});
        runtimeOnly.add(key);
      }
      continue;
    }
    if (
      isPrototypeDef(def) &&
      (def.$prototype === "LocalStorage" || def.$prototype === "SessionStorage")
    ) {
      setOwnScopeValue(scope, key, cloneValue(def.default ?? null));
      continue;
    }
    if (isPrototypeDef(def) && def.$prototype === "Request") {
      // A client-timing fetch has no build-time value at all — not even a placeholder.
      runtimeOnly.add(key);
    }
  }

  // A state entry that reads a runtime-only key cannot resolve until hydration either, so it is
  // Runtime-only in turn. Without this, prerender would bake the failed evaluation (`null`) into
  // Every template that reads *this* entry, one step removed from the original. Iterated to a
  // Fixpoint because marking one entry can qualify another, in either direction, and declaration
  // Order must not decide the answer.
  let marked = true;
  while (marked) {
    marked = false;
    for (const [key, source] of [...computedBodies, ...templateDefs]) {
      if (!runtimeOnly.has(key) && readsRuntimeOnlyState(source, scope)) {
        runtimeOnly.add(key);
        marked = true;
      }
    }
  }

  for (const [key, template] of templateDefs) {
    defineLazyScopeValue(scope, key, () => evaluateStaticTemplate(template, scope));
  }

  return scope;
}

/**
 * @param {Record<string, unknown>} scope
 * @param {string} key
 * @param {unknown} value
 */
export function setOwnScopeValue(scope: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(scope, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/**
 * @param {Record<string, unknown>} scope
 * @param {string} key
 * @param {() => unknown} getter
 */
export function defineLazyScopeValue(
  scope: Record<string, unknown>,
  key: string,
  getter: () => unknown,
) {
  Object.defineProperty(scope, key, {
    configurable: true,
    enumerable: true,
    get: getter,
  });
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} scope
 * @returns {unknown}
 */
export function resolveStaticValue(value: unknown, scope: Record<string, unknown> | null) {
  if (isRefObject(value)) {
    return resolveRefValue((value as JxMutableNode).$ref, scope!);
  }
  if (isTemplateString(value)) {
    return evaluateStaticTemplate(value as string, scope!);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRefObject(value: unknown): value is JxRef {
  return isRef(value);
}

/**
 * @param {unknown} refValue
 * @param {Record<string, unknown>} scope
 * @returns {unknown}
 */
export function resolveRefValue(refValue: unknown, scope: Record<string, unknown>) {
  if (typeof refValue !== "string") {
    return refValue;
  }
  if (refValue.startsWith("$map/")) {
    const parts = refValue.split("/");
    const key = parts[1]!;
    const base = (scope.$map as Record<string, unknown> | undefined)?.[key] ?? scope[`$map/${key}`];
    return parts.length > 2 ? getPathValue(base, parts.slice(2).join("/")) : base;
  }
  if (refValue.startsWith("#/state/")) {
    const sub = refValue.slice("#/state/".length);
    const slash = sub.indexOf("/");
    if (slash === -1) {
      return scope[sub];
    }
    return getPathValue(scope[sub.slice(0, slash)], sub.slice(slash + 1));
  }
  return scope[refValue] ?? null;
}

/**
 * Detect whether a template string interpolates a state value that only exists after hydration.
 *
 * Evaluating one of those at build time is worse than leaving it alone. The build-time scope holds
 * a `() => {}` placeholder for a bodyless `$src` Function and nothing at all for a `Request`, so
 * the template resolves to text like `() => {}`, `undefined` or `""` — and that text _replaces_ the
 * template in the emitted HTML, so the client-side binding is destroyed rather than merely wrong.
 * Returning "unresolvable" instead leaves the template in place for the client to populate.
 *
 * A read that _calls_ the value is left alone: invoking a build-time callable is exactly how named
 * formulas (spec.md §19.4c) are meant to be used during prerender.
 *
 * @param {string} str
 * @param {Record<string, unknown>} scope
 * @returns {boolean}
 */
function readsRuntimeOnlyState(str: string, scope: Record<string, unknown>) {
  if (!scope) {
    return false;
  }
  const runtimeOnly = (scope as Record<PropertyKey, unknown>)[RUNTIME_ONLY_KEYS];
  for (const match of str.matchAll(/\bstate\.([A-Za-z_$][\w$]*)\s*(\()?/g)) {
    if (match[2]) {
      continue;
    }
    const key = match[1] as string;
    if (runtimeOnly instanceof Set && runtimeOnly.has(key)) {
      return true;
    }
    // Reading the key can run a computed's getter, which is free to throw on partial build-time
    // Data. A throw says nothing about whether the entry is runtime-only, so it is not a mark.
    let value: unknown;
    try {
      value = scope[key];
    } catch {
      continue;
    }
    if (typeof value === "function") {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} str
 * @param {Record<string, unknown>} scope
 * @returns {unknown}
 */
export function evaluateStaticTemplate(str: string, scope: Record<string, unknown>) {
  if (readsRuntimeOnlyState(str, scope)) {
    return null;
  }
  try {
    const singleExprMatch = str.match(/^\$\{(.+)\}$/s);
    if (singleExprMatch) {
      const fn = new Function("state", "$map", `return (${singleExprMatch[1]})`) as (
        state: Record<string, unknown>,
        $map: unknown,
      ) => unknown;
      return fn(scope, scope?.$map);
    }
    const fn = new Function("state", "$map", `return \`${str}\``) as (
      state: Record<string, unknown>,
      $map: unknown,
    ) => unknown;
    return fn(scope, scope?.$map);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} base
 * @param {string} path
 * @returns {unknown}
 */
export function getPathValue(base: unknown, path: string) {
  if (!path) {
    return base;
  }
  let acc: unknown = base;
  for (const key of path.split("/")) {
    acc = acc == null ? undefined : (acc as Record<string, unknown>)[key];
  }
  return acc;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function cloneValue(value: unknown) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return structuredClone(value);
}

// ─── HTML building ────────────────────────────────────────────────────────────

/**
 * Build an HTML attribute string from a static element definition.
 *
 * @param {JxElement | JxMutableNode} def
 * @param {Record<string, unknown>} scope @returns {string}
 */
export function buildAttrs(def: JxElement | JxMutableNode, scope: Record<string, unknown> | null) {
  let out = "";

  const id = resolveStaticValue(def.id, scope);
  const className = resolveStaticValue(def.className, scope);
  const hidden = resolveStaticValue(def.hidden, scope);
  const tabIndex = resolveStaticValue(def.tabIndex, scope);
  const title = resolveStaticValue(def.title, scope);
  const lang = resolveStaticValue(def.lang, scope);
  const dir = resolveStaticValue(def.dir, scope);

  if (id) {
    out += ` id="${escapeHtml(String(id))}"`;
  }
  if (className) {
    out += ` class="${escapeHtml(String(className))}"`;
  }
  if (hidden) {
    out += " hidden";
  }
  if (tabIndex !== undefined && tabIndex !== null) {
    out += ` tabindex="${escapeHtml(String(tabIndex))}"`;
  }
  if (title) {
    out += ` title="${escapeHtml(String(title))}"`;
  }
  if (lang) {
    out += ` lang="${escapeHtml(String(lang))}"`;
  }
  if (dir) {
    out += ` dir="${escapeHtml(String(dir))}"`;
  }

  if (def.style && scope) {
    const inline = Object.entries(def.style)
      .filter(
        ([k, v]) =>
          !k.startsWith(":") &&
          !k.startsWith(".") &&
          !k.startsWith("&") &&
          !k.startsWith("[") &&
          !k.startsWith("@") &&
          v !== null &&
          typeof v !== "object" &&
          typeof v === "string" &&
          isTemplateString(v),
      )
      .map(([k, v]) => {
        const value = resolveStaticValue(v, scope);
        return value == null ? null : `${camelToKebab(k)}: ${value}`;
      })
      .filter(Boolean)
      .join("; ");
    if (inline) {
      out += ` style="${inline}"`;
    }
  }
  if (def.attributes) {
    for (const [k, v] of Object.entries(def.attributes)) {
      const value = resolveStaticValue(v, scope);
      if (
        value !== null &&
        value !== undefined &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      ) {
        out += ` ${k}="${escapeHtml(String(value))}"`;
      }
    }
  }

  if (def.tagName === "img") {
    if (!def.attributes?.loading) {
      out += ` loading="lazy"`;
    }
    if (!def.attributes?.decoding) {
      out += ` decoding="async"`;
    }
  }

  if (def.$static) {
    out += ` data-jx-static`;
  } else if (def.$prerendered) {
    out += ` data-jx-prerendered`;
  }

  return out;
}

/**
 * Tags rendered with `white-space: pre` by every UA, where inter-element whitespace is content
 * rather than formatting. Emitters indent nested children for readability; inside these tags — and
 * anywhere below them, since `white-space` inherits — that indentation would render as literal
 * blank lines and leading spaces, so children must be concatenated with no separator.
 */
export const PREFORMATTED_TAGS = new Set(["pre", "textarea", "listing", "plaintext", "xmp"]);

/**
 * The separator to place between an element's compiled children: none inside a preformatted
 * subtree, a newline plus `indent` elsewhere.
 *
 * @param {boolean | undefined} preformatted
 * @param {string} [indent]
 * @returns {string}
 */
export function childSeparator(preformatted: boolean | undefined, indent = "  "): string {
  return preformatted ? "" : `\n${indent}`;
}

/**
 * Build the inner HTML (textContent or children) for a node.
 *
 * @param {JxElement} def
 * @param {JxElement | null} raw
 * @param {{
 *   scope: Record<string, unknown>;
 *   scopeDefs: Record<string, unknown>;
 *   media: Record<string, string>;
 *   preformatted?: boolean;
 * }} context
 * @param {(def: unknown, raw: unknown, context: unknown) => string} childCompiler
 * @returns {string}
 */
export function buildInner(
  def: JxElement,
  raw: JxElement | null,
  context: {
    scope: Record<string, unknown> | null;
    scopeDefs: Record<string, unknown>;
    media: Record<string, string>;
    preformatted?: boolean;
  },
  childCompiler: (def: unknown, raw: unknown, context: unknown) => string,
) {
  const source = raw ?? def;

  if (source.textContent !== undefined) {
    const value = resolveStaticValue(source.textContent, context.scope);
    return value == null ? "" : escapeHtml(String(value));
  }
  if (source.innerHTML) {
    return (resolveStaticValue(source.innerHTML, context.scope) as string) ?? "";
  }
  if (Array.isArray(source.children)) {
    const rawChildren = raw?.children;
    return source.children
      .map((c: JxElement | JxMutableNode | string, i: number) => {
        const childRaw = (rawChildren as (JxElement | string)[] | undefined)?.[i] ?? c;
        return childCompiler(c, childRaw, context);
      })
      .join(childSeparator(context.preformatted));
  }
  return "";
}

// ─── CSS extraction ───────────────────────────────────────────────────────────

/**
 * The inline pre-paint script injected into <head> when a project declares a pure color-scheme
 * media query: restores the visitor's persisted forced scheme before first paint (no FOUC).
 *
 * @returns {string}
 * @docs framework/concepts/color-schemes
 */
export function colorSchemePrePaintScript(): string {
  const key = JSON.stringify(COLOR_SCHEME_STORAGE_KEY);
  const attr = JSON.stringify(COLOR_SCHEME_ATTR);
  return `(function(){try{var s=localStorage.getItem(${key});if(s==="light"||s==="dark"){document.documentElement.setAttribute(${attr},s)}}catch(e){}})()`;
}

/**
 * Resolve an `@`-prefixed style key into an emit function that pushes conditional rules. Pure
 * color-scheme queries dual-emit per the forced-scheme contract (spec §9.5): a media-guarded copy
 * that applies while no scheme is forced plus an unconditional copy under the forced root
 * attribute.
 *
 * @param {string} atKey
 * @param {Record<string, string>} mediaQueries
 * @param {string[]} rules
 * @returns {(selector: string, props: string) => void}
 * @docs framework/concepts/color-schemes
 */
function conditionalRuleEmitter(
  atKey: string,
  mediaQueries: Record<string, string>,
  rules: string[],
): (selector: string, props: string) => void {
  const query = atKey.startsWith("@--")
    ? (mediaQueries[atKey.slice(1)] ?? atKey.slice(1))
    : atKey.startsWith("@(")
      ? atKey.slice(1)
      : null;
  const atRule = query === null ? atKey : `@media ${query}`;
  const scheme = query === null ? null : pureSchemeOf(query);
  return (selector: string, props: string) => {
    if (!props) {
      return;
    }
    if (scheme) {
      const { auto, forced } = schemeSelectors(selector, scheme);
      rules.push(`${atRule} { ${auto} { ${props} } }`, `${forced} { ${props} }`);
    } else {
      rules.push(`${atRule} { ${selector} { ${props} } }`);
    }
  };
}

/**
 * Push the rules for one `@`-prefixed style block scoped to `selector`: flat props plus one level
 * of nested selectors, routed through conditionalRuleEmitter (scheme-aware).
 *
 * @param {string[]} rules
 * @param {string} atKey
 * @param {Record<string, string>} mediaQueries
 * @param {string} selector
 * @param {Record<string, unknown>} obj
 */
function pushConditionalRule(
  rules: string[],
  atKey: string,
  mediaQueries: Record<string, string>,
  selector: string,
  obj: Record<string, unknown>,
) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return;
  }
  const emit = conditionalRuleEmitter(atKey, mediaQueries, rules);
  emit(selector, toCSSText(obj));
  for (const [sel, sub] of Object.entries(obj)) {
    if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
      continue;
    }
    if (sel.startsWith("@")) {
      continue;
    }
    const resolved = sel.startsWith("&")
      ? sel.replace("&", selector)
      : sel.startsWith(":") || sel.startsWith(".") || sel.startsWith("[")
        ? `${selector}${sel}`
        : `${selector} ${sel}`;
    emit(resolved, toCSSText(sub));
  }
}

/**
 * Walk the entire document tree and collect all static nested CSS rules.
 *
 * @param {JxElement | JxMutableNode} doc
 * @param {Record<string, string>} [mediaQueries]
 * @param {JxStyle | null} [projectStyle]
 * @returns {string}
 */
export function compileStyles(
  doc: JxElement | JxMutableNode,
  mediaQueries: Record<string, string> = {},
  projectStyle: JxStyle | null = null,
) {
  const rules: string[] = [];

  // Emit project-level (site-wide) styles — CSS custom properties go on :root,
  // Everything else on body.  Project-level style is implicitly :root, so a
  // Flat object like { "--bg": "#000", "margin": "0" } is the expected format.
  if (projectStyle && typeof projectStyle === "object") {
    const emitProjectRules = (selector: string, obj: Record<string, unknown>) => {
      const props = toCSSText(obj);
      if (props) {
        rules.push(`${selector} { ${props} }`);
      }
      for (const [key, val] of Object.entries(obj)) {
        if (val === null || typeof val !== "object" || Array.isArray(val)) {
          continue;
        }
        if (key.startsWith("@")) {
          pushConditionalRule(rules, key, mediaQueries, selector, val as Record<string, unknown>);
          continue;
        }
        const resolved = key.startsWith("&")
          ? key.replace("&", selector)
          : key.startsWith(":") || key.startsWith(".") || key.startsWith("[")
            ? `${selector}${key}`
            : `${selector} ${key}`;
        emitProjectRules(resolved, val as Record<string, unknown>);
      }
    };

    // Collect CSS custom properties into :root {}
    const rootProps: Record<string, unknown> = {};
    // Collect direct CSS properties into body {}
    const bodyProps: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(projectStyle)) {
      if (
        key.startsWith(":") ||
        key.startsWith(".") ||
        key.startsWith("[") ||
        key.startsWith("@")
      ) {
        continue;
      }
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        continue;
      }
      if (key.startsWith("--")) {
        rootProps[key] = val;
      } else {
        bodyProps[key] = val;
      }
    }
    // Base rules precede conditional blocks so equal-specificity overrides win by source order.
    const rootCSS = toCSSText(rootProps);
    if (rootCSS) {
      rules.push(`:root { ${rootCSS} }`);
    }
    const bodyCSS = toCSSText(bodyProps);
    if (bodyCSS) {
      rules.push(`body { ${bodyCSS} }`);
    }

    for (const [key, val] of Object.entries(projectStyle)) {
      if (key.startsWith(":") || key.startsWith(".") || key.startsWith("[")) {
        emitProjectRules(key, val as Record<string, unknown>);
      } else if (
        val !== null &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        !key.startsWith("@") &&
        !key.startsWith("--")
      ) {
        emitProjectRules(key, val as Record<string, unknown>);
      } else if (
        key.startsWith("@") &&
        val !== null &&
        typeof val === "object" &&
        !Array.isArray(val)
      ) {
        // Conditional block at project top level: custom properties override :root, direct
        // Properties override body, selector-keyed sub-objects their own selector.
        const emit = conditionalRuleEmitter(key, mediaQueries, rules);
        const condRoot: Record<string, unknown> = {};
        const condBody: Record<string, unknown> = {};
        const condSubs: [string, Record<string, unknown>][] = [];
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            if (!k.startsWith("@")) {
              condSubs.push([k, v as Record<string, unknown>]);
            }
            continue;
          }
          if (k.startsWith("--")) {
            condRoot[k] = v;
          } else {
            condBody[k] = v;
          }
        }
        emit(":root", toCSSText(condRoot));
        emit("body", toCSSText(condBody));
        for (const [sel, sub] of condSubs) {
          emit(sel, toCSSText(sub));
        }
      }
    }
  }

  // Forced-scheme UA hint: native widgets follow the forced attribute, not only the OS scheme.
  if (
    Object.values(mediaQueries).some((q) => pureSchemeOf(q) !== null) &&
    !(projectStyle && typeof projectStyle === "object" && "colorScheme" in projectStyle)
  ) {
    rules.push(
      ":root { color-scheme: light dark }",
      `:root:where([${COLOR_SCHEME_ATTR}="light"]) { color-scheme: light }`,
      `:root:where([${COLOR_SCHEME_ATTR}="dark"]) { color-scheme: dark }`,
    );
  }

  const counter = { n: 0 };
  collectStyles(doc, rules, mediaQueries, "", counter);
  if (rules.length === 0) {
    return "";
  }
  return `<style>\n${rules.join("\n")}\n</style>`;
}

/**
 * Recursively emit CSS rules for a nested element selector.
 *
 * @param {string} selector
 * @param {Record<string, unknown>} obj
 * @param {string[]} rules
 * @param {Record<string, string>} mediaQueries
 */
function emitNestedElement(
  selector: string,
  obj: Record<string, unknown>,
  rules: string[],
  mediaQueries: Record<string, string>,
) {
  const props = toCSSText(obj);
  if (props) {
    rules.push(`${selector} { ${props} }`);
  }
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || typeof val !== "object" || Array.isArray(val)) {
      continue;
    }
    if (key.startsWith("@")) {
      pushConditionalRule(rules, key, mediaQueries, selector, val as Record<string, unknown>);
      continue;
    }
    const resolved = key.startsWith("&")
      ? key.replace("&", selector)
      : key.startsWith(":") || key.startsWith(".") || key.startsWith("[")
        ? `${selector}${key}`
        : `${selector} ${key}`;
    emitNestedElement(resolved, val as Record<string, unknown>, rules, mediaQueries);
  }
}

/**
 * @param {JxElement | JxMutableNode | string} def
 * @param {string[]} rules
 * @param {Record<string, string>} mediaQueries
 * @param {string} [_parentSel]
 * @param {{ n: number }} [counter]
 */
export function collectStyles(
  def: JxElement | JxMutableNode | string,
  rules: string[],
  mediaQueries: Record<string, string>,
  _parentSel = "",
  counterArg?: { n: number },
  prefix = "jx",
) {
  const counter = counterArg ?? { n: 0 };
  if (!def || typeof def !== "object") {
    return;
  }

  if (def.style && !def.id && !def.className) {
    def.className = `${prefix}-${counter.n}`;
    counter.n += 1;
  }

  /* A chosen tag needs a selector that matches every candidate, not the first one.
     `#id` and `.class` are unaffected — they identify the element regardless of what it turns out
     to be — but a bare tag selector has to become the union, or styling an `<a>|<div>` wrapper
     would style exactly one of the two branches and silently miss the other. */
  const tagSelector = tagNameCandidates(def.tagName).join(", ") || "*";
  const selector = def.id
    ? `#${def.id}`
    : def.className
      ? `.${def.className.split(" ")[0]}`
      : tagSelector;

  if (def.style) {
    const baseDecls = [];
    for (const [prop, value] of Object.entries(def.style)) {
      if (
        prop.startsWith(":") ||
        prop.startsWith(".") ||
        prop.startsWith("&") ||
        prop.startsWith("[") ||
        prop.startsWith("@")
      ) {
        continue;
      }
      if (value === null || typeof value === "object") {
        continue;
      }
      if (typeof value === "string" && isTemplateString(value)) {
        continue;
      }
      baseDecls.push(`  ${camelToKebab(prop)}: ${value};`);
    }
    if (baseDecls.length > 0) {
      rules.push(`${selector} {\n${baseDecls.join("\n")}\n}`);
    }

    for (const [prop, val] of Object.entries(def.style)) {
      if (val === null || typeof val !== "object" || Array.isArray(val)) {
        continue;
      }
      if (prop.startsWith("@")) {
        pushConditionalRule(rules, prop, mediaQueries, selector, val as Record<string, unknown>);
      } else {
        const resolved = prop.startsWith("&")
          ? prop.replace("&", selector)
          : prop.startsWith(":") || prop.startsWith(".") || prop.startsWith("[")
            ? `${selector}${prop}`
            : `${selector} ${prop}`;
        emitNestedElement(
          resolved,
          /** @type {Record<string, unknown>} */ val,
          rules,
          mediaQueries,
        );
      }
    }
  }

  if (Array.isArray(def.children)) {
    for (const c of def.children) {
      collectStyles(c, rules, mediaQueries, selector, counter, prefix);
    }
  }

  // $switch case nodes render in place of the container's content — collect their styles too
  if (def.cases && typeof def.cases === "object") {
    for (const c of Object.values(def.cases)) {
      collectStyles(
        c as JxElement | JxMutableNode | string,
        rules,
        mediaQueries,
        selector,
        counter,
        prefix,
      );
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * HTML-escape a string for safe attribute and text content embedding.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str: string) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Convert a page title to a valid custom element tag name.
 *
 * @param {string} title
 * @returns {string}
 */
export function titleToTagName(title: string) {
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return slug.includes("-") ? slug : `jx-${slug}`;
}

/**
 * @param {string} tagName
 * @returns {string}
 */
export function tagNameToClassName(tagName: string) {
  return tagName
    .split("-")
    .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Recursively collect unique $src values from $prototype: "Function" entries.
 *
 * @param {JxElement} doc
 * @returns {string[]}
 */
export function collectSrcImports(doc: JxElement) {
  const srcs = new Set<string>();
  _walkSrc(doc, srcs);
  return [...srcs];
}

/**
 * @param {JxElement | JxMutableNode | string} def
 * @param {Set<string>} srcs
 */
function _walkSrc(def: JxElement | JxMutableNode | string, srcs: Set<string>) {
  if (!def || typeof def !== "object") {
    return;
  }
  if (def.state) {
    for (const d of Object.values(def.state)) {
      if (
        d &&
        typeof d === "object" &&
        (d as JxMutableNode).$prototype === "Function" &&
        (d as JxMutableNode).$src
      ) {
        srcs.add((d as JxMutableNode).$src as string);
      }
    }
  }
  if (Array.isArray(def.children)) {
    for (const c of def.children) {
      _walkSrc(c, srcs);
    }
  }
}

/**
 * Recursively collect all `timing: "server"` entries from the document tree.
 *
 * @param {JxElement} doc
 * @returns {{ key: string; exportName: string; src: string }[]}
 */
export function collectServerEntries(doc: JxElement) {
  const entries = new Map<string, { key: string; exportName: string; src: string }>();
  _walkServerEntries(doc, entries);
  return [...entries.values()];
}

/**
 * @param {JxElement | JxMutableNode | string} def
 * @param {Map<string, { key: string; exportName: string; src: string }>} entries
 */
function _walkServerEntries(
  def: JxElement | JxMutableNode | string,
  entries: Map<string, { key: string; exportName: string; src: string }>,
) {
  if (!def || typeof def !== "object") {
    return;
  }
  if (def.state) {
    for (const [key, d] of Object.entries(def.state)) {
      if (isServerFnDef(d)) {
        entries.set(d.$export, { exportName: d.$export, key, src: d.$src });
      }
    }
  }
  if (Array.isArray(def.children)) {
    for (const c of def.children) {
      _walkServerEntries(c, entries);
    }
  }
}

// ─── Component pre-rendering ─────────────────────────────────────────────────

export const SELF_CLOSING = new Set<string>([
  "input",
  "br",
  "hr",
  "img",
  "meta",
  "link",
  "area",
  "col",
  "source",
]);

/**
 * A tag for the PRERENDER, resolved against the same scope the attributes are.
 *
 * The static renderer produces bytes, so it must commit to one element. Every candidate is a
 * literal `TagName`, so committing is safe — and it is resolved here rather than left as text
 * precisely because the old `${…}` form was left as text and then re-resolved against the page
 * scope, where a component's own state is undefined.
 *
 * @param {unknown} tagName
 * @param {Record<string, unknown>} scope
 * @returns {string}
 */
export function resolveStaticTagName(
  tagName: unknown,
  scope: Record<string, unknown> | null,
): string {
  if (typeof tagName === "string") {
    return tagName;
  }
  const candidates = tagNameCandidates(tagName);
  if (candidates.length === 0) {
    return "div";
  }
  if (!isTagExpression(tagName)) {
    return candidates[0]!;
  }
  const expression = tagName.$expression;
  if (expression.operator === "?:") {
    return resolveStaticValue(expression.target, scope) ? expression.value : expression.initial;
  }
  const key = resolveStaticValue(expression.target, scope);
  return expression.cases[String(key)] ?? expression.default;
}

/**
 * Recursively render a Jx node tree to static HTML for pre-rendering.
 *
 * @param {JxElement | JxMutableNode | string} node
 * @param {Record<string, unknown>} scope
 * @param {string | null} [slotContent] - HTML to substitute for `<slot>` elements
 * @returns {string}
 */
export function renderStaticNode(
  node: JxElement | JxMutableNode | string,
  scope: Record<string, unknown> | null,
  slotContent: string | null = null,
): string {
  if (typeof node === "string") {
    if (isTemplateString(node) && scope) {
      const val = evaluateStaticTemplate(node, scope);
      return val != null ? escapeHtml(String(val)) : escapeHtml(node);
    }
    return escapeHtml(node);
  }
  if (typeof node === "number" || typeof node === "boolean") {
    return escapeHtml(String(node));
  }
  if (Array.isArray(node)) {
    return (node as (JxElement | JxMutableNode | string)[])
      .map((c: JxElement | JxMutableNode | string): string =>
        renderStaticNode(c, scope, slotContent),
      )
      .join("\n");
  }
  if (!node || typeof node !== "object") {
    return "";
  }

  // Skip mapped arrays — can't pre-render dynamic lists
  if (node.$prototype === "Array") {
    return "";
  }

  // $switch/cases — resolve the key statically and render the matched case inside a container
  // Element (mirrors the runtime's renderSwitch DOM shape). External $ref cases can't be fetched
  // At compile time, so they render the empty container.
  if (node.$switch) {
    const switchTag = node.tagName ?? "div";
    const attrs = buildAttrs(node, scope);
    const key = resolveStaticValue(node.$switch, scope);
    const caseDef =
      key == null
        ? undefined
        : (node.cases as Record<string, JxElement | string> | undefined)?.[String(key)];
    const inner =
      caseDef !== undefined && !isRefObject(caseDef)
        ? renderStaticNode(caseDef, scope, slotContent)
        : "";
    return `<${switchTag}${attrs}>${inner}</${switchTag}>`;
  }

  /* Resolved against the SAME scope the attributes are resolved against, so the prerendered markup
     and the client's first render agree about what element this is. The old `${…}` form could not
     do this — it re-resolved the emitted string against the page scope, where a component's own
     state does not exist, so SSR silently emitted the fallback branch's tag. */
  const tag = resolveStaticTagName(node.tagName, scope);

  // Replace <slot> with provided slot content
  if (tag === "slot" && slotContent != null) {
    return slotContent;
  }

  const attrs = buildAttrs(node, scope);

  if (SELF_CLOSING.has(tag)) {
    return `<${tag}${attrs}>`;
  }

  let inner = "";
  if (node.textContent !== undefined) {
    const val = resolveStaticValue(node.textContent, scope);
    inner = val != null ? escapeHtml(String(val)) : "";
  } else if (node.innerHTML) {
    const val = resolveStaticValue(node.innerHTML, scope);
    inner = val != null ? String(val) : (node.innerHTML as string);
  } else if (Array.isArray(node.children)) {
    inner = node.children
      .map((c: JxElement | JxMutableNode | string) => renderStaticNode(c, scope, slotContent))
      .join("\n");
  }

  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Pre-render a component definition to static HTML for its inner content.
 *
 * @param {JxElement} doc - Component JSON definition
 * @param {Record<string, JsonValue> | null} [propsOverride] - Instance-specific prop values to
 *   merge into state
 * @param {string | null} [slotContent] - HTML to substitute for `<slot>` elements
 * @returns {string} The pre-rendered innerHTML
 */
export function preRenderComponentHtml(
  doc: JxElement,
  propsOverride: Record<string, JsonValue> | null = null,
  slotContent: string | null = null,
) {
  let stateDefs: Record<string, JxStateDefinition> = doc.state ?? {};
  if (propsOverride) {
    stateDefs = { ...stateDefs };
    for (const [key, value] of Object.entries(propsOverride)) {
      if (key in stateDefs) {
        const existing = stateDefs[key];
        stateDefs[key] =
          existing &&
          typeof existing === "object" &&
          !Array.isArray(existing) &&
          "default" in existing
            ? { .../** @type {JxStateObject} */ existing, default: value }
            : (value as JxStateDefinition);
      } else {
        stateDefs[key] = value as JxStateDefinition;
      }
    }
  }
  const scope = buildInitialScope(stateDefs, null);
  if (!Array.isArray(doc.children)) {
    return "";
  }
  return doc.children
    .map((c: JxElement | JxMutableNode | string) => renderStaticNode(c, scope, slotContent))
    .join("\n");
}

/**
 * Check if a component definition is fully static (no runtime behavior needed).
 *
 * Returns true when: no event handlers, no $prototype entries (Functions, Request, Storage), no
 * $ref values. Conservative — returns false when uncertain.
 *
 * @param {JxElement} doc - Component JSON definition
 * @returns {boolean}
 */
export function isComponentFullyStatic(doc: JxElement) {
  return _isStaticNode(doc);
}

/**
 * @param {JxElement | string | (JxElement | string)[]} node
 * @returns {boolean}
 */
function _isStaticNode(node: JxElement | string | (JxElement | string)[]): boolean {
  if (!node || typeof node !== "object") {
    return true;
  }
  if (Array.isArray(node)) {
    return node.every((n) => _isStaticNode(n));
  }

  // Check for $prototype (Functions, Request, Storage, etc.)
  if (node.$prototype) {
    return false;
  }
  // Check for $ref
  if (node.$ref) {
    return false;
  }

  // Check state entries
  if (node.state) {
    for (const def of Object.values(node.state)) {
      if (!def || typeof def !== "object") {
        continue;
      }
      const d = def as JxMutableNode;
      if (d.$prototype) {
        return false;
      }
      if (d.$ref) {
        return false;
      }
    }
  }

  // Check for event handlers
  for (const key of Object.keys(node)) {
    if (key.startsWith("on") && key !== "observedAttributes") {
      return false;
    }
  }

  // Recurse into children
  if (Array.isArray(node.children)) {
    return node.children.every((c) => _isStaticNode(c));
  }
  // Children descriptor object ($prototype: "Array", etc.)
  if (node.children && typeof node.children === "object" && node.children.$prototype) {
    return false;
  }

  return true;
}

/**
 * Generate CSS rules for a component: host-level styles using tag selector, plus inner element
 * styles using .jx-N selectors via collectStyles.
 *
 * @param {string} tagName - The custom element tag name (used as CSS selector)
 * @param {JxStyle | null} styleDef - The component's style object
 * @param {JxElement | null} [doc] - The full component document (for walking children)
 * @param {Record<string, string>} [mediaQueries] - Project media query definitions
 * @returns {string} CSS text, or empty string if no styles
 */
export function buildComponentCSS(
  tagName: string,
  styleDef?: JxStyle | null | undefined,
  doc: JxElement | null = null,
  mediaQueries: Record<string, string> = {},
) {
  const rules: string[] = [];

  if (styleDef && typeof styleDef === "object") {
    const decls: string[] = [];
    for (const [prop, value] of Object.entries(styleDef)) {
      if (
        prop.startsWith(":") ||
        prop.startsWith(".") ||
        prop.startsWith("&") ||
        prop.startsWith("[") ||
        prop.startsWith("@")
      ) {
        continue;
      }
      if (value === null || typeof value === "object") {
        continue;
      }
      if (typeof value === "string" && isTemplateString(value)) {
        continue;
      }
      decls.push(`  ${camelToKebab(prop)}: ${value};`);
    }
    if (decls.length > 0) {
      rules.push(`${tagName} {\n${decls.join("\n")}\n}`);
    }

    for (const [prop, val] of Object.entries(styleDef)) {
      if (prop.startsWith("@")) {
        pushConditionalRule(rules, prop, mediaQueries, tagName, val as Record<string, unknown>);
      } else if (
        prop.startsWith(":") ||
        prop.startsWith(".") ||
        prop.startsWith("&") ||
        prop.startsWith("[")
      ) {
        const resolved = prop.startsWith("&") ? prop.replace("&", tagName) : `${tagName}${prop}`;
        rules.push(`${resolved} { ${toCSSText(val as Record<string, unknown>)} }`);
      }
    }
  }

  if (doc && Array.isArray(doc.children)) {
    const counter = { n: 0 };
    for (const child of doc.children) {
      collectStyles(child, rules, mediaQueries, "", counter, tagName);
    }
  }

  return rules.length > 0 ? `${rules.join("\n")}\n` : "";
}
