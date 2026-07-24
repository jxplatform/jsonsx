/**
 * Compile-element.js — Custom element compilation with lit-html
 *
 * Compiles Jx documents into self-registering custom element ES modules using @vue/reactivity for
 * state and lit-html for rendering.
 */

import { RESERVED_KEYS, camelToKebab } from "@jxsuite/runtime";
import {
  collectStyles,
  compileExpression,
  compileStatements,
  emitFormulaFn,
  escapeHtml,
  isMutating,
  isSchemaOnly,
  tagNameToClassName,
} from "../shared.ts";
import {
  hasStructuredBody,
  isExpressionDef,
  isFunctionDef,
  isMappedArray,
  isNamedFormulaDef,
  isRef,
  paramNames,
} from "@jxsuite/schema/guards";
import { parseJxDocument } from "@jxsuite/schema/parse";
import type { ExpressionNode } from "../shared.ts";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";
import type {
  JxDocument,
  JxExpressionDef,
  JxFunctionDef,
  JxMappedArray,
  JxMutableNode,
  JxStyle,
} from "@jxsuite/schema/types";

/** Options accepted by compileElement. */
export interface CompileElementOptions {
  /** Resolve an `$elements` ref path to its emitted JS module path. */
  resolveElementPath?: (refPath: string, currentDir: string | null) => string;
  /**
   * Rewrite a Function-def `$src` specifier to its served URL (bundleable specifiers → their
   * `/assets/` bundle path). Receives the directory of the declaring document for relative
   * specifiers. Identity when omitted.
   */
  rewriteSrc?: (specifier: string, docDir: string | null) => string;
  $media?: Record<string, string>;
  formats?: FormatRegistry;
  basePath?: string | null;
  [key: string]: unknown;
}

/**
 * Compile a Jx custom element document to a JS module string.
 *
 * @param {string | JxDocument} sourcePath - Path to .json file or raw object
 * @param {CompileElementOptions} [opts]
 * @returns {Promise<{ files: { path: string; content: string; tagName: string }[] }>}
 */
export async function compileElement(
  sourcePath: string | JxDocument,
  opts: CompileElementOptions = {},
) {
  const { resolveElementPath, $media: optsMedia, formats } = opts;
  /** @type {{ path: string; content: string; tagName: string }[]} */
  const files: { path: string; content: string; tagName: string }[] = [];
  const visited = new Set<string>();

  /**
   * @param {string | JxDocument} srcPath
   * @param {string | null} parentDir
   */
  async function processElement(srcPath: string | JxDocument, parentDir: string | null) {
    let doc: JxDocument;
    let filePath: string | null;
    if (typeof srcPath === "string") {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      filePath = parentDir ? resolve(parentDir, srcPath) : resolve(srcPath);
      if (visited.has(filePath)) {
        return;
      }
      visited.add(filePath);
      if (filePath.endsWith(".json")) {
        doc = parseJxDocument(readFileSync(filePath, "utf8"), filePath);
      } else {
        const { extname } = await import("node:path");
        const ext = extname(filePath).toLowerCase();
        const entry = formats?.byExtension?.(ext, "parse");
        if (!entry) {
          const { unknownFormatError } = await import("../site/format-host.ts");
          throw unknownFormatError(filePath, ext);
        }
        // Format plugins contractually parse source text into a Jx document.
        doc = (await entry.call("parse", readFileSync(filePath, "utf8"))) as JxDocument;
      }
    } else {
      doc = srcPath;
      filePath = null;
      if (doc.tagName && visited.has(doc.tagName)) {
        return;
      }
      if (doc.tagName) {
        visited.add(doc.tagName);
      }
    }

    const { tagName } = doc;
    if (!tagName || !tagName.includes("-")) {
      throw new Error(`compileElement: tagName "${tagName}" must contain a hyphen`);
    }

    const { dirname: dn } = await import("node:path");
    const currentDir = filePath ? dn(filePath) : null;

    // Process $elements dependencies depth-first
    const elementImports: string[] = [];
    if (Array.isArray(doc.$elements)) {
      for (const elRef of doc.$elements) {
        const refPath = isRef(elRef) ? elRef.$ref : elRef;
        if (typeof refPath !== "string") {
          continue;
        }

        if (currentDir) {
          await processElement(refPath, currentDir);
        }

        /** @type {string} */
        const importPath = resolveElementPath
          ? resolveElementPath(refPath, currentDir)
          : refPath.replace(/\.json$/, ".js");
        elementImports.push(importPath);
      }
    }

    const className = tagNameToClassName(tagName);
    if (optsMedia) {
      doc.$media = { ...optsMedia, ...doc.$media };
    }
    const { rewriteSrc } = opts;
    const jsContent = emitElementModule(
      doc,
      className,
      elementImports,
      rewriteSrc ? (spec: string) => rewriteSrc(spec, currentDir) : undefined,
    );
    const outputPath = filePath ? filePath.replace(/\.json$/, ".js") : `${tagName}.js`;
    files.push({ content: jsContent, path: outputPath, tagName });
  }

  await processElement(sourcePath, opts.basePath ?? null);
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
export async function compileElementPage(
  sourcePath: string | JxDocument,
  opts: {
    title?: string;
    reactivitySrc?: string;
    litHtmlSrc?: string;
    [key: string]: unknown;
  } = {},
) {
  const {
    title = "Jx App",
    reactivitySrc = "https://esm.sh/@vue/reactivity@3.5.13",
    litHtmlSrc = "https://esm.sh/lit-html@3.3.0",
  } = opts;

  const result = await compileElement(sourcePath, opts);
  const root = result.files.at(-1);
  if (!root) {
    throw new Error("compileElementPage: no element modules were produced");
  }

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

  return { files: result.files, html: htmlContent };
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
function extractInitialValue(def: JxMutableNode) {
  if (def === null || typeof def !== "object" || Array.isArray(def)) {
    return JSON.stringify(def);
  }
  // Expanded signal with explicit default
  if ("default" in def) {
    return JSON.stringify(def.default);
  }
  // Pure schema-only type definitions — skip (no runtime value)
  if (isSchemaOnly(def)) {
    return; // Caller should skip this entry
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
 * @param {JxDocument} doc
 * @param {string} className
 * @param {string[]} elementImports
 * @returns {string}
 */
export function emitElementModule(
  doc: JxDocument,
  className: string,
  elementImports: string[],
  rewriteSrc?: (specifier: string) => string,
) {
  const lines: string[] = ["// Generated by @jxsuite/compiler — do not edit manually"];

  if (doc.$id) {
    lines.push(`// Source: ${doc.$id}`);
  }

  for (const imp of elementImports) {
    lines.push(`import '${imp}';`);
  }

  // Collect $src imports from state entries before emitting other imports
  const srcImportMap = new Map<string, string[]>();
  const defs = doc.state ?? {};
  for (const [key, def] of Object.entries(defs)) {
    const d = def as JxMutableNode;
    if (d && typeof d === "object" && !Array.isArray(d) && d.$prototype === "Function" && d.$src) {
      const srcPath = d.$src;
      if (!srcImportMap.has(srcPath)) {
        srcImportMap.set(srcPath, []);
      }
      (srcImportMap.get(srcPath) as string[]).push(key);
    }
  }
  for (const [srcPath, names] of srcImportMap) {
    // Bundleable specifiers (npm:…, ./relative) are rewritten to their /assets/ bundle URL;
    // The site build bundles them after all documents compile (spec.md §12).
    const importPath = rewriteSrc ? rewriteSrc(srcPath) : srcPath;
    lines.push(`import { ${names.join(", ")} } from '${importPath}';`);
  }

  lines.push(
    `import { reactive, computed, effect } from '@vue/reactivity';`,
    `import { render, html } from 'lit-html';`,
    "",
    `class ${className} extends HTMLElement {`,
    "  #dispose = null;",
    "",
    // Constructor: build reactive state
    "  constructor() {",
    "    super();",
  );

  const stateEntries: [string, string][] = [];
  const computedEntries: [string, JxExpressionDef | JxFunctionDef][] = [];
  const functionEntries: [string, JxExpressionDef | JxFunctionDef][] = [];

  const formulaEntries: [string, JxExpressionDef][] = [];
  for (const [key, def] of Object.entries(defs)) {
    const d = def as JxMutableNode;
    if (isExpressionDef(d)) {
      const node = d.$expression as ExpressionNode;
      if (isNamedFormulaDef(d)) {
        formulaEntries.push([key, d]);
      } else if (isMutating(node.operator)) {
        functionEntries.push([key, d]);
      } else {
        computedEntries.push([key, d]);
      }
    } else if (isFunctionDef(d)) {
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
    if (isExpressionDef(def)) {
      const compiled = compileExpression(def.$expression as ExpressionNode, {
        eventParam: "e",
        statePrefix: "s",
      });
      lines.push(`    this.state.${key} = (s, e) => { ${compiled}; };`);
    } else if (hasStructuredBody(def)) {
      // Structured body (spec §20) — statements compiled against this.state; dispatch target is
      // The component instance itself (WHATWG dispatchEvent on the custom element).
      const compiled = compileStatements(def.body, {
        dispatchTarget: "this",
        eventParam: "e",
        indent: "      ",
        statePrefix: "this.state",
      });
      lines.push(`    this.state.${key} = (s, e) => {`, compiled, "    };");
    } else {
      const args = def.parameters ? paramNames(def.parameters) : (def.arguments ?? ["state"]);
      const paramList = args.join(", ");
      if (def.$src) {
        // $src function — wrap imported function so it receives state
        lines.push(`    this.state.${key} = (${paramList}) => ${key}(${paramList});`);
      } else {
        lines.push(
          `    this.state.${key} = (${paramList}) => {`,
          `      ${typeof def.body === "string" ? def.body : ""}`,
          "    };",
        );
      }
    }
  }

  // Emit named formulas — scope callables mapping positional args onto declared parameters
  for (const [key, def] of formulaEntries) {
    lines.push("");
    const compiled = compileExpression(def.$expression as ExpressionNode, {
      eventParam: "e",
      statePrefix: "this.state",
    });
    lines.push(`    this.state.${key} = ${emitFormulaFn(def, compiled)};`);
  }

  // Emit computed signals — $src or inline body
  for (const [key, def] of computedEntries) {
    lines.push("");
    if (isExpressionDef(def)) {
      const compiled = compileExpression(def.$expression as ExpressionNode, {
        eventParam: "e",
        statePrefix: "this.state",
      });
      lines.push(`    this.state.${key} = computed(() => ${compiled});`);
    } else if (def.$src) {
      lines.push(`    this.state.${key} = computed(() => ${key}(this.state));`);
    } else {
      lines.push(`    this.state.${key} = computed(() => {`);
      const body = (typeof def.body === "string" ? def.body : "").replaceAll(
        "state.",
        "this.state.",
      );
      lines.push(`      ${body}`, "    });");
    }
  }

  lines.push("  }", ""); // End constructor

  // Collect CSS rules from children tree (assigns .jx-N classes to defs)
  const cssRules: string[] = [];
  if (Array.isArray(doc.children)) {
    const counter = { n: 0 };
    for (const child of doc.children) {
      collectStyles(child, cssRules, doc.$media ?? {}, "", counter, doc.tagName);
    }
  }

  lines.push(
    // Template method
    "  template() {",
    "    const s = this.state;",
    "    return html`",
    emitLitChildren(doc.children, doc.style, "      "),
    "    `;",
    "  }",
    "",
    // ConnectedCallback
    "  connectedCallback() {",
    // Read $props from data-jx-props attribute (set by compiler for pre-rendered instances)
    "    const _pa = this.getAttribute('data-jx-props');",
    "    if (_pa) {",
    "      try {",
    "        const _p = JSON.parse(_pa);",
    "        for (const [k, v] of Object.entries(_p)) {",
    "          if (k in this.state) this.state[k] = v;",
    "        }",
    "      } catch {}",
    "      this.removeAttribute('data-jx-props');",
    "    }",
    // Merge JS properties set before connection (by parent runtime).
    // Only check own properties to avoid inherited DOM properties like `title`.
    "    for (const key of Object.keys(this.state)) {",
    "      if (this.hasOwnProperty(key) && this[key] !== undefined) {",
    "        this.state[key] = this[key];",
    "      }",
    "    }",
  );
  if (doc.style && typeof doc.style === "object") {
    const dynamicStyles: [string, string][] = [];
    for (const [prop, value] of Object.entries(doc.style)) {
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
      const cssProp = camelToKebab(prop);
      if (typeof value === "string" && value.includes("${")) {
        dynamicStyles.push([cssProp, value]);
      }
    }
    if (dynamicStyles.length > 0) {
      lines.push("    effect(() => {");
      for (const [cssProp, value] of dynamicStyles) {
        const expr = value.replaceAll(
          /\$\{([^}]+)\}/g,
          (_: string, e: string) => `\${${e.replaceAll("state.", "this.state.")}}`,
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
  lines.push(
    "    if (this.hasAttribute('data-jx-prerendered')) {",
    "      this.removeAttribute('data-jx-prerendered');",
    "    }",
    "    this.innerHTML = '';",
    "    this.#dispose = effect(() => render(this.template(), this));",
  );
  if (hasSlot) {
    // Replace <slot> placeholder with saved slotted content
    lines.push(
      "    const _slot = this.querySelector('slot');",
      "    if (_slot && _slotted.length > 0) {",
      "      for (const n of _slotted) _slot.before(n);",
      "      _slot.remove();",
      "    }",
    );
  }
  lines.push(
    // Lifecycle: onMount (spec §16.4) — same microtask contract as the runtime
    "    if (typeof this.state.onMount === 'function') {",
    "      queueMicrotask(() => this.state.onMount(this.state));",
    "    }",
    "  }",
    "",
    // DisconnectedCallback
    "  disconnectedCallback() {",
    "    if (this.#dispose) { this.#dispose(); this.#dispose = null; }",
    "    if (typeof this.state.onUnmount === 'function') { this.state.onUnmount(this.state); }",
    "  }",
    "}",
    "",
    `customElements.define('${doc.tagName}', ${className});`,
    "",
  );

  return lines.join("\n");
}

/**
 * Convert Jx children to lit-html template content.
 *
 * @param {JxMutableNode["children"]} children
 * @param {JxStyle | null | undefined} parentStyle
 * @param {string} indent
 * @returns {string}
 */
function emitLitChildren(
  children: JxMutableNode["children"],
  _parentStyle: JxStyle | null | undefined,
  indent: string,
) {
  if (!children) {
    return "";
  }

  // Legacy whole-children repeater: the array IS the children slot.
  if (isMappedArray(children)) {
    return emitMappedArray(children, indent);
  }

  if (!Array.isArray(children)) {
    return "";
  }

  // Mixed children: elements/text plus array pseudo-elements expanded inline among siblings.
  return children
    .map((child: JxMutableNode | string) =>
      isMappedArray(child) ? emitMappedArray(child, indent) : emitLitNode(child, indent),
    )
    .join("\n");
}

/**
 * @param {JxMutableNode | string} def
 * @param {string} indent
 * @returns {string}
 */
function emitLitNode(def: JxMutableNode | string, indent: string) {
  // String children are text nodes
  if (typeof def === "string") {
    if (def.includes("${")) {
      return `${indent}${toLitTextContent(def)}`;
    }
    return `${indent}${escapeHtml(def)}`;
  }
  if (typeof def === "number" || typeof def === "boolean") {
    return `${indent}${escapeHtml(String(def))}`;
  }
  if (!def || typeof def !== "object") {
    return "";
  }

  const tag = def.tagName ?? "div";

  const parts: string[] = [];

  if (def.attributes) {
    for (const [key, val] of Object.entries(def.attributes)) {
      if (val && typeof val === "object" && isRef(val)) {
        parts.push(`${key}="\${${refToExpr(val.$ref)}}"`);
      } else if (typeof val === "string" && val.includes("${")) {
        parts.push(`${key}="${toLitExpr(val)}"`);
      } else {
        parts.push(`${key}="${val}"`);
      }
    }
  }

  if (def.id) {
    parts.push(`id="${def.id}"`);
  }
  if (def.className) {
    parts.push(`class="${def.className}"`);
  }

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
    ) {
      continue;
    }

    if (val && typeof val === "object" && (val as JxMutableNode).$ref) {
      parts.push(`.${key}="\${${refToExpr((val as JxMutableNode).$ref as string)}}"`);
    } else if (typeof val === "string" && val.includes("${")) {
      parts.push(`.${key}="${toLitExpr(val)}"`);
    }
  }

  if (def.$props) {
    for (const [key, val] of Object.entries(def.$props)) {
      if (val && typeof val === "object" && (val as JxMutableNode).$ref) {
        parts.push(`.${key}="\${${refToExpr((val as JxMutableNode).$ref as string)}}"`);
      } else {
        parts.push(`.${key}="\${${JSON.stringify(val)}}"`);
      }
    }
  }

  for (const [key, val] of Object.entries(def)) {
    if (!key.startsWith("on") || key === "observedAttributes") {
      continue;
    }
    const eventName = key.slice(2).toLowerCase();
    if (val && typeof val === "object" && (val as JxMutableNode).$ref) {
      parts.push(
        `@${eventName}="\${(e) => ${refToExpr((val as JxMutableNode).$ref as string)}(s, e)}"`,
      );
    } else if (val && typeof val === "object" && "$expression" in /** @type {any} */ val) {
      const compiled = compileExpression(
        (val as Record<string, unknown>).$expression as ExpressionNode,
        {
          eventParam: "e",
          statePrefix: "s",
        },
      );
      parts.push(`@${eventName}="\${(e) => { ${compiled}; }}"`);
    } else if (isFunctionDef(val)) {
      parts.push(`@${eventName}="\${(e) => { ${inlineHandlerBody(val)} }}"`);
    }
  }

  const styleStr = emitStyleString(def.style);
  if (styleStr) {
    parts.push(`style="${styleStr}"`);
  }

  const attrsStr = parts.length > 0 ? `\n${indent}  ${parts.join(`\n${indent}  `)}` : "";

  const selfClosing = new Set(["input", "br", "hr", "img", "meta", "link"]);
  if (selfClosing.has(tag)) {
    return `${indent}<${tag}${attrsStr}\n${indent}>`;
  }

  let inner = "";
  if (def.$switch) {
    const switchRef = isRef(def.$switch) ? def.$switch.$ref : (def.$switch as string);
    const switchExpr = refToExpr(switchRef);
    const cases = (def.cases ?? {}) as Record<string, JxMutableNode>;
    const caseEntries: string[] = [];
    for (const [key, caseDef] of Object.entries(cases)) {
      if (!caseDef || isRef(caseDef)) {
        continue;
      }
      const renderedCase = emitLitNode(caseDef, `${indent}  `);
      caseEntries.push(`  ${JSON.stringify(key)}: html\`\n${renderedCase}\n  \``);
    }
    inner = `\${{\n${caseEntries.join(",\n")}\n}[${switchExpr}]}`;
  } else if (def.textContent !== undefined) {
    inner = toLitTextContent(def.textContent);
  } else if (def.innerHTML !== undefined) {
    inner = def.innerHTML;
  } else if (def.children) {
    inner = `\n${emitLitChildren(def.children, def.style, `${indent}  `)}\n${indent}`;
  }

  return `${indent}<${tag}${attrsStr}\n${indent}>${inner}</${tag}>`;
}

/**
 * @param {JxMappedArray} arrayDef
 * @param {string} indent
 * @returns {string}
 */
function emitMappedArray(arrayDef: JxMappedArray, indent: string) {
  const itemsExpr = isRef(arrayDef.items) ? refToExpr(arrayDef.items.$ref) : "ITEMS";
  const mapDef = arrayDef.map;

  if (!mapDef) {
    return "";
  }

  const tag = mapDef.tagName ?? "div";
  const parts: string[] = [];

  // The map root gets the same attribute treatment as any other element (emitLitNode above);
  // `${item…}`/`${index…}` templates resolve against the map callback's own parameters.
  if (mapDef.attributes) {
    for (const [key, val] of Object.entries(mapDef.attributes)) {
      if (val && typeof val === "object" && isRef(val)) {
        parts.push(`${key}="\${${mapRefToExpr(val.$ref)}}"`);
      } else if (typeof val === "string" && val.includes("${")) {
        parts.push(`${key}="${toLitExpr(val)}"`);
      } else {
        parts.push(`${key}="${val}"`);
      }
    }
  }

  if (mapDef.id) {
    parts.push(`id="${toLitExpr(String(mapDef.id))}"`);
  }
  if (mapDef.className) {
    parts.push(`class="${toLitExpr(String(mapDef.className))}"`);
  }

  if (mapDef.$props) {
    for (const [key, val] of Object.entries(mapDef.$props)) {
      if (isRef(val)) {
        parts.push(`.${key}="\${${mapRefToExpr(val.$ref)}}"`);
      } else {
        parts.push(`.${key}="\${${JSON.stringify(val)}}"`);
      }
    }
  }

  const styleStr = emitStyleString(mapDef.style);
  if (styleStr) {
    parts.push(`style="${styleStr}"`);
  }

  for (const [key, val] of Object.entries(mapDef)) {
    if (!key.startsWith("on")) {
      continue;
    }
    const eventName = key.slice(2).toLowerCase();
    if (isRef(val)) {
      parts.push(`@${eventName}="\${(e) => ${refToExpr(val.$ref)}(s, e)}"`);
    } else if (isExpressionDef(val)) {
      const compiled = compileExpression(val.$expression as ExpressionNode, {
        eventParam: "e",
        statePrefix: "s",
      });
      parts.push(`@${eventName}="\${(e) => { ${compiled}; }}"`);
    }
  }

  const attrsStr = parts.length > 0 ? `\n${indent}    ${parts.join(`\n${indent}    `)}` : "";

  let inner = "";
  if (mapDef.textContent !== undefined) {
    inner = toLitTextContent(mapDef.textContent);
  } else if (mapDef.children) {
    inner = `\n${emitLitChildren(mapDef.children, null, `${indent}      `)}\n${indent}    `;
  }

  return `${indent}\${${itemsExpr}.map((item, index) => html\`\n${indent}  <${tag}${attrsStr}\n${indent}  >${inner}</${tag}>\n${indent}\`)}`;
}

/**
 * Convert a $ref string to a JS expression using `s` (this.state alias).
 *
 * @param {string} ref
 * @returns {string}
 */
function refToExpr(ref: string) {
  if (ref.startsWith("#/state/")) {
    const path = ref.slice("#/state/".length);
    return `s.${path.replaceAll("/", ".")}`;
  }
  if (ref.startsWith("$map/")) {
    const path = ref.slice("$map/".length);
    return path.replaceAll("/", ".");
  }
  return `s.${ref}`;
}

/**
 * @param {string} ref
 * @returns {string}
 */
function mapRefToExpr(ref: string) {
  if (ref.startsWith("$map/")) {
    return ref.slice("$map/".length).replaceAll("/", ".");
  }
  return refToExpr(ref);
}

/**
 * @param {string} str
 * @returns {string}
 */
function toLitExpr(str: string) {
  return str.replaceAll("state.", "s.");
}

/**
 * Convert textContent value to lit-html text content. Bug fix: handles $ref objects, which
 * previously produced [object Object].
 *
 * @param {unknown} value
 * @returns {string}
 */
function toLitTextContent(value: unknown) {
  // Handle $ref objects → emit as lit expression
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as JxMutableNode).$ref === "string"
  ) {
    return `\${${refToExpr((value as JxMutableNode).$ref as string)}}`;
  }
  if (typeof value === "string" && value.includes("${")) {
    return toLitExpr(value);
  }
  return String(value);
}

/**
 * @param {import("@jxsuite/schema/types").JxFunctionDef} def
 * @returns {string}
 */
function inlineHandlerBody(def: JxFunctionDef) {
  if (hasStructuredBody(def)) {
    return compileStatements(def.body, {
      dispatchTarget: "e.currentTarget",
      eventParam: "e",
      statePrefix: "s",
    });
  }
  const body = typeof def.body === "string" ? def.body : "";
  return body.replaceAll(/(?<!this\.)state\./g, "s.").replaceAll(/(?<!this\.)state(?!\.)/g, "s");
}

/**
 * @param {JxStyle | null | undefined} styleDef
 * @returns {string}
 */
function emitStyleString(styleDef: JxStyle | null | undefined) {
  if (!styleDef || typeof styleDef !== "object") {
    return "";
  }

  const parts: string[] = [];
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
 * @param {JxMutableNode["children"]} children
 * @returns {boolean}
 */
function treeHasSlot(children: JxMutableNode["children"]): boolean {
  if (!Array.isArray(children)) {
    return false;
  }
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    if (child.tagName === "slot") {
      return true;
    }
    if (treeHasSlot(child.children)) {
      return true;
    }
  }
  return false;
}
