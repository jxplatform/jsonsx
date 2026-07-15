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
import { statementListSchema, statementSchema } from "../defs/statement.schema";
import { externalClassDefSchema } from "../defs/external-class-def.schema";
import { pureTypeDefSchema } from "../defs/pure-type-def.schema";
import {
  assignmentOperatorSchema,
  binaryOperatorSchema,
  callOperatorSchema,
  conditionalOperatorSchema,
  expressionEntrySchema,
  expressionLiteralSchema,
  expressionNodeSchema,
  expressionOperandSchema,
  expressionPointerSchema,
  mapFilterMethodSchema,
  noArgMethodSchema,
  oneArgMethodSchema,
  pureMethodSchema,
  reduceMethodSchema,
  spliceMethodSchema,
  switchOperatorSchema,
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
import { extensionManifestSchema } from "../defs/extension-manifest.schema";
import {
  DOCUMENT_PATHS_SCHEMA_ID,
  PROJECT_FIELDS_SCHEMA_ID,
  jxFieldSchemaDef,
  relationshipRefSchema,
} from "../defs/field-schema.schema";
import { imageConfigSchema } from "../defs/image-config.schema";
import { projectConfigSchema } from "../defs/project-config.schema";

// ─── Web standards data loader ────────────────────────────────────────────────

let webDataCache: Promise<{
  cssProps: string[];
  eventHandlers: string[];
  tagExamples: string[];
}> | null = null;

/**
 * Web-standards parsing (WebIDL / CSS / HTML elements) is expensive and the data is static for the
 * Process, so memoize it. generateSchema runs several times across a build or test run, and
 * Re-parsing on each call made the validateDocument / CLI tests load-sensitive (occasionally past
 * The 5s test timeout under full-suite CPU contention).
 */
function loadWebData() {
  webDataCache ??= computeWebData();
  return webDataCache;
}

async function computeWebData() {
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
      ConditionalOperator: conditionalOperatorSchema,
      SwitchOperator: switchOperatorSchema,
      CallOperator: callOperatorSchema,
      PureMethod: pureMethodSchema,
      AssignmentOperator: assignmentOperatorSchema,
      NoArgMethod: noArgMethodSchema,
      OneArgMethod: oneArgMethodSchema,
      SpliceMethod: spliceMethodSchema,
      ReduceMethod: reduceMethodSchema,
      MapFilterMethod: mapFilterMethodSchema,
      ExpressionNode: expressionNodeSchema,
      ExpressionEntry: expressionEntrySchema,
      Statement: statementSchema,
      StatementList: statementListSchema,

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
      ImageConfig: imageConfigSchema,
    },
    $id: "https://jxsuite.com/schema/project/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description:
      "Schema for Jx project.json files. " +
      "A project.json file is the root anchor file for a Jx project, " +
      "declaring site metadata, default settings, global styles, extensions, " +
      "and build configuration. Open by design: extension-contributed sections " +
      "are opaque top-level keys; the generated per-project entry document " +
      "(project.schema.json) closes the composition.",
    properties: projectConfigSchema.properties,
    title: "Jx Project",
    type: "object",
  };
}

// ─── Project Core Fragment Generator ─────────────────────────────────────────

/**
 * The core fragment of the composed per-project schema (specs/extensions.md §5.1): core
 * project.json properties only — no extension sections — and deliberately open, because closure
 * (`unevaluatedProperties: false`) happens in the generated entry document. Publishes the
 * `JxFieldSchema` and `RelationshipRef` defs the entry document unions into the `jxFieldSchema`
 * dynamic anchor.
 */
export function generateProjectCoreSchema() {
  return {
    $defs: {
      ImageConfig: imageConfigSchema,
      JxFieldSchema: jxFieldSchemaDef,
      RelationshipRef: relationshipRefSchema,
    },
    $id: "https://jxsuite.com/schema/project/core/v2",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description:
      "Core fragment of the Jx project.json schema. Open by design: extension fragments " +
      "contribute their own top-level sections and the generated per-project entry document " +
      "(project.schema.json) closes the composition. See specs/extensions.md §5.",
    properties: projectConfigSchema.properties,
    title: "Jx Project Core",
    type: "object",
  };
}

// ─── Union Resource Generators ───────────────────────────────────────────────

/**
 * The shipped DEFAULT field-union resource. The generated per-project entry document re-embeds a
 * resource under the same $id with the effective union (adding extension extras); by standard
 * compound-document $id resolution the embed shadows this default wherever both are in play.
 */
export function generateProjectFieldsSchema() {
  return {
    $id: PROJECT_FIELDS_SCHEMA_ID,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    anyOf: [
      { $ref: "https://jxsuite.com/schema/project/core/v2#/$defs/JxFieldSchema" },
      { $ref: "https://jxsuite.com/schema/project/core/v2#/$defs/RelationshipRef" },
    ],
    description:
      "Default field-schema union for section entry schemas: the core field shape plus " +
      "relationship references. Per-project entry documents override this resource with the " +
      "effective union. See specs/extensions.md §5.3.",
    title: "Jx Project Field Union",
  };
}

/** The shipped DEFAULT $paths-value resource: permissive until extensions contribute shapes. */
export function generateDocumentPathsSchema() {
  return {
    $id: DOCUMENT_PATHS_SCHEMA_ID,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description:
      "Default $paths-value union for documents. Per-project entry documents override this " +
      "resource with the union of extension-contributed paths shapes.",
    title: "Jx Document Paths Union",
  };
}

// ─── Extension Manifest Schema Generator ─────────────────────────────────────

export function generateExtensionManifestSchema() {
  return {
    $id: "https://jxsuite.com/schema/extension-manifest/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Jx Extension Manifest",
    ...extensionManifestSchema,
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
// (no direct dependency, and shipping no types usable from here).
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
    // The generated schema is JSON Schema 2020-12, so use the matching Ajv build
    // (the default `ajv` export is draft-07 and can't compile a 2020-12 schema).
    ({ default: Ajv } = (await import("ajv/dist/2020")) as { default: AjvCtor });
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

async function runSchemaCli() {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");

  const schemaDir = dirname(resolve(process.argv[1] as string, ".."));

  const componentSchema = await generateSchema();
  const projectSchema = generateProjectSchema();
  const classSchema = generateClassSchema();
  const projectCoreSchema = generateProjectCoreSchema();
  const manifestSchema = generateExtensionManifestSchema();
  const fieldsSchema = generateProjectFieldsSchema();
  const pathsSchema = generateDocumentPathsSchema();

  const componentStr = JSON.stringify(componentSchema, null, 2);
  const projectStr = JSON.stringify(projectSchema, null, 2);
  const classStr = JSON.stringify(classSchema, null, 2);
  const projectCoreStr = JSON.stringify(projectCoreSchema, null, 2);
  const manifestStr = JSON.stringify(manifestSchema, null, 2);
  const fieldsStr = JSON.stringify(fieldsSchema, null, 2);
  const pathsStr = JSON.stringify(pathsSchema, null, 2);

  const [out] = process.argv.slice(2);

  if (out) {
    writeFileSync(out, componentStr, "utf8");
    console.error(`Jx component schema written to ${out}`);
  } else {
    writeFileSync(resolve(schemaDir, "schema.json"), componentStr, "utf8");
    writeFileSync(resolve(schemaDir, "project-schema.json"), projectStr, "utf8");
    writeFileSync(resolve(schemaDir, "class-schema.json"), classStr, "utf8");
    mkdirSync(resolve(schemaDir, "schemas"), { recursive: true });
    writeFileSync(
      resolve(schemaDir, "schemas", "project.core.schema.json"),
      projectCoreStr,
      "utf8",
    );
    writeFileSync(resolve(schemaDir, "schemas", "project.fields.schema.json"), fieldsStr, "utf8");
    writeFileSync(resolve(schemaDir, "schemas", "document.paths.schema.json"), pathsStr, "utf8");
    writeFileSync(resolve(schemaDir, "extension-manifest.schema.json"), manifestStr, "utf8");
    console.error("Generated:");
    console.error("  schema.json (component)");
    console.error("  project-schema.json");
    console.error("  class-schema.json");
    console.error("  schemas/project.core.schema.json");
    console.error("  schemas/project.fields.schema.json");
    console.error("  schemas/document.paths.schema.json");
    console.error("  extension-manifest.schema.json");
  }
}

// Runs when invoked as a script or driven by a test that stages argv[1]. The build lives in an async
// Function rather than a top-level await: Bun's test runtime drops a dynamically-imported module's
// Top-level-await continuation on Windows. `ready` lets tests await the same sequence.
// oxlint-disable-next-line unicorn/prefer-top-level-await
export const ready = process.argv[1]?.endsWith("schema.ts") ? runSchemaCli() : undefined;
