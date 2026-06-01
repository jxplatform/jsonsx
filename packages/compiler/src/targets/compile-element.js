/**
 * Compile-element.js — Custom element compilation with lit-html
 *
 * Compiles Jx documents into self-registering custom element ES modules using @vue/reactivity for
 * state and lit-html for rendering.
 */

import { camelToKebab, RESERVED_KEYS } from "@jxsuite/runtime";
import {
  escapeHtml,
  tagNameToClassName,
  isSchemaOnly,
  collectStyles,
  compileExpression,
  isMutating,
} from "../shared.js";

/**
 * Compile a Jx custom element document to a JS module string.
 *
 * @param {string | any} sourcePath - Path to .json file or raw object
 * @param {Record<string, unknown>} [opts]
 * @returns {Promise<{ files: { path: string; content: string; tagName: string }[] }>}
 */
export async function compileElement(sourcePath, opts = {}) {
  const { resolveElementPath, $media: optsMedia } = /** @type {JxMutableNode} */ (opts);
  /** @type {{ path: string; content: string; tagName: string }[]} */
  const files = [];
  /** @type {Set<string>} */
  const visited = new Set();

  /**
   * @param {string | any} srcPath
   * @param {string | null} parentDir
   */
  async function processElement(srcPath, parentDir) {
    /** @type {JxMutableNode} */
    let doc;
    /** @type {string | null} */
    let filePath;
    if (typeof srcPath === "string") {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      filePath = parentDir ? resolve(parentDir, srcPath) : resolve(srcPath);
      if (visited.has(filePath)) return;
      visited.add(filePath);
      if (filePath.endsWith(".md")) {
        const { transpileJxMarkdown } = await import("@jxsuite/parser/transpile");
        doc = transpileJxMarkdown(readFileSync(filePath, "utf8"));
      } else {
        doc = JSON.parse(readFileSync(filePath, "utf8"));
      }
    } else {
      doc = srcPath;
      filePath = null;
      if (visited.has(/** @type {string} */ (doc.tagName))) return;
      visited.add(/** @type {string} */ (doc.tagName));
    }

    const tagName = doc.tagName;
    if (!tagName || !tagName.includes("-")) {
      throw new Error(`compileElement: tagName "${tagName}" must contain a hyphen`);
    }

    const { dirname: dn } = await import("node:path");
    const currentDir = filePath ? dn(filePath) : null;

    // Process $elements dependencies depth-first
    /** @type {string[]} */
    const elementImports = [];
    if (Array.isArray(doc.$elements)) {
      for (const elRef of doc.$elements) {
        const refPath = /** @type {JxMutableNode} */ (elRef).$ref ?? elRef;
        if (typeof refPath !== "string") continue;

        if (currentDir) {
          await processElement(refPath, currentDir);
        }

        /** @type {string} */
        let importPath;
        if (resolveElementPath) {
          importPath = resolveElementPath(refPath, currentDir);
        } else {
          importPath = refPath.replace(/\.json$/, ".js");
        }
        elementImports.push(importPath);
      }
    }

    const className = tagNameToClassName(tagName);
    if (optsMedia) {
      doc.$media = { ...optsMedia, ...doc.$media };
    }
    const jsContent = emitElementModule(doc, className, elementImports);
    const outputPath = filePath ? filePath.replace(/\.json$/, ".js") : `${tagName}.js`;
    files.push({ path: outputPath, content: jsContent, tagName });
  }

  await processElement(sourcePath, /** @type {string | null} */ (opts.basePath ?? null));
  return { files };
}

/**
 * Compile a Jx custom element document to a complete HTML page with an import map for CDN
 * dependencies.
 *
 * @param {string | any} sourcePath
 * @param {Record<string, unknown>} [opts]
 * @returns {Promise<{
 *   html: string;
 *   files: { path: string; content: string; tagName: string }[];
 * }>}
 */
export async function compileElementPage(sourcePath, opts = {}) {
  const {
    title = "Jx App",
    reactivitySrc = "https://esm.sh/@vue/reactivity@3.5.13",
    litHtmlSrc = "https://esm.sh/lit-html@3.3.0",
  } = /** @type {JxMutableNode} */ (opts);

  const result = await compileElement(sourcePath, opts);
  const root = result.files[result.files.length - 1];

  const { basename } = await import("node:path");
  const rootScript = basename(root.path);

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <script type="importmap">
  {
    "imports": {
      "@vue/reactivity": "${reactivitySrc}",
      "lit-html": "${litHtmlSrc}"
    }
  }
  </script>
</head>
<body>
  <${root.tagName}></${root.tagName}>
  <script type="module" src="./${rootScript}"></script>
</body>
</html>`;

  return { html: htmlContent, files: result.files };
}

// ─── Element code generation helpers ──────────────────────────────────────────

/**
 * Extract the initial value for a state entry to use in reactive({}). Bug fix: expanded signals
 * like { type, default, description } now correctly extract the `default` value instead of dumping
 * the whole object.
 *
 * @param {JxMutableNode} def
 * @returns {string | undefined}
 */
function extractInitialValue(def) {
  if (def === null || typeof def !== "object" || Array.isArray(def)) {
    return JSON.stringify(def);
  }
  // Expanded signal with explicit default
  if ("default" in def) {
    return JSON.stringify(def.default);
  }
  // Pure schema-only type definitions — skip (no runtime value)
  if (isSchemaOnly(def)) {
    return undefined; // caller should skip this entry
  }
  // $prototype entries (LocalStorage, SessionStorage, Request, etc.)
  if (def.$prototype === "LocalStorage" || def.$prototype === "SessionStorage") {
    return JSON.stringify(def.default ?? null);
  }
  if (def.$prototype === "Request") {
    return "null";
  }
  // Plain object → treat as initial state value
  return JSON.stringify(def);
}

/**
 * Generate a complete ES module string for a custom element.
 *
 * @param {JxMutableNode | Record<string, any>} doc
 * @param {string} className
 * @param {string[]} elementImports
 * @returns {string}
 */
export function emitElementModule(doc, className, elementImports) {
  /** @type {string[]} */
  const lines = [];

  lines.push("// Generated by @jxsuite/compiler — do not edit manually");
  if (doc.$id) lines.push(`// Source: ${doc.$id}`);

  for (const imp of elementImports) {
    lines.push(`import '${imp}';`);
  }

  // Collect $src imports from state entries before emitting other imports
  /** @type {Map<string, string[]>} */
  const srcImportMap = new Map();
  const defs = doc.state ?? {};
  for (const [key, def] of Object.entries(defs)) {
    const d = /** @type {JxMutableNode} */ (def);
    if (d && typeof d === "object" && !Array.isArray(d) && d.$prototype === "Function" && d.$src) {
      const srcPath = d.$src;
      if (!srcImportMap.has(srcPath)) srcImportMap.set(srcPath, []);
      /** @type {string[]} */ (srcImportMap.get(srcPath)).push(key);
    }
  }
  for (const [srcPath, names] of srcImportMap) {
    lines.push(`import { ${names.join(", ")} } from '${srcPath}';`);
  }

  lines.push(`import { reactive, computed, effect } from '@vue/reactivity';`);
  lines.push(`import { render, html } from 'lit-html';`);
  lines.push("");
  lines.push(`class ${className} extends HTMLElement {`);
  lines.push("  #dispose = null;");
  lines.push("");

  // Constructor: build reactive state
  lines.push("  constructor() {");
  lines.push("    super();");

  /** @type {[string, string][]} */
  const stateEntries = [];
  /** @type {[string, any][]} */
  const computedEntries = [];
  /** @type {[string, any][]} */
  const functionEntries = [];

  for (const [key, def] of Object.entries(defs)) {
    const d = /** @type {JxMutableNode} */ (def);
    if (d && typeof d === "object" && !Array.isArray(d) && "$expression" in d) {
      const node = /** @type {any} */ (d).$expression;
      if (isMutating(node.operator)) {
        functionEntries.push([key, d]);
      } else {
        computedEntries.push([key, d]);
      }
    } else if (d && typeof d === "object" && !Array.isArray(d) && d.$prototype === "Function") {
      if (typeof d.body === "string" && d.body.includes("return")) {
        computedEntries.push([key, d]);
      } else {
        functionEntries.push([key, d]);
      }
    } else {
      // Use extractInitialValue to get the correct initial value
      const initVal = extractInitialValue(d);
      if (initVal !== undefined) {
        stateEntries.push([key, initVal]);
      }
    }
  }

  // Emit reactive({...}) with initial state values
  lines.push("    this.state = reactive({");
  for (const [key, initVal] of stateEntries) {
    lines.push(`      ${key}: ${initVal},`);
  }
  lines.push("    });");

  // Emit functions: this.state.fnName = (state) => { body } or imported $src function
  for (const [key, def] of functionEntries) {
    lines.push("");
    if ("$expression" in def) {
      const compiled = compileExpression(def.$expression, { statePrefix: "s", eventParam: "e" });
      lines.push(`    this.state.${key} = (s, e) => { ${compiled}; };`);
    } else if (def.$src) {
      // $src function — wrap imported function so it receives state
      const args = def.parameters ?? def.arguments ?? ["state"];
      const paramList = args.join(", ");
      lines.push(`    this.state.${key} = (${paramList}) => ${key}(${paramList});`);
    } else {
      const args = def.parameters ?? def.arguments ?? ["state"];
      const paramList = args.join(", ");
      lines.push(`    this.state.${key} = (${paramList}) => {`);
      lines.push(`      ${def.body}`);
      lines.push("    };");
    }
  }

  // Emit computed signals — $src or inline body
  for (const [key, def] of computedEntries) {
    lines.push("");
    if ("$expression" in def) {
      const compiled = compileExpression(def.$expression, {
        statePrefix: "this.state",
        eventParam: "e",
      });
      lines.push(`    this.state.${key} = computed(() => ${compiled});`);
    } else if (def.$src) {
      lines.push(`    this.state.${key} = computed(() => ${key}(this.state));`);
    } else {
      lines.push(`    this.state.${key} = computed(() => {`);
      const body = def.body.replace(/state\./g, "this.state.");
      lines.push(`      ${body}`);
      lines.push("    });");
    }
  }

  lines.push("  }"); // end constructor
  lines.push("");

  // Collect CSS rules from children tree (assigns .jx-N classes to defs)
  /** @type {string[]} */
  const cssRules = [];
  if (Array.isArray(doc.children)) {
    const counter = { n: 0 };
    for (const child of doc.children) {
      collectStyles(child, cssRules, doc.$media ?? {}, "", counter, doc.tagName);
    }
  }

  // Template method
  lines.push("  template() {");
  lines.push("    const s = this.state;");
  lines.push("    return html`");
  lines.push(emitLitChildren(doc.children, doc.style, "      "));
  lines.push("    `;");
  lines.push("  }");
  lines.push("");

  // connectedCallback
  lines.push("  connectedCallback() {");
  // Read $props from data-jx-props attribute (set by compiler for pre-rendered instances)
  lines.push("    const _pa = this.getAttribute('data-jx-props');");
  lines.push("    if (_pa) {");
  lines.push("      try {");
  lines.push("        const _p = JSON.parse(_pa);");
  lines.push("        for (const [k, v] of Object.entries(_p)) {");
  lines.push("          if (k in this.state) this.state[k] = v;");
  lines.push("        }");
  lines.push("      } catch {}");
  lines.push("      this.removeAttribute('data-jx-props');");
  lines.push("    }");
  // Merge JS properties set before connection (by parent runtime).
  // Only check own properties to avoid inherited DOM properties like `title`.
  lines.push("    for (const key of Object.keys(this.state)) {");
  lines.push("      if (this.hasOwnProperty(key) && this[key] !== undefined) {");
  lines.push("        this.state[key] = this[key];");
  lines.push("      }");
  lines.push("    }");
  if (doc.style && typeof doc.style === "object") {
    /** @type {[string, string][]} */
    const dynamicStyles = [];
    for (const [prop, value] of Object.entries(doc.style)) {
      if (
        prop.startsWith(":") ||
        prop.startsWith(".") ||
        prop.startsWith("&") ||
        prop.startsWith("[") ||
        prop.startsWith("@")
      )
        continue;
      if (value === null || typeof value === "object") continue;
      const cssProp = camelToKebab(prop);
      if (typeof value === "string" && value.includes("${")) {
        dynamicStyles.push([cssProp, value]);
      }
    }
    if (dynamicStyles.length > 0) {
      lines.push("    effect(() => {");
      for (const [cssProp, value] of dynamicStyles) {
        const expr = value.replace(
          /\$\{([^}]+)\}/g,
          (/** @type {string} */ _, /** @type {string} */ e) =>
            "${" + e.replace(/state\./g, "this.state.") + "}",
        );
        lines.push(`      this.style['${cssProp}'] = \`${expr}\`;`);
      }
      lines.push("    });");
    }
  }
  const hasSlot = treeHasSlot(doc.children);
  if (hasSlot) {
    // Save light DOM children (slotted content) before clearing
    lines.push(
      "    const _slotted = Array.from(this.childNodes).filter(n => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()));",
    );
  }
  lines.push("    if (this.hasAttribute('data-jx-prerendered')) {");
  lines.push("      this.removeAttribute('data-jx-prerendered');");
  lines.push("    }");
  lines.push("    this.innerHTML = '';");
  lines.push("    this.#dispose = effect(() => render(this.template(), this));");
  if (hasSlot) {
    // Replace <slot> placeholder with saved slotted content
    lines.push("    const _slot = this.querySelector('slot');");
    lines.push("    if (_slot && _slotted.length > 0) {");
    lines.push("      for (const n of _slotted) _slot.before(n);");
    lines.push("      _slot.remove();");
    lines.push("    }");
  }
  lines.push("  }");
  lines.push("");

  // disconnectedCallback
  lines.push("  disconnectedCallback() {");
  lines.push("    if (this.#dispose) { this.#dispose(); this.#dispose = null; }");
  lines.push("  }");

  lines.push("}");
  lines.push("");
  lines.push(`customElements.define('${doc.tagName}', ${className});`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Convert Jx children to lit-html template content.
 *
 * @param {(JxMutableNode | string)[] | JxMutableNode | undefined} children
 * @param {JxStyle | Record<string, any> | null | undefined} parentStyle
 * @param {string} indent
 * @returns {string}
 */
function emitLitChildren(children, parentStyle, indent) {
  if (!children) return "";

  if (/** @type {JxMutableNode} */ (children).$prototype === "Array") {
    return emitMappedArray(/** @type {JxMutableNode} */ (children), indent);
  }

  if (!Array.isArray(children)) return "";

  return children
    .map((/** @type {JxMutableNode | string} */ child) => emitLitNode(child, indent))
    .join("\n");
}

/**
 * @param {JxMutableNode | string} def
 * @param {string} indent
 * @returns {string}
 */
function emitLitNode(def, indent) {
  // String children are text nodes
  if (typeof def === "string") {
    if (def.includes("${")) return `${indent}${toLitTextContent(def)}`;
    return `${indent}${escapeHtml(def)}`;
  }
  if (typeof def === "number" || typeof def === "boolean") {
    return `${indent}${escapeHtml(String(def))}`;
  }
  if (!def || typeof def !== "object") return "";

  const tag = def.tagName ?? "div";

  /** @type {string[]} */
  const parts = [];

  if (def.attributes) {
    for (const [key, val] of Object.entries(def.attributes)) {
      if (typeof val === "string" && val.includes("${")) {
        parts.push(`${key}="${toLitExpr(val)}"`);
      } else {
        parts.push(`${key}="${val}"`);
      }
    }
  }

  if (def.id) parts.push(`id="${def.id}"`);
  if (def.className) parts.push(`class="${def.className}"`);

  for (const [key, val] of Object.entries(def)) {
    if (
      RESERVED_KEYS.has(key) ||
      key.startsWith("$") ||
      key.startsWith("on") ||
      key === "tagName" ||
      key === "id" ||
      key === "className" ||
      key === "style" ||
      key === "children" ||
      key === "textContent" ||
      key === "innerHTML" ||
      key === "attributes"
    )
      continue;

    if (val && typeof val === "object" && /** @type {JxMutableNode} */ (val).$ref) {
      parts.push(
        `.${key}="\${${refToExpr(/** @type {string} */ (/** @type {JxMutableNode} */ (val).$ref))}}"`,
      );
    } else if (typeof val === "string" && val.includes("${")) {
      parts.push(`.${key}="${toLitExpr(val)}"`);
    }
  }

  if (def.$props) {
    for (const [key, val] of Object.entries(def.$props)) {
      if (val && typeof val === "object" && /** @type {JxMutableNode} */ (val).$ref) {
        parts.push(
          `.${key}="\${${refToExpr(/** @type {string} */ (/** @type {JxMutableNode} */ (val).$ref))}}"`,
        );
      } else {
        parts.push(`.${key}="\${${JSON.stringify(val)}}"`);
      }
    }
  }

  for (const [key, val] of Object.entries(def)) {
    if (!key.startsWith("on") || key === "observedAttributes") continue;
    const eventName = key.slice(2).toLowerCase();
    if (val && typeof val === "object" && /** @type {JxMutableNode} */ (val).$ref) {
      parts.push(
        `@${eventName}="\${(e) => ${refToExpr(/** @type {string} */ (/** @type {JxMutableNode} */ (val).$ref))}(s, e)}"`,
      );
    } else if (val && typeof val === "object" && "$expression" in /** @type {any} */ (val)) {
      const compiled = compileExpression(/** @type {any} */ (val).$expression, {
        statePrefix: "s",
        eventParam: "e",
      });
      parts.push(`@${eventName}="\${(e) => { ${compiled}; }}"`);
    } else if (
      val &&
      typeof val === "object" &&
      /** @type {JxMutableNode} */ (val).$prototype === "Function"
    ) {
      parts.push(
        `@${eventName}="\${(e) => { ${inlineHandlerBody(/** @type {JxMutableNode} */ (val))} }}"`,
      );
    }
  }

  const styleStr = emitStyleString(def.style);
  if (styleStr) parts.push(`style="${styleStr}"`);

  const attrsStr = parts.length > 0 ? "\n" + indent + "  " + parts.join("\n" + indent + "  ") : "";

  const selfClosing = new Set(["input", "br", "hr", "img", "meta", "link"]);
  if (selfClosing.has(tag)) {
    return `${indent}<${tag}${attrsStr}\n${indent}>`;
  }

  let inner = "";
  if (def.textContent !== undefined) {
    inner = toLitTextContent(def.textContent);
  } else if (def.innerHTML !== undefined) {
    inner = def.innerHTML;
  } else if (def.children) {
    inner = "\n" + emitLitChildren(def.children, def.style, indent + "  ") + "\n" + indent;
  }

  return `${indent}<${tag}${attrsStr}\n${indent}>${inner}</${tag}>`;
}

/**
 * @param {JxMutableNode} arrayDef
 * @param {string} indent
 * @returns {string}
 */
function emitMappedArray(arrayDef, indent) {
  const itemsExpr = arrayDef.items?.$ref ? refToExpr(arrayDef.items.$ref) : "ITEMS";
  const mapDef = arrayDef.map;

  if (!mapDef) return "";

  const tag = mapDef.tagName ?? "div";
  /** @type {string[]} */
  const parts = [];

  if (mapDef.$props) {
    for (const [key, val] of Object.entries(mapDef.$props)) {
      if (val && typeof val === "object" && /** @type {JxMutableNode} */ (val).$ref) {
        parts.push(
          `.${key}="\${${mapRefToExpr(/** @type {string} */ (/** @type {JxMutableNode} */ (val).$ref))}}"`,
        );
      } else {
        parts.push(`.${key}="\${${JSON.stringify(val)}}"`);
      }
    }
  }

  const styleStr = emitStyleString(mapDef.style);
  if (styleStr) parts.push(`style="${styleStr}"`);

  for (const [key, val] of Object.entries(mapDef)) {
    if (!key.startsWith("on")) continue;
    const eventName = key.slice(2).toLowerCase();
    if (val && typeof val === "object" && /** @type {JxMutableNode} */ (val).$ref) {
      parts.push(
        `@${eventName}="\${(e) => ${refToExpr(/** @type {string} */ (/** @type {JxMutableNode} */ (val).$ref))}(s, e)}"`,
      );
    } else if (val && typeof val === "object" && "$expression" in /** @type {any} */ (val)) {
      const compiled = compileExpression(/** @type {any} */ (val).$expression, {
        statePrefix: "s",
        eventParam: "e",
      });
      parts.push(`@${eventName}="\${(e) => { ${compiled}; }}"`);
    }
  }

  const attrsStr =
    parts.length > 0 ? "\n" + indent + "    " + parts.join("\n" + indent + "    ") : "";

  let inner = "";
  if (mapDef.textContent !== undefined) {
    inner = toLitTextContent(mapDef.textContent);
  } else if (mapDef.children) {
    inner =
      "\n" + emitLitChildren(mapDef.children, null, indent + "      ") + "\n" + indent + "    ";
  }

  return `${indent}\${${itemsExpr}.map((item, index) => html\`\n${indent}  <${tag}${attrsStr}\n${indent}  >${inner}</${tag}>\n${indent}\`)}`;
}

/**
 * Convert a $ref string to a JS expression using `s` (this.state alias).
 *
 * @param {string} ref
 * @returns {string}
 */
function refToExpr(ref) {
  if (ref.startsWith("#/state/")) {
    const path = ref.slice("#/state/".length);
    return "s." + path.replace(/\//g, ".");
  }
  if (ref.startsWith("$map/")) {
    const path = ref.slice("$map/".length);
    return path.replace(/\//g, ".");
  }
  return "s." + ref;
}

/**
 * @param {string} ref
 * @returns {string}
 */
function mapRefToExpr(ref) {
  if (ref.startsWith("$map/")) {
    return ref.slice("$map/".length).replace(/\//g, ".");
  }
  return refToExpr(ref);
}

/**
 * @param {string} str
 * @returns {string}
 */
function toLitExpr(str) {
  return str.replace(/state\./g, "s.");
}

/**
 * Convert textContent value to lit-html text content. Bug fix: handles $ref objects, which
 * previously produced [object Object].
 *
 * @param {unknown} value
 * @returns {string}
 */
function toLitTextContent(value) {
  // Handle $ref objects → emit as lit expression
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (/** @type {JxMutableNode} */ (value).$ref) === "string"
  ) {
    return `\${${refToExpr(/** @type {string} */ (/** @type {JxMutableNode} */ (value).$ref))}}`;
  }
  if (typeof value === "string" && value.includes("${")) {
    return toLitExpr(value);
  }
  return String(value);
}

/**
 * @param {JxMutableNode} def
 * @returns {string}
 */
function inlineHandlerBody(def) {
  const body = def.body ?? "";
  return body.replace(/(?<!this\.)state\./g, "s.").replace(/(?<!this\.)state(?!\.)/g, "s");
}

/**
 * @param {JxStyle | Record<string, any> | null | undefined} styleDef
 * @returns {string}
 */
function emitStyleString(styleDef) {
  if (!styleDef || typeof styleDef !== "object") return "";

  /** @type {string[]} */
  const parts = [];
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

    if (typeof value === "string" && value.includes("${")) {
      const cssProp = camelToKebab(prop);
      parts.push(`${cssProp}: ${toLitExpr(value)}`);
    }
  }

  return parts.join("; ");
}

/**
 * Check if a children tree contains a `<slot>` element.
 *
 * @param {(JxMutableNode | string)[] | undefined} children
 * @returns {boolean}
 */
function treeHasSlot(children) {
  if (!Array.isArray(children)) return false;
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    if (child.tagName === "slot") return true;
    if (treeHasSlot(child.children)) return true;
  }
  return false;
}
