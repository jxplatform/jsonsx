import type { FromSchema } from "json-schema-to-ts";

import type { headEntrySchema } from "./defs/head-entry.schema";
import type { imageConfigSchema } from "./defs/image-config.schema";
import type { cemEventSchema, cemParameterSchema } from "./defs/cem.schema";
import type { projectConfigSchema } from "./defs/project-config.schema";
import type { refObjectSchema } from "./defs/ref-object.schema";
import type { styleObjectSchema } from "./defs/style-object.schema";
import type { elementDefSchema } from "./defs/element-def.schema";
import type { functionDefSchema } from "./defs/function-def.schema";
import type { externalClassDefSchema } from "./defs/external-class-def.schema";
import type { typedStateDefSchema } from "./defs/typed-state-def.schema";
import type { pureTypeDefSchema } from "./defs/pure-type-def.schema";
import type { expressionEntrySchema, expressionNodeSchema } from "./defs/expression-node.schema";
import type { defsMapSchema, stateEntrySchema, stateMapSchema } from "./defs/state-entry.schema";
import type {
  classConstructorDefSchema,
  classDefSchema,
  classFieldDefSchema,
  classMethodDefSchema,
  classParameterDefSchema,
} from "./defs/class-def.schema";

// ─── Strict Schema-Derived Types ────────────────────────────────────────────────
// These are the precise types derived from the JSON Schema defs via FromSchema.
// Use these when you need exact schema conformance (e.g., validation, serialization).

// oxlint-disable typescript/no-namespace, no-shadow -- type-only grouping of schema-derived types whose members intentionally mirror the loose top-level type names (Strict.ImageConfig vs ImageConfig); an ES module split would fragment the schema package's public surface
export namespace Strict {
  export type HeadEntry = FromSchema<typeof headEntrySchema>;
  export type ImageConfig = FromSchema<typeof imageConfigSchema>;
  export type CemParameter = FromSchema<typeof cemParameterSchema>;
  export type CemEvent = FromSchema<typeof cemEventSchema>;
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
// oxlint-enable typescript/no-namespace, no-shadow

// ─── JSON Value Model ───────────────────────────────────────────────────────────
// Jx documents are JSON. These types describe what can actually appear in one,
// As opposed to `unknown` (nothing known) or `any` (checking disabled).

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

// ─── Binding Model ──────────────────────────────────────────────────────────────
// Any bindable position in a document holds either a literal value or a JSON
// Pointer reference into the reactive scope.

/**
 * A JSON Pointer reference into document state, e.g. `{ $ref: "#/state/count" }`. (A type literal
 * rather than an interface so it stays assignable to JsonValue.)
 */
export interface JxRef {
  $ref: string;
}

/** A value that may be given literally or bound via `$ref`. */
export type Bindable<T> = T | JxRef;

// ─── Expression Model ───────────────────────────────────────────────────────────
// Declarative expressions: operator + target (+ value), with operands that are
// Pointers, literals, or nested expression nodes.

export type JxExpressionOperand =
  | JxRef
  | JxExpressionNode
  | string
  | number
  | boolean
  | null
  | JxExpressionOperand[]
  // Plain-object literal (e.g. an Intl options bag); $ref/operator shapes are the members above.
  | Record<string, JsonValue>;

export interface JxExpressionNode {
  operator: string;
  target: JxExpressionOperand;
  value?: JxExpressionOperand;
  initial?: JxExpressionOperand;
  /** `switch` only: matched discriminant value (string form) → result operand. */
  cases?: Record<string, JxExpressionOperand>;
  /** `switch` only: result operand when no case key matches. */
  default?: JxExpressionOperand;
}

/** A state entry (or event binding) whose value is computed from a declarative expression. */
export interface JxExpressionDef {
  $expression: JxExpressionNode;
  /**
   * Named-formula parameters (CEM convention, as on Function entries). Present ⇒ the entry is a
   * callable formula invoked via the `call` operator, with `$args/<name>` refs in its body.
   */
  parameters?: (string | CemParameter)[];
  [key: string]: unknown;
}

// ─── State Definition Model ─────────────────────────────────────────────────────
// The shapes a `state` entry can take, mirroring the runtime's five-shape
// Detection algorithm in buildScope(). Use the guards in `@jxsuite/schema/guards`
// To discriminate.

// ─── Statement Model (spec §20) ─────────────────────────────────────────────────
// Structured function bodies: `body` as a statement array instead of opaque JS source,
// Mirroring ESTree's BlockStatement.body = Statement[].

/** An `{ if, then, else }` branch — the JSON Schema 2020-12 conditional keyword triple. */
export interface JxIfStatement {
  if: JxExpressionOperand;
  then: JxStatement[];
  else?: JxStatement[];
}

/** A `{ $switch, cases }` multiway branch in statement position (element-level convention). */
export interface JxSwitchStatement {
  $switch: JxExpressionOperand;
  cases: Record<string, JxStatement[]>;
  default?: JxStatement[];
}

/** A WHATWG `dispatchEvent` statement: emits a CustomEvent with CustomEventInit members. */
export interface JxDispatchStatement {
  dispatchEvent: string;
  detail?: JxExpressionOperand;
  bubbles?: boolean;
  composed?: boolean;
}

/**
 * One statement of a structured function body: a bare expression node in statement position
 * (mutation or `call`), a branch, a multiway branch, or an event dispatch.
 */
export type JxStatement =
  | JxExpressionNode
  | JxIfStatement
  | JxSwitchStatement
  | JxDispatchStatement;

/** A function declaration: inline `body` or external `$src`/`$export`. */
export interface JxFunctionDef {
  $prototype: "Function";
  /**
   * Inline function body: opaque JS source (the reactive scope is the implicit first parameter) or
   * a structured statement array (spec §20).
   */
  body?: string | JxStatement[];
  /** Parameters after the implicit scope parameter: bare names or CEM parameter objects. */
  parameters?: (string | CemParameter)[];
  /** Explicit function name; defaults to the state key. */
  name?: string;
  /** External module specifier; mutually exclusive with `body`. */
  $src?: string;
  /** Named export within `$src`; defaults to the state key. */
  $export?: string;
  /** Legacy alias for `parameters` (bare names only). */
  arguments?: string[];
  timing?: "compiler" | "server" | "client";
  debounce?: number;
  emits?: CemEvent[];
  description?: string;
  deprecated?: string | boolean;
  [key: string]: unknown;
}

/** A `timing: "server"` function proxy — executed server-side, no `$prototype`. */
export interface JxServerFnDef {
  timing: "server";
  $src: string;
  $export: string;
  parameters?: (string | CemParameter)[];
  /** Named arguments forwarded to the server function: literals or `$ref` bindings. */
  arguments?: Record<string, JsonValue>;
  debounce?: number;
  [key: string]: unknown;
}

// ─── Consumer-Friendly Types ────────────────────────────────────────────────────
// Relaxed types for everyday use in the runtime/compiler/studio. These add an index
// Signature for dynamic property access while preserving the known property structure.

export interface JxHeadEntry {
  tagName: string;
  attributes?: Record<string, string | boolean>;
  /**
   * Element content. An **object** is a structured data block — the compiler serializes it to JSON
   * inside the tag, which is how JSON-LD is authored (site-architecture.md §8.5).
   */
  textContent?: string | Record<string, unknown>;
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
  /** Wrap a multi-format image in a `<picture>` with one `<source>` per format. Default true. */
  picture?: boolean;
  service?: "build" | "cloudflare";
  remoteDomains?: string[];
}

/** A CEM-compatible function parameter. JSON-precise (assignable to JsonValue). */
export interface CemParameter {
  name: string;
  /** Parameter type — JSON Schema or CEM `{ text }` format. */
  type?: JsonValue;
  description?: string;
  optional?: boolean;
  default?: JsonValue;
}

/** A CEM-compatible event a function dispatches. JSON-precise (assignable to JsonValue). */
export interface CemEvent {
  name: string;
  type?: JsonValue;
  description?: string;
  deprecated?: boolean | string;
}

export type RefObject = FromSchema<typeof refObjectSchema>;

export interface JxStyle {
  [property: string]: string | number | JxStyle | undefined;
}

/**
 * A tag chosen when the element is created, from a set the schema enumerates.
 *
 * Both branches resolve to a `TagName`, so the candidates are readable without evaluating anything
 * — which is what lets the compiler emit one template per candidate and `jx validate` refuse an
 * illegal name at authoring time. See `defs/tag-expression.schema.ts` for why this is not a `${…}`
 * template and not a third `$switch` spelling.
 */
export type JxTagExpression =
  | { operator: "?:"; target: unknown; value: string; initial: string }
  | { operator: "switch"; target: unknown; cases: Record<string, string>; default: string };

/**
 * An ELEMENT's tag. The document root's and a head entry's stay `string` — see
 * `defs/tag-expression.schema.ts`.
 */
export type JxElementTagName = string | { $expression: JxTagExpression };

export interface JxElement {
  tagName?: JxElementTagName;
  textContent?: string | null | JxRef;
  innerHTML?: string;
  /**
   * Child nodes. A repeater (`{ $prototype: "Array", … }`) may appear as a member of the array —
   * nestled among siblings or as the sole child — and is structurally a `JxElement` (its
   * `items`/`map`/`filter`/`sort` are absorbed by the open index signature; narrow with
   * `isMappedArray`). The bare `| JxMappedArray` form (whole children slot is one repeater) is
   * retained for backward compatibility with legacy docs.
   */
  children?: (JxElement | string)[] | JxMappedArray;
  style?: JxStyle;
  attributes?: Record<string, JxAttributeValue>;
  className?: string;
  id?: string;
  hidden?: boolean;
  tabIndex?: number;
  title?: string;
  lang?: string;
  dir?: string;
  $ref?: string;
  $props?: Record<string, JsonValue>;
  $switch?: string | JxRef;
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
  items: Bindable<JsonValue[]>;
  map?: JxElement;
  filter?: Bindable<string>;
  sort?: Bindable<string>;
}

export interface JxDocument extends JxElement {
  /**
   * The custom element's NAME, always a literal.
   *
   * Narrowed from {@link JxElement.tagName} deliberately: this string becomes
   * `customElements.define(…)`, the emitted module's file name and a CSS selector prefix, none of
   * which can be chosen per instance. Carrying the rule in the type means `defineElement` and the
   * compiler keep receiving a string without a positional guard anyone can forget to write.
   */
  tagName?: string;
  state?: Record<string, JxStateDefinition>;
  $layout?: string | false;
  $paths?: JxPathsDef;
  $elements?: (JxElement | string)[];
  $head?: JxHeadEntry[];
  $media?: Record<string, string>;
  $defs?: Record<string, JsonValue>;
  imports?: Record<string, string>;
}

export type FunctionDef = FromSchema<typeof functionDefSchema>;

export type ExternalClassDef = FromSchema<typeof externalClassDefSchema>;

export type TypedStateDef = FromSchema<typeof typedStateDefSchema>;

export type PureTypeDef = FromSchema<typeof pureTypeDefSchema>;

export type ExpressionNode = FromSchema<typeof expressionNodeSchema>;
export type ExpressionEntry = FromSchema<typeof expressionEntrySchema>;

/**
 * Every shape a `state` entry can take — the runtime's five-shape detection algorithm: naked values
 * (Shape 1), expanded signals / pure type defs (Shape 2/2b), function declarations (Shape 4),
 * expressions (Shape 5), prototype instances, and server function proxies. Discriminate with the
 * guards in `@jxsuite/schema/guards`.
 */
export type JxStateDefinition =
  | JsonPrimitive
  | JsonValue[]
  | JxFunctionDef
  | JxPrototypeDef
  | JxExpressionDef
  | JxServerFnDef
  | JxStateObject;

/** An expanded signal (`{ default }`), pure type definition, or naked plain object. */
export interface JxStateObject {
  type?: string;
  default?: JsonValue;
  properties?: Record<string, JxStateObject>;
  items?: JxStateObject | JxStateObject[];
  enum?: JsonValue[];
  description?: string;
  /** Linked HTML attribute name for CEM extraction. */
  attribute?: string;
  /** Whether property changes reflect back to the HTML attribute. */
  reflects?: boolean;
  deprecated?: string | boolean;
  [key: string]: unknown;
}

/** A `$prototype` instance entry (Request, Storage, ContentCollection, custom classes, …). */
export interface JxPrototypeDef {
  $prototype: string;
  $src?: string;
  $export?: string;
  /** Function body (Function entries) or request body (Request entries). */
  body?: string | JsonObject;
  parameters?: (string | CemParameter)[];
  arguments?: string[];
  timing?: "compiler" | "server" | "client";
  default?: JsonValue;
  debounce?: number;
  contentType?: string;
  filter?: Record<string, JsonValue>;
  sort?: { field: string; order?: string };
  limit?: number;
  id?: Bindable<string>;
  /** Request prototype config. */
  url?: string;
  method?: string;
  manual?: boolean;
  headers?: Record<string, string>;
  /** Storage prototype config (LocalStorage / SessionStorage key). */
  key?: string;
  /** Cookie prototype config. */
  name?: string;
  maxAge?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: string;
  /** IndexedDB prototype config. */
  database?: string;
  store?: string;
  version?: number;
  keyPath?: string;
  autoIncrement?: boolean;
  indexes?: { name: string; keyPath: string; unique?: boolean }[];
  /** FormData prototype config. */
  fields?: Record<string, JsonValue>;
  [key: string]: unknown;
}

// ─── Event Binding Model ────────────────────────────────────────────────────────

/**
 * The value of an `on*` document key: a `$ref` to a state function, an inline function declaration,
 * or a declarative expression.
 */
export type JxEventBinding = JxRef | JxFunctionDef | JxExpressionDef;

export type StateMap = FromSchema<typeof stateMapSchema>;
export type DefsMap = FromSchema<typeof defsMapSchema>;

export type ClassDef = FromSchema<typeof classDefSchema>;
export type ClassFieldDef = FromSchema<typeof classFieldDefSchema>;
export type ClassMethodDef = FromSchema<typeof classMethodDefSchema>;
export type ClassParameterDef = FromSchema<typeof classParameterDefSchema>;
export type ClassConstructorDef = FromSchema<typeof classConstructorDefSchema>;

// ─── Class Definition Model (consumer-friendly) ────────────────────────────────
// Working types for .class.json schema-defined classes, mirroring class-def.schema.

/** A typed parameter definition (or a `$ref` into `$defs/parameters`). */
export interface JxClassParamDef {
  identifier?: string;
  $ref?: string;
  type?: unknown;
  format?: string;
  default?: JsonValue;
  description?: string;
  [key: string]: unknown;
}

export interface JxClassFieldDef {
  role?: "field";
  access?: "public" | "private" | "protected";
  scope?: "instance" | "static";
  identifier?: string;
  type?: unknown;
  $prototype?: string;
  initializer?: JsonValue;
  default?: JsonValue;
  description?: string;
  [key: string]: unknown;
}

export interface JxClassCtorDef {
  role?: "constructor";
  $prototype?: "Function";
  parameters?: JxClassParamDef[];
  superCall?: { arguments?: string[] };
  body?: string | string[];
  description?: string;
  [key: string]: unknown;
}

export interface JxClassMethodDef {
  role?: "method" | "accessor" | "parse" | "serialize" | "discover" | "load";
  $prototype?: "Function";
  access?: "public" | "private" | "protected";
  scope?: "instance" | "static";
  identifier?: string;
  timing?: ("compiler" | "server" | "client")[];
  parameters?: JxClassParamDef[];
  returnType?: { $ref?: string };
  body?: string | string[];
  getter?: { body?: string };
  setter?: { parameters?: JxClassParamDef[]; body?: string };
  description?: string;
  [key: string]: unknown;
}

/** A .class.json document: `$prototype: "Class"` with fields/constructor/methods in `$defs`. */
export interface JxClassDef {
  $prototype: "Class";
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  extends?: string | JxRef;
  $implementation?: string;
  $defs?: {
    fields?: Record<string, JxClassFieldDef>;
    /**
     * The constructor definition. On objects parsed from JSON without an explicit "constructor"
     * key, plain property access yields `Object.prototype.constructor` (a Function) — narrow with
     * `typeof === "object"` before use.
     */
    // oxlint-disable-next-line typescript/ban-types, typescript/no-unsafe-function-type -- only `Function` absorbs the inherited Object.prototype.constructor on plain object literals
    constructor?: JxClassCtorDef | Function;
    methods?: Record<string, JxClassMethodDef>;
    parameters?: Record<string, JxClassParamDef>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** The adapters the compiler actually implements (site-loader VALID_ADAPTERS + "static"). */
export type AdapterId = "static" | "cloudflare-pages" | "cloudflare-workers" | "node" | "bun";

/**
 * Deployment tracking (project.json `build.deploy`): the hosting project this repo publishes to.
 * Identifiers only — no secrets — so it travels with the repo and any Studio (local or cloud) can
 * tell whether publishing is set up.
 */
/** `dist/_headers` output — the response headers only the build can know (RFC 9111, RFC 8246). */
export interface HeadersConfig {
  /** Emit the file at all. Default true. */
  enabled?: boolean;
  /**
   * `"auto"` marks the content-addressed image variants immutable and revalidates everything else.
   * `"off"` emits no `Cache-Control` at all, for a host that manages caching itself.
   */
  cache?: "auto" | "off";
  security?: {
    /** `X-Content-Type-Options: nosniff`. Default true. */
    contentTypeOptions?: boolean;
    /** `X-Frame-Options`, or false to omit. Default `"SAMEORIGIN"`. */
    frameOptions?: "DENY" | "SAMEORIGIN" | false;
    /** `Referrer-Policy`, or false to omit. Default `"strict-origin-when-cross-origin"`. */
    referrerPolicy?: string | false;
    /** `Permissions-Policy`, or false to omit. */
    permissionsPolicy?: string | false;
    /**
     * RFC 6797. **Off by default**: a wrong `max-age` locks an apex domain to HTTPS for that long,
     * and the mistake is not visible until a certificate lapses.
     */
    hsts?: boolean | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };
  };
  /** Verbatim rules, merged after the generated block. Keys are path patterns. */
  rules?: Record<string, Record<string, string>>;
}

export interface DeployConfig {
  provider: "cloudflare-pages";
  accountId: string;
  projectName: string;
  productionUrl?: string | undefined;
}

export interface ProjectConfig {
  /** Relative path to the generated per-project schema (written by `jx schema`). */
  $schema?: string;
  name?: string;
  url?: string;
  state?: Record<string, unknown>;
  $media?: Record<string, string>;
  $elements?: (string | JxElement)[];
  $head?: JxHeadEntry[];
  $defs?: Record<string, unknown>;
  build?: {
    adapter?: AdapterId | (string & Record<never, never>);
    deploy?: DeployConfig;
    sitemap?: boolean;
    headers?: HeadersConfig;
    [key: string]: unknown;
  };
  images?: ImageConfig;
  imports?: Record<string, string>;
  /**
   * Extension packages: bare package names (resolved project-first) or relative paths. Each must
   * export jx-extension.json. Extension-contributed sections (e.g. `content`) are opaque top-level
   * keys absorbed by the index signature.
   */
  extensions?: string[];
  /** Redirect map: source path → destination (or destination with HTTP status). */
  redirects?: Record<
    string,
    string | { destination: string; status?: number } | { destination: string; rewrite: true }
  >;
  defaults?: {
    /** Default layout path; `null` means explicitly no layout. */
    layout?: string | null;
    lang?: string;
    /** Base direction for `<html dir>`. A page's `$dir` overrides it. */
    dir?: "ltr" | "rtl" | "auto";
    charset?: string;
    [key: string]: unknown;
  };
  style?: JxStyle;
  [key: string]: unknown;
}

// ─── Editor/Mutation Types ──────────────────────────────────────────────────────

/** The value of an HTML attribute in a document: a literal or a `$ref` binding. */
export type JxAttributeValue = Bindable<string | number | boolean>;

/**
 * A dynamic-route path source (spec §4.3): explicit values, data-file ref, a legacy array of param
 * objects, or an extension-discriminated source (an object carrying a `resolvePaths` discriminator
 * key registered by an enabled extension, e.g. the parser's `contentType` — the extension owns the
 * narrow shape).
 */
export type JxPathsDef =
  | { values: JsonValue[]; param?: string }
  | { $ref: string; param?: string; field?: string }
  | { param?: string; field?: string; [discriminator: string]: unknown }
  | Record<string, JsonValue>[];

/**
 * The editor's working representation of a document node. Known properties are fully typed;
 * unrecognized keys (open schema) surface as `unknown` and must be narrowed with the guards in
 * `@jxsuite/schema/guards` before use.
 */
export interface JxMutableNode {
  tagName?: JxElementTagName;
  textContent?: string | null | JxRef;
  innerHTML?: string;
  /**
   * Child nodes. The editor models a mapped-array (repeater) member as a `JxMutableNode` carrying
   * `$prototype: "Array"` (plus `items`/`map`/`filter`/`sort` below), so members stay assignable
   * here. The bare `| JxMappedArray` form (whole children slot is one repeater) is retained for
   * backward compatibility.
   */
  children?: (JxMutableNode | string)[] | JxMappedArray;
  style?: JxStyle;
  attributes?: Record<string, JxAttributeValue>;
  className?: string;
  id?: string;
  title?: string;
  $ref?: string;
  $props?: Record<string, JsonValue>;
  $switch?: string | JxRef;
  cases?: Record<string, JxMutableNode>;
  $prototype?: string;
  $title?: string;
  $id?: string;
  $src?: string;
  $layout?: string | false;
  $static?: boolean;
  $paths?: JxPathsDef;
  state?: Record<string, JxStateDefinition>;
  /** Repeater fields when this node is a mapped-array container. */
  items?: Bindable<JsonValue[]>;
  filter?: Bindable<string>;
  sort?: Bindable<string>;
  map?: JxMutableNode;
  $elements?: (JxMutableNode | string | JxRef)[];
  $head?: JxHeadEntry[];
  $media?: Record<string, string>;
  $defs?: Record<string, JsonValue>;
  imports?: Record<string, string>;
  observedAttributes?: string[];
  [key: string]: unknown;
}

// ─── Paths ──────────────────────────────────────────────────────────────────────

export type JxPath = (string | number)[];

// ─── Content Type Schema ────────────────────────────────────────────────────────
// Part-3 cleanup: move to parser — the parser extension owns the content-section shapes now; these
// Stay here only while the studio still imports them from @jxsuite/schema/types.

/** One field within a content-type JSON schema; recursive for nested objects. */
export interface ContentTypeSchemaField {
  type?: string;
  $ref?: string;
  properties?: Record<string, ContentTypeSchemaField>;
  items?: ContentTypeSchemaField;
  required?: string[];
  description?: string;
  [key: string]: unknown;
}

export interface ContentTypeSchema {
  properties?: Record<string, ContentTypeSchemaField>;
  required?: string[];
  [key: string]: unknown;
}

// ─── Content Wire Types ─────────────────────────────────────────────────────────
// Core wire shapes for content loading (specs/extensions.md §8): format classes' `load`
// Capabilities return ContentLoaderEntry[], and hosts pass the entries through untouched.
// Extensions implement them; core only threads them.

/** A table-of-contents entry extracted from a loaded content document. */
export interface TocEntry {
  depth: number;
  text: string;
  id: string;
}

/** One loaded content entry, as produced by a format class's `load` capability. */
export interface ContentLoaderEntry {
  id: string;
  data: Record<string, unknown>;
  body: string | null;
  $children?: (JxElement | string)[];
  _meta?: {
    excerpt?: string;
    toc?: TocEntry[];
    readingTime?: number;
    wordCount?: number;
    /**
     * The source file's modification time, RFC 3339. The fallback a feed uses when an entry carries
     * no authored date, and what lets the sitemap give a generated page its own `<lastmod>` rather
     * than its template's.
     */
    mtime?: string;
    /** Authored text of a field the date-coercion pass rewrote, keyed by field name. */
    rawDates?: Record<string, unknown>;
  };
}
