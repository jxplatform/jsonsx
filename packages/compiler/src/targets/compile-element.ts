/**
 * Compile-element.js — Custom element compilation with lit-html
 *
 * Compiles Jx documents into self-registering custom element ES modules using @vue/reactivity for
 * state and lit-html for rendering.
 */

import { RESERVED_KEYS, camelToKebab } from "@jxsuite/runtime";
import {
  PREFORMATTED_TAGS,
  collectStyles,
  compileExpression,
  compileOperandSource,
  compileStatements,
  emitFormulaFn,
  emitRequestFetch,
  escapeHtml,
  isMutating,
  isSchemaOnly,
  srcImportBinding,
  tagNameToClassName,
} from "../shared.ts";
import {
  bodyReturnsValue,
  hasStructuredBody,
  isExpressionDef,
  isFunctionDef,
  isMappedArray,
  isNamedFormulaDef,
  isRef,
  isTagExpression,
  paramNames,
} from "@jxsuite/schema/guards";
import { parseJxDocument } from "@jxsuite/schema/parse";
import type { ExpressionNode } from "../shared.ts";
import { resolveShadowMode } from "../shadow.ts";
import type { ShadowMode } from "../shadow.ts";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";
import { escapeToken, objectKey, refAccessor, refSegments } from "@jxsuite/runtime/pointer";
import type {
  JxDocument,
  JxExpressionDef,
  JxFunctionDef,
  JxMappedArray,
  JxMutableNode,
  JxPrototypeDef,
  JxStyle,
  ProjectConfig,
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
  /** Project `defaults`, read for `defaults.shadow` (spec.md §16.6). */
  defaults?: ProjectConfig["defaults"];
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
      resolveShadowMode(doc, opts.defaults),
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

/** Lifecycle hooks the generated element calls itself, so they are never `$ref`'d (spec.md §16.4). */
const LIFECYCLE_KEYS = new Set(["onMount", "onUnmount", "onAdopted"]);

/**
 * Collect the state keys a document uses as a _callable_, at any depth: bound to an `on*` event,
 * invoked by an `$expression` `call` node, or called as `state.key(…)` from a template string or
 * another function's body.
 *
 * A bodyless `$src` Function carries no body to classify by, and unlike the interpreter — which
 * introspects the imported function — a compiler only has the document to go on. Anything not used
 * as a callable has its return value read reactively, and so becomes a computed (spec.md §5.3 4b).
 * Defaulting the other way round would turn a called helper into a value and break its call site.
 *
 * @param {JxDocument} doc
 * @returns {Set<string>}
 */
function collectCallableRefs(doc: JxDocument) {
  const keys = new Set<string>();
  const seen = new Set<object>();

  const addStateRef = (ref: unknown) => {
    if (typeof ref === "string" && ref.startsWith("#/state/")) {
      keys.add(ref.slice("#/state/".length).split("/")[0] as string);
    }
  };

  const visit = (node: unknown) => {
    if (typeof node === "string") {
      // `${state.formatDate(d)}` in a template, or `state.helper(x)` in another function's body.
      for (const call of node.matchAll(/\bstate\.([A-Za-z_$][\w$]*)\s*\(/g)) {
        keys.add(call[1] as string);
      }
      return;
    }
    if (!node || typeof node !== "object" || seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    // An `$expression` `call` node names its callee in `target` (spec.md §19.4c).
    if (record.operator === "call" && isRef(record.target)) {
      addStateRef((record.target as { $ref: string }).$ref);
    }
    for (const [key, val] of Object.entries(record)) {
      if (key.startsWith("on") && key !== "observedAttributes" && isRef(val)) {
        addStateRef(val.$ref);
      }
      visit(val);
    }
  };

  visit(doc.children);
  visit(doc.state);
  return keys;
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
  shadow: ShadowMode | null = null,
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
      (srcImportMap.get(srcPath) as string[]).push(srcImportBinding(key, d));
    }
  }
  for (const [srcPath, names] of srcImportMap) {
    // Bundleable specifiers (npm:…, ./relative) are rewritten to their /assets/ bundle URL;
    // The site build bundles them after all documents compile (spec.md §12).
    const importPath = rewriteSrc ? rewriteSrc(srcPath) : srcPath;
    lines.push(`import { ${names.join(", ")} } from '${importPath}';`);
  }

  // `$prototype: "Request"` entries each get an auto-fetch effect in connectedCallback, plus the
  // Machinery to stop those effects again on disconnect. Both are emitted only when one exists, so
  // Documents without a Request produce exactly the same module as before.
  const requestEntries = Object.entries(defs).filter(([, def]) => {
    const d = def as JxMutableNode;
    return Boolean(d) && typeof d === "object" && !Array.isArray(d) && d.$prototype === "Request";
  });

  lines.push(
    `import { reactive, computed, effect, stop } from '@vue/reactivity';`,
    `import { render, html } from 'lit-html';`,
    "",
    `class ${className} extends HTMLElement {`,
    // One registry for every effect the element creates — render, dynamic host styles, Request
    // Auto-fetches. Calling an @vue/reactivity runner re-runs it, so teardown has to be `stop()`,
    // And a single list keeps every effect on the same lifecycle instead of leaking the ones nobody
    // Held a handle to.
    "  #effects = [];",
    ...(shadow === null ? [] : ["  #root = null;"]),
    "",
    // Constructor: build reactive state
    "  constructor() {",
    "    super();",
  );

  const stateEntries: [string, string][] = [];
  const computedEntries: [string, JxExpressionDef | JxFunctionDef][] = [];
  const functionEntries: [string, JxExpressionDef | JxFunctionDef][] = [];

  const formulaEntries: [string, JxExpressionDef][] = [];
  /** `"${…}"` state entries — computed, exactly as the runtime treats them. */
  const templateEntries: [string, string][] = [];
  const callableRefs = collectCallableRefs(doc);
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
      if (d.$src && typeof d.body !== "string") {
        // Bodyless `$src` entry — classify by document usage, not by an absent body. `body` and
        // `$src` are mutually exclusive (spec.md §5.3 4d), so this is the only shape a
        // Spec-conformant external Function takes.
        if (callableRefs.has(key) || LIFECYCLE_KEYS.has(key)) {
          functionEntries.push([key, d]);
        } else {
          computedEntries.push([key, d]);
        }
      } else if (typeof d.body === "string" && bodyReturnsValue(d.body)) {
        computedEntries.push([key, d]);
      } else {
        functionEntries.push([key, d]);
      }
    } else if (typeof def === "string" && def.includes("${")) {
      /* A TEMPLATE STRING IS A COMPUTED, and the runtime has always said so — `runtime.ts`'s
         second state pass is `if (typeof def === "string" && def.includes("${")) state[key] =
         computed(() => evaluateTemplate(def, state))`, and `StateEntry`'s own schema description
         reads "string with ${} → computed". This branch did not exist, so the compiler fell
         through to `extractInitialValue` and emitted the template as a LITERAL.

         The consequence is the worst shape a bug can take: the same component behaved one way in
         Studio's canvas, which runs the runtime, and another way on the deployed site, which runs
         this. A real site's `$switch` discriminant (`imageKey: "${state.image ? 'set' : ''}"`)
         evaluated correctly in the editor and shipped as the literal text of its own expression,
         so the case never matched and the image silently never rendered in production. Found by
         building that site and reading the emitted component. */
      templateEntries.push([key, def]);
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
    /*
     * A state key is author data, not an identifier: `{"user.name": 1}` is a legal document, and
     * pasting it raw emitted `user.name: 1,` — a SyntaxError this build reported as a success.
     */
    lines.push(`      ${objectKey(key)}: ${initVal},`);
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
      lines.push(
        `    ${refAccessor("this.state", escapeToken(key))} = (s, e) => { ${compiled}; };`,
      );
    } else if (hasStructuredBody(def)) {
      // Structured body (spec §20) — statements compiled against this.state; dispatch target is
      // The component instance itself (WHATWG dispatchEvent on the custom element).
      const compiled = compileStatements(def.body, {
        dispatchTarget: "this",
        eventParam: "e",
        indent: "      ",
        statePrefix: "this.state",
      });
      lines.push(
        `    ${refAccessor("this.state", escapeToken(key))} = (s, e) => {`,
        compiled,
        "    };",
      );
    } else {
      const args = def.parameters ? paramNames(def.parameters) : (def.arguments ?? ["state"]);
      const paramList = args.join(", ");
      const body = typeof def.body === "string" ? def.body : "";
      // Every call site invokes a state function as `(state, event)` — the template's
      // `s.fn(s, e)`, `onMount`, `onUnmount`. Declared names that already start with `state` line
      // Up positionally, so they are emitted directly. Any other declaration — including the
      // `"parameters": ["event"]` form that examples/components/{todo-app,fetch-demo}.json use — is
      // Mapped onto the arguments by name, the way the client target does it
      // (compile-client.ts), with `state` bound as the outer parameter so a body referencing bare
      // `state` resolves regardless of the declared arity.
      if (args[0] === "state") {
        if (def.$src) {
          // $src function — wrap imported function so it receives state
          lines.push(
            `    ${refAccessor("this.state", escapeToken(key))} = (${paramList}) => ${key}(${paramList});`,
          );
        } else {
          lines.push(
            `    ${refAccessor("this.state", escapeToken(key))} = (${paramList}) => {`,
            `      ${body}`,
            "    };",
          );
        }
      } else {
        const callArgs = args.map((a: string) => (a === "state" ? "state" : "e")).join(", ");
        if (def.$src) {
          lines.push(
            `    ${refAccessor("this.state", escapeToken(key))} = (state, e) => ${key}(${callArgs});`,
          );
        } else {
          lines.push(
            `    ${refAccessor("this.state", escapeToken(key))} = (state, e) => {`,
            `      const _fn = (${paramList}) => {`,
            `        ${body}`,
            "      };",
            `      return _fn(${callArgs});`,
            "    };",
          );
        }
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
    lines.push(
      `    ${refAccessor("this.state", escapeToken(key))} = ${emitFormulaFn(def, compiled)};`,
    );
  }

  /* Emitted with the same `state.` → `this.state.` rewrite the inline-body path below uses, into a
     template literal — which is what `evaluateTemplate` is, so the result is a string on both
     sides rather than a string here and a raw value there. */
  for (const [key, template] of templateEntries) {
    lines.push(
      "",
      `    ${refAccessor("this.state", escapeToken(key))} = computed(() => \`${template.replaceAll("state.", "this.state.")}\`);`,
    );
  }

  // Emit computed signals — $src or inline body
  for (const [key, def] of computedEntries) {
    lines.push("");
    if (isExpressionDef(def)) {
      const compiled = compileExpression(def.$expression as ExpressionNode, {
        eventParam: "e",
        statePrefix: "this.state",
      });
      lines.push(
        `    ${refAccessor("this.state", escapeToken(key))} = computed(() => ${compiled});`,
      );
    } else if (def.$src) {
      lines.push(
        `    ${refAccessor("this.state", escapeToken(key))} = computed(() => ${key}(this.state));`,
      );
    } else {
      lines.push(`    ${refAccessor("this.state", escapeToken(key))} = computed(() => {`);
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

  // Subtrees a branching construct would otherwise repeat are lifted into `const _cN = html`…``
  // Declarations emitted inside `template()`, above the `return` — inside it, so they are rebuilt
  // Per render and read the same `s` the template does.
  const hoistScope = createHoistScope();
  const templateBody = emitLitChildren(doc.children, doc.style, "      ", false, false, hoistScope);

  lines.push(
    // Template method
    "  template() {",
    "    const s = this.state;",
    ...hoistScope.decls,
    "    return html`",
    templateBody,
    "    `;",
    "  }",
    "",
    ...(shadow === null
      ? []
      : [
          /*
           * The hydration contract. A declarative shadow root the parser already materialized
           * MUST be adopted rather than replaced — calling `attachShadow` over one throws, and
           * even where it did not, replacing it would discard the server-rendered markup this
           * whole feature exists to ship.
           *
           * An `open` root is on the element. A `closed` one is not, by definition, and
           * `ElementInternals` is the standard's only way back to it — which is why the two modes
           * need different code rather than a mode string in one call.
           */
          "  #renderRoot() {",
          "    if (this.#root) return this.#root;",
          shadow === "closed"
            ? "    this.#root = this.attachInternals().shadowRoot ?? this.attachShadow({ mode: 'closed' });"
            : "    this.#root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });",
          "    return this.#root;",
          "  }",
          "",
        ]),
    // ConnectedCallback
    "  connectedCallback() {",
    /*
     * Each of the three absorption paths below skips a `#`-prefixed key: private state is not part
     * of the component's interface and is never settable through $props (spec.md §5.6). Emitted as
     * a runtime check rather than resolved at build time because all three read keys that arrive
     * with the instance — an attribute payload, an attribute name, a property a parent set — none
     * of which the compiler can see. The interpreter enforces the same rule in `runtime.ts`; the
     * two tiers agreeing is the point, since a document is authored against whichever runs.
     */
    // Read $props from data-jx-props attribute (set by compiler for pre-rendered instances)
    "    const _pa = this.getAttribute('data-jx-props');",
    "    if (_pa) {",
    "      try {",
    "        const _p = JSON.parse(_pa);",
    "        for (const [k, v] of Object.entries(_p)) {",
    "          if (k.startsWith('#')) continue;",
    "          if (k in this.state) this.state[k] = v;",
    "        }",
    "      } catch {}",
    "      this.removeAttribute('data-jx-props');",
    "    }",
    // Literal `props.*` attributes — the live-render mirror of the build-time lift in site-build.
    // String values only: HTML lowercases attribute names, so a state key must be lowercase to match.
    // Names are collected first because removing while iterating the live NamedNodeMap skips entries.
    "    const _pn = this.getAttributeNames().filter(n => n.startsWith('props.') && n.length > 6);",
    "    for (const _n of _pn) {",
    "      const _k = _n.slice(6);",
    "      if (_k.startsWith('#')) { this.removeAttribute(_n); continue; }",
    "      if (_k in this.state) {",
    "        this.state[_k] = this.getAttribute(_n);",
    "        this.removeAttribute(_n);",
    "      }",
    "    }",
    // Merge JS properties set before connection (by parent runtime).
    // Only check own properties to avoid inherited DOM properties like `title`.
    "    for (const key of Object.keys(this.state)) {",
    "      if (key.startsWith('#')) continue;",
    "      if (this.hasOwnProperty(key) && this[key] !== undefined) {",
    "        this.state[key] = this[key];",
    "      }",
    "    }",
  );

  // `$prototype: "Request"` entries fetch on connect — after the `$props`/property merge above, so
  // A template `url` interpolates the values the parent passed in rather than the initial ones.
  // Runners are collected so disconnectedCallback can stop them: a reactive URL would otherwise
  // Keep fetching after removal, and every re-insertion would stack another effect on top.
  for (const [key, def] of requestEntries) {
    lines.push(
      emitRequestFetch(key, def as unknown as JxPrototypeDef, {
        collect: "this.#effects",
        indent: "    ",
        statePrefix: "this.state",
      }),
    );
  }
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
      lines.push("    this.#effects.push(effect(() => {");
      for (const [cssProp, value] of dynamicStyles) {
        const expr = value.replaceAll(
          /\$\{([^}]+)\}/g,
          (_: string, e: string) => `\${${e.replaceAll("state.", "this.state.")}}`,
        );
        lines.push(`      this.style['${cssProp}'] = \`${expr}\`;`);
      }
      lines.push("    }));");
    }
  }
  const hasSlot = treeHasSlot(doc.children);
  /*
   * The slot emulation is a light-DOM construction: save the host's children, render over them,
   * then splice them back where the literal `<slot>` element landed. Inside a shadow root that
   * would be actively wrong — the light children ARE the slotted content and must stay in the
   * light tree, where a real `<slot>` distributes them. This is the single largest behavioural
   * difference between the two modes, and the reason shadow cannot be the default.
   */
  if (hasSlot && shadow === null) {
    // Save light DOM children (slotted content) before clearing
    lines.push(
      "    const _slotted = Array.from(this.childNodes).filter(n => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()));",
    );
  }
  lines.push(
    "    if (this.hasAttribute('data-jx-prerendered')) {",
    "      this.removeAttribute('data-jx-prerendered');",
    "    }",
  );
  if (shadow === null) {
    lines.push(
      /*
       * `replaceChildren()`, not `innerHTML = ''`: identical semantics for clearing an element, and
       * it is not a DOM injection sink. The runtime made the same change for the same reason — a
       * write that was never injecting anything still costs a page a Trusted Types policy under
       * `require-trusted-types-for 'script'`, and this one is emitted into every light-DOM element
       * module a site ships.
       */
      "    this.replaceChildren();",
      "    this.#effects.push(effect(() => render(this.template(), this)));",
    );
  } else {
    /*
     * Nothing clears the LIGHT DOM here: those children are the slotted content, and a real
     * `<slot>` distributes them.
     *
     * The shadow root is cleared, and for the same reason light mode clears `innerHTML`: lit
     * renders into a container by appending its own tree, so leaving the declarative markup in
     * place shows the component twice. A declarative shadow root is a first paint, not a
     * hydration target — Jx does not use lit-ssr's `hydrate`, and the light path discards its
     * prerender too.
     *
     * The stylesheet link is the one thing that survives: it is what styles this root, the
     * document's head cannot reach in here, and re-adding it would refetch it.
     */
    lines.push(
      "    const _root = this.#renderRoot();",
      "    for (const _n of [..._root.childNodes]) {",
      "      if (!(_n.nodeType === 1 && _n.tagName === 'LINK')) _n.remove();",
      "    }",
      "    this.#effects.push(effect(() => render(this.template(), _root)));",
    );
  }
  if (hasSlot && shadow === null) {
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
    "    for (const _e of this.#effects) { stop(_e); }",
    "    this.#effects.length = 0;",
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
 * Declarations that must be emitted _beside_ a lit template rather than inside it.
 *
 * `emitLitNode` writes one template string, so a construct with N branches recursed once per branch
 * and wrote the whole subtree N times into the bundle — the authored document contains it once. A
 * scope collects `const _cN = html`…`;` declarations for subtrees that would otherwise repeat, and
 * the branches reference those instead.
 *
 * One scope per template body: `template()` has its own, and each map callback gets a fresh one
 * because its declarations close over that callback's `item`/`index`.
 */
interface HoistScope {
  decls: string[];
  byText: Map<string, string>;
}

function createHoistScope(): HoistScope {
  return { byText: new Map(), decls: [] };
}

/**
 * Hoist an emitted subtree into a `const` and return the `${_cN}` expression referencing it.
 * Identical subtrees collapse onto a single declaration.
 *
 * @param {HoistScope} scope
 * @param {string} text
 * @returns {string}
 */
function hoistSubtree(scope: HoistScope, text: string): string {
  const existing = scope.byText.get(text);
  if (existing) {
    return existing;
  }
  const name = `_c${scope.decls.length}`;
  scope.decls.push(`    const ${name} = html\`\n${text}\n    \`;`);
  const ref = `\${${name}}`;
  scope.byText.set(text, ref);
  return ref;
}

/**
 * Convert Jx children to lit-html template content.
 *
 * @param {JxMutableNode["children"]} children
 * @param {JxStyle | null | undefined} parentStyle
 * @param {string} indent
 * @param {boolean} [preformatted]
 * @returns {string}
 */
function emitLitChildren(
  children: JxMutableNode["children"],
  _parentStyle: JxStyle | null | undefined,
  indent: string,
  preformatted = false,
  inMap = false,
  scope: HoistScope | null = null,
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
      isMappedArray(child)
        ? emitMappedArray(child, indent)
        : emitLitNode(child, preformatted ? "" : indent, preformatted, inMap, scope),
    )
    .join(preformatted ? "" : "\n");
}

/**
 * @param {JxMutableNode | string} def
 * @param {string} indent
 * @param {boolean} [preformatted]
 * @returns {string}
 */
function emitLitNode(
  def: JxMutableNode | string,
  indent: string,
  preformatted = false,
  inMap = false,
  scope: HoistScope | null = null,
  /** Pre-emitted inner content, so a branching construct can share one subtree across branches. */
  innerOverride: string | null = null,
): string {
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

  /* A CHOSEN TAG BECOMES ONE TEMPLATE PER CANDIDATE, keyed by the discriminant — the same shape
     this function already emits for `$switch` twenty lines down, because it is the same problem:
     lit cannot bind a tag name, and the alternative (`lit-html/static.js`'s `unsafeStatic`) is an
     HTML-injection primitive with an unbounded template cache, deliberately avoided in this repo.

     The candidates are literal `TagName`s by schema, so this terminates and every branch is a legal
     element. The subtree is written once in the DOCUMENT, and — since the hoist scope below lifts it
     into a single `const` the branches share — once in the BUNDLE too. */
  if (isTagExpression(def.tagName)) {
    const expression = def.tagName.$expression;
    // The same two shapes `$switch` accepts: a pointer, or an expression node.
    // `compileOperandSource` — the compiler's counterpart to the runtime's `evaluateOperand`, so
    // Both sides read the discriminant the same way.
    const discriminant = compileOperandSource(expression.target, {
      eventParam: "e",
      statePrefix: "s",
    });
    const branches =
      expression.operator === "?:"
        ? [
            [true, expression.value],
            [false, expression.initial],
          ]
        : [...Object.entries(expression.cases), ["__default__", expression.default]];
    // The inner content is identical across candidates — only the tag differs — so it is emitted
    // Once and every branch references it. Skipped when the candidates disagree about being
    // Preformatted, because `white-space` decides how the subtree itself is indented.
    const candidateTags = branches.map(([, candidate]) => String(candidate));
    const sharedPre = candidateTags.map((t) => preformatted || PREFORMATTED_TAGS.has(t));
    let innerRef: string | null = null;
    if (scope && sharedPre.every((p) => p === sharedPre[0])) {
      const sharedInner = emitNodeInner(def, `${indent}  `, sharedPre[0] === true, inMap, scope);
      if (sharedInner.trim() !== "") {
        innerRef = hoistSubtree(scope, sharedInner);
      }
    }
    const rendered: [string | boolean | undefined, string][] = branches.map(([key, candidate]) => {
      const asLiteral = { ...def, tagName: candidate as string };
      return [key, emitLitNode(asLiteral, `${indent}  `, preformatted, inMap, scope, innerRef)];
    });
    if (expression.operator === "?:") {
      const [, yes] = rendered[0]!;
      const [, no] = rendered[1]!;
      return `${indent}\${${discriminant}
  ? html\`
${yes}
  \`
  : html\`
${no}
  \`}`;
    }
    const entries = rendered
      .filter(([key]) => key !== "__default__")
      .map(([key, text]) => `  ${JSON.stringify(key)}: html\`\n${text}\n  \``);
    const [, fallback] = rendered.at(-1)!;
    return (
      `${indent}${"$"}{{\n${entries.join(",\n")}\n}` +
      `[String(${discriminant})] ?? html\`\n${fallback}\n\`}`
    );
  }

  const tag = def.tagName ?? "div";
  // `white-space` inherits, so once inside a <pre> the whole subtree stays whitespace-significant.
  const inPre = preformatted || PREFORMATTED_TAGS.has(tag);

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

  // `id`/`className` take the same template rewriting as every other attribute — inside a map
  // These routinely carry `${$map.item…}`/`${$map.index}`, which emitMappedArray already rewrites
  // On the map root but nothing rewrote on its descendants.
  if (def.id) {
    parts.push(`id="${toLitExpr(String(def.id))}"`);
  }
  if (def.className) {
    parts.push(`class="${toLitExpr(String(def.className))}"`);
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
    } else {
      // A literal IDL value (`value: "a"`, `checked: true`) is still a property the author asked
      // For. Without this branch it was dropped outright — including every `${…}` a build-time map
      // Expansion had already resolved to a constant, which is how an unrolled `<option>` lost its
      // Value and fell back to using its own label as its key.
      parts.push(`.${key}="\${${JSON.stringify(val)}}"`);
    }
  }

  if (def.$props) {
    for (const [key, val] of Object.entries(def.$props)) {
      if (val && typeof val === "object" && (val as JxMutableNode).$ref) {
        parts.push(`.${key}="\${${refToExpr((val as JxMutableNode).$ref as string)}}"`);
      } else if (typeof val === "string" && val.includes("${")) {
        // A template value is a binding, not text. JSON-quoting it emitted the template's own source
        // As the prop value (`.label="${"${state.x}"}"`), so the component received the literal
        // String `${state.x}` forever.
        parts.push(`.${key}="${toLitExpr(val)}"`);
      } else {
        parts.push(`.${key}="\${${JSON.stringify(val)}}"`);
      }
    }
  }

  // A handler bound inside a map publishes its iteration to state before running, matching the
  // Interpreter's child scope and the client target's handler wrapper. Bodies read it as
  // `state.$map.index` / `state.$map.item`.
  const mapCtx = inMap ? "s.$map = $map; " : "";
  for (const [key, val] of Object.entries(def)) {
    if (!key.startsWith("on") || key === "observedAttributes") {
      continue;
    }
    const eventName = key.slice(2).toLowerCase();
    if (val && typeof val === "object" && (val as JxMutableNode).$ref) {
      parts.push(
        mapCtx
          ? `@${eventName}="\${(e) => { ${mapCtx}${refToExpr((val as JxMutableNode).$ref as string)}(s, e); }}"`
          : `@${eventName}="\${(e) => ${refToExpr((val as JxMutableNode).$ref as string)}(s, e)}"`,
      );
    } else if (val && typeof val === "object" && "$expression" in /** @type {any} */ val) {
      const compiled = compileExpression(
        (val as Record<string, unknown>).$expression as ExpressionNode,
        {
          eventParam: "e",
          statePrefix: "s",
        },
      );
      parts.push(`@${eventName}="\${(e) => { ${mapCtx}${compiled}; }}"`);
    } else if (isFunctionDef(val)) {
      parts.push(`@${eventName}="\${(e) => { ${mapCtx}${inlineHandlerBody(val)} }}"`);
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

  const inner = innerOverride ?? emitNodeInner(def, indent, inPre, inMap, scope);

  // Inside a <pre>, the newline before `>` would land in the element's own text.
  return inPre
    ? `<${tag}${attrsStr}>${inner}</${tag}>`
    : `${indent}<${tag}${attrsStr}\n${indent}>${inner}</${tag}>`;
}

/**
 * Emit an element's inner content — the `$switch` lookup, text, raw HTML, or children.
 *
 * Split out of `emitLitNode` so a chosen `tagName` can emit it once and share it across candidates
 * instead of recursing into the same subtree per branch.
 *
 * @param {JxMutableNode} def
 * @param {string} indent
 * @param {boolean} inPre
 * @param {boolean} inMap
 * @param {HoistScope | null} scope
 * @returns {string}
 */
function emitNodeInner(
  def: JxMutableNode,
  indent: string,
  inPre: boolean,
  inMap: boolean,
  scope: HoistScope | null,
): string {
  if (def.$switch) {
    const switchRef = isRef(def.$switch) ? def.$switch.$ref : (def.$switch as string);
    const switchExpr = refToExpr(switchRef);
    const cases = (def.cases ?? {}) as Record<string, JxMutableNode>;
    const rendered: [string, string][] = [];
    for (const [key, caseDef] of Object.entries(cases)) {
      if (!caseDef || isRef(caseDef)) {
        continue;
      }
      rendered.push([key, emitLitNode(caseDef, `${indent}  `, false, inMap, scope)]);
    }
    // Cases that emit byte-identical subtrees share one hoisted `const` rather than repeating it
    // Once per case — the authored document names the subtree once (#126).
    const repeated = new Set(
      rendered
        .map(([, text]) => text)
        .filter((text, i, all) => all.indexOf(text) !== i && text.trim() !== ""),
    );
    const caseEntries = rendered.map(([key, text]) => {
      const body = scope && repeated.has(text) ? hoistSubtree(scope, text) : text;
      return `  ${JSON.stringify(key)}: html\`\n${body}\n  \``;
    });
    return `\${{\n${caseEntries.join(",\n")}\n}[${switchExpr}]}`;
  }
  if (def.textContent !== undefined) {
    return toLitTextContent(def.textContent);
  }
  if (def.innerHTML !== undefined) {
    return def.innerHTML;
  }
  if (def.children) {
    return inPre
      ? emitLitChildren(def.children, def.style, "", true, inMap, scope)
      : `\n${emitLitChildren(def.children, def.style, `${indent}  `, false, inMap, scope)}\n${indent}`;
  }
  return "";
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

  // IDL properties (`value`, `checked`, `selected`, …) go straight on the element, exactly as they
  // Do outside a map (emitLitNode above). Without this loop the map body silently dropped them, so
  // An `<option value="${$map.item.v}">` emitted no value at all and every option fell back to its
  // Own label — a change handler then received a display string instead of the key.
  for (const [key, val] of Object.entries(mapDef)) {
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
      parts.push(`.${key}="\${${mapRefToExpr((val as JxMutableNode).$ref as string)}}"`);
    } else if (typeof val === "string" && val.includes("${")) {
      parts.push(`.${key}="${toLitExpr(val)}"`);
    } else {
      parts.push(`.${key}="\${${JSON.stringify(val)}}"`);
    }
  }

  if (mapDef.$props) {
    for (const [key, val] of Object.entries(mapDef.$props)) {
      if (isRef(val)) {
        parts.push(`.${key}="\${${mapRefToExpr(val.$ref)}}"`);
      } else if (typeof val === "string" && val.includes("${")) {
        // `$props: { label: "${$map.item.name}" }` is the ordinary way to pass per-item data to a
        // Component in a list; JSON-quoting it handed over the template source instead.
        parts.push(`.${key}="${toLitExpr(val)}"`);
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
      parts.push(`@${eventName}="\${(e) => { s.$map = $map; ${refToExpr(val.$ref)}(s, e); }}"`);
    } else if (isExpressionDef(val)) {
      const compiled = compileExpression(val.$expression as ExpressionNode, {
        eventParam: "e",
        statePrefix: "s",
      });
      parts.push(`@${eventName}="\${(e) => { s.$map = $map; ${compiled}; }}"`);
    }
  }

  const attrsStr = parts.length > 0 ? `\n${indent}    ${parts.join(`\n${indent}    `)}` : "";

  // The map body gets its own hoist scope: a subtree lifted out of a branch here closes over this
  // Callback's `item`/`index`, so its declaration belongs inside the callback, not in `template()`.
  const mapScope = createHoistScope();
  let inner = "";
  if (mapDef.textContent !== undefined) {
    inner = toLitTextContent(mapDef.textContent);
  } else if (mapDef.children) {
    inner = `\n${emitLitChildren(mapDef.children, null, `${indent}      `, false, true, mapScope)}\n${indent}    `;
  }

  const body = `html\`\n${indent}  <${tag}${attrsStr}\n${indent}  >${inner}</${tag}>\n${indent}\``;

  // `${$map.item…}` and `${$map.index}` are spec-sanctioned template forms: spec.md §6.6 names
  // `$map` alongside `item`/`index` as an iteration binding, and the interpreter passes it into the
  // Template evaluator as a real parameter. The compiled callback bound only `item`/`index`, so
  // Every such template survived into the module as a dead `$map` reference and threw at render.
  // Binding the same object here resolves every access form — `$map.item`, `$map?.item`,
  // `$map["item"]` — and nests correctly, since an inner map shadows the outer binding exactly as
  // The interpreter's child scope does. Emitted only when referenced, so output is otherwise
  // Unchanged.
  const prelude =
    (body.includes("$map") ? `const $map = { item, index }; ` : "") +
    mapScope.decls.map((d) => `${d.trim()} `).join("");
  const callback = prelude
    ? `(item, index) => { ${prelude}return ${body}; }`
    : `(item, index) => ${body}`;

  return `${indent}\${${itemsExpr}.map(${callback})}`;
}

/**
 * Convert a $ref string to a JS expression using `s` (this.state alias).
 *
 * @param {string} ref
 * @returns {string}
 */
function refToExpr(ref: string) {
  if (ref.startsWith("#/state/")) {
    return refAccessor("s", ref.slice("#/state/".length));
  }
  if (ref.startsWith("$map/")) {
    return mapVarAccessor(ref.slice("$map/".length));
  }
  /*
   * The remaining schemes, mirroring `compileRef` in @jxsuite/runtime. They used to fall through to
   * the state branch, so `parent#/user` emitted `s.parent#/user` — a syntax error. A prop reaches
   * this element through `state`, so `parent#/` reads from `s` exactly as `#/state/` does.
   */
  if (ref.startsWith("parent#/")) {
    return refAccessor("s", ref.slice("parent#/".length));
  }
  if (ref.startsWith("window#/")) {
    return refAccessor("window", ref.slice("window#/".length));
  }
  if (ref.startsWith("document#/")) {
    return refAccessor("document", ref.slice("document#/".length));
  }
  return refAccessor("s", ref);
}

/**
 * `$map/item/title` reads the loop variable `item`, so its first segment is an emitted identifier
 * rather than a member of some receiver — the one ref form whose base is not fixed.
 *
 * @param {string} path
 * @returns {string}
 */
function mapVarAccessor(path: string) {
  const [head, ...rest] = refSegments(path);
  return refAccessor(head ?? "", rest.map((seg) => escapeToken(seg)).join("/"));
}

/**
 * @param {string} ref
 * @returns {string}
 */
function mapRefToExpr(ref: string) {
  if (ref.startsWith("$map/")) {
    return mapVarAccessor(ref.slice("$map/".length));
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
  const declared = def.parameters ? paramNames(def.parameters) : (def.arguments ?? []);
  if (declared.length > 0) {
    // The call site supplies only `(e)`, so map the declared names onto the arguments the handler
    // Actually has — `state` to the `s` alias, anything else to the event. Binding by name means the
    // Body needs no textual rewriting, and a declared `event` stops silently resolving to the
    // Deprecated `window.event` global (any other declared name threw ReferenceError outright).
    const args = declared.map((name: string) => (name === "state" ? "s" : "e")).join(", ");
    return `((${declared.join(", ")}) => { ${body} })(${args});`;
  }
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
