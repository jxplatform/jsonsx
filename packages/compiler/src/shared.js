/**
 * Shared.js — Shared compiler utilities
 *
 * Detection, scope resolution, HTML building, CSS extraction, and naming utilities used across all
 * compilation targets (static, client, element, server).
 */

import { camelToKebab, toCSSText, RESERVED_KEYS } from "@jxsuite/runtime";

// Re-export runtime utilities used by submodules
export { camelToKebab, toCSSText, RESERVED_KEYS };

// CDN defaults
export const DEFAULT_REACTIVITY_SRC = "https://esm.sh/@vue/reactivity@3.5.32";
export const DEFAULT_LIT_HTML_SRC = "https://esm.sh/lit-html@3.3.0";

// ─── Schema keywords ─────────────────────────────────────────────────────────

/**
 * Schema-only keywords used to detect pure type definitions (Shape 2b). An object with ONLY these
 * keys and no `default` is a type def, not a signal.
 */
export const SCHEMA_KEYWORDS = new Set([
  "type",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "items",
  "properties",
  "required",
  "description",
  "title",
  "$comment",
]);

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Returns true if a $src path points to a .class.json schema-defined class.
 *
 * @param {unknown} src
 * @returns {boolean}
 */
export function isClassJsonSrc(src) {
  return typeof src === "string" && src.endsWith(".class.json");
}

/**
 * Returns true if an object contains only schema keywords (no `default`, no `$prototype`).
 *
 * @param {Record<string, unknown>} obj
 * @returns {boolean}
 */
export function isSchemaOnly(obj) {
  for (const k of Object.keys(obj)) {
    if (!SCHEMA_KEYWORDS.has(k)) return false;
  }
  return true;
}

/**
 * Returns true if a string contains a ${} template expression.
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function isTemplateString(val) {
  return typeof val === "string" && val.includes("${");
}

/**
 * Determine whether a node (or any of its descendants) requires client-side JavaScript.
 *
 * @param {JxElement | JxMutableNode | string} def
 * @returns {boolean}
 */
export function isDynamic(def) {
  if (!def || typeof def !== "object") return false;

  if (def.state) {
    for (const [k, d] of Object.entries(def.state)) {
      // Skip injected context (read-only, not reactive)
      if (k === "$site" || k === "$page") continue;
      // Skip timing: "compiler" entries — resolved at build time, baked into static HTML
      if (
        d &&
        typeof d === "object" &&
        !Array.isArray(d) &&
        /** @type {JxPrototypeDef} */ (d).timing === "compiler"
      )
        continue;
      if (typeof d !== "object" || d === null || Array.isArray(d)) return true;
      if (/** @type {JxPrototypeDef} */ (d).$prototype) return true;
      if ("default" in /** @type {object} */ (d)) return true;
      if (isSchemaOnly(d)) continue;
      return true;
    }
  }

  if (def.$switch) return true;
  if (
    !Array.isArray(def.children) &&
    /** @type {JxMappedArray | undefined} */ (def.children)?.$prototype === "Array"
  )
    return true;

  if (Array.isArray(def.children)) {
    if (def.children.some((c) => isDynamic(c))) return true;
  }

  for (const [key, val] of Object.entries(def)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (
      val !== null &&
      typeof val === "object" &&
      typeof (/** @type {JxMutableNode} */ (val).$ref) === "string"
    )
      return true;
    if (isTemplateString(val)) return true;
  }

  if (def.style && typeof def.style === "object") {
    for (const val of Object.values(def.style)) {
      if (isTemplateString(val)) return true;
    }
  }

  if (def.attributes && typeof def.attributes === "object") {
    for (const val of Object.values(def.attributes)) {
      if (isTemplateString(val)) return true;
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
export function isNodeDynamic(def) {
  if (!def || typeof def !== "object") return false;

  if (def.$switch) return true;
  if (
    !Array.isArray(def.children) &&
    /** @type {JxMappedArray | undefined} */ (def.children)?.$prototype === "Array"
  )
    return true;

  for (const [key, val] of Object.entries(def)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (
      val !== null &&
      typeof val === "object" &&
      typeof (/** @type {JxMutableNode} */ (val).$ref) === "string"
    )
      return true;
    if (isTemplateString(val)) return true;
  }

  if (def.style && typeof def.style === "object") {
    for (const val of Object.values(def.style)) {
      if (isTemplateString(val)) return true;
    }
  }

  if (def.attributes && typeof def.attributes === "object") {
    for (const val of Object.values(def.attributes)) {
      if (isTemplateString(val)) return true;
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
export function hasAnyIsland(def) {
  if (!def || typeof def !== "object") return false;
  if (isDynamic(def)) return true;
  if (Array.isArray(def.children)) return def.children.some((c) => hasAnyIsland(c));
  return false;
}

// ─── Scope / value resolution ─────────────────────────────────────────────────

/**
 * @param {JxElement | JxMutableNode | null} raw
 * @param {Record<string, unknown> | null} [parentScope]
 * @param {Record<string, unknown>} [scopeDefs]
 * @param {Record<string, string>} [media]
 * @returns {{
 *   scope: Record<string, unknown>;
 *   scopeDefs: Record<string, unknown>;
 *   media: Record<string, string>;
 * }}
 */
export function createCompileContext(raw, parentScope = null, scopeDefs = {}, media = {}) {
  const scope = raw?.state
    ? buildInitialScope(raw.state, parentScope)
    : (parentScope ?? Object.create(null));
  return { scope, scopeDefs, media };
}

/**
 * @param {Record<string, JxStateDefinition>} [defs]
 * @param {Record<string, unknown> | null} [parentScope]
 * @returns {Record<string, unknown>}
 */
export function buildInitialScope(defs = {}, parentScope = null) {
  const scope = Object.create(parentScope ?? null);

  for (const [key, def] of Object.entries(defs)) {
    if (typeof def !== "object" || def === null || Array.isArray(def)) {
      setOwnScopeValue(scope, key, cloneValue(def));
      continue;
    }
    const d = /** @type {JxStateObject & JxPrototypeDef} */ (def);
    if ("default" in d) {
      setOwnScopeValue(scope, key, cloneValue(d.default));
      continue;
    }
    if (!d.$prototype && !isSchemaOnly(d)) {
      setOwnScopeValue(scope, key, cloneValue(d));
    }
  }

  for (const [key, def] of Object.entries(defs)) {
    if (typeof def === "string" && isTemplateString(def)) {
      defineLazyScopeValue(scope, key, () => evaluateStaticTemplate(def, scope));
      continue;
    }
    if (!def || typeof def !== "object") continue;
    const d = /** @type {JxStateObject & JxPrototypeDef} */ (def);
    if (d.$prototype === "Function") {
      if (d.body) {
        const fn = new Function("state", ...(d.parameters ?? d.arguments ?? []), d.body);
        if (d.body.includes("return")) {
          defineLazyScopeValue(scope, key, () => fn(scope));
        } else {
          setOwnScopeValue(scope, key, fn);
        }
      } else if (!d.body?.includes("return")) {
        setOwnScopeValue(scope, key, () => {});
      }
      continue;
    }
    if (d.$prototype === "LocalStorage" || d.$prototype === "SessionStorage") {
      setOwnScopeValue(scope, key, cloneValue(d.default ?? null));
    }
  }

  return scope;
}

/**
 * @param {Record<string, unknown>} scope
 * @param {string} key
 * @param {unknown} value
 */
export function setOwnScopeValue(scope, key, value) {
  Object.defineProperty(scope, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * @param {Record<string, unknown>} scope
 * @param {string} key
 * @param {() => unknown} getter
 */
export function defineLazyScopeValue(scope, key, getter) {
  Object.defineProperty(scope, key, {
    enumerable: true,
    configurable: true,
    get: getter,
  });
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} scope
 * @returns {unknown}
 */
export function resolveStaticValue(value, scope) {
  if (isRefObject(value)) return resolveRefValue(/** @type {JxMutableNode} */ (value).$ref, scope);
  if (isTemplateString(value)) return evaluateStaticTemplate(/** @type {string} */ (value), scope);
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRefObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (/** @type {JxMutableNode} */ (value).$ref) === "string"
  );
}

/**
 * @param {unknown} refValue
 * @param {Record<string, unknown>} scope
 * @returns {unknown}
 */
export function resolveRefValue(refValue, scope) {
  if (typeof refValue !== "string") return refValue;
  if (refValue.startsWith("$map/")) {
    const parts = refValue.split("/");
    const key = parts[1];
    const base = /** @type {Record<string, unknown> | undefined} */ (scope.$map)?.[key] ??
    scope["$map/" + key];
    return parts.length > 2 ? getPathValue(base, parts.slice(2).join("/")) : base;
  }
  if (refValue.startsWith("#/state/")) {
    const sub = refValue.slice("#/state/".length);
    const slash = sub.indexOf("/");
    if (slash < 0) return scope[sub];
    return getPathValue(scope[sub.slice(0, slash)], sub.slice(slash + 1));
  }
  return scope[refValue] ?? null;
}

/**
 * @param {string} str
 * @param {Record<string, unknown>} scope
 * @returns {unknown}
 */
export function evaluateStaticTemplate(str, scope) {
  try {
    const singleExprMatch = str.match(/^\$\{(.+)\}$/s);
    if (singleExprMatch) {
      const fn = new Function("state", "$map", `return (${singleExprMatch[1]})`);
      return fn(scope, scope?.$map);
    }
    const fn = new Function("state", "$map", `return \`${str}\``);
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
export function getPathValue(base, path) {
  if (!path) return base;
  return path.split("/").reduce(
    /**
     * @param {Record<string, unknown>} acc
     * @param {string} key
     * @returns {Record<string, unknown>}
     */
    (acc, key) => (/** @type {Record<string, unknown>} */ (acc == null ? undefined : acc[key])),
    /** @type {Record<string, unknown>} */ (base),
  );
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function cloneValue(value) {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

// ─── HTML building ────────────────────────────────────────────────────────────

/**
 * Build an HTML attribute string from a static element definition.
 *
 * @param {JxElement | JxMutableNode} def
 * @param {Record<string, unknown>} scope @returns {string}
 */
export function buildAttrs(def, scope) {
  let out = "";

  const id = resolveStaticValue(def.id, scope);
  const className = resolveStaticValue(def.className, scope);
  const hidden = resolveStaticValue(def.hidden, scope);
  const tabIndex = resolveStaticValue(def.tabIndex, scope);
  const title = resolveStaticValue(def.title, scope);
  const lang = resolveStaticValue(def.lang, scope);
  const dir = resolveStaticValue(def.dir, scope);

  if (id) out += ` id="${escapeHtml(String(id))}"`;
  if (className) out += ` class="${escapeHtml(String(className))}"`;
  if (hidden) out += " hidden";
  if (tabIndex !== undefined && tabIndex !== null)
    out += ` tabindex="${escapeHtml(String(tabIndex))}"`;
  if (title) out += ` title="${escapeHtml(String(title))}"`;
  if (lang) out += ` lang="${escapeHtml(String(lang))}"`;
  if (dir) out += ` dir="${escapeHtml(String(dir))}"`;

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
    if (inline) out += ` style="${inline}"`;
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
    if (!def.attributes?.loading) out += ` loading="lazy"`;
    if (!def.attributes?.decoding) out += ` decoding="async"`;
  }

  if (def.$static) {
    out += ` data-jx-static`;
  } else if (def.$prerendered) {
    out += ` data-jx-prerendered`;
  }

  return out;
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
 * }} context
 * @param {(def: any, raw: any, context: any) => string} childCompiler
 * @returns {string}
 */
export function buildInner(def, raw, context, childCompiler) {
  const source = raw ?? def;

  if (source.textContent !== undefined) {
    const value = resolveStaticValue(source.textContent, context.scope);
    return value == null ? "" : escapeHtml(String(value));
  }
  if (source.innerHTML)
    return /** @type {string} */ (resolveStaticValue(source.innerHTML, context.scope)) ?? "";
  if (Array.isArray(source.children)) {
    const rawChildren = raw?.children;
    return source.children
      .map((/** @type {JxElement | JxMutableNode | string} */ c, /** @type {number} */ i) => {
        const childRaw = /** @type {(JxElement | string)[] | undefined} */ (rawChildren)?.[i] ?? c;
        return childCompiler(c, childRaw, context);
      })
      .join("\n  ");
  }
  return "";
}

// ─── CSS extraction ───────────────────────────────────────────────────────────

/**
 * Walk the entire document tree and collect all static nested CSS rules.
 *
 * @param {JxElement | JxMutableNode} doc
 * @param {Record<string, string>} [mediaQueries]
 * @param {JxStyle | null} [projectStyle]
 * @returns {string}
 */
export function compileStyles(doc, mediaQueries = {}, projectStyle = null) {
  /** @type {string[]} */
  const rules = [];

  // Emit project-level (site-wide) styles — CSS custom properties go on :root,
  // everything else on body.  Project-level style is implicitly :root, so a
  // flat object like { "--bg": "#000", "margin": "0" } is the expected format.
  if (projectStyle && typeof projectStyle === "object") {
    function emitProjectRules(/** @type {string} */ selector, /** @type {JxMutableNode} */ obj) {
      const props = toCSSText(obj);
      if (props) rules.push(`${selector} { ${props} }`);
      for (const [key, val] of Object.entries(obj)) {
        if (val === null || typeof val !== "object" || Array.isArray(val)) continue;
        if (key.startsWith("@")) {
          const query = key.startsWith("@--")
            ? (mediaQueries[key.slice(1)] ?? key.slice(1))
            : key.slice(1);
          const mProps = toCSSText(val);
          if (mProps) rules.push(`@media ${query} { ${selector} { ${mProps} } }`);
          for (const [sel, sub] of Object.entries(/** @type {Record<string, unknown>} */ (val))) {
            if (sub === null || typeof sub !== "object" || Array.isArray(sub)) continue;
            if (sel.startsWith("@")) continue;
            const resolved = sel.startsWith("&")
              ? sel.replace("&", selector)
              : sel.startsWith(":") || sel.startsWith(".") || sel.startsWith("[")
                ? `${selector}${sel}`
                : `${selector} ${sel}`;
            const subProps = toCSSText(sub);
            if (subProps) rules.push(`@media ${query} { ${resolved} { ${subProps} } }`);
          }
          continue;
        }
        const resolved = key.startsWith("&")
          ? key.replace("&", selector)
          : key.startsWith(":") || key.startsWith(".") || key.startsWith("[")
            ? `${selector}${key}`
            : `${selector} ${key}`;
        emitProjectRules(resolved, /** @type {Record<string, unknown>} */ (val));
      }
    }

    for (const [key, val] of Object.entries(projectStyle)) {
      if (key.startsWith(":") || key.startsWith(".") || key.startsWith("[")) {
        emitProjectRules(key, /** @type {Record<string, unknown>} */ (val));
      } else if (
        val !== null &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        !key.startsWith("@") &&
        !key.startsWith("--")
      ) {
        emitProjectRules(key, val);
      } else if (key.startsWith("@")) {
        // @media block at top level
        const query = key.startsWith("@--")
          ? (mediaQueries[key.slice(1)] ?? key.slice(1))
          : key.slice(1);
        rules.push(`@media ${query} { body { ${toCSSText(/** @type {object} */ (val))} } }`);
      }
    }
    // Collect CSS custom properties into :root {}
    /** @type {Record<string, unknown>} */
    const rootProps = {};
    // Collect direct CSS properties into body {}
    /** @type {Record<string, unknown>} */
    const bodyProps = {};
    for (const [key, val] of Object.entries(projectStyle)) {
      if (key.startsWith(":") || key.startsWith(".") || key.startsWith("[") || key.startsWith("@"))
        continue;
      if (val !== null && typeof val === "object" && !Array.isArray(val)) continue;
      if (key.startsWith("--")) {
        rootProps[key] = val;
      } else {
        bodyProps[key] = val;
      }
    }
    const rootCSS = toCSSText(rootProps);
    if (rootCSS) {
      rules.push(`:root { ${rootCSS} }`);
    }
    const bodyCSS = toCSSText(bodyProps);
    if (bodyCSS) {
      rules.push(`body { ${bodyCSS} }`);
    }
  }

  const counter = { n: 0 };
  collectStyles(doc, rules, mediaQueries, "", counter);
  if (rules.length === 0) return "";
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
function emitNestedElement(selector, obj, rules, mediaQueries) {
  const props = toCSSText(obj);
  if (props) rules.push(`${selector} { ${props} }`);
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || typeof val !== "object" || Array.isArray(val)) continue;
    if (key.startsWith("@")) {
      const query = key.startsWith("@--")
        ? (mediaQueries[key.slice(1)] ?? key.slice(1))
        : key.slice(1);
      const mProps = toCSSText(val);
      if (mProps) rules.push(`@media ${query} { ${selector} { ${mProps} } }`);
      for (const [sel, sub] of Object.entries(/** @type {Record<string, unknown>} */ (val))) {
        if (sub === null || typeof sub !== "object" || Array.isArray(sub)) continue;
        if (sel.startsWith("@")) continue;
        const resolved = sel.startsWith("&")
          ? sel.replace("&", selector)
          : sel.startsWith(":") || sel.startsWith(".") || sel.startsWith("[")
            ? `${selector}${sel}`
            : `${selector} ${sel}`;
        const subProps = toCSSText(sub);
        if (subProps) rules.push(`@media ${query} { ${resolved} { ${subProps} } }`);
      }
      continue;
    }
    const resolved = key.startsWith("&")
      ? key.replace("&", selector)
      : key.startsWith(":") || key.startsWith(".") || key.startsWith("[")
        ? `${selector}${key}`
        : `${selector} ${key}`;
    emitNestedElement(resolved, /** @type {Record<string, unknown>} */ (val), rules, mediaQueries);
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
  def,
  rules,
  mediaQueries,
  _parentSel = "",
  counter = { n: 0 },
  prefix = "jx",
) {
  if (!def || typeof def !== "object") return;

  if (def.style) {
    if (!def.id && !def.className) {
      def.className = `${prefix}-${counter.n++}`;
    }
  }

  const selector = def.id
    ? `#${def.id}`
    : def.className
      ? `.${def.className.split(" ")[0]}`
      : (def.tagName ?? "*");

  if (def.style) {
    const baseDecls = [];
    for (const [prop, value] of Object.entries(def.style)) {
      if (
        prop.startsWith(":") ||
        prop.startsWith(".") ||
        prop.startsWith("&") ||
        prop.startsWith("[") ||
        prop.startsWith("@")
      )
        continue;
      if (value === null || typeof value === "object") continue;
      if (typeof value === "string" && isTemplateString(value)) continue;
      baseDecls.push(`  ${camelToKebab(prop)}: ${value};`);
    }
    if (baseDecls.length > 0) {
      rules.push(`${selector} {\n${baseDecls.join("\n")}\n}`);
    }

    for (const [prop, val] of Object.entries(def.style)) {
      if (val === null || typeof val !== "object" || Array.isArray(val)) continue;
      if (prop.startsWith("@")) {
        const query = prop.startsWith("@--")
          ? (mediaQueries[prop.slice(1)] ?? prop.slice(1))
          : prop.slice(1);
        rules.push(`@media ${query} { ${selector} { ${toCSSText(val)} } }`);
        for (const [sel, nestedRules] of Object.entries(
          /** @type {Record<string, unknown>} */ (val),
        )) {
          if (nestedRules === null || typeof nestedRules !== "object" || Array.isArray(nestedRules))
            continue;
          if (sel.startsWith("@")) continue;
          const resolved = sel.startsWith("&")
            ? sel.replace("&", selector)
            : sel.startsWith(":") || sel.startsWith(".") || sel.startsWith("[")
              ? `${selector}${sel}`
              : `${selector} ${sel}`;
          rules.push(`@media ${query} { ${resolved} { ${toCSSText(nestedRules)} } }`);
        }
      } else {
        const resolved = prop.startsWith("&")
          ? prop.replace("&", selector)
          : prop.startsWith(":") || prop.startsWith(".") || prop.startsWith("[")
            ? `${selector}${prop}`
            : `${selector} ${prop}`;
        emitNestedElement(
          resolved,
          /** @type {Record<string, unknown>} */ (val),
          rules,
          mediaQueries,
        );
      }
    }
  }

  if (Array.isArray(def.children)) {
    def.children.forEach((/** @type {JxElement | JxMutableNode | string} */ c) => {
      collectStyles(c, rules, mediaQueries, selector, counter, prefix);
    });
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * HTML-escape a string for safe attribute and text content embedding.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert a page title to a valid custom element tag name.
 *
 * @param {string} title
 * @returns {string}
 */
export function titleToTagName(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.includes("-") ? slug : `jx-${slug}`;
}

/**
 * @param {string} tagName
 * @returns {string}
 */
export function tagNameToClassName(tagName) {
  return tagName
    .split("-")
    .map((/** @type {string} */ s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Recursively collect unique $src values from $prototype: "Function" entries.
 *
 * @param {JxElement} doc
 * @returns {string[]}
 */
export function collectSrcImports(doc) {
  /** @type {Set<string>} */
  const srcs = new Set();
  _walkSrc(doc, srcs);
  return [...srcs];
}

/**
 * @param {JxElement | JxMutableNode | string} def
 * @param {Set<string>} srcs
 */
function _walkSrc(def, srcs) {
  if (!def || typeof def !== "object") return;
  if (def.state) {
    for (const d of Object.values(def.state)) {
      if (
        d &&
        typeof d === "object" &&
        /** @type {JxMutableNode} */ (d).$prototype === "Function" &&
        /** @type {JxMutableNode} */ (d).$src
      ) {
        srcs.add(/** @type {string} */ (/** @type {JxMutableNode} */ (d).$src));
      }
    }
  }
  if (Array.isArray(def.children)) {
    def.children.forEach((/** @type {JxElement | JxMutableNode | string} */ c) =>
      _walkSrc(c, srcs),
    );
  }
}

/**
 * Recursively collect all `timing: "server"` entries from the document tree.
 *
 * @param {JxElement} doc
 * @returns {{ key: string; exportName: string; src: string }[]}
 */
export function collectServerEntries(doc) {
  /** @type {Map<string, { key: string; exportName: string; src: string }>} */
  const entries = new Map();
  _walkServerEntries(doc, entries);
  return [...entries.values()];
}

/**
 * @param {JxElement | JxMutableNode | string} def
 * @param {Map<string, { key: string; exportName: string; src: string }>} entries
 */
function _walkServerEntries(def, entries) {
  if (!def || typeof def !== "object") return;
  if (def.state) {
    for (const [key, d] of Object.entries(def.state)) {
      const entry = /** @type {JxMutableNode} */ (d);
      if (
        entry &&
        typeof entry === "object" &&
        entry.timing === "server" &&
        entry.$src &&
        entry.$export &&
        !entry.$prototype
      ) {
        entries.set(entry.$export, { key, exportName: entry.$export, src: entry.$src });
      }
    }
  }
  if (Array.isArray(def.children)) {
    def.children.forEach((/** @type {JxElement | JxMutableNode | string} */ c) =>
      _walkServerEntries(c, entries),
    );
  }
}

// ─── Component pre-rendering ─────────────────────────────────────────────────

/** @type {Set<string>} */
const SELF_CLOSING = new Set(["input", "br", "hr", "img", "meta", "link", "area", "col", "source"]);

/**
 * Recursively render a Jx node tree to static HTML for pre-rendering.
 *
 * @param {JxElement | JxMutableNode | string} node
 * @param {Record<string, unknown>} scope
 * @param {string | null} [slotContent] - HTML to substitute for `<slot>` elements
 * @returns {string}
 */
export function renderStaticNode(node, scope, slotContent = null) {
  if (typeof node === "string") {
    if (isTemplateString(node) && scope) {
      const val = evaluateStaticTemplate(node, scope);
      return val != null ? escapeHtml(String(val)) : escapeHtml(node);
    }
    return escapeHtml(node);
  }
  if (typeof node === "number" || typeof node === "boolean") return escapeHtml(String(node));
  if (Array.isArray(node))
    return node
      .map((/** @type {JxElement | JxMutableNode | string} */ c) =>
        renderStaticNode(c, scope, slotContent),
      )
      .join("\n");
  if (!node || typeof node !== "object") return "";

  // Skip mapped arrays — can't pre-render dynamic lists
  if (node.$prototype === "Array") return "";

  const tag = node.tagName ?? "div";

  // Replace <slot> with provided slot content
  if (tag === "slot" && slotContent != null) return slotContent;

  const attrs = buildAttrs(node, scope);

  if (SELF_CLOSING.has(tag)) return `<${tag}${attrs}>`;

  let inner = "";
  if (node.textContent !== undefined) {
    const val = resolveStaticValue(node.textContent, scope);
    inner = val != null ? escapeHtml(String(val)) : "";
  } else if (node.innerHTML) {
    const val = resolveStaticValue(node.innerHTML, scope);
    inner = val != null ? String(val) : /** @type {string} */ (node.innerHTML);
  } else if (Array.isArray(node.children)) {
    inner = node.children
      .map((/** @type {JxElement | JxMutableNode | string} */ c) =>
        renderStaticNode(c, scope, slotContent),
      )
      .join("\n");
  }

  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Pre-render a component definition to static HTML for its inner content.
 *
 * @param {JxElement} doc - Component JSON definition
 * @param {Record<string, unknown> | null} [propsOverride] - Instance-specific prop values to merge
 *   into state
 * @param {string | null} [slotContent] - HTML to substitute for `<slot>` elements
 * @returns {string} The pre-rendered innerHTML
 */
export function preRenderComponentHtml(doc, propsOverride = null, slotContent = null) {
  /** @type {Record<string, JxStateDefinition>} */
  let stateDefs = doc.state ?? {};
  if (propsOverride) {
    stateDefs = { ...stateDefs };
    for (const [key, value] of Object.entries(propsOverride)) {
      if (key in stateDefs) {
        const existing = stateDefs[key];
        if (
          existing &&
          typeof existing === "object" &&
          !Array.isArray(existing) &&
          "default" in existing
        ) {
          stateDefs[key] = { .../** @type {JxStateObject} */ (existing), default: value };
        } else {
          stateDefs[key] = /** @type {JxStateDefinition} */ (value);
        }
      } else {
        stateDefs[key] = /** @type {JxStateDefinition} */ (value);
      }
    }
  }
  const scope = buildInitialScope(stateDefs, null);
  if (!Array.isArray(doc.children)) return "";
  return doc.children
    .map((/** @type {JxElement | JxMutableNode | string} */ c) =>
      renderStaticNode(c, scope, slotContent),
    )
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
export function isComponentFullyStatic(doc) {
  return _isStaticNode(doc);
}

/**
 * @param {JxElement | string | (JxElement | string)[]} node
 * @returns {boolean}
 */
function _isStaticNode(node) {
  if (!node || typeof node !== "object") return true;
  if (Array.isArray(node)) return node.every(_isStaticNode);

  // Check for $prototype (Functions, Request, Storage, etc.)
  if (node.$prototype) return false;
  // Check for $ref
  if (node.$ref) return false;

  // Check state entries
  if (node.state) {
    for (const def of Object.values(node.state)) {
      if (!def || typeof def !== "object") continue;
      const d = /** @type {JxMutableNode} */ (def);
      if (d.$prototype) return false;
      if (d.$ref) return false;
    }
  }

  // Check for event handlers
  for (const key of Object.keys(node)) {
    if (key.startsWith("on") && key !== "observedAttributes") return false;
  }

  // Recurse into children
  if (Array.isArray(node.children)) {
    if (!node.children.every(_isStaticNode)) return false;
  } else if (node.children && typeof node.children === "object") {
    // children descriptor object ($prototype: "Array", etc.)
    if (node.children.$prototype) return false;
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
export function buildComponentCSS(tagName, styleDef, doc = null, mediaQueries = {}) {
  /** @type {string[]} */
  const rules = [];

  if (styleDef && typeof styleDef === "object") {
    /** @type {string[]} */
    const decls = [];
    for (const [prop, value] of Object.entries(styleDef)) {
      if (
        prop.startsWith(":") ||
        prop.startsWith(".") ||
        prop.startsWith("&") ||
        prop.startsWith("[") ||
        prop.startsWith("@")
      )
        continue;
      if (value === null || typeof value === "object") continue;
      if (typeof value === "string" && isTemplateString(value)) continue;
      decls.push(`  ${camelToKebab(prop)}: ${value};`);
    }
    if (decls.length > 0) {
      rules.push(`${tagName} {\n${decls.join("\n")}\n}`);
    }

    for (const [prop, val] of Object.entries(styleDef)) {
      if (prop.startsWith("@")) {
        const query = prop.startsWith("@--")
          ? (mediaQueries[prop.slice(1)] ?? prop.slice(1))
          : prop.slice(1);
        rules.push(`@media ${query} { ${tagName} { ${toCSSText(/** @type {object} */ (val))} } }`);
      } else if (
        prop.startsWith(":") ||
        prop.startsWith(".") ||
        prop.startsWith("&") ||
        prop.startsWith("[")
      ) {
        const resolved = prop.startsWith("&") ? prop.replace("&", tagName) : `${tagName}${prop}`;
        rules.push(`${resolved} { ${toCSSText(/** @type {object} */ (val))} }`);
      }
    }
  }

  if (doc && Array.isArray(doc.children)) {
    const counter = { n: 0 };
    for (const child of doc.children) {
      collectStyles(child, rules, mediaQueries, "", counter, tagName);
    }
  }

  return rules.length > 0 ? rules.join("\n") + "\n" : "";
}
