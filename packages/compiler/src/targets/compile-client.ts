/**
 * Compile-client.js — Pre-rendered HTML with reactive bindings
 *
 * Produces clean HTML with `data-bind` marker attributes and a small JS bootstrapper using
 * vue/reactivity's `effect` + `computed`.
 *
 * Functions whose body contains `return` become computed() on state. Mapped arrays ($prototype:
 * "Array") use lit-html for efficient rendering.
 *
 * Output pattern: HTML: pre-rendered with data-bind, :prop="key", @event="key" JS: state (reactive
 * state + computed signals), bind (DOM getters), on (event handlers), hydrate()
 */

import { camelToKebab, RESERVED_KEYS } from "@jxsuite/runtime";
import {
  isSchemaOnly,
  isTemplateString,
  isRefObject,
  resolveStaticValue,
  createCompileContext,
  buildAttrs,
  compileStyles,
  escapeHtml,
  DEFAULT_REACTIVITY_SRC,
  DEFAULT_LIT_HTML_SRC,
  compileExpression,
  isMutating,
} from "../shared";
import type { JxStyle } from "@jxsuite/schema/types";

/**
 * Compile a Jx document to pre-rendered HTML + reactive JS module.
 *
 * @param {JxMutableNode | Record<string, any>} raw
 * @param {Record<string, unknown>} opts
 * @returns {{ html: string; files: { path: string; content: string }[] }}
 */
export function compileClient(
  raw: JxMutableNode | Record<string, any>,
  opts: Record<string, unknown>,
) {
  const {
    title,
    reactivitySrc = DEFAULT_REACTIVITY_SRC,
    litHtmlSrc = DEFAULT_LIT_HTML_SRC,
    modulePath = "app.js",
  } = opts as JxMutableNode;

  const context = createCompileContext(raw, null, raw.state ?? {}, raw.$media ?? {});
  const styleBlock = compileStyles(
    raw,
    raw.$media ?? {},
    (opts.projectStyle ?? null) as JxStyle | null,
  );

  // Collectors for bindings and handlers
  const counter = { t: 0, s: 0, h: 0, m: 0, sw: 0, l: 0, needsLit: false };
  const bindings: Map<string, string> = new Map(); // key → expression string
  const handlers: Map<string, any> = new Map(); // key → { body, args }

  // Classify state entries into reactive state, computed, bind, on, and init blocks
  const stateEntries: [string, any][] = []; // [key, initValue]  → reactive({...})
  const computedEntries: [string, string][] = []; // [key, bodyExpr]   → state.key = computed(...)
  const bindEntries: [string, string][] = []; // [key, bodyExpr]   → bind = {...}
  const onEntries: [string, any][] = []; // [key, { args, body }] → on = {...}
  const initBlocks: string[] = []; // lines emitted after state for prototype init

  // Map $src path → Set of function names to import
  const srcImportMap: Map<string, Set<string>> = new Map();

  const defs = raw.state ?? {};
  for (const [key, def] of Object.entries(defs)) {
    if (def === null || typeof def !== "object" || Array.isArray(def)) {
      // Naked primitive or array → reactive state
      if (typeof def === "string" && isTemplateString(def)) {
        // Template string → computed on state so other computeds can ref it
        computedEntries.push([key, "() => `" + def + "`"]);
      } else {
        stateEntries.push([key, def]);
      }
      continue;
    }

    const d = def as JxMutableNode;

    // $expression: Shape 5
    if ("$expression" in d) {
      const node = (d as any).$expression;
      if (isMutating(node.operator)) {
        const compiled = compileExpression(node, { statePrefix: "state", eventParam: "e" });
        onEntries.push([key, { args: ["state", "e"], body: compiled }]);
      } else {
        const compiled = compileExpression(node, { statePrefix: "state", eventParam: "e" });
        computedEntries.push([key, `() => ${compiled}`]);
      }
      continue;
    }

    // $prototype: "Function"
    if (d.$prototype === "Function") {
      const args = d.parameters ?? d.arguments;
      if (d.$src) {
        if (!srcImportMap.has(d.$src)) srcImportMap.set(d.$src, new Set());
        (srcImportMap.get(d.$src) as Set<string>).add(key);

        // $src functions always produce computed entries (they return values)
        computedEntries.push([key, "() => { return " + key + "(state); }"]);
      } else if (d.body && d.body.includes("return")) {
        // Body contains return → computed
        computedEntries.push([key, "() => { " + d.body + " }"]);
      } else {
        // No return → event handler
        onEntries.push([key, { args: args ?? ["state"], body: d.body }]);
      }
      continue;
    }

    // Pure schema-only type def → skip
    if (isSchemaOnly(d)) continue;

    // Expanded signal with default
    if ("default" in d && !d.$prototype) {
      stateEntries.push([key, d.default]);
      continue;
    }

    // $prototype: "LocalStorage" / "SessionStorage"
    if (d.$prototype === "LocalStorage" || d.$prototype === "SessionStorage") {
      const storeName = d.$prototype === "LocalStorage" ? "localStorage" : "sessionStorage";
      const storageKey = d.key ?? key;
      const defaultVal = d.default ?? null;
      stateEntries.push([key, null]);
      initBlocks.push(emitStorageInit(key, storeName, storageKey, defaultVal));
      continue;
    }

    // $prototype: "Request"
    if (d.$prototype === "Request") {
      stateEntries.push([key, null]);
      initBlocks.push(emitRequestInit(key, d));
      continue;
    }

    // $prototype: "Cookie"
    if (d.$prototype === "Cookie") {
      stateEntries.push([key, null]);
      initBlocks.push(emitCookieInit(key, d.name ?? key, d.default ?? null));
      continue;
    }

    // Plain object → reactive state
    stateEntries.push([key, d]);
  }

  // Build HTML tree with data-bind markers
  const bodyContent = buildClientNode(raw, raw, context, bindings, handlers, counter);

  // Merge inline-discovered bindings/handlers
  for (const [key, expr] of bindings) {
    if (!bindEntries.some(([k]) => k === key)) {
      bindEntries.push([key, expr]);
    }
  }
  for (const [key, def] of handlers) {
    if (!onEntries.some(([k]) => k === key)) {
      onEntries.push([key, def]);
    }
  }

  // Generate the JS module
  const moduleContent = emitClientModule(
    stateEntries,
    computedEntries,
    bindEntries,
    onEntries,
    initBlocks,
    srcImportMap,
    counter,
    reactivitySrc,
  );

  // Build importmap entries — always include lit-html since compiled custom elements need it
  const importmapEntries = [
    `      "@vue/reactivity": "${reactivitySrc}"`,
    `      "lit-html": "${litHtmlSrc}"`,
  ];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <script type="importmap">
  {
    "imports": {
${importmapEntries.join(",\n")}
    }
  }
  </script>
  ${styleBlock}
  <script type="module" src="./${modulePath}"></script>
</head>
<body>
  ${bodyContent}
</body>
</html>`;

  return { html, files: [{ path: modulePath, content: moduleContent }] };
}

// ─── HTML tree walker ─────────────────────────────────────────────────────────

/**
 * @param {JxMutableNode} def
 * @param {JxMutableNode} raw
 * @param {any} context
 * @param {Map<string, string>} bindings
 * @param {Map<string, any>} handlers
 * @param {{
 *   t: number;
 *   s: number;
 *   h: number;
 *   m: number;
 *   sw: number;
 *   l: number;
 *   needsLit: boolean;
 * }} counter
 * @returns {string}
 */
function buildClientNode(
  def: JxMutableNode,
  raw: JxMutableNode,
  context: any,
  bindings: Map<string, string>,
  handlers: Map<string, any>,
  counter: { t: number; s: number; h: number; m: number; sw: number; l: number; needsLit: boolean },
) {
  // String children are text nodes
  if (typeof def === "string") {
    return escapeHtml(def);
  }
  if (typeof def === "number" || typeof def === "boolean") {
    return escapeHtml(String(def));
  }
  if (!def || typeof def !== "object") return "";

  const nextContext = createCompileContext(
    raw,
    context.scope,
    raw?.state ?? context.scopeDefs,
    raw?.$media ?? context.media,
  );

  const tag = def.tagName ?? "div";
  const bindAttrs = [];
  let needsBind = false;

  // textContent bindings
  if (def.textContent !== undefined) {
    const tc = raw?.textContent ?? (def.textContent as unknown as JxMutableNode);
    if (isRefObject(tc)) {
      const key = refToBindingKey((tc as JxMutableNode).$ref as string);
      bindAttrs.push(`:text-content="${key}"`);
      addRefBinding(bindings, key, (tc as JxMutableNode).$ref as string);
      needsBind = true;
    } else if (isTemplateString(tc)) {
      const key = `_t${counter.t++}`;
      bindAttrs.push(`:text-content="${key}"`);
      bindings.set(key, "() => `" + tc + "`");
      needsBind = true;
    }
  }

  // Event handlers (onclick, oninput, etc.)
  for (const [prop, val] of Object.entries(def)) {
    if (!prop.startsWith("on") || prop === "observedAttributes") continue;
    const eventName = prop.slice(2).toLowerCase();
    if (isRefObject(val)) {
      const key = refToBindingKey((val as JxMutableNode).$ref as string);
      bindAttrs.push(`@${eventName}="${key}"`);
      needsBind = true;
    } else if (val && typeof val === "object" && (val as JxMutableNode).$prototype === "Function") {
      const v = val as JxMutableNode;
      const key = `_h${counter.h++}`;
      bindAttrs.push(`@${eventName}="${key}"`);
      handlers.set(key, { args: v.parameters ?? v.arguments ?? ["state", "event"], body: v.body });
      needsBind = true;
    } else if (val && typeof val === "object" && "$expression" in /** @type {any} */ (val)) {
      const key = `_h${counter.h++}`;
      bindAttrs.push(`@${eventName}="${key}"`);
      const compiled = compileExpression((val as any).$expression, {
        statePrefix: "state",
        eventParam: "e",
      });
      handlers.set(key, { args: ["state", "e"], body: compiled });
      needsBind = true;
    }
  }

  // Dynamic style properties
  if (def.style && typeof def.style === "object") {
    for (const [prop, val] of Object.entries(def.style)) {
      if (
        prop.startsWith(":") ||
        prop.startsWith(".") ||
        prop.startsWith("&") ||
        prop.startsWith("[") ||
        prop.startsWith("@")
      )
        continue;
      if (val === null || typeof val === "object") continue;
      if (isTemplateString(val)) {
        const key = `_s${counter.s++}`;
        bindAttrs.push(`:style.${camelToKebab(prop)}="${key}"`);
        bindings.set(key, "() => `" + val + "`");
        needsBind = true;
      }
    }
  }

  // Dynamic attributes
  if (def.attributes && typeof def.attributes === "object") {
    for (const [attr, val] of Object.entries(def.attributes)) {
      if (isRefObject(val)) {
        const key = refToBindingKey((val as JxMutableNode).$ref as string);
        bindAttrs.push(`:attr.${attr}="${key}"`);
        addRefBinding(bindings, key, (val as JxMutableNode).$ref as string);
        needsBind = true;
      } else if (isTemplateString(val)) {
        const key = `_t${counter.t++}`;
        bindAttrs.push(`:attr.${attr}="${key}"`);
        bindings.set(key, "() => `" + val + "`");
        needsBind = true;
      }
    }
  }

  // Dynamic non-reserved properties (hidden, value, etc.)
  for (const [prop, val] of Object.entries(def)) {
    if (
      RESERVED_KEYS.has(prop) ||
      prop.startsWith("on") ||
      prop.startsWith("$") ||
      prop === "tagName" ||
      prop === "id" ||
      prop === "className" ||
      prop === "style" ||
      prop === "children" ||
      prop === "textContent" ||
      prop === "innerHTML" ||
      prop === "attributes"
    )
      continue;
    if (isRefObject(val)) {
      const key = refToBindingKey((val as JxMutableNode).$ref as string);
      bindAttrs.push(`:${camelToKebab(prop)}="${key}"`);
      addRefBinding(bindings, key, (val as JxMutableNode).$ref as string);
      needsBind = true;
    } else if (isTemplateString(val)) {
      const key = `_t${counter.t++}`;
      bindAttrs.push(`:${camelToKebab(prop)}="${key}"`);
      bindings.set(key, "() => `" + val + "`");
      needsBind = true;
    }
  }

  // Build static attrs
  const staticAttrs = buildAttrs(def, nextContext.scope);
  const dataBindAttr = needsBind ? " data-bind" : "";
  const bindAttrStr = bindAttrs.length > 0 ? " " + bindAttrs.join(" ") : "";

  // Inner content
  let inner = "";
  const source = raw ?? def;
  if (source.textContent !== undefined && !needsBind) {
    const value = resolveStaticValue(source.textContent, nextContext.scope);
    inner = value == null ? "" : escapeHtml(String(value));
  } else if (source.textContent !== undefined && needsBind) {
    const value = resolveStaticValue(source.textContent, nextContext.scope);
    inner = value == null ? "" : escapeHtml(String(value));
  } else if (source.innerHTML) {
    // resolveStaticValue may return null if innerHTML contains `${` from rendered content
    // (e.g., code examples) that isn't an actual template expression. Fall back to raw value.
    inner = (resolveStaticValue(source.innerHTML, nextContext.scope) as string) ?? source.innerHTML;
  } else if (
    source.children &&
    typeof source.children === "object" &&
    !Array.isArray(source.children) &&
    (source.children as JxMutableNode).$prototype === "Array"
  ) {
    // ─── Mapped array → lit-html render binding ───
    counter.needsLit = true;
    const listKey = `_list${counter.l++}`;
    const arrayDef = source.children as JxMutableNode;

    // Resolve items source expression
    let itemsExpr;
    if (isRefObject(arrayDef.items)) {
      const path = refToBindingKey(arrayDef.items.$ref);
      itemsExpr = "state." + path;
    } else {
      itemsExpr = JSON.stringify(arrayDef.items);
    }

    // Compile the map template to a lit-html template string
    const litTemplate = emitLitMapTemplate(arrayDef.map);
    bindings.set(
      listKey,
      "() => (" + itemsExpr + " ?? []).map((item, index) => html`" + litTemplate + "`)",
    );

    bindAttrs.push(`:render="${listKey}"`);
    needsBind = true;
    // Re-derive the data-bind/attr strings since we added to bindAttrs
    const dataBindAttr2 = " data-bind";
    const bindAttrStr2 = " " + bindAttrs.join(" ");
    const selfClosing = new Set(["input", "br", "hr", "img", "meta", "link"]);
    if (selfClosing.has(tag)) {
      return `<${tag}${staticAttrs}${dataBindAttr2}${bindAttrStr2}>`;
    }
    return `<${tag}${staticAttrs}${dataBindAttr2}${bindAttrStr2}></${tag}>`;
  } else if (Array.isArray(source.children)) {
    const rawChildren = raw?.children;
    inner = source.children
      .map((c, i) => {
        const childRaw = rawChildren?.[i] ?? c;
        return buildClientNode(
          c as unknown as JxMutableNode,
          childRaw as unknown as JxMutableNode,
          nextContext,
          bindings,
          handlers,
          counter,
        );
      })
      .join("\n  ");
  }

  // Self-closing tags
  const selfClosing = new Set(["input", "br", "hr", "img", "meta", "link"]);
  if (selfClosing.has(tag)) {
    return `<${tag}${staticAttrs}${dataBindAttr}${bindAttrStr}>`;
  }

  return `<${tag}${staticAttrs}${dataBindAttr}${bindAttrStr}>${inner}</${tag}>`;
}

// ─── Lit-html map template generation ─────────────────────────────────────────

/**
 * Compile a map definition to a lit-html template string. Converts $map.item → item, $map.index →
 * index.
 *
 * @param {JxMutableNode} def
 * @returns {string}
 */
function emitLitMapTemplate(def: JxMutableNode) {
  if (!def) return "";
  const tag = def.tagName ?? "div";
  let attrs = "";

  if (def.id) attrs += ' id="' + def.id + '"';
  if (def.className) attrs += ' class="' + mapRefsToLit(def.className) + '"';

  // attributes object
  if (def.attributes && typeof def.attributes === "object") {
    for (const [k, v] of Object.entries(def.attributes)) {
      if (typeof v === "string" && isTemplateString(v)) {
        attrs += " " + k + '="' + mapRefsToLit(v) + '"';
      } else {
        attrs += " " + k + '="' + escapeHtml(String(v)) + '"';
      }
    }
  }

  // style → inline CSS
  if (def.style && typeof def.style === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(def.style)) {
      if (
        k.startsWith(":") ||
        k.startsWith(".") ||
        k.startsWith("&") ||
        k.startsWith("[") ||
        k.startsWith("@")
      )
        continue;
      if (v === null || typeof v === "object") continue;
      const cssProp = camelToKebab(k);
      if (isTemplateString(String(v))) {
        parts.push(cssProp + ": " + mapRefsToLit(String(v)));
      } else {
        parts.push(cssProp + ": " + v);
      }
    }
    if (parts.length > 0) {
      attrs += ' style="' + parts.join("; ") + '"';
    }
  }

  // Event handlers in map template
  for (const [prop, val] of Object.entries(def)) {
    if (!prop.startsWith("on") || prop === "observedAttributes") continue;
    const eventName = prop.slice(2).toLowerCase();
    if (isRefObject(val)) {
      const key = refToBindingKey((val as JxMutableNode).$ref as string);
      attrs += " @" + eventName + "=${(e) => { state.$map = { item, index }; on." + key + "(e); }}";
    } else if (val && typeof val === "object" && (val as JxMutableNode).$prototype === "Function") {
      const body = mapRefsToLit((val as JxMutableNode).body as string);
      attrs += " @" + eventName + "=${(e) => { " + body + " }}";
    } else if (val && typeof val === "object" && "$expression" in /** @type {any} */ (val)) {
      const compiled = compileExpression((val as any).$expression, {
        statePrefix: "state",
        eventParam: "e",
      });
      attrs += " @" + eventName + "=${(e) => { state.$map = { item, index }; " + compiled + "; }}";
    }
  }

  // Non-reserved properties that render as attributes
  if (def.contentEditable) {
    attrs += ' contenteditable="' + def.contentEditable + '"';
  }

  // Inner content
  let inner = "";
  if (def.textContent !== undefined) {
    const tc = String(def.textContent);
    if (isTemplateString(tc)) {
      inner = mapRefsToLit(tc);
    } else if (isRefObject(def.textContent)) {
      const path = refToBindingKey((def.textContent as unknown as JxMutableNode).$ref as string);
      inner = "${state." + path + "}";
    } else {
      inner = escapeHtml(tc);
    }
  } else if (def.innerHTML) {
    inner = mapRefsToLit(String(def.innerHTML));
  } else if (Array.isArray(def.children)) {
    inner =
      "\n      " +
      def.children.map((c) => emitLitMapTemplate(c as JxMutableNode)).join("\n      ") +
      "\n    ";
  }

  const voidTags = new Set(["input", "br", "hr", "img", "meta", "link"]);
  if (voidTags.has(tag)) return "<" + tag + attrs + ">";
  return "<" + tag + attrs + ">" + inner + "</" + tag + ">";
}

/**
 * Replace $map references: $map.item → item, $map.index → index
 *
 * @param {string} str
 * @returns {string}
 */
function mapRefsToLit(str: string) {
  return str.replace(/\$map\./g, "");
}

// ─── JS module generation ─────────────────────────────────────────────────────

/**
 * @param {[string, any][]} stateEntries
 * @param {[string, string][]} computedEntries
 * @param {[string, string][]} bindEntries
 * @param {[string, any][]} onEntries
 * @param {string[]} initBlocks
 * @param {Map<string, Set<string>>} srcImportMap
 * @param {{
 *   t: number;
 *   s: number;
 *   h: number;
 *   m: number;
 *   sw: number;
 *   l: number;
 *   needsLit: boolean;
 * }} counter
 * @param {string} _reactivitySrc
 * @returns {string}
 */
function emitClientModule(
  stateEntries: [string, any][],
  computedEntries: [string, string][],
  bindEntries: [string, string][],
  onEntries: [string, any][],
  initBlocks: string[],
  srcImportMap: Map<string, Set<string>>,
  counter: { t: number; s: number; h: number; m: number; sw: number; l: number; needsLit: boolean },
  _reactivitySrc: string,
) {
  const lines: string[] = [];
  const needsLit = counter.needsLit;
  const needsComputed = computedEntries.length > 0;

  lines.push("// Generated by @jxsuite/compiler — do not edit manually");

  // Reactivity imports
  const reactivityImports = ["reactive", "effect"];
  if (needsComputed) reactivityImports.push("computed");
  lines.push("import { " + reactivityImports.join(", ") + " } from '@vue/reactivity';");

  // lit-html imports (only when arrays are present)
  if (needsLit) {
    lines.push("import { html, render } from 'lit-html';");
  }

  // $src imports
  for (const [src, names] of srcImportMap) {
    lines.push("import { " + [...names].join(", ") + " } from '" + src + "';");
  }

  lines.push("");

  // state — reactive state
  lines.push("const state = reactive({");
  for (const [key, val] of stateEntries) {
    lines.push("  " + key + ": " + JSON.stringify(val) + ",");
  }
  lines.push("});");
  lines.push("");

  // Prototype init blocks (Request fetch, LocalStorage read, etc.)
  if (initBlocks.length > 0) {
    for (const block of initBlocks) {
      lines.push(block);
    }
    lines.push("");
  }

  // Computed signals on state
  if (computedEntries.length > 0) {
    for (const [key, expr] of computedEntries) {
      lines.push("state." + key + " = computed(" + expr + ");");
    }
    lines.push("");
  }

  // bind — DOM getters
  if (bindEntries.length > 0) {
    lines.push("const bind = {");
    for (const [key, expr] of bindEntries) {
      lines.push("  " + key + ": " + expr + ",");
    }
    lines.push("};");
  } else {
    lines.push("const bind = {};");
  }
  lines.push("");

  // on — event handlers
  if (onEntries.length > 0) {
    lines.push("const on = {");
    for (const [key, def] of onEntries) {
      const argNames = def.args ?? ["state"];
      const callArgs = argNames.map((a: string) => (a === "state" ? "state" : "e")).join(", ");
      lines.push(
        "  " +
          key +
          ": (e) => { const fn = (" +
          argNames.join(", ") +
          ") => { " +
          def.body +
          " }; fn(" +
          callArgs +
          "); },",
      );
    }
    lines.push("};");
  } else {
    lines.push("const on = {};");
  }
  lines.push("");

  // Hydration function
  lines.push("function hydrate(root) {");
  lines.push("  root.querySelectorAll('[data-bind]').forEach(el => {");
  lines.push("    [...el.attributes].forEach(a => {");
  lines.push("      if (a.name.startsWith(':')) {");
  lines.push("        const parts = a.name.slice(1).split('.');");
  lines.push("        const key = a.value;");
  if (needsLit) {
    lines.push("        if (parts[0] === 'render') {");
    lines.push("          effect(() => { render(bind[key](), el); });");
    lines.push("        } else if (parts[0] === 'style' && parts.length > 1) {");
  } else {
    lines.push("        if (parts[0] === 'style' && parts.length > 1) {");
  }
  lines.push("          effect(() => { el.style[parts[1]] = bind[key](); });");
  lines.push("        } else if (parts[0] === 'attr' && parts.length > 1) {");
  lines.push("          effect(() => { el.setAttribute(parts[1], bind[key]()); });");
  lines.push("        } else {");
  lines.push("          const prop = parts[0].replace(/-([a-z])/g, (_, c) => c.toUpperCase());");
  lines.push("          effect(() => { el[prop] = bind[key](); });");
  lines.push("        }");
  lines.push("      } else if (a.name.startsWith('@')) {");
  lines.push("        el.addEventListener(a.name.slice(1), on[a.value]);");
  lines.push("      }");
  lines.push("    });");
  lines.push("  });");
  lines.push("}");
  lines.push("");
  lines.push("hydrate(document);");
  lines.push("");

  return lines.join("\n");
}

// ─── Prototype init emitters ─────────────────────────────────────────────────

/**
 * @param {string} key
 * @param {JxMutableNode} def
 * @returns {string}
 */
function emitRequestInit(key: string, def: JxMutableNode) {
  const url = def.url;
  const method = def.method ?? "GET";
  const isTemplateUrl = isTemplateString(url);

  if (def.manual) {
    return "// " + key + ": manual Request — fetch triggered by user action";
  }

  const lines: string[] = [];
  lines.push("// " + key + ": auto-fetch from " + (isTemplateUrl ? "(dynamic URL)" : url));
  lines.push("effect(() => {");

  if (isTemplateUrl) {
    lines.push("  const url = `" + url + "`;");
    lines.push('  if (!url || url === "undefined" || url.includes("undefined")) return;');
  } else {
    lines.push("  const url = " + JSON.stringify(url) + ";");
  }

  const fetchOpts: string[] = [];
  if (method !== "GET") fetchOpts.push("method: " + JSON.stringify(method));
  if (def.headers) fetchOpts.push("headers: " + JSON.stringify(def.headers));
  if (def.body) {
    const bodyStr =
      typeof def.body === "object"
        ? JSON.stringify(JSON.stringify(def.body))
        : JSON.stringify(def.body);
    fetchOpts.push("body: " + bodyStr);
  }

  const optsStr = fetchOpts.length > 0 ? ", { " + fetchOpts.join(", ") + " }" : "";
  lines.push("  fetch(url" + optsStr + ")");
  lines.push("    .then(r => r.ok ? r.json() : Promise.reject(r.statusText))");
  lines.push("    .then(d => { state." + key + " = d; })");
  lines.push("    .catch(e => { state." + key + " = { error: String(e) }; });");
  lines.push("});");

  return lines.join("\n");
}

/**
 * @param {string} key
 * @param {string} storeName
 * @param {string} storageKey
 * @param {unknown} defaultVal
 * @returns {string}
 */
function emitStorageInit(key: string, storeName: string, storageKey: string, defaultVal: unknown) {
  const lines: string[] = [];
  lines.push("// " + key + ": " + storeName + ' (key: "' + storageKey + '")');
  lines.push("try {");
  lines.push("  const _s = " + storeName + ".getItem(" + JSON.stringify(storageKey) + ");");
  lines.push(
    "  state." + key + " = _s !== null ? JSON.parse(_s) : " + JSON.stringify(defaultVal) + ";",
  );
  lines.push("} catch { state." + key + " = " + JSON.stringify(defaultVal) + "; }");
  lines.push("effect(() => {");
  lines.push("  const v = state." + key + ";");
  lines.push("  try {");
  lines.push(
    "    if (v === null) " + storeName + ".removeItem(" + JSON.stringify(storageKey) + ");",
  );
  lines.push(
    "    else " + storeName + ".setItem(" + JSON.stringify(storageKey) + ", JSON.stringify(v));",
  );
  lines.push("  } catch {}");
  lines.push("});");
  return lines.join("\n");
}

/**
 * @param {string} key
 * @param {string} cookieName
 * @param {unknown} defaultVal
 * @returns {string}
 */
function emitCookieInit(key: string, cookieName: string, defaultVal: unknown) {
  const lines: string[] = [];
  lines.push("// " + key + ': Cookie (name: "' + cookieName + '")');
  lines.push("{");
  lines.push(
    '  const _m = document.cookie.match(new RegExp("(?:^|; )' + cookieName + '=([^;]*)"));',
  );
  lines.push(
    "  try { state." +
      key +
      " = _m ? JSON.parse(decodeURIComponent(_m[1])) : " +
      JSON.stringify(defaultVal) +
      "; }",
  );
  lines.push("  catch { state." + key + " = _m ? _m[1] : " + JSON.stringify(defaultVal) + "; }");
  lines.push("}");
  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {string} ref
 * @returns {string}
 */
function refToBindingKey(ref: string) {
  if (ref.startsWith("#/state/")) {
    return ref.slice("#/state/".length).replace(/\//g, "_");
  }
  return ref.replace(/\//g, "_");
}

/**
 * @param {Map<string, string>} bindings
 * @param {string} key
 * @param {string} ref
 */
function addRefBinding(bindings: Map<string, string>, key: string, ref: string) {
  if (bindings.has(key)) return;
  if (ref.startsWith("#/state/")) {
    const path = ref.slice("#/state/".length);
    const parts = path.split("/");
    bindings.set(key, "() => state." + parts.join("."));
  } else {
    bindings.set(key, "() => state." + ref);
  }
}
