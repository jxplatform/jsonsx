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

import { RESERVED_KEYS, camelToKebab } from "@jxsuite/runtime";
import {
  DEFAULT_LIT_HTML_SRC,
  DEFAULT_REACTIVITY_SRC,
  buildAttrs,
  childSeparator,
  colorSchemePrePaintScript,
  compileExpression,
  compileStatements,
  compileStyles,
  createCompileContext,
  emitFormulaFn,
  emitRequestFetch,
  escapeHtml,
  isMutating,
  isRefObject,
  isSchemaOnly,
  isTemplateString,
  PREFORMATTED_TAGS,
  pureSchemeOf,
  resolveStaticValue,
  srcImportBinding,
} from "../shared.ts";
import {
  bodyReturnsValue,
  hasStructuredBody,
  isExpandedSignal,
  isExpressionDef,
  isFunctionDef,
  isMappedArray,
  isNamedFormulaDef,
  isPrototypeDef,
  isTagExpression,
  paramNames,
  tagNameCandidates,
} from "@jxsuite/schema/guards";
import type { CompileContext, ExpressionNode } from "../shared.ts";
import {
  escapeToken,
  objectKey,
  refAccessor,
  refBindingKey,
  refSegments,
} from "@jxsuite/runtime/pointer";
import type {
  JsonObject,
  JsonValue,
  JxDocument,
  JxMappedArray,
  JxMutableNode,
  JxStyle,
} from "@jxsuite/schema/types";

/** A compiled event handler entry: parameter names + function body. */
interface HandlerDef {
  args?: string[] | undefined;
  body?: string | undefined;
}

/**
 * Compile a Jx document to pre-rendered HTML + reactive JS module.
 *
 * @param {JxDocument} raw
 * @param {{
 *   title?: string;
 *   reactivitySrc?: string;
 *   litHtmlSrc?: string;
 *   modulePath?: string;
 *   projectStyle?: JxStyle | null;
 * }} opts
 * @returns {{ html: string; files: { path: string; content: string }[] }}
 */
export function compileClient(
  raw: JxDocument,
  opts: {
    title?: string;
    reactivitySrc?: string;
    litHtmlSrc?: string;
    modulePath?: string;
    projectStyle?: JxStyle | null;
    prePaintScheme?: boolean;
    [key: string]: unknown;
  },
) {
  const {
    title = "Jx App",
    reactivitySrc = DEFAULT_REACTIVITY_SRC,
    litHtmlSrc = DEFAULT_LIT_HTML_SRC,
    modulePath = "app.js",
  } = opts;

  const context = createCompileContext(raw, null, raw.state ?? {}, raw.$media ?? {});
  const styleBlock = compileStyles(
    raw,
    raw.$media ?? {},
    (opts.projectStyle ?? null) as JxStyle | null,
  );

  // Collectors for bindings and handlers
  const counter = { h: 0, l: 0, m: 0, needsLit: false, s: 0, sw: 0, t: 0 };
  const bindings = new Map<string, string>(); // Key → expression string
  const handlers = new Map<string, HandlerDef>(); // Key → { body, args }

  // Classify state entries into reactive state, computed, bind, on, and init blocks
  const stateEntries: [string, JsonValue | undefined][] = []; // [key, initValue] → reactive({...})
  const computedEntries: [string, string][] = []; // [key, bodyExpr]   → state.key = computed(...)
  const bindEntries: [string, string][] = []; // [key, bodyExpr]   → bind = {...}
  const onEntries: [string, HandlerDef][] = []; // [key, { args, body }] → on = {...}
  const initBlocks: string[] = []; // Lines emitted after state for prototype init

  // Map $src path → Set of function names to import
  const srcImportMap = new Map<string, Set<string>>();

  const defs = raw.state ?? {};
  for (const [key, def] of Object.entries(defs)) {
    if (def === null || typeof def !== "object" || Array.isArray(def)) {
      // Naked primitive or array → reactive state
      if (typeof def === "string" && isTemplateString(def)) {
        // Template string → computed on state so other computeds can ref it
        computedEntries.push([key, `() => \`${def}\``]);
      } else {
        stateEntries.push([key, def]);
      }
      continue;
    }

    // $expression: Shape 5
    if (isExpressionDef(def)) {
      const node = def.$expression as ExpressionNode;
      const compiled = compileExpression(node, {
        eventParam: "e",
        statePrefix: "state",
      });
      if (isNamedFormulaDef(def)) {
        // Named formula → a scope callable mapping positional args onto declared parameters.
        // Call sites stay positional, matching the interpreter.
        initBlocks.push(`state[${JSON.stringify(key)}] = ${emitFormulaFn(def, compiled)};`);
      } else if (isMutating(node.operator)) {
        onEntries.push([key, { args: ["state", "e"], body: compiled }]);
      } else {
        computedEntries.push([key, `() => ${compiled}`]);
      }
      continue;
    }

    // $prototype: "Function"
    if (isFunctionDef(def)) {
      const args = def.parameters ? paramNames(def.parameters) : def.arguments;
      if (hasStructuredBody(def)) {
        // Structured body (spec §20) → an event handler compiled from statements.
        // With parameters, a positional callable like a named formula.
        const compiled = compileStatements(def.body, { eventParam: "e", statePrefix: "state" });
        if (def.parameters && def.parameters.length > 0) {
          initBlocks.push(
            `state[${JSON.stringify(key)}] = ${emitFormulaFn(def, `(() => {\n${compiled}\n})()`)};`,
          );
        } else {
          onEntries.push([key, { args: ["state", "e"], body: compiled }]);
        }
      } else if (def.$src) {
        if (!srcImportMap.has(def.$src)) {
          srcImportMap.set(def.$src, new Set());
        }
        (srcImportMap.get(def.$src) as Set<string>).add(srcImportBinding(key, def));

        // $src functions always produce computed entries (they return values)
        computedEntries.push([key, `() => { return ${key}(state); }`]);
      } else if (typeof def.body === "string" && bodyReturnsValue(def.body)) {
        // Body contains return → computed
        computedEntries.push([key, `() => { ${def.body} }`]);
      } else {
        // No return → event handler
        onEntries.push([key, { args: args ?? ["state"], body: def.body as string | undefined }]);
      }
      continue;
    }

    // Pure schema-only type def → skip
    if (isSchemaOnly(def)) {
      continue;
    }

    // Expanded signal with default
    if (isExpandedSignal(def)) {
      stateEntries.push([key, def.default]);
      continue;
    }

    if (isPrototypeDef(def)) {
      // $prototype: "LocalStorage" / "SessionStorage"
      if (def.$prototype === "LocalStorage" || def.$prototype === "SessionStorage") {
        const storeName = def.$prototype === "LocalStorage" ? "localStorage" : "sessionStorage";
        const storageKey = def.key ?? key;
        const defaultVal = def.default ?? null;
        stateEntries.push([key, null]);
        initBlocks.push(emitStorageInit(key, storeName, storageKey, defaultVal));
        continue;
      }

      // $prototype: "Request"
      if (def.$prototype === "Request") {
        stateEntries.push([key, null]);
        initBlocks.push(emitRequestFetch(key, def));
        continue;
      }

      // $prototype: "Cookie"
      if (def.$prototype === "Cookie") {
        stateEntries.push([key, null]);
        initBlocks.push(emitCookieInit(key, def.name ?? key, def.default ?? null));
        continue;
      }
    }

    // Plain object → reactive state (parsed JSON, so structurally a JsonObject)
    stateEntries.push([key, def as JsonObject]);
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
    opts.rewriteSrc as ((specifier: string) => string) | undefined,
  );

  // Build importmap entries — always include lit-html since compiled custom elements need it
  const importmapEntries = [
    `      "@vue/reactivity": "${reactivitySrc}"`,
    `      "lit-html": "${litHtmlSrc}"`,
  ];

  // Forced-scheme contract (spec §9.5): restore the persisted scheme before any styles apply
  const prePaint =
    opts.prePaintScheme !== false &&
    Object.values(raw.$media ?? {}).some((q) => pureSchemeOf(String(q)) !== null)
      ? `<script>${colorSchemePrePaintScript()}</script>\n  `
      : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${prePaint}<script type="importmap">
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

  return { files: [{ content: moduleContent, path: modulePath }], html };
}

// ─── HTML tree walker ─────────────────────────────────────────────────────────

/**
 * @param {JxMutableNode} def
 * @param {JxMutableNode} raw
 * @param {CompileContext} context
 * @param {Map<string, string>} bindings
 * @param {Map<string, HandlerDef>} handlers
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
  context: CompileContext,
  bindings: Map<string, string>,
  handlers: Map<string, HandlerDef>,
  counter: {
    t: number;
    s: number;
    h: number;
    m: number;
    sw: number;
    l: number;
    needsLit: boolean;
  },
) {
  // String children are text nodes
  if (typeof def === "string") {
    return escapeHtml(def);
  }
  if (typeof def === "number" || typeof def === "boolean") {
    return escapeHtml(String(def));
  }
  if (!def || typeof def !== "object") {
    return "";
  }

  const nextContext = createCompileContext(
    raw,
    context.scope,
    raw?.state ?? context.scopeDefs,
    raw?.$media ?? context.media,
  );

  /* REFUSED, LOUDLY. A chosen tag has no implementation in this target: the element's identity is
     fixed in the prerendered markup, so there is nothing here to re-choose at hydration the way the
     `$switch` binding below re-chooses a subtree. Emitting a silently wrong element would be an
     instance of the class the tagName pattern was added to end, so a dynamic page that needs a
     chosen tag is told to put the element in a component (which compiles through `compile-element`,
     where the construct is implemented) rather than shipping markup with the wrong tag. */
  if (isTagExpression(def.tagName)) {
    throw new Error(
      "A tag chosen at creation is not supported on a dynamic page yet (candidates: " +
        `${tagNameCandidates(def.tagName).join(", ")}). Move the element into a component, or ` +
        "give it a literal tagName.",
    );
  }
  const tag = def.tagName ?? "div";
  // `white-space` inherits, so once inside a <pre> the whole subtree stays whitespace-significant.
  nextContext.preformatted = context.preformatted === true || PREFORMATTED_TAGS.has(tag);
  const bindAttrs = [];
  let needsBind = false;

  // TextContent bindings
  if (def.textContent !== undefined) {
    const tc = raw?.textContent ?? (def.textContent as unknown as JxMutableNode);
    if (isRefObject(tc)) {
      const key = refToBindingKey((tc as JxMutableNode).$ref as string);
      bindAttrs.push(`:text-content="${key}"`);
      addRefBinding(bindings, key, (tc as JxMutableNode).$ref as string);
      needsBind = true;
    } else if (isTemplateString(tc)) {
      const key = `_t${counter.t}`;
      counter.t += 1;
      bindAttrs.push(`:text-content="${key}"`);
      bindings.set(key, `() => \`${tc}\``);
      needsBind = true;
    }
  }

  // Event handlers (onclick, oninput, etc.)
  for (const [prop, val] of Object.entries(def)) {
    if (!prop.startsWith("on") || prop === "observedAttributes") {
      continue;
    }
    const eventName = prop.slice(2).toLowerCase();
    if (isRefObject(val)) {
      const key = refToBindingKey(val.$ref);
      bindAttrs.push(`@${eventName}="${key}"`);
      needsBind = true;
    } else if (hasStructuredBody(val)) {
      const key = `_h${counter.h}`;
      counter.h += 1;
      bindAttrs.push(`@${eventName}="${key}"`);
      handlers.set(key, {
        args: ["state", "e"],
        body: compileStatements(val.body, { eventParam: "e", statePrefix: "state" }),
      });
      needsBind = true;
    } else if (isFunctionDef(val)) {
      const key = `_h${counter.h}`;
      counter.h += 1;
      bindAttrs.push(`@${eventName}="${key}"`);
      handlers.set(key, {
        args: val.parameters ? paramNames(val.parameters) : (val.arguments ?? ["state", "event"]),
        body: val.body as string | undefined,
      });
      needsBind = true;
    } else if (isExpressionDef(val)) {
      const key = `_h${counter.h}`;
      counter.h += 1;
      bindAttrs.push(`@${eventName}="${key}"`);
      const compiled = compileExpression(val.$expression as ExpressionNode, {
        eventParam: "e",
        statePrefix: "state",
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
      ) {
        continue;
      }
      if (val === null || typeof val === "object") {
        continue;
      }
      if (isTemplateString(val)) {
        const key = `_s${counter.s}`;
        counter.s += 1;
        bindAttrs.push(`:style.${camelToKebab(prop)}="${key}"`);
        bindings.set(key, `() => \`${val}\``);
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
        const key = `_t${counter.t}`;
        counter.t += 1;
        bindAttrs.push(`:attr.${attr}="${key}"`);
        bindings.set(key, `() => \`${val}\``);
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
    ) {
      continue;
    }
    if (isRefObject(val)) {
      const key = refToBindingKey((val as JxMutableNode).$ref as string);
      bindAttrs.push(`:${camelToKebab(prop)}="${key}"`);
      addRefBinding(bindings, key, (val as JxMutableNode).$ref as string);
      needsBind = true;
    } else if (isTemplateString(val)) {
      const key = `_t${counter.t}`;
      counter.t += 1;
      bindAttrs.push(`:${camelToKebab(prop)}="${key}"`);
      bindings.set(key, `() => \`${val}\``);
      needsBind = true;
    }
  }

  // Build static attrs
  const staticAttrs = buildAttrs(def, nextContext.scope);
  const dataBindAttr = needsBind ? " data-bind" : "";
  const bindAttrStr = bindAttrs.length > 0 ? ` ${bindAttrs.join(" ")}` : "";

  // Inner content
  let inner = "";
  const source = raw ?? def;
  if (source.$switch) {
    // ─── $switch → lit-html render binding ───
    // Without this branch the node fell through to the generic element path, which emitted a
    // Container and then looked for `children` to recurse into — `cases` is not `children`, so the
    // Subtree was never visited and the page shipped with the content missing, no error (#127).
    // The container is emitted empty for the same reason the mapped-array branch below is: lit's
    // `render` appends into the container rather than replacing its existing children, so any
    // Prerendered branch would survive alongside the rendered one.
    counter.needsLit = true;
    const swKey = `_sw${counter.sw}`;
    counter.sw += 1;
    const discriminant = isRefObject(source.$switch)
      ? `state.${refToBindingKey((source.$switch as { $ref: string }).$ref)}`
      : `\`${String(source.$switch)}\``;
    const cases = (source.cases ?? {}) as Record<string, JxMutableNode>;
    const caseEntries = Object.entries(cases)
      // An external `$ref` case cannot be fetched at compile time, exactly as in the static target.
      .filter(([, caseDef]) => caseDef && !isRefObject(caseDef))
      .map(
        ([key, caseDef]) =>
          `${JSON.stringify(key)}: html\`${emitChildLit(caseDef, nextContext.preformatted)}\``,
      );
    bindings.set(swKey, `() => ({${caseEntries.join(", ")}})[String(${discriminant})] ?? html\`\``);
    bindAttrs.push(`:render="${swKey}"`);
    const bindAttrStrSwitch = ` ${bindAttrs.join(" ")}`;
    return `<${tag}${staticAttrs} data-bind${bindAttrStrSwitch}></${tag}>`;
  }
  if (source.textContent !== undefined && !needsBind) {
    const value = resolveStaticValue(source.textContent, nextContext.scope);
    inner = value == null ? "" : escapeHtml(String(value));
  } else if (source.textContent !== undefined && needsBind) {
    const value = resolveStaticValue(source.textContent, nextContext.scope);
    inner = value == null ? "" : escapeHtml(String(value));
  } else if (source.innerHTML) {
    // ResolveStaticValue may return null if innerHTML contains `${` from rendered content
    // (e.g., code examples) that isn't an actual template expression. Fall back to raw value.
    inner = (resolveStaticValue(source.innerHTML, nextContext.scope) as string) ?? source.innerHTML;
  } else if (isMappedArray(source.children)) {
    // ─── Mapped array → lit-html render binding ───
    counter.needsLit = true;
    const listKey = `_list${counter.l}`;
    counter.l += 1;
    const arrayDef = source.children;

    // Resolve items source expression
    let itemsExpr;
    if (isRefObject(arrayDef.items)) {
      const path = refToBindingKey(arrayDef.items.$ref);
      itemsExpr = `state.${path}`;
    } else {
      itemsExpr = JSON.stringify(arrayDef.items);
    }

    // Compile the map template to a lit-html template string
    const litTemplate = emitLitMapTemplate(arrayDef.map);
    bindings.set(
      listKey,
      `() => (${itemsExpr} ?? []).map((item, index) => html\`${litTemplate}\`)`,
    );

    bindAttrs.push(`:render="${listKey}"`);
    needsBind = true;
    // Re-derive the data-bind/attr strings since we added to bindAttrs
    const dataBindAttr2 = " data-bind";
    const bindAttrStr2 = ` ${bindAttrs.join(" ")}`;
    const selfClosing = new Set(["input", "br", "hr", "img", "meta", "link"]);
    if (selfClosing.has(tag)) {
      return `<${tag}${staticAttrs}${dataBindAttr2}${bindAttrStr2}>`;
    }
    return `<${tag}${staticAttrs}${dataBindAttr2}${bindAttrStr2}></${tag}>`;
  } else if (Array.isArray(source.children) && source.children.some((c) => isMappedArray(c))) {
    // ─── Children mix static nodes with array pseudo-elements ───
    // Render the whole children region via one lit binding on this element (wrapper-less, one
    // Lit part per element so multiple arrays among siblings don't collide), with each array
    // Member expanded inline as a `.map()` hole.
    counter.needsLit = true;
    const listKey = `_children${counter.l}`;
    counter.l += 1;
    const childrenTpl = source.children
      .map((c) => emitChildLit(c as JxMutableNode, nextContext.preformatted))
      .join(childSeparator(nextContext.preformatted, "      "));
    bindings.set(
      listKey,
      nextContext.preformatted
        ? `() => html\`${childrenTpl}\``
        : `() => html\`\n      ${childrenTpl}\n    \``,
    );
    bindAttrs.push(`:render="${listKey}"`);
    needsBind = true;
    const bindAttrStr2 = ` ${bindAttrs.join(" ")}`;
    return `<${tag}${staticAttrs} data-bind${bindAttrStr2}></${tag}>`;
  } else if (Array.isArray(source.children)) {
    const rawChildren = Array.isArray(raw?.children) ? raw.children : undefined;
    inner = source.children
      .map((c, i) => {
        const childRaw = rawChildren?.[i] ?? c;
        return buildClientNode(
          c as JxMutableNode,
          childRaw as JxMutableNode,
          nextContext,
          bindings,
          handlers,
          counter,
        );
      })
      .join(childSeparator(nextContext.preformatted));
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
 * @param {boolean} [preformatted]
 * @returns {string}
 */
function emitLitMapTemplate(def: JxMutableNode | undefined, preformatted = false) {
  if (!def) {
    return "";
  }
  // Same refusal as `buildClientNode` above, for the repeater's item template — this target has no
  // Branch construct, and a silently wrong element is what the tagName pattern exists to prevent.
  if (isTagExpression(def.tagName)) {
    throw new Error(
      "A tag chosen at creation is not supported inside a dynamic page's repeater yet " +
        `(candidates: ${tagNameCandidates(def.tagName).join(", ")}). Move the item into a ` +
        "component, or give it a literal tagName.",
    );
  }
  const tag = def.tagName ?? "div";
  // `white-space` inherits, so once inside a <pre> the whole subtree stays whitespace-significant.
  const inPre = preformatted || PREFORMATTED_TAGS.has(tag);
  let attrs = "";

  if (def.id) {
    attrs += ` id="${def.id}"`;
  }
  if (def.className) {
    attrs += ` class="${mapRefsToLit(def.className)}"`;
  }

  // $props → lit property bindings. The element target emits these; the client target emitted
  // Nothing, so a component in a list silently received none of its per-item props.
  if (def.$props && typeof def.$props === "object") {
    for (const [k, v] of Object.entries(def.$props)) {
      if (isRefObject(v)) {
        attrs += ` .${k}="\${${mapRefToClientExpr((v as { $ref: string }).$ref)}}"`;
      } else if (typeof v === "string" && isTemplateString(v)) {
        attrs += ` .${k}="${mapRefsToLit(v)}"`;
      } else {
        attrs += ` .${k}="\${${JSON.stringify(v)}}"`;
      }
    }
  }

  // Attributes object
  if (def.attributes && typeof def.attributes === "object") {
    for (const [k, v] of Object.entries(def.attributes)) {
      attrs +=
        typeof v === "string" && isTemplateString(v)
          ? ` ${k}="${mapRefsToLit(v)}"`
          : ` ${k}="${escapeHtml(String(v))}"`;
    }
  }

  // Style → inline CSS
  if (def.style && typeof def.style === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(def.style)) {
      if (
        k.startsWith(":") ||
        k.startsWith(".") ||
        k.startsWith("&") ||
        k.startsWith("[") ||
        k.startsWith("@")
      ) {
        continue;
      }
      if (v === null || typeof v === "object") {
        continue;
      }
      const cssProp = camelToKebab(k);
      if (isTemplateString(String(v))) {
        parts.push(`${cssProp}: ${mapRefsToLit(String(v))}`);
      } else {
        parts.push(`${cssProp}: ${v}`);
      }
    }
    if (parts.length > 0) {
      attrs += ` style="${parts.join("; ")}"`;
    }
  }

  // Event handlers in map template
  for (const [prop, val] of Object.entries(def)) {
    if (!prop.startsWith("on") || prop === "observedAttributes") {
      continue;
    }
    const eventName = prop.slice(2).toLowerCase();
    if (isRefObject(val)) {
      const key = refToBindingKey((val as JxMutableNode).$ref as string);
      attrs += ` @${eventName}=\${(e) => { state.$map = { item, index }; on.${key}(e); }}`;
    } else if (hasStructuredBody(val)) {
      const compiled = compileStatements(val.body, { eventParam: "e", statePrefix: "state" });
      attrs += ` @${eventName}=\${(e) => { state.$map = { item, index }; ${compiled} }}`;
    } else if (val && typeof val === "object" && (val as JxMutableNode).$prototype === "Function") {
      const body = mapRefsToLit((val as JxMutableNode).body as string);
      attrs += ` @${eventName}=\${(e) => { ${body} }}`;
    } else if (val && typeof val === "object" && "$expression" in /** @type {any} */ val) {
      const compiled = compileExpression(
        (val as Record<string, unknown>).$expression as ExpressionNode,
        {
          eventParam: "e",
          statePrefix: "state",
        },
      );
      attrs += ` @${eventName}=\${(e) => { state.$map = { item, index }; ${compiled}; }}`;
    }
  }

  // Non-reserved properties that render as attributes
  if (def.contentEditable) {
    attrs += ` contenteditable="${def.contentEditable}"`;
  }

  // Inner content
  let inner = "";
  if (def.textContent !== undefined) {
    const tc = String(def.textContent);
    if (isTemplateString(tc)) {
      inner = mapRefsToLit(tc);
    } else if (isRefObject(def.textContent)) {
      const path = refToBindingKey((def.textContent as unknown as JxMutableNode).$ref as string);
      inner = `\${state.${path}}`;
    } else {
      inner = escapeHtml(tc);
    }
  } else if (def.innerHTML) {
    inner = mapRefsToLit(String(def.innerHTML));
  } else if (isMappedArray(def.children)) {
    // Legacy whole-children repeater nested inside a map template.
    inner = `\n      ${emitArrayHole(def.children)}\n    `;
  } else if (Array.isArray(def.children)) {
    const rendered = def.children.map((c) => emitChildLit(c, inPre));
    inner = inPre ? rendered.join("") : `\n      ${rendered.join("\n      ")}\n    `;
  }

  const voidTags = new Set(["input", "br", "hr", "img", "meta", "link"]);
  if (voidTags.has(tag)) {
    return `<${tag}${attrs}>`;
  }
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Emit one child of a lit template: a string text node, an array pseudo-element (expanded inline
 * via a `.map()` hole), or a nested element.
 *
 * @param {JxMutableNode | string} c
 * @param {boolean} [preformatted]
 * @returns {string}
 */
function emitChildLit(c: JxMutableNode | string, preformatted = false): string {
  if (typeof c === "string") {
    return isTemplateString(c) ? mapRefsToLit(c) : escapeHtml(c);
  }
  if (typeof c === "number" || typeof c === "boolean") {
    return escapeHtml(String(c));
  }
  if (isMappedArray(c)) {
    return emitArrayHole(c);
  }
  return emitLitMapTemplate(c, preformatted);
}

/**
 * Emit a lit-html `${(items ?? []).map(...)}` hole for a mapped array, expanding its template
 * inline among sibling nodes (wrapper-less).
 *
 * @param {JxMappedArray} arrayDef
 * @returns {string}
 */
function emitArrayHole(arrayDef: JxMappedArray): string {
  const { items } = arrayDef;
  const itemsExpr = isRefObject(items)
    ? `state.${refToBindingKey((items as { $ref: string }).$ref)}`
    : JSON.stringify(items ?? []);
  const tpl = emitLitMapTemplate(arrayDef.map);
  return `\${(${itemsExpr} ?? []).map((item, index) => html\`${tpl}\`)}`;
}

/**
 * Replace $map references: $map.item → item, $map.index → index
 *
 * @param {string} str
 * @returns {string}
 */
function mapRefsToLit(str: string) {
  return str.replaceAll("$map.", "");
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
  stateEntries: [string, JsonValue | undefined][],
  computedEntries: [string, string][],
  bindEntries: [string, string][],
  onEntries: [string, HandlerDef][],
  initBlocks: string[],
  srcImportMap: Map<string, Set<string>>,
  counter: {
    t: number;
    s: number;
    h: number;
    m: number;
    sw: number;
    l: number;
    needsLit: boolean;
  },
  _reactivitySrc: string,
  rewriteSrc?: (specifier: string) => string,
) {
  const lines: string[] = [];
  const { needsLit } = counter;
  const needsComputed = computedEntries.length > 0;

  lines.push("// Generated by @jxsuite/compiler — do not edit manually");

  // Reactivity imports
  const reactivityImports = ["reactive", "effect"];
  if (needsComputed) {
    reactivityImports.push("computed");
  }
  lines.push(`import { ${reactivityImports.join(", ")} } from '@vue/reactivity';`);

  // Lit-html imports (only when arrays are present)
  if (needsLit) {
    lines.push("import { html, render } from 'lit-html';");
  }

  // $src imports — bundleable specifiers (npm:…, ./relative) are rewritten to their /assets/
  // Bundle URL; the site build bundles them after all documents compile (spec.md §12).
  for (const [src, names] of srcImportMap) {
    const importPath = rewriteSrc ? rewriteSrc(src) : src;
    lines.push(`import { ${[...names].join(", ")} } from '${importPath}';`);
  }

  // State — reactive state
  lines.push("", "const state = reactive({");
  for (const [key, val] of stateEntries) {
    /*
     * State keys come from the document, so `{"user.name": 1}` is legal input. Pasting one raw as
     * an identifier emitted `user.name: 1,` — a SyntaxError the build reported as a success.
     */
    lines.push(`  ${objectKey(key)}: ${JSON.stringify(val)},`);
  }
  lines.push("});", "");

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
      lines.push(`${refAccessor("state", escapeToken(key))} = computed(${expr});`);
    }
    lines.push("");
  }

  // Bind — DOM getters
  if (bindEntries.length > 0) {
    lines.push("const bind = {");
    for (const [key, expr] of bindEntries) {
      lines.push(`  ${objectKey(key)}: ${expr},`);
    }
    lines.push("};");
  } else {
    lines.push("const bind = {};");
  }
  lines.push("");

  // On — event handlers
  if (onEntries.length > 0) {
    lines.push("const on = {");
    for (const [key, def] of onEntries) {
      const argNames = def.args ?? ["state"];
      const callArgs = argNames.map((a: string) => (a === "state" ? "state" : "e")).join(", ");
      lines.push(
        `  ${objectKey(key)}: (e) => { const fn = (${argNames.join(", ")}) => { ${def.body} }; fn(${
          callArgs
        }); },`,
      );
    }
    lines.push("};");
  } else {
    lines.push("const on = {};");
  }
  // Hydration function
  lines.push(
    "",
    "function hydrate(root) {",
    "  root.querySelectorAll('[data-bind]').forEach(el => {",
    "    [...el.attributes].forEach(a => {",
    "      if (a.name.startsWith(':')) {",
    "        const parts = a.name.slice(1).split('.');",
    "        const key = a.value;",
  );
  if (needsLit) {
    lines.push(
      "        if (parts[0] === 'render') {",
      "          effect(() => { render(bind[key](), el); });",
      "        } else if (parts[0] === 'style' && parts.length > 1) {",
    );
  } else {
    lines.push("        if (parts[0] === 'style' && parts.length > 1) {");
  }
  lines.push(
    "          effect(() => { el.style[parts[1]] = bind[key](); });",
    "        } else if (parts[0] === 'attr' && parts.length > 1) {",
    "          effect(() => { el.setAttribute(parts[1], bind[key]()); });",
    "        } else {",
    "          const prop = parts[0].replace(/-([a-z])/g, (_, c) => c.toUpperCase());",
    "          effect(() => { el[prop] = bind[key](); });",
    "        }",
    "      } else if (a.name.startsWith('@')) {",
    "        el.addEventListener(a.name.slice(1), on[a.value]);",
    "      }",
    "    });",
    "  });",
    "}",
    "",
    "hydrate(document);",
    "",
  );

  return lines.join("\n");
}

// ─── Prototype init emitters ─────────────────────────────────────────────────
// Request auto-fetch lives in shared.ts (`emitRequestFetch`) so the element target emits the same
// Effect against `this.state`.

/**
 * @param {string} key
 * @param {string} storeName
 * @param {string} storageKey
 * @param {unknown} defaultVal
 * @returns {string}
 */
function emitStorageInit(key: string, storeName: string, storageKey: string, defaultVal: unknown) {
  const lines: string[] = [
    `// ${key}: ${storeName} (key: "${storageKey}")`,
    "try {",
    `  const _s = ${storeName}.getItem(${JSON.stringify(storageKey)});`,
    `  state.${key} = _s !== null ? JSON.parse(_s) : ${JSON.stringify(defaultVal)};`,
    `} catch { state.${key} = ${JSON.stringify(defaultVal)}; }`,
    "effect(() => {",
    `  const v = state.${key};`,
    "  try {",
    `    if (v === null) ${storeName}.removeItem(${JSON.stringify(storageKey)});`,
    `    else ${storeName}.setItem(${JSON.stringify(storageKey)}, JSON.stringify(v));`,
    "  } catch {}",
    "});",
  ];
  return lines.join("\n");
}

/**
 * @param {string} key
 * @param {string} cookieName
 * @param {unknown} defaultVal
 * @returns {string}
 */
function emitCookieInit(key: string, cookieName: string, defaultVal: unknown) {
  const lines: string[] = [
    `// ${key}: Cookie (name: "${cookieName}")`,
    "{",
    `  const _m = document.cookie.match(new RegExp("(?:^|; )${cookieName}=([^;]*)"));`,
    `  try { state.${key} = _m ? JSON.parse(decodeURIComponent(_m[1])) : ${JSON.stringify(
      defaultVal,
    )}; }`,
    `  catch { state.${key} = _m ? _m[1] : ${JSON.stringify(defaultVal)}; }`,
    "}",
  ];
  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {string} ref
 * @returns {string}
 */
/**
 * Lower a `$ref` to the JS expression that reads it inside a map callback — the mirror of the
 * element target's `refToExpr`/`mapRefToExpr`. Distinct from `refToBindingKey` below, which
 * flattens `/` to `_` to name a binding and would produce nonsense (`state.$map_item`) as an
 * expression.
 *
 * @param {string} ref
 * @returns {string}
 */
function mapRefToClientExpr(ref: string) {
  if (ref.startsWith("$map/")) {
    // The loop variable is an emitted identifier, so its first segment is the base, not a member.
    const [head, ...rest] = refSegments(ref.slice("$map/".length));
    return refAccessor(head ?? "", rest.map((seg) => escapeToken(seg)).join("/"));
  }
  if (ref.startsWith("#/state/")) {
    return refAccessor("state", ref.slice("#/state/".length));
  }
  return refAccessor("state", ref);
}

/**
 * The `bind`/`on` map key for a ref. It is emitted both as an object-literal key and as a
 * `data-bind` attribute value, so it has to survive being a JavaScript identifier and an HTML
 * attribute at once. Stripping the `#/state/` prefix first keeps every pure-slash ref on the key it
 * already had — `#/state/user/name` is still `user_name` — so this fix changes no shipped output.
 *
 * @param {string} ref
 * @returns {string}
 */
function refToBindingKey(ref: string) {
  return refBindingKey(ref.startsWith("#/state/") ? ref.slice("#/state/".length) : ref);
}

/**
 * @param {Map<string, string>} bindings
 * @param {string} key
 * @param {string} ref
 */
function addRefBinding(bindings: Map<string, string>, key: string, ref: string) {
  if (bindings.has(key)) {
    return;
  }
  bindings.set(
    key,
    `() => ${refAccessor("state", ref.startsWith("#/state/") ? ref.slice("#/state/".length) : ref)}`,
  );
}
