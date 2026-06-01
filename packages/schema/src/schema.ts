/**
 * jx-schema.js — Jx JSON Schema 2020-12 meta-schema generator
 * @version 1.0.0
 * @license MIT
 *
 * Generates a comprehensive JSON Schema 2020-12 document that validates Jx
 * source files. All HTML element names, CSS property names, and DOM event
 * handler names are derived at generation time from upstream web standards via:
 *
 *   webref/elements — HTML element tag names
 *   webref/css      — CSS property names (camelCase CSSOM)
 *   webref/idl      — DOM EventHandler attribute names
 *
 * Usage:
 *   import { generateSchema } from './schema.js';
 *   const schema = await generateSchema();
 *   fs.writeFileSync('schema.json', JSON.stringify(schema, null, 2));
 *
 * CLI:
 *   bun run schema.js [output-path]
 *
 * @module jx-schema
 */

import { listAll as listElements } from "@webref/elements";
import css from "@webref/css";
import idl from "@webref/idl";

// ─── Built-in $prototype values (Jx-specific, not from web standards) ─────

const BUILT_IN_PROTOTYPES = [
  "Function",
  "Request",
  "URLSearchParams",
  "FormData",
  "LocalStorage",
  "SessionStorage",
  "Cookie",
  "IndexedDB",
  "Array",
  "Set",
  "Map",
  "Blob",
  "ReadableStream",
];

// ─── Web standards data loader ────────────────────────────────────────────────

/**
 * Fetch and normalise the three webref datasets in parallel.
 *
 * @returns {Promise<{ tagExamples: string[]; cssProps: string[]; eventHandlers: string[] }>}
 */
async function loadWebData() {
  const [elementsData, cssData, idlData] = await Promise.all([
    listElements(),
    css.listAll(),
    idl.parseAll(),
  ]);

  // ── Tag names ──────────────────────────────────────────────────────────────
  const tagSet = new Set<string>();
  for (const { elements } of Object.values(elementsData)) {
    for (const el of elements) {
      if (!el.obsolete) tagSet.add(el.name);
    }
  }
  const tagExamples = [...tagSet].sort();

  // ── CSS camelCase property names (CSSOM styleDeclaration) ─────────────────
  const cssSet = new Set<string>();
  for (const prop of cssData.properties) {
    for (const decl of prop.styleDeclaration ?? []) {
      cssSet.add(decl);
    }
  }
  const cssProps = [...cssSet].sort();

  // ── EventHandler attribute names from IDL ─────────────────────────────────
  const handlerSet = new Set<string>();
  for (const ast of Object.values(idlData)) {
    for (const def of ast) {
      if (def.type !== "interface" && def.type !== "interface mixin") continue;
      if (!def.members) continue;
      for (const member of def.members) {
        if (
          member.type === "attribute" &&
          member.name?.startsWith("on") &&
          typeof member.idlType?.idlType === "string" &&
          member.idlType.idlType === "EventHandler"
        ) {
          handlerSet.add(member.name);
        }
      }
    }
  }
  const eventHandlers = [...handlerSet].sort();

  return { tagExamples, cssProps, eventHandlers };
}

// ─── Generator ────────────────────────────────────────────────────────────────

/**
 * Generate the full Jx meta-schema as a plain JavaScript object. Derives HTML elements, CSS
 * properties, and event handlers from upstream web standards data at generation time.
 *
 * @returns {Promise<object>} JSON Schema 2020-12 document
 */
export async function generateSchema() {
  const { tagExamples, cssProps, eventHandlers } = await loadWebData();

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://jxsuite.com/schema/v1",
    title: "Jx Document",
    description:
      "Schema for Jx component files. " +
      "A Jx document is a JSON object that declaratively describes a reactive " +
      "web component: its structure (DOM tree), styling, type definitions ($defs), " +
      "runtime state, and inline or external functions. Reactivity is powered by @vue/reactivity.",
    type: "object",

    // ── Top-level properties ────────────────────────────────────────────────
    properties: {
      $schema: {
        description: "URI identifying the Jx dialect version. Enables schema-aware IDE tooling.",
        type: "string",
        examples: ["https://jxsuite.com/schema/v1"],
      },
      $id: {
        description: "Component identifier string. Used by tooling and the builder.",
        type: "string",
        examples: ["Counter", "TodoApp", "UserCard"],
      },
      $defs: {
        description:
          "Pure JSON Schema type definitions for this component. " +
          "All entries are reusable type schemas — no runtime artifacts are produced. " +
          "Referenced from state entries via $ref. Naming convention: PascalCase.",
        $ref: "#/$defs/DefsMap",
      },
      state: {
        description:
          "Runtime variables for this component. All entries are reactive by default. " +
          "Entry shape is determined by value type: " +
          "scalar/array → reactive property, string with ${} → computed, " +
          "object with $prototype → function or data source, " +
          "object with type and default → typed reactive property.",
        $ref: "#/$defs/StateMap",
      },
      $media: {
        description:
          "Named media breakpoints following CSS @custom-media convention. " +
          "Keys use the CSS custom property -- prefix.",
        type: "object",
        additionalProperties: { type: "string" },
        examples: [
          {
            "--sm": "(min-width: 640px)",
            "--md": "(min-width: 768px)",
            "--dark": "(prefers-color-scheme: dark)",
          },
        ],
      },
      $elements: {
        description:
          "Custom element dependencies. Items are either $ref objects pointing to JX " +
          "element definitions, or bare npm package name strings for web component libraries.",
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              required: ["$ref"],
              properties: { $ref: { type: "string" } },
              additionalProperties: false,
            },
            {
              type: "string",
              description: "npm package specifier (must declare customElements in package.json)",
            },
          ],
        },
      },
      $head: {
        description:
          "Page-level <head> entries. Array of element definitions for meta tags, " +
          "link tags, script tags, etc. Merged with layout and site-level $head entries.",
        type: "array",
        items: { $ref: "#/$defs/ElementDef" },
      },
      $layout: {
        description:
          "Layout reference for pages. String path to a layout JSON file, " +
          "or false to opt out of the default layout.",
        oneOf: [{ type: "string" }, { type: "boolean", const: false }],
        examples: ["./layouts/base.json"],
      },
      $paths: {
        description:
          "Dynamic route parameters. Maps parameter names to data sources " +
          "for generating one page per entry at build time.",
        type: "object",
      },
      title: {
        description:
          "Page title. Can be a static string or a template string with ${} expressions.",
        $ref: "#/$defs/StringOrRef",
      },
      imports: {
        description:
          "Import map: $prototype names to .class.json file paths. " +
          "Allows state entries to reference external classes by name without $src.",
        type: "object",
        additionalProperties: { type: "string" },
      },
      observedAttributes: {
        description:
          "HTML attributes the custom element watches for changes. " +
          "Follows the Web Components observedAttributes convention.",
        type: "array",
        items: { type: "string" },
      },
      cases: {
        description:
          "Switch cases object. Maps case values to element definitions or external " +
          "component refs. Used alongside $switch for dynamic component rendering.",
        type: "object",
        additionalProperties: {
          oneOf: [{ $ref: "#/$defs/ElementDef" }, { $ref: "#/$defs/ExternalComponentRef" }],
        },
      },
      tagName: { $ref: "#/$defs/TagName" },
      children: { $ref: "#/$defs/ChildrenValue" },
      style: { $ref: "#/$defs/StyleObject" },
      attributes: { $ref: "#/$defs/AttributesObject" },
    },
    additionalProperties: { $ref: "#/$defs/ElementPropertyValue" },

    // ── Reusable sub-schemas ────────────────────────────────────────────────
    $defs: {
      // ── $defs map (type definitions only) ────────────────────────────────
      DefsMap: {
        description:
          "Map of reusable JSON Schema type definitions. " +
          "Keys are PascalCase type names. No runtime artifacts are produced.",
        type: "object",
        additionalProperties: { $ref: "#/$defs/TypeDefEntry" },
      },

      TypeDefEntry: {
        description:
          "A $defs type definition entry. Must be a pure JSON Schema type " +
          "definition or a class definition (.class.json format).",
        oneOf: [{ $ref: "#/$defs/PureTypeDef" }, { $ref: "#/$defs/ClassDef" }],
      },

      // ── state map (runtime variables) ───────────────────────────────────
      StateMap: {
        description:
          "Map of runtime variables. Keys are camelCase (public) or #-prefixed (private). " +
          "All entries are reactive by default.",
        type: "object",
        additionalProperties: { $ref: "#/$defs/StateEntry" },
      },

      StateEntry: {
        description:
          "A single state entry. Shape is determined by value type: " +
          "scalar/array → naked reactive property, string with ${} → computed, " +
          'object with $prototype: "Function" → function, ' +
          "object with $prototype: <other> → data source, " +
          "object with type and default → typed reactive property, " +
          "plain object → naked object reactive property.",
        oneOf: [
          // Shape 1: Naked value (scalar)
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { type: "string" },
          { type: "array" },
          // Shape 2: Typed value (object with type and default, no $prototype)
          { $ref: "#/$defs/TypedStateDef" },
          // Shape 3: Function ($prototype: "Function")
          { $ref: "#/$defs/FunctionDef" },
          // Shape 4: External class / data source ($prototype: <other>)
          { $ref: "#/$defs/ExternalClassDef" },
          // Shape 5: Expression ($expression)
          { $ref: "#/$defs/ExpressionEntry" },
          // Shape 1: Naked object (plain object, no reserved keys)
          {
            type: "object",
            not: {
              anyOf: [
                { required: ["$prototype"] },
                { required: ["default"] },
                { required: ["type"] },
                { required: ["$expression"] },
              ],
            },
          },
        ],
      },

      // ── Shape 2: Typed State Variable ──────────────────────────────────
      TypedStateDef: {
        description:
          "A typed reactive state variable with explicit type and default value. " +
          "The type property is a JSON Schema or $ref to a $defs type definition. " +
          "The default property is the initial runtime value.",
        type: "object",
        required: ["default"],
        properties: {
          default: { description: "Initial state value." },
          type: {
            description:
              "JSON Schema type definition, $ref to a $defs type, or JSON Schema type string.",
            oneOf: [{ type: "string" }, { type: "object" }],
          },
          description: { type: "string" },
          attribute: {
            description: "Linked HTML attribute name for CEM extraction.",
            type: "string",
          },
          reflects: {
            description: "Whether property changes reflect back to the HTML attribute.",
            type: "boolean",
          },
          deprecated: {
            description: "Deprecation notice for CEM extraction.",
            oneOf: [{ type: "boolean" }, { type: "string" }],
          },
          examples: { type: "array" },
          $ref: { description: "Reference to a shared type definition.", type: "string" },
        },
        not: { required: ["$prototype"] },
      },

      // ── Shape 2b: Pure Type Definition ───────────────────────────────────
      PureTypeDef: {
        description:
          "A reusable JSON Schema type definition for tooling only. " +
          "No function, no runtime artifact. " +
          "Referenced from state entries via $ref. " +
          "Naming convention: PascalCase.",
        type: "object",
        required: ["type"],
        properties: {
          type: { $ref: "#/$defs/JsonSchemaType" },
          description: { type: "string" },
          enum: { type: "array" },
          minimum: { type: "number" },
          maximum: { type: "number" },
          minLength: { type: "integer", minimum: 0 },
          maxLength: { type: "integer", minimum: 0 },
          pattern: { type: "string" },
          items: {},
          properties: { type: "object" },
          required: { type: "array", items: { type: "string" } },
          examples: { type: "array" },
        },
        not: {
          anyOf: [{ required: ["default"] }, { required: ["$prototype"] }],
        },
      },

      // ── Shape 4: Function ────────────────────────────────────────────────
      FunctionDef: {
        description:
          'A function declaration. $prototype must be "Function". ' +
          "body (inline) and $src (external) are mutually exclusive. " +
          "First parameter is always state (the reactive scope).",
        type: "object",
        required: ["$prototype"],
        properties: {
          $prototype: { type: "string", const: "Function" },
          body: {
            description: "Inline function body string. First implicit parameter is state.",
            type: "string",
            examples: [
              "state.count++",
              'state.items.push({ id: Date.now(), text: "", done: false })',
              'return state.score >= 90 ? "gold" : "silver"',
            ],
          },
          parameters: {
            description:
              "Function parameters (after the implicit state parameter). " +
              "Accepts CEM-compatible parameter objects or bare string names for backward compatibility.",
            type: "array",
            items: {
              oneOf: [{ type: "string" }, { $ref: "#/$defs/CemParameter" }],
            },
            examples: [
              ["event"],
              [{ name: "event", type: { text: "Event" } }],
              [{ name: "id", type: { text: "number" }, description: "Item identifier" }],
            ],
          },
          name: {
            description: "Explicit function name. Defaults to the state key name.",
            type: "string",
          },
          $src: {
            description: "External module specifier. Mutually exclusive with body.",
            type: "string",
            examples: ["./counter.js", "npm:@myorg/validators"],
          },
          $export: {
            description: "Named export in $src module. Defaults to the state key name.",
            type: "string",
          },
          type: {
            description: "Return type for tooling (JSON Schema or CEM { text } format).",
          },
          emits: {
            description:
              "Array of CEM-compatible Event objects this function dispatches. " +
              "Used for CEM extraction and studio event discovery.",
            type: "array",
            items: { $ref: "#/$defs/CemEvent" },
          },
          description: { type: "string" },
        },
        additionalProperties: false,
      },

      // ── Shape 6: Class Definition ($prototype: "Class") ────────────────
      ClassDef: {
        description:
          'A .class.json schema-defined class. $prototype must be "Class". ' +
          "Defines fields, constructor, methods, and type parameters via $defs. " +
          "Optionally points to a JS module via $implementation for hybrid execution.",
        type: "object",
        required: ["$prototype", "title"],
        properties: {
          $schema: { type: "string" },
          $id: { type: "string" },
          $prototype: { type: "string", const: "Class" },
          title: {
            description: "PascalCase class name, used as the export name.",
            type: "string",
          },
          description: { type: "string" },
          extends: {
            description: "Base class — string name or $ref to another .class.json.",
            oneOf: [
              { type: "string" },
              { type: "object", required: ["$ref"], properties: { $ref: { type: "string" } } },
            ],
          },
          $implementation: {
            description: "Relative path to a JS module containing the actual class implementation.",
            type: "string",
          },
          $defs: {
            description: "Class members: parameters, returnTypes, fields, constructor, methods.",
            type: "object",
            properties: {
              parameters: {
                description: "Reusable typed parameter schemas, keyed by name.",
                type: "object",
                additionalProperties: { $ref: "#/$defs/ClassParameterDef" },
              },
              returnTypes: {
                description: "Output type schemas, keyed by name.",
                type: "object",
                additionalProperties: { type: "object" },
              },
              fields: {
                description: "Class fields with role, access, scope, and type information.",
                type: "object",
                additionalProperties: { $ref: "#/$defs/ClassFieldDef" },
              },
              constructor: { $ref: "#/$defs/ClassConstructorDef" },
              methods: {
                description: "Class methods and accessors.",
                type: "object",
                additionalProperties: { $ref: "#/$defs/ClassMethodDef" },
              },
            },
          },
        },
        additionalProperties: false,
      },

      ClassParameterDef: {
        description: "A typed parameter definition for a class.",
        type: "object",
        required: ["identifier"],
        properties: {
          identifier: { type: "string" },
          type: {},
          format: {
            description: 'When "json-schema", this parameter\'s value is itself a JSON Schema.',
            type: "string",
          },
          description: { type: "string" },
          default: {},
          examples: { type: "array" },
        },
      },

      ClassFieldDef: {
        description: "A class field definition with access control and scope.",
        type: "object",
        properties: {
          role: { type: "string", const: "field" },
          access: { type: "string", enum: ["public", "private", "protected"] },
          scope: { type: "string", enum: ["instance", "static"] },
          identifier: { type: "string" },
          type: {},
          $prototype: {
            description: 'Data source prototype for this field (e.g., "Request").',
            type: "string",
          },
          initializer: {},
          default: {},
          description: { type: "string" },
          examples: { type: "array" },
        },
      },

      ClassConstructorDef: {
        description: "Class constructor definition.",
        type: "object",
        properties: {
          role: { type: "string", const: "constructor" },
          $prototype: { type: "string", const: "Function" },
          parameters: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  required: ["$ref"],
                  properties: { $ref: { type: "string" } },
                  additionalProperties: false,
                },
                { $ref: "#/$defs/ClassParameterDef" },
              ],
            },
          },
          superCall: {
            type: "object",
            properties: {
              arguments: { type: "array", items: { type: "string" } },
            },
          },
          body: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
        },
      },

      ClassMethodDef: {
        description: "A class method or accessor definition.",
        type: "object",
        properties: {
          role: { type: "string", enum: ["method", "accessor"] },
          $prototype: { type: "string", const: "Function" },
          access: { type: "string", enum: ["public", "private", "protected"] },
          scope: { type: "string", enum: ["instance", "static"] },
          identifier: { type: "string" },
          parameters: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  required: ["$ref"],
                  properties: { $ref: { type: "string" } },
                  additionalProperties: false,
                },
                { $ref: "#/$defs/ClassParameterDef" },
              ],
            },
          },
          returnType: {},
          body: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          getter: {
            type: "object",
            properties: { body: { type: "string" } },
          },
          setter: {
            type: "object",
            properties: {
              parameters: { type: "array" },
              body: { type: "string" },
            },
          },
          description: { type: "string" },
        },
      },

      // ── Shape 5: External Class ──────────────────────────────────────────
      ExternalClassDef: {
        description:
          'An external class / data source. $prototype is a constructor name (not "Function"). ' +
          "When $prototype is not in the built-in registry, $src is required. " +
          "All state entries are reactive by default.",
        type: "object",
        required: ["$prototype"],
        properties: {
          $prototype: {
            description: "Constructor name — built-in Web API class or external class name.",
            type: "string",
            not: { const: "Function" },
            examples: [
              ...BUILT_IN_PROTOTYPES.filter((p) => p !== "Function"),
              "MarkdownCollection",
              "MyParser",
            ],
          },
          $src: {
            description: "External module specifier. Required when $prototype is not a built-in.",
            type: "string",
            examples: ["@jxsuite/md", "./lib/my-parser.js", "npm:@myorg/data"],
          },
          $export: {
            description: "Named export in $src module. Defaults to the $prototype value.",
            type: "string",
          },
          timing: { type: "string", enum: ["compiler", "server", "client"] },
          manual: { type: "boolean" },
          debounce: { type: "integer", minimum: 0 },
          url: { $ref: "#/$defs/StringOrRef" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
          },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: {},
          responseType: {
            type: "string",
            enum: ["json", "text", "blob", "arraybuffer", "document", ""],
          },
          key: { type: "string" },
          name: { type: "string" },
          maxAge: { type: "integer" },
          expires: { type: "string" },
          path: { type: "string" },
          domain: { type: "string" },
          secure: { type: "boolean" },
          sameSite: { type: "string", enum: ["strict", "lax", "none"] },
          database: { type: "string" },
          store: { type: "string" },
          version: { type: "integer", minimum: 1 },
          keyPath: { type: "string" },
          autoIncrement: { type: "boolean" },
          indexes: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "keyPath"],
              properties: {
                name: { type: "string" },
                keyPath: {
                  oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                },
                unique: { type: "boolean" },
              },
            },
          },
          default: {},
          description: { type: "string" },
          items: {},
          map: { $ref: "#/$defs/ElementDef" },
          filter: { $ref: "#/$defs/RefObject" },
          sort: { $ref: "#/$defs/RefObject" },
          src: {
            description: "Configuration property passed to external class constructor.",
            type: "string",
          },
        },
      },

      // ── Element definition ────────────────────────────────────────────────
      ElementDef: {
        description: "A Jx element definition. Maps directly to a DOM element.",
        type: "object",
        required: ["tagName"],
        properties: {
          tagName: { $ref: "#/$defs/TagName" },
          id: { type: "string" },
          className: { $ref: "#/$defs/StringOrRef" },
          textContent: { $ref: "#/$defs/StringOrRef" },
          innerHTML: { $ref: "#/$defs/StringOrRef" },
          innerText: { $ref: "#/$defs/StringOrRef" },
          hidden: { $ref: "#/$defs/BoolOrRef" },
          tabIndex: { $ref: "#/$defs/NumberOrRef" },
          title: { $ref: "#/$defs/StringOrRef" },
          lang: { $ref: "#/$defs/StringOrRef" },
          dir: { type: "string", enum: ["ltr", "rtl", "auto"] },
          value: { $ref: "#/$defs/StringOrRef" },
          checked: { $ref: "#/$defs/BoolOrRef" },
          disabled: { $ref: "#/$defs/BoolOrRef" },
          selected: { $ref: "#/$defs/BoolOrRef" },
          src: { $ref: "#/$defs/StringOrRef" },
          href: { $ref: "#/$defs/StringOrRef" },
          alt: { $ref: "#/$defs/StringOrRef" },
          type: { $ref: "#/$defs/StringOrRef" },
          name: { $ref: "#/$defs/StringOrRef" },
          placeholder: { $ref: "#/$defs/StringOrRef" },
          children: { $ref: "#/$defs/ChildrenValue" },
          style: { $ref: "#/$defs/StyleObject" },
          attributes: { $ref: "#/$defs/AttributesObject" },
          $switch: { $ref: "#/$defs/SwitchDef" },
          $ref: { $ref: "#/$defs/ExternalRef" },
          $props: { $ref: "#/$defs/PropsObject" },
          "$map/item": { $ref: "#/$defs/RefObject" },
          "$map/index": { $ref: "#/$defs/RefObject" },
          // Event handlers (derived from @webref/idl at generation time)
          ...buildEventHandlerProperties(eventHandlers),
        },
        additionalProperties: { $ref: "#/$defs/ElementPropertyValue" },
      },

      // ── Children ─────────────────────────────────────────────────────────
      ChildrenValue: {
        description: "Static array of child definitions, or an Array namespace for dynamic lists.",
        oneOf: [
          {
            type: "array",
            items: {
              oneOf: [{ $ref: "#/$defs/ElementDef" }, { type: "string" }, { type: "number" }],
            },
          },
          { $ref: "#/$defs/ArrayNamespace" },
        ],
      },

      ArrayNamespace: {
        description: "Dynamic mapped list. Re-renders when the items state entry changes.",
        type: "object",
        required: ["$prototype", "items", "map"],
        properties: {
          $prototype: { type: "string", const: "Array" },
          items: {
            oneOf: [{ $ref: "#/$defs/RefObject" }, { type: "array" }],
          },
          map: { $ref: "#/$defs/ElementDef" },
          filter: { $ref: "#/$defs/RefObject" },
          sort: { $ref: "#/$defs/RefObject" },
        },
        additionalProperties: false,
      },

      // ── $switch ───────────────────────────────────────────────────────────
      SwitchDef: {
        description: "Reactive $ref that drives which case to render.",
        type: "object",
        required: ["$ref"],
        properties: { $ref: { $ref: "#/$defs/InternalRef" } },
        additionalProperties: false,
      },

      SwitchNode: {
        type: "object",
        required: ["$switch", "cases"],
        properties: {
          tagName: { $ref: "#/$defs/TagName" },
          $switch: { $ref: "#/$defs/SwitchDef" },
          cases: {
            type: "object",
            additionalProperties: {
              oneOf: [{ $ref: "#/$defs/ElementDef" }, { $ref: "#/$defs/ExternalComponentRef" }],
            },
          },
        },
      },

      // ── Style (CSS properties derived from @webref/css) ───────────────────
      StyleObject: {
        description:
          "CSS style definition. camelCase property names follow CSSOM convention. " +
          "Keys starting with :, ., &, or [ are treated as nested CSS selectors. " +
          "Keys matching $media breakpoint names are treated as responsive rules.",
        type: "object",
        // Known camelCase CSS properties give IDE autocompletion
        properties: buildCssProperties(cssProps),
        // Nested selectors, media breakpoints, and custom / unknown properties
        additionalProperties: {
          oneOf: [
            { type: "string" },
            { type: "number" },
            {
              description: "Nested CSS selector or media breakpoint rules.",
              type: "object",
              additionalProperties: { oneOf: [{ type: "string" }, { type: "number" }] },
            },
          ],
        },
      },

      AttributesObject: {
        description: "HTML attributes and ARIA attributes set via element.setAttribute().",
        type: "object",
        additionalProperties: {
          oneOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { $ref: "#/$defs/RefObject" },
          ],
        },
      },

      PropsObject: {
        description: "Explicit prop passing at a component boundary.",
        type: "object",
        additionalProperties: {
          oneOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "array" },
            { type: "object" },
            { $ref: "#/$defs/RefObject" },
          ],
        },
      },

      // ── $ref types ────────────────────────────────────────────────────────
      RefObject: {
        description:
          "A $ref binding. Resolves to a state entry (reactive) or plain value (static).",
        type: "object",
        required: ["$ref"],
        properties: { $ref: { $ref: "#/$defs/AnyRef" } },
        additionalProperties: false,
      },

      AnyRef: {
        type: "string",
        oneOf: [
          { $ref: "#/$defs/InternalRef" },
          { $ref: "#/$defs/StateRef" },
          { $ref: "#/$defs/ExternalRef" },
          { $ref: "#/$defs/GlobalRef" },
          { $ref: "#/$defs/ParentRef" },
          { $ref: "#/$defs/MapRef" },
        ],
      },

      InternalRef: {
        description: "Reference to a $defs type definition in the current component.",
        type: "string",
        pattern: "^#/\\$defs/",
        examples: ["#/$defs/Count", "#/$defs/TodoItem", "#/$defs/Status"],
      },

      StateRef: {
        description: "Reference to a state entry (runtime variable) in the current component.",
        type: "string",
        pattern: "^#/state/",
        examples: ["#/state/count", "#/state/addTask", "#/state/items"],
      },

      ExternalRef: {
        description: "Reference to an external Jx component file.",
        type: "string",
        pattern: "^(\\./|\\.\\./).*\\.json$|^https?://",
        examples: ["./card.json", "https://cdn.example.com/button.json"],
      },

      ExternalComponentRef: {
        type: "object",
        required: ["$ref"],
        properties: {
          $ref: { $ref: "#/$defs/ExternalRef" },
          $props: { $ref: "#/$defs/PropsObject" },
        },
      },

      GlobalRef: {
        description: "Reference to a window or document global.",
        type: "string",
        pattern: "^(window|document)#/",
        examples: ["window#/currentUser", "document#/appConfig"],
      },

      ParentRef: {
        description: "Reference to a named state entry passed via $props from a parent component.",
        type: "string",
        pattern: "^parent#/",
        examples: ["parent#/sharedState", "parent#/theme"],
      },

      MapRef: {
        description: "Reference to the current Array map iteration context.",
        type: "string",
        pattern: "^\\$map/(item|index)(/.*)?$",
        examples: ["$map/item", "$map/index", "$map/item/text", "$map/item/done"],
      },

      // ── Expression ($expression) ──────────────────────────────────────

      ExpressionPointer: {
        description: "A JSON Pointer $ref operand within an expression node.",
        type: "object",
        properties: {
          $ref: {
            type: "string",
            pattern: "^(\\$map/|\\$reduce/|event#/|#/|parent#/|window#/|document#/)",
          },
        },
        required: ["$ref"],
        additionalProperties: false,
      },

      ExpressionLiteral: {
        description: "A non-reactive operand: scalar or array of operands.",
        anyOf: [
          { type: "string", not: { pattern: "\\$\\{" } },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { type: "array", items: { $ref: "#/$defs/ExpressionOperand" } },
        ],
      },

      ExpressionOperand: {
        description:
          "Anything that may appear in target or value: a pointer, a literal, or a nested expression node.",
        anyOf: [
          { $ref: "#/$defs/ExpressionPointer" },
          { $ref: "#/$defs/ExpressionNode" },
          { $ref: "#/$defs/ExpressionLiteral" },
        ],
      },

      UnaryOperator: { enum: ["!", "-"] },
      BinaryOperator: {
        enum: ["+", "-", "*", "/", "%", "===", "!==", "<", "<=", ">", ">=", "&&", "||"],
      },
      AssignmentOperator: { enum: ["=", "+=", "-=", "*=", "/="] },
      NoArgMethod: { enum: ["pop", "shift"] },
      OneArgMethod: { enum: ["push", "unshift"] },
      SpliceMethod: { const: "splice" },
      ReduceMethod: { const: "reduce" },
      MapFilterMethod: { enum: ["map", "filter"] },

      ExpressionNode: {
        description: "The core expression node. operator + target, with value gated by arity.",
        type: "object",
        required: ["operator", "target"],
        additionalProperties: false,
        properties: {
          operator: { type: "string" },
          target: { $ref: "#/$defs/ExpressionOperand" },
          value: { $ref: "#/$defs/ExpressionOperand" },
          initial: { $ref: "#/$defs/ExpressionOperand" },
        },
        oneOf: [
          {
            title: "Unary — target only, no value",
            properties: { operator: { $ref: "#/$defs/UnaryOperator" } },
            required: ["operator"],
            not: { anyOf: [{ required: ["value"] }, { required: ["initial"] }] },
          },
          {
            title: "Binary — left in target, right in value",
            properties: { operator: { $ref: "#/$defs/BinaryOperator" } },
            required: ["operator", "value"],
            not: { required: ["initial"] },
          },
          {
            title: "Assignment — writable target, value required",
            properties: {
              operator: { $ref: "#/$defs/AssignmentOperator" },
              target: { $ref: "#/$defs/ExpressionPointer" },
            },
            required: ["operator", "value"],
            not: { required: ["initial"] },
          },
          {
            title: "pop / shift — array receiver, no value",
            properties: {
              operator: { $ref: "#/$defs/NoArgMethod" },
              target: { $ref: "#/$defs/ExpressionPointer" },
            },
            required: ["operator"],
            not: { anyOf: [{ required: ["value"] }, { required: ["initial"] }] },
          },
          {
            title: "push / unshift — array receiver, single value argument",
            properties: {
              operator: { $ref: "#/$defs/OneArgMethod" },
              target: { $ref: "#/$defs/ExpressionPointer" },
            },
            required: ["operator", "value"],
            not: { required: ["initial"] },
          },
          {
            title: "splice — array receiver, [start, deleteCount, ...items]",
            properties: {
              operator: { $ref: "#/$defs/SpliceMethod" },
              target: { $ref: "#/$defs/ExpressionPointer" },
              value: { type: "array", items: { $ref: "#/$defs/ExpressionOperand" }, minItems: 1 },
            },
            required: ["operator", "value"],
            not: { required: ["initial"] },
          },
          {
            title: "reduce — pure fold; per-item expression in value, seed in initial",
            properties: {
              operator: { $ref: "#/$defs/ReduceMethod" },
              target: { $ref: "#/$defs/ExpressionPointer" },
              value: { $ref: "#/$defs/ExpressionNode" },
            },
            required: ["operator", "value", "initial"],
          },
          {
            title: "map / filter — pure; per-item expression in value, no initial",
            properties: {
              operator: { $ref: "#/$defs/MapFilterMethod" },
              target: { $ref: "#/$defs/ExpressionPointer" },
              value: { $ref: "#/$defs/ExpressionNode" },
            },
            required: ["operator", "value"],
            not: { required: ["initial"] },
          },
        ],
      },

      ExpressionEntry: {
        description:
          "A declarative expression entry (Shape 5). Used as a state entry or inline event handler.",
        type: "object",
        required: ["$expression"],
        properties: {
          $expression: { $ref: "#/$defs/ExpressionNode" },
          $title: { type: "string" },
          $description: { type: "string" },
        },
        additionalProperties: false,
      },

      // ── Property value types ──────────────────────────────────────────────
      ElementPropertyValue: {
        oneOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { $ref: "#/$defs/RefObject" },
        ],
      },

      StringOrRef: {
        oneOf: [{ type: "string" }, { $ref: "#/$defs/RefObject" }],
      },

      BoolOrRef: {
        oneOf: [{ type: "boolean" }, { $ref: "#/$defs/RefObject" }],
      },

      NumberOrRef: {
        oneOf: [{ type: "number" }, { $ref: "#/$defs/RefObject" }],
      },

      // ── CEM-compatible definitions ────────────────────────────────────────
      CemParameter: {
        description:
          "A CEM-compatible parameter definition for a function. " +
          "Follows the Custom Elements Manifest Parameter shape.",
        type: "object",
        required: ["name"],
        properties: {
          name: { description: "Parameter name.", type: "string" },
          type: { description: "Parameter type (JSON Schema or CEM { text } format)." },
          description: { description: "Parameter documentation.", type: "string" },
          optional: { description: "Whether the parameter is optional.", type: "boolean" },
          default: { description: "Default value for the parameter." },
        },
      },

      CemEvent: {
        description:
          "A CEM-compatible event definition. " +
          "Describes a CustomEvent the function dispatches.",
        type: "object",
        required: ["name"],
        properties: {
          name: { description: "Event name (e.g. 'task-toggled').", type: "string" },
          type: { description: "Event type (e.g. { text: 'CustomEvent' })." },
          description: { description: "Event documentation.", type: "string" },
          deprecated: {
            description: "Deprecation notice.",
            oneOf: [{ type: "boolean" }, { type: "string" }],
          },
        },
      },

      // ── Primitives ────────────────────────────────────────────────────────
      TagName: {
        description:
          "HTML element tag name or custom element name (must contain a hyphen per Web Components spec).",
        type: "string",
        minLength: 1,
        // Examples derived from @webref/elements at generation time
        examples: [...tagExamples, "my-counter", "todo-app", "user-card"],
      },

      JsonSchemaType: {
        type: "string",
        enum: ["string", "number", "integer", "boolean", "array", "object", "null"],
      },
    },
  };
}

// ─── Schema building helpers ──────────────────────────────────────────────────

/**
 * Build the event handler `properties` fragment for ElementDef. Each key maps to a RefObject
 * pointing at a declared handler function. Derived from @webref/idl EventHandler attributes at
 * generation time.
 *
 * @param {string[]} eventHandlers
 * @returns {object}
 */
function buildEventHandlerProperties(eventHandlers: string[]) {
  const properties: Record<string, any> = {};
  for (const name of eventHandlers) {
    properties[name] = {
      description: `Event handler for the "${name.slice(2)}" event.`,
      oneOf: [{ $ref: "#/$defs/RefObject" }, { $ref: "#/$defs/ExpressionEntry" }],
    };
  }
  return properties;
}

/**
 * Build the explicit CSS `properties` fragment for StyleObject. Each key is a camelCase CSSOM
 * property name; the value schema accepts strings and numbers (CSS values are always coerced to
 * strings at runtime). Derived from @webref/css styleDeclaration names at generation time.
 *
 * @param {string[]} cssProps
 * @returns {object}
 */
function buildCssProperties(cssProps: string[]) {
  const properties: Record<string, any> = {};
  for (const name of cssProps) {
    properties[name] = { oneOf: [{ type: "string" }, { type: "number" }] };
  }
  return properties;
}

// ─── Project Schema Generator ────────────────────────────────────────────────

/**
 * Generate the Jx project.json schema as a plain JavaScript object. This schema validates project
 * configuration files. No webref data needed.
 *
 * @returns {object} JSON Schema 2020-12 document
 */
export function generateProjectSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://jxsuite.com/schema/project/v1",
    title: "Jx Project",
    description:
      "Schema for Jx project.json files. " +
      "A project.json file is the root anchor file for a Jx project, " +
      "declaring site metadata, default settings, global styles, content types, " +
      "and build configuration.",
    type: "object",

    properties: {
      name: {
        description: "Human-readable project name.",
        type: "string",
        default: "Jx Site",
        examples: ["My Portfolio", "Jx Example Site"],
      },
      url: {
        description: "Production URL of the deployed site.",
        type: "string",
        examples: ["https://example.com", "https://jxsuite.com"],
      },
      defaults: {
        description: "Default settings applied to all pages unless overridden.",
        type: "object",
        properties: {
          layout: {
            description:
              "Default layout file path applied to all pages. " +
              "Set to null to render pages without a layout.",
            oneOf: [{ type: "string" }, { type: "null" }],
            default: null,
            examples: ["./layouts/base.json"],
          },
          lang: {
            description: "Default lang attribute for the <html> element.",
            type: "string",
            default: "en",
          },
          charset: {
            description: "Default charset for the page.",
            type: "string",
            default: "utf-8",
          },
        },
      },
      $head: {
        description:
          "Global <head> entries applied to all pages. " +
          "Array of element definitions for meta tags, link tags, script tags, etc.",
        type: "array",
        items: {
          type: "object",
          properties: {
            tagName: { type: "string" },
            attributes: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
        },
        examples: [
          [
            { tagName: "link", attributes: { rel: "icon", href: "/favicon.svg" } },
            { tagName: "meta", attributes: { name: "generator", content: "Jx" } },
          ],
        ],
      },
      $elements: {
        description:
          "Global custom element dependencies available to all pages. " +
          "Items are $ref objects or npm package specifier strings.",
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              required: ["$ref"],
              properties: { $ref: { type: "string" } },
              additionalProperties: false,
            },
            { type: "string" },
          ],
        },
      },
      imports: {
        description:
          "Global import map: $prototype names to .class.json file paths. " +
          "Makes external classes available by name in all pages.",
        type: "object",
        additionalProperties: { type: "string" },
        examples: [
          {
            MarkdownFile: "@jxsuite/parser/MarkdownFile.class.json",
            MarkdownCollection: "@jxsuite/parser/MarkdownCollection.class.json",
          },
        ],
      },
      $media: {
        description:
          "Named media breakpoints following CSS @custom-media convention. " +
          "Available in all component style objects.",
        type: "object",
        additionalProperties: { type: "string" },
        examples: [
          {
            "--sm": "(min-width: 640px)",
            "--md": "(min-width: 768px)",
            "--lg": "(min-width: 1024px)",
          },
        ],
      },
      style: {
        description:
          "Global CSS styles applied to the <body> element. " +
          "Uses the same camelCase CSSOM convention as component styles.",
        type: "object",
        additionalProperties: {
          oneOf: [{ type: "string" }, { type: "number" }, { type: "object" }],
        },
      },
      state: {
        description: "Site-wide reactive state available to all pages.",
        type: "object",
      },
      contentTypes: {
        description:
          "Content type definitions. Each key is a content type name; " +
          "the value defines the source directory, frontmatter schema, and element dependencies.",
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            source: {
              description: "Path to the content directory relative to the project root.",
              type: "string",
              examples: ["./content/blog/", "./content/docs/"],
            },
            schema: {
              description: "JSON Schema for validating frontmatter of content type entries.",
              type: "object",
            },
            $elements: {
              description:
                "Custom elements available in markdown directives for this content type.",
              type: "array",
              items: {
                oneOf: [
                  {
                    type: "object",
                    required: ["$ref"],
                    properties: { $ref: { type: "string" } },
                  },
                  { type: "string" },
                ],
              },
            },
          },
        },
      },
      redirects: {
        description: "Static redirect rules. Maps source paths to destination paths.",
        type: "object",
        additionalProperties: { type: "string" },
        examples: [{ "/old-about": "/about" }],
      },
      copy: {
        description:
          "Declarative file copy map. Keys are source paths (relative to project root), values are destination paths (relative to outDir).",
        type: "object",
        additionalProperties: { type: "string" },
      },
      build: {
        description: "Build configuration.",
        type: "object",
        properties: {
          outDir: {
            description: "Output directory for compiled site.",
            type: "string",
            default: "./dist",
          },
          format: {
            description: "Output format.",
            type: "string",
            enum: ["directory", "single"],
            default: "directory",
          },
          trailingSlash: {
            description: "Trailing slash behavior for generated URLs.",
            type: "string",
            enum: ["always", "never", "ignore"],
            default: "always",
          },
          adapter: {
            description: "Platform adapter for deployment-specific output.",
            type: "string",
            enum: ["netlify", "vercel", "cloudflare"],
          },
        },
      },
      i18n: {
        description: "Internationalization configuration.",
        type: "object",
        properties: {
          defaultLocale: {
            description: "Default locale code.",
            type: "string",
            examples: ["en"],
          },
          locales: {
            description: "Available locale codes.",
            type: "array",
            items: { type: "string" },
            examples: [["en", "fr", "de"]],
          },
          routing: {
            description: "Locale routing strategy.",
            type: "string",
            enum: ["prefix-except-default", "prefix-always"],
          },
        },
      },
    },

    additionalProperties: false,
  };
}

// ─── Class Schema Generator ─────────────────────────────────────────────────

/**
 * Generate the standalone .class.json schema as a plain JavaScript object. This schema validates Jx
 * class definition files.
 *
 * @returns {object} JSON Schema 2020-12 document
 */
export function generateClassSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://jxsuite.com/schema/class/v1",
    title: "Jx Class Definition",
    description:
      "Schema for Jx .class.json files. A class definition describes a schema-defined " +
      "class with fields, constructor, methods, and type parameters. Optionally points " +
      "to a JS module via $implementation for hybrid execution.",
    type: "object",
    required: ["$prototype", "title"],

    properties: {
      $schema: { type: "string" },
      $id: { type: "string" },
      $prototype: {
        description: 'Must be "Class" for class definition files.',
        type: "string",
        const: "Class",
      },
      title: {
        description: "PascalCase class name, used as the export name.",
        type: "string",
        examples: ["MarkdownFile", "DataSource", "Calculator"],
      },
      description: { type: "string" },
      extends: {
        description: "Base class — string name or $ref to another .class.json.",
        oneOf: [
          { type: "string" },
          {
            type: "object",
            required: ["$ref"],
            properties: { $ref: { type: "string" } },
            additionalProperties: false,
          },
        ],
      },
      $implementation: {
        description: "Relative path to a JS module containing the actual class implementation.",
        type: "string",
        examples: ["./md.js", "./lib/calculator.js"],
      },
      $defs: {
        description: "Class members: parameters, returnTypes, fields, constructor, methods.",
        type: "object",
        properties: {
          parameters: {
            description: "Reusable typed parameter schemas, keyed by name.",
            type: "object",
            additionalProperties: { $ref: "#/$defs/ClassParameterDef" },
          },
          returnTypes: {
            description: "Output type schemas, keyed by name.",
            type: "object",
            additionalProperties: { type: "object" },
          },
          fields: {
            description: "Class fields with role, access, scope, and type information.",
            type: "object",
            additionalProperties: { $ref: "#/$defs/ClassFieldDef" },
          },
          constructor: { $ref: "#/$defs/ClassConstructorDef" },
          methods: {
            description: "Class methods and accessors.",
            type: "object",
            additionalProperties: { $ref: "#/$defs/ClassMethodDef" },
          },
        },
      },
    },
    additionalProperties: false,

    $defs: {
      ClassParameterDef: {
        description: "A typed parameter definition for a class.",
        type: "object",
        required: ["identifier"],
        properties: {
          identifier: { type: "string" },
          type: {},
          format: {
            description: 'When "json-schema", this parameter\'s value is itself a JSON Schema.',
            type: "string",
          },
          description: { type: "string" },
          default: {},
          examples: { type: "array" },
        },
      },

      ClassFieldDef: {
        description: "A class field definition with access control and scope.",
        type: "object",
        properties: {
          role: { type: "string", const: "field" },
          access: { type: "string", enum: ["public", "private", "protected"] },
          scope: { type: "string", enum: ["instance", "static"] },
          identifier: { type: "string" },
          type: {},
          $prototype: {
            description: 'Data source prototype for this field (e.g., "Request").',
            type: "string",
          },
          initializer: {},
          default: {},
          description: { type: "string" },
          examples: { type: "array" },
        },
      },

      ClassConstructorDef: {
        description: "Class constructor definition.",
        type: "object",
        properties: {
          role: { type: "string", const: "constructor" },
          $prototype: { type: "string", const: "Function" },
          parameters: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  required: ["$ref"],
                  properties: { $ref: { type: "string" } },
                  additionalProperties: false,
                },
                { $ref: "#/$defs/ClassParameterDef" },
              ],
            },
          },
          superCall: {
            type: "object",
            properties: {
              arguments: { type: "array", items: { type: "string" } },
            },
          },
          body: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          description: { type: "string" },
        },
      },

      ClassMethodDef: {
        description: "A class method or accessor definition.",
        type: "object",
        properties: {
          role: { type: "string", enum: ["method", "accessor"] },
          $prototype: { type: "string", const: "Function" },
          access: { type: "string", enum: ["public", "private", "protected"] },
          scope: { type: "string", enum: ["instance", "static"] },
          identifier: { type: "string" },
          parameters: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  required: ["$ref"],
                  properties: { $ref: { type: "string" } },
                  additionalProperties: false,
                },
                { $ref: "#/$defs/ClassParameterDef" },
              ],
            },
          },
          returnType: {},
          body: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          getter: {
            type: "object",
            properties: { body: { type: "string" } },
          },
          setter: {
            type: "object",
            properties: {
              parameters: { type: "array" },
              body: { type: "string" },
            },
          },
          description: { type: "string" },
        },
      },
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the meta-schema as a formatted JSON string.
 *
 * @returns {Promise<string>}
 */
export async function generateSchemaString() {
  return JSON.stringify(await generateSchema(), null, 2);
}

/**
 * Validate a Jx document against the generated schema using Ajv.
 *
 * @param {object} doc
 * @returns {Promise<{ valid: boolean; errors: object[] | null }>}
 */
export async function validateDocument(doc: object) {
  let Ajv, addFormats;
  try {
    // @ts-ignore — optional peer dependency
    ({ default: Ajv } = await import("ajv"));
    // @ts-ignore — optional peer dependency
    ({ default: addFormats } = await import("ajv-formats"));
  } catch {
    throw new Error("Schema validation requires ajv and ajv-formats: bun add ajv ajv-formats");
  }

  const ajv = new Ajv({ allErrors: true, strict: false, ownProperties: true });
  addFormats(ajv);

  const schema = await generateSchema();
  const validate = ajv.compile(schema);
  const valid = validate(doc);

  return { valid, errors: validate.errors ?? null };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("schema.js")) {
  const { writeFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");

  const schemaDir = dirname(resolve(process.argv[1], ".."));

  // Generate all three schemas
  const componentSchema = await generateSchema();
  const projectSchema = generateProjectSchema();
  const classSchema = generateClassSchema();

  const componentStr = JSON.stringify(componentSchema, null, 2);
  const projectStr = JSON.stringify(projectSchema, null, 2);
  const classStr = JSON.stringify(classSchema, null, 2);

  const [, , out] = process.argv;

  if (out) {
    // Legacy single-file mode
    writeFileSync(out, componentStr, "utf8");
    console.error(`Jx component schema written to ${out}`);
  } else {
    // Default: write all three to packages/schema/
    writeFileSync(resolve(schemaDir, "schema.json"), componentStr, "utf8");
    writeFileSync(resolve(schemaDir, "project-schema.json"), projectStr, "utf8");
    writeFileSync(resolve(schemaDir, "class-schema.json"), classStr, "utf8");
    console.error("Generated:");
    console.error("  schema.json (component)");
    console.error("  project-schema.json");
    console.error("  class-schema.json");
  }
}
