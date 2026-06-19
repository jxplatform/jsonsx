/**
 * Jx-schema.ts — Jx JSON Schema 2020-12 meta-schema generator
 * @version 2.0.0
 * @license MIT
 *
 * Generates comprehensive JSON Schema 2020-12 documents that validate Jx source files.
 * Individual schema definitions live in ../defs/ as the single source of truth.
 * This module composes them and injects web standards data derived at generation time from:
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
 *   bun run schema.ts [output-path]
 *
 * @module jx-schema
 */

import { listAll as listElements } from "@webref/elements";
import css from "@webref/css";
import idl from "@webref/idl";

import { tagNameSchema } from "../defs/tag-name.schema";
import {
  boolOrRefSchema,
  numberOrRefSchema,
  stringOrRefSchema,
} from "../defs/string-or-ref.schema";
import { headEntrySchema } from "../defs/head-entry.schema";
import { cemEventSchema, cemParameterSchema } from "../defs/cem.schema";
import { jsonSchemaTypeSchema } from "../defs/json-schema-type.schema";
import {
  anyRefSchema,
  externalComponentRefSchema,
  externalRefSchema,
  globalRefSchema,
  internalRefSchema,
  mapRefSchema,
  parentRefSchema,
  refObjectSchema,
  stateRefSchema,
} from "../defs/ref-object.schema";
import { styleObjectSchema } from "../defs/style-object.schema";
import { arrayNamespaceSchema, childrenValueSchema } from "../defs/children-value.schema";
import {
  attributesObjectSchema,
  elementDefSchema,
  elementPropertyValueSchema,
  propsObjectSchema,
  switchDefSchema,
  switchNodeSchema,
} from "../defs/element-def.schema";
import { typedStateDefSchema } from "../defs/typed-state-def.schema";
import { functionDefSchema } from "../defs/function-def.schema";
import { externalClassDefSchema } from "../defs/external-class-def.schema";
import { pureTypeDefSchema } from "../defs/pure-type-def.schema";
import {
  assignmentOperatorSchema,
  binaryOperatorSchema,
  expressionEntrySchema,
  expressionLiteralSchema,
  expressionNodeSchema,
  expressionOperandSchema,
  expressionPointerSchema,
  mapFilterMethodSchema,
  noArgMethodSchema,
  oneArgMethodSchema,
  reduceMethodSchema,
  spliceMethodSchema,
  unaryOperatorSchema,
} from "../defs/expression-node.schema";
import {
  defsMapSchema,
  stateEntrySchema,
  stateMapSchema,
  typeDefEntrySchema,
} from "../defs/state-entry.schema";
import {
  classConstructorDefSchema,
  classDefSchema,
  classFieldDefSchema,
  classMethodDefSchema,
  classParameterDefSchema,
  formatDefSchema,
  studioHintsSchema,
} from "../defs/class-def.schema";
import { contentTypeDefSchema } from "../defs/content-type-def.schema";
import { imageConfigSchema } from "../defs/image-config.schema";
import { projectConfigSchema } from "../defs/project-config.schema";

// ─── Web standards data loader ────────────────────────────────────────────────

async function loadWebData() {
  const [elementsData, cssData, idlData] = await Promise.all([
    listElements(),
    css.listAll(),
    idl.parseAll(),
  ]);

  const tagSet = new Set<string>();
  for (const { elements } of Object.values(elementsData)) {
    for (const el of elements) {
      if (!el.obsolete) {
        tagSet.add(el.name);
      }
    }
  }
  const tagExamples = [...tagSet].toSorted();

  const cssSet = new Set<string>();
  for (const prop of cssData.properties) {
    for (const decl of prop.styleDeclaration ?? []) {
      cssSet.add(decl);
    }
  }
  const cssProps = [...cssSet].toSorted();

  const handlerSet = new Set<string>();
  for (const ast of Object.values(idlData)) {
    for (const def of ast) {
      if (def.type !== "interface" && def.type !== "interface mixin") {
        continue;
      }
      if (!def.members) {
        continue;
      }
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
  const eventHandlers = [...handlerSet].toSorted();

  return { cssProps, eventHandlers, tagExamples };
}

// ─── Injection helpers ─────────────────────────────────────────────────────────

function buildEventHandlerProperties(eventHandlers: string[]) {
  const properties: Record<string, unknown> = {};
  for (const name of eventHandlers) {
    properties[name] = {
      description: `Event handler for the "${name.slice(2)}" event.`,
      oneOf: [{ $ref: "#/$defs/RefObject" }, { $ref: "#/$defs/ExpressionEntry" }],
    };
  }
  return properties;
}

function buildCssProperties(cssProps: string[]) {
  const properties: Record<string, unknown> = {};
  for (const name of cssProps) {
    properties[name] = { oneOf: [{ type: "string" }, { type: "number" }] };
  }
  return properties;
}

// ─── Generator ────────────────────────────────────────────────────────────────

export async function generateSchema() {
  const { tagExamples, cssProps, eventHandlers } = await loadWebData();

  return {
    $defs: {
      DefsMap: defsMapSchema,
      TypeDefEntry: typeDefEntrySchema,
      StateMap: stateMapSchema,
      StateEntry: stateEntrySchema,
      TypedStateDef: typedStateDefSchema,
      PureTypeDef: pureTypeDefSchema,
      FunctionDef: functionDefSchema,
      ClassDef: classDefSchema,
      ClassParameterDef: classParameterDefSchema,
      ClassFieldDef: classFieldDefSchema,
      ClassConstructorDef: classConstructorDefSchema,
      ClassMethodDef: classMethodDefSchema,
      FormatDef: formatDefSchema,
      StudioHints: studioHintsSchema,
      ExternalClassDef: externalClassDefSchema,
      ExpressionPointer: expressionPointerSchema,
      ExpressionLiteral: expressionLiteralSchema,
      ExpressionOperand: expressionOperandSchema,
      UnaryOperator: unaryOperatorSchema,
      BinaryOperator: binaryOperatorSchema,
      AssignmentOperator: assignmentOperatorSchema,
      NoArgMethod: noArgMethodSchema,
      OneArgMethod: oneArgMethodSchema,
      SpliceMethod: spliceMethodSchema,
      ReduceMethod: reduceMethodSchema,
      MapFilterMethod: mapFilterMethodSchema,
      ExpressionNode: expressionNodeSchema,
      ExpressionEntry: expressionEntrySchema,

      // Element defs — with webref data injected
      ElementDef: {
        ...elementDefSchema,
        properties: {
          ...elementDefSchema.properties,
          ...buildEventHandlerProperties(eventHandlers),
        },
      },
      ChildrenValue: childrenValueSchema,
      ArrayNamespace: arrayNamespaceSchema,
      SwitchDef: switchDefSchema,
      SwitchNode: switchNodeSchema,
      StyleObject: {
        ...styleObjectSchema,
        properties: buildCssProperties(cssProps),
      },
      AttributesObject: attributesObjectSchema,
      PropsObject: propsObjectSchema,
      RefObject: refObjectSchema,
      AnyRef: anyRefSchema,
      InternalRef: internalRefSchema,
      StateRef: stateRefSchema,
      ExternalRef: externalRefSchema,
      ExternalComponentRef: externalComponentRefSchema,
      GlobalRef: globalRefSchema,
      ParentRef: parentRefSchema,
      MapRef: mapRefSchema,
      ElementPropertyValue: elementPropertyValueSchema,
      StringOrRef: stringOrRefSchema,
      BoolOrRef: boolOrRefSchema,
      NumberOrRef: numberOrRefSchema,
      CemParameter: cemParameterSchema,
      CemEvent: cemEventSchema,
      TagName: {
        ...tagNameSchema,
        examples: [...tagExamples, "my-counter", "todo-app", "user-card"],
      },
      JsonSchemaType: jsonSchemaTypeSchema,
      HeadEntry: headEntrySchema,
      ImageConfig: imageConfigSchema,
      ContentTypeDef: contentTypeDefSchema,
    },
    $id: "https://jxsuite.com/schema/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: { $ref: "#/$defs/ElementPropertyValue" },
    description:
      "Schema for Jx component files. " +
      "A Jx document is a JSON object that declaratively describes a reactive " +
      "web component: its structure (DOM tree), styling, type definitions ($defs), " +
      "runtime state, and inline or external functions. Reactivity is powered by @vue/reactivity.",
    properties: {
      $defs: {
        $ref: "#/$defs/DefsMap",
        description:
          "Pure JSON Schema type definitions for this component. " +
          "All entries are reusable type schemas — no runtime artifacts are produced. " +
          "Referenced from state entries via $ref. Naming convention: PascalCase.",
      },
      $elements: {
        description:
          "Custom element dependencies. Items are either $ref objects pointing to JX " +
          "element definitions, or bare npm package name strings for web component libraries.",
        items: {
          oneOf: [
            {
              additionalProperties: false,
              properties: { $ref: { type: "string" } },
              required: ["$ref"],
              type: "object",
            },
            {
              description: "npm package specifier (must declare customElements in package.json)",
              type: "string",
            },
          ],
        },
        type: "array",
      },
      $head: {
        description:
          "Page-level <head> entries. Array of element definitions for meta tags, " +
          "link tags, script tags, etc. Merged with layout and site-level $head entries.",
        items: { $ref: "#/$defs/ElementDef" },
        type: "array",
      },
      $id: {
        description: "Component identifier string. Used by tooling and the builder.",
        examples: ["Counter", "TodoApp", "UserCard"],
        type: "string",
      },
      $layout: {
        description:
          "Layout reference for pages. String path to a layout JSON file, " +
          "or false to opt out of the default layout.",
        examples: ["./layouts/base.json"],
        oneOf: [{ type: "string" }, { const: false, type: "boolean" }],
      },
      $media: {
        additionalProperties: { type: "string" },
        description:
          "Named media breakpoints following CSS @custom-media convention. " +
          "Keys use the CSS custom property -- prefix.",
        examples: [
          {
            "--dark": "(prefers-color-scheme: dark)",
            "--md": "(min-width: 768px)",
            "--sm": "(min-width: 640px)",
          },
        ],
        type: "object",
      },
      $paths: {
        description:
          "Dynamic route parameters. Maps parameter names to data sources " +
          "for generating one page per entry at build time.",
        type: "object",
      },
      $schema: {
        description: "URI identifying the Jx dialect version. Enables schema-aware IDE tooling.",
        examples: ["https://jxsuite.com/schema/v1"],
        type: "string",
      },
      attributes: { $ref: "#/$defs/AttributesObject" },
      cases: {
        additionalProperties: {
          oneOf: [{ $ref: "#/$defs/ElementDef" }, { $ref: "#/$defs/ExternalComponentRef" }],
        },
        description:
          "Switch cases object. Maps case values to element definitions or external " +
          "component refs. Used alongside $switch for dynamic component rendering.",
        type: "object",
      },
      children: { $ref: "#/$defs/ChildrenValue" },
      imports: {
        additionalProperties: { type: "string" },
        description:
          "Import map: $prototype names to .class.json file paths. " +
          "Allows state entries to reference external classes by name without $src.",
        type: "object",
      },
      observedAttributes: {
        description:
          "HTML attributes the custom element watches for changes. " +
          "Follows the Web Components observedAttributes convention.",
        items: { type: "string" },
        type: "array",
      },
      state: {
        $ref: "#/$defs/StateMap",
        description:
          "Runtime variables for this component. All entries are reactive by default. " +
          "Entry shape is determined by value type: " +
          "scalar/array → reactive property, string with ${} → computed, " +
          "object with $prototype → function or data source, " +
          "object with type and default → typed reactive property.",
      },
      style: { $ref: "#/$defs/StyleObject" },
      tagName: { $ref: "#/$defs/TagName" },
      title: {
        $ref: "#/$defs/StringOrRef",
        description:
          "Page title. Can be a static string or a template string with ${} expressions.",
      },
    },
    title: "Jx Document",
    type: "object",
  };
}

// ─── Project Schema Generator ────────────────────────────────────────────────

export function generateProjectSchema() {
  return {
    $defs: {
      ContentTypeDef: contentTypeDefSchema,
      ImageConfig: imageConfigSchema,
    },
    $id: "https://jxsuite.com/schema/project/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    description:
      "Schema for Jx project.json files. " +
      "A project.json file is the root anchor file for a Jx project, " +
      "declaring site metadata, default settings, global styles, content types, " +
      "and build configuration.",
    properties: projectConfigSchema.properties,
    title: "Jx Project",
    type: "object",
  };
}

// ─── Class Schema Generator ─────────────────────────────────────────────────

export function generateClassSchema() {
  return {
    $defs: {
      ClassConstructorDef: classConstructorDefSchema,
      ClassFieldDef: classFieldDefSchema,
      ClassMethodDef: classMethodDefSchema,
      ClassParameterDef: classParameterDefSchema,
      FormatDef: formatDefSchema,
      StudioHints: studioHintsSchema,
    },
    $id: "https://jxsuite.com/schema/class/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    description:
      "Schema for Jx .class.json files. A class definition describes a schema-defined " +
      "class with fields, constructor, methods, and type parameters. Optionally points " +
      "to a JS module via $implementation for hybrid execution.",
    properties: {
      $defs: {
        description: "Class members: parameters, returnTypes, fields, constructor, methods.",
        properties: {
          constructor: { $ref: "#/$defs/ClassConstructorDef" },
          fields: {
            additionalProperties: { $ref: "#/$defs/ClassFieldDef" },
            description: "Class fields with role, access, scope, and type information.",
            type: "object",
          },
          methods: {
            additionalProperties: { $ref: "#/$defs/ClassMethodDef" },
            description: "Class methods and accessors.",
            type: "object",
          },
          parameters: {
            additionalProperties: { $ref: "#/$defs/ClassParameterDef" },
            description: "Reusable typed parameter schemas, keyed by name.",
            type: "object",
          },
          returnTypes: {
            additionalProperties: { type: "object" },
            description: "Output type schemas, keyed by name.",
            type: "object",
          },
        },
        type: "object",
      },
      $id: { type: "string" },
      $implementation: {
        description: "Relative path to a JS module containing the actual class implementation.",
        examples: ["./md.js", "./lib/calculator.js"],
        type: "string",
      },
      $prototype: {
        const: "Class",
        description: 'Must be "Class" for class definition files.',
        type: "string",
      },
      $schema: { type: "string" },
      $studio: { $ref: "#/$defs/StudioHints" },
      description: { type: "string" },
      extends: {
        description: "Base class — string name or $ref to another .class.json.",
        oneOf: [
          { type: "string" },
          {
            additionalProperties: false,
            properties: { $ref: { type: "string" } },
            required: ["$ref"],
            type: "object",
          },
        ],
      },
      format: { $ref: "#/$defs/FormatDef" },
      title: {
        description: "PascalCase class name, used as the export name.",
        examples: ["MarkdownFile", "DataSource", "Calculator"],
        type: "string",
      },
    },
    required: ["$prototype", "title"],
    title: "Jx Class Definition",
    type: "object",
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateSchemaString() {
  return JSON.stringify(await generateSchema(), null, 2);
}

// Minimal structural types for the optional `ajv` / `ajv-formats` peer deps
// (not installed, and shipping no types, in this repo).
interface AjvValidateFn {
  (doc: unknown): boolean;
  errors?: unknown[] | null;
}
interface AjvInstance {
  compile: (schema: unknown) => AjvValidateFn;
}
type AjvCtor = new (opts: {
  allErrors: boolean;
  ownProperties: boolean;
  strict: boolean;
}) => AjvInstance;
type AddFormatsFn = (ajv: AjvInstance) => void;

export async function validateDocument(doc: Record<string, unknown>) {
  let Ajv: AjvCtor, addFormats: AddFormatsFn;
  try {
    // @ts-expect-error — optional peer dependency
    ({ default: Ajv } = (await import("ajv")) as { default: AjvCtor });
    // @ts-expect-error — optional peer dependency
    ({ default: addFormats } = (await import("ajv-formats")) as { default: AddFormatsFn });
  } catch {
    throw new Error("Schema validation requires ajv and ajv-formats: bun add ajv ajv-formats");
  }

  const ajv = new Ajv({ allErrors: true, ownProperties: true, strict: false });
  addFormats(ajv);

  const schema = await generateSchema();
  const validate = ajv.compile(schema);
  const valid = validate(doc);

  return { errors: validate.errors ?? null, valid };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("schema.ts")) {
  const { writeFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");

  const schemaDir = dirname(resolve(process.argv[1], ".."));

  const componentSchema = await generateSchema();
  const projectSchema = generateProjectSchema();
  const classSchema = generateClassSchema();

  const componentStr = JSON.stringify(componentSchema, null, 2);
  const projectStr = JSON.stringify(projectSchema, null, 2);
  const classStr = JSON.stringify(classSchema, null, 2);

  const [out] = process.argv.slice(2);

  if (out) {
    writeFileSync(out, componentStr, "utf8");
    console.error(`Jx component schema written to ${out}`);
  } else {
    writeFileSync(resolve(schemaDir, "schema.json"), componentStr, "utf8");
    writeFileSync(resolve(schemaDir, "project-schema.json"), projectStr, "utf8");
    writeFileSync(resolve(schemaDir, "class-schema.json"), classStr, "utf8");
    console.error("Generated:");
    console.error("  schema.json (component)");
    console.error("  project-schema.json");
    console.error("  class-schema.json");
  }
}
