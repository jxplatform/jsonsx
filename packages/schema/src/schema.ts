/**
 * jx-schema.ts — Jx JSON Schema 2020-12 meta-schema generator
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
  stringOrRefSchema,
  boolOrRefSchema,
  numberOrRefSchema,
} from "../defs/string-or-ref.schema";
import { headEntrySchema } from "../defs/head-entry.schema";
import { cemParameterSchema, cemEventSchema } from "../defs/cem.schema";
import { jsonSchemaTypeSchema } from "../defs/json-schema-type.schema";
import {
  internalRefSchema,
  stateRefSchema,
  externalRefSchema,
  globalRefSchema,
  parentRefSchema,
  mapRefSchema,
  anyRefSchema,
  refObjectSchema,
  externalComponentRefSchema,
} from "../defs/ref-object.schema";
import { styleObjectSchema } from "../defs/style-object.schema";
import { arrayNamespaceSchema, childrenValueSchema } from "../defs/children-value.schema";
import {
  attributesObjectSchema,
  propsObjectSchema,
  elementPropertyValueSchema,
  switchDefSchema,
  switchNodeSchema,
  elementDefSchema,
} from "../defs/element-def.schema";
import { typedStateDefSchema } from "../defs/typed-state-def.schema";
import { functionDefSchema } from "../defs/function-def.schema";
import { externalClassDefSchema } from "../defs/external-class-def.schema";
import { pureTypeDefSchema } from "../defs/pure-type-def.schema";
import {
  expressionPointerSchema,
  expressionLiteralSchema,
  expressionOperandSchema,
  expressionNodeSchema,
  expressionEntrySchema,
  unaryOperatorSchema,
  binaryOperatorSchema,
  assignmentOperatorSchema,
  noArgMethodSchema,
  oneArgMethodSchema,
  spliceMethodSchema,
  reduceMethodSchema,
  mapFilterMethodSchema,
} from "../defs/expression-node.schema";
import {
  stateEntrySchema,
  stateMapSchema,
  defsMapSchema,
  typeDefEntrySchema,
} from "../defs/state-entry.schema";
import {
  classParameterDefSchema,
  classFieldDefSchema,
  classConstructorDefSchema,
  classMethodDefSchema,
  classDefSchema,
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
      if (!el.obsolete) tagSet.add(el.name);
    }
  }
  const tagExamples = [...tagSet].sort();

  const cssSet = new Set<string>();
  for (const prop of cssData.properties) {
    for (const decl of prop.styleDeclaration ?? []) {
      cssSet.add(decl);
    }
  }
  const cssProps = [...cssSet].sort();

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

// ─── Injection helpers ─────────────────────────────────────────────────────────

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

function buildCssProperties(cssProps: string[]) {
  const properties: Record<string, any> = {};
  for (const name of cssProps) {
    properties[name] = { oneOf: [{ type: "string" }, { type: "number" }] };
  }
  return properties;
}

// ─── Generator ────────────────────────────────────────────────────────────────

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
  };
}

// ─── Project Schema Generator ────────────────────────────────────────────────

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
    properties: projectConfigSchema.properties,
    additionalProperties: false,
    $defs: {
      ImageConfig: imageConfigSchema,
      ContentTypeDef: contentTypeDefSchema,
    },
  };
}

// ─── Class Schema Generator ─────────────────────────────────────────────────

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
      ClassParameterDef: classParameterDefSchema,
      ClassFieldDef: classFieldDefSchema,
      ClassConstructorDef: classConstructorDefSchema,
      ClassMethodDef: classMethodDefSchema,
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateSchemaString() {
  return JSON.stringify(await generateSchema(), null, 2);
}

export async function validateDocument(doc: Record<string, unknown>) {
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

  const [, , out] = process.argv;

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
