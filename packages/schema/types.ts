import type { FromSchema } from "json-schema-to-ts";

import { headEntrySchema } from "./defs/head-entry.schema";
import { imageConfigSchema } from "./defs/image-config.schema";
import { cemParameterSchema, cemEventSchema } from "./defs/cem.schema";
import { contentTypeDefSchema } from "./defs/content-type-def.schema";
import { projectConfigSchema } from "./defs/project-config.schema";
import { refObjectSchema } from "./defs/ref-object.schema";
import { styleObjectSchema } from "./defs/style-object.schema";
import { elementDefSchema } from "./defs/element-def.schema";
import { functionDefSchema } from "./defs/function-def.schema";
import { externalClassDefSchema } from "./defs/external-class-def.schema";
import { typedStateDefSchema } from "./defs/typed-state-def.schema";
import { pureTypeDefSchema } from "./defs/pure-type-def.schema";
import { expressionNodeSchema, expressionEntrySchema } from "./defs/expression-node.schema";
import { stateEntrySchema, stateMapSchema, defsMapSchema } from "./defs/state-entry.schema";
import {
  classDefSchema,
  classFieldDefSchema,
  classMethodDefSchema,
  classParameterDefSchema,
  classConstructorDefSchema,
} from "./defs/class-def.schema";

// ─── Strict Schema-Derived Types ────────────────────────────────────────────────
// These are the precise types derived from the JSON Schema defs via FromSchema.
// Use these when you need exact schema conformance (e.g., validation, serialization).

export namespace Strict {
  export type HeadEntry = FromSchema<typeof headEntrySchema>;
  export type ImageConfig = FromSchema<typeof imageConfigSchema>;
  export type CemParameter = FromSchema<typeof cemParameterSchema>;
  export type CemEvent = FromSchema<typeof cemEventSchema>;
  export type ContentTypeDef = FromSchema<typeof contentTypeDefSchema>;
  export type RefObject = FromSchema<typeof refObjectSchema>;
  export type Style = FromSchema<typeof styleObjectSchema>;
  export type Element = FromSchema<typeof elementDefSchema>;
  export type FunctionDef = FromSchema<typeof functionDefSchema>;
  export type ExternalClassDef = FromSchema<typeof externalClassDefSchema>;
  export type TypedStateDef = FromSchema<typeof typedStateDefSchema>;
  export type PureTypeDef = FromSchema<typeof pureTypeDefSchema>;
  export type ExpressionNode = FromSchema<typeof expressionNodeSchema>;
  export type ExpressionEntry = FromSchema<typeof expressionEntrySchema>;
  export type StateDefinition = FromSchema<typeof stateEntrySchema>;
  export type StateMap = FromSchema<typeof stateMapSchema>;
  export type DefsMap = FromSchema<typeof defsMapSchema>;
  export type ClassDef = FromSchema<typeof classDefSchema>;
  export type ClassFieldDef = FromSchema<typeof classFieldDefSchema>;
  export type ClassMethodDef = FromSchema<typeof classMethodDefSchema>;
  export type ClassParameterDef = FromSchema<typeof classParameterDefSchema>;
  export type ClassConstructorDef = FromSchema<typeof classConstructorDefSchema>;
  export type ProjectConfig = FromSchema<typeof projectConfigSchema>;
}

// ─── Consumer-Friendly Types ────────────────────────────────────────────────────
// Relaxed types for everyday use in the runtime/compiler/studio. These add an index
// signature for dynamic property access while preserving the known property structure.

export interface JxHeadEntry {
  tagName: string;
  attributes?: Record<string, string | boolean>;
  textContent?: string;
  children?: (JxHeadEntry | string)[];
  [key: string]: unknown;
}

export interface ImageConfig {
  optimize?: boolean;
  widths?: number[];
  formats?: string[];
  quality?: { webp?: number; avif?: number; jpeg?: number; png?: number };
  sizes?: string;
  lazyLoad?: boolean;
  service?: "build" | "cloudflare";
  binding?: string;
}

export type CemParameter = FromSchema<typeof cemParameterSchema>;
export type CemEvent = FromSchema<typeof cemEventSchema>;

export type ContentTypeDef = FromSchema<typeof contentTypeDefSchema>;

export type RefObject = FromSchema<typeof refObjectSchema>;

export type JxStyle = {
  [property: string]: string | number | JxStyle | undefined;
};

export interface JxElement {
  tagName?: string;
  textContent?: string | null;
  innerHTML?: string;
  children?: (JxElement | string)[] | JxMappedArray;
  style?: JxStyle;
  attributes?: Record<string, unknown>;
  className?: string;
  id?: string;
  hidden?: boolean;
  tabIndex?: number;
  title?: string;
  lang?: string;
  dir?: string;
  $ref?: string;
  $props?: Record<string, unknown>;
  $switch?: { $ref: string };
  cases?: Record<string, JxElement>;
  $prototype?: string;
  $static?: boolean;
  $prerendered?: boolean;
  $title?: string;
  $id?: string;
  $src?: string;
  observedAttributes?: string[];
  state?: Record<string, JxStateDefinition>;
  [key: string]: unknown;
}

export interface JxMappedArray {
  $prototype: "Array";
  items: { $ref: string } | unknown;
  map?: JxElement;
  filter?: { $ref: string } | unknown;
  sort?: { $ref: string } | unknown;
}

export interface JxDocument extends JxElement {
  state?: Record<string, JxStateDefinition>;
  $elements?: (JxElement | string)[];
  $head?: JxHeadEntry[];
  $media?: Record<string, string>;
  $defs?: Record<string, unknown>;
  imports?: Record<string, string>;
}

export type FunctionDef = FromSchema<typeof functionDefSchema>;

export type ExternalClassDef = FromSchema<typeof externalClassDefSchema>;

export type TypedStateDef = FromSchema<typeof typedStateDefSchema>;

export type PureTypeDef = FromSchema<typeof pureTypeDefSchema>;

export type ExpressionNode = FromSchema<typeof expressionNodeSchema>;
export type ExpressionEntry = FromSchema<typeof expressionEntrySchema>;

export type JxStateDefinition = string | number | boolean | null | JxStateObject | JxPrototypeDef;

export interface JxStateObject {
  type?: string;
  default?: unknown;
  properties?: Record<string, unknown>;
  items?: unknown;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface JxPrototypeDef {
  $prototype: string;
  $src?: string;
  $export?: string;
  body?: string;
  parameters?: string[];
  arguments?: string[];
  timing?: "compiler" | "server" | "client";
  default?: unknown;
  debounce?: number;
  contentType?: string;
  filter?: Record<string, unknown>;
  sort?: { field: string; order?: string };
  limit?: number;
  id?: string | { $ref: string };
  [key: string]: unknown;
}

export type StateMap = FromSchema<typeof stateMapSchema>;
export type DefsMap = FromSchema<typeof defsMapSchema>;

export type ClassDef = FromSchema<typeof classDefSchema>;
export type ClassFieldDef = FromSchema<typeof classFieldDefSchema>;
export type ClassMethodDef = FromSchema<typeof classMethodDefSchema>;
export type ClassParameterDef = FromSchema<typeof classParameterDefSchema>;
export type ClassConstructorDef = FromSchema<typeof classConstructorDefSchema>;

export interface ProjectConfig {
  name?: string;
  url?: string;
  state?: Record<string, unknown>;
  $media?: Record<string, string>;
  $elements?: (string | JxElement)[];
  $head?: JxHeadEntry[];
  $defs?: Record<string, unknown>;
  build?: { adapter?: string; [key: string]: unknown };
  images?: ImageConfig;
  imports?: Record<string, string>;
  contentTypes?: Record<string, ContentTypeDef>;
  defaults?: { layout?: string; lang?: string; charset?: string; [key: string]: unknown };
  style?: JxStyle;
  [key: string]: unknown;
}

// ─── Editor/Mutation Types ──────────────────────────────────────────────────────

export interface JxMutableNode {
  tagName?: string;
  textContent?: string | null;
  innerHTML?: string;
  children?: (JxMutableNode | string)[];
  style?: Record<string, any>;
  attributes?: Record<string, any>;
  className?: string;
  id?: string;
  $ref?: string;
  $props?: Record<string, unknown>;
  $switch?: string | { $ref: string };
  cases?: Record<string, JxMutableNode>;
  $prototype?: string;
  $title?: string;
  $id?: string;
  $src?: string;
  state?: Record<string, any>;
  $elements?: (JxMutableNode | string | { $ref: string })[];
  $head?: JxHeadEntry[];
  $media?: Record<string, string>;
  $defs?: Record<string, any>;
  [key: string]: any;
}

// ─── Paths ──────────────────────────────────────────────────────────────────────

export type JxPath = (string | number)[];

// ─── Content Type Schema ────────────────────────────────────────────────────────

export interface ContentTypeSchema {
  properties?: Record<string, any>;
  required?: string[];
  [key: string]: unknown;
}
