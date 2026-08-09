export const BUILT_IN_PROTOTYPES = [
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
] as const;

export const externalClassDefSchema = {
  description:
    'An external class / data source. $prototype is a constructor name (not "Function"). ' +
    "When $prototype is not in the built-in registry, $src is required. " +
    "All state entries are reactive by default.",
  properties: {
    $export: {
      description: "Named export in $src module. Defaults to the $prototype value.",
      type: "string",
    },
    $prototype: {
      description: "Constructor name — built-in Web API class or external class name.",
      examples: [
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
        "MarkdownCollection",
        "MyParser",
      ],
      not: { const: "Function" },
      type: "string",
    },
    $src: {
      description: "External module specifier. Required when $prototype is not a built-in.",
      examples: ["@jxsuite/md", "./lib/my-parser.js", "npm:@myorg/data"],
      type: "string",
    },
    autoIncrement: { type: "boolean" },
    body: {},
    database: { type: "string" },
    debounce: { minimum: 0, type: "integer" },
    default: {},
    description: { type: "string" },
    domain: { type: "string" },
    expires: { type: "string" },
    /* Widened to mirror `sort` below, because this one grab-bag of properties is shared by EVERY
       state `$prototype` with no discrimination on which prototype is in play. `filter` as a
       reactive `$ref` is what the built-in `Array` prototype wants; `@jxsuite/parser`'s
       ContentCollection and `@jxsuite/connector`'s TableQuery both declare their own `filter` as a
       rule ARRAY, and the core shape silently overrode the class's own declaration — so a document
       using a documented class parameter correctly failed `jx validate` with "must be object". */
    filter: {
      anyOf: [
        { $ref: "#/$defs/RefObject" },
        { description: "A single filter object, e.g. an equality shorthand.", type: "object" },
        {
          description: 'Ordered filter rules, e.g. [{ field: "Slug", op: "not empty" }].',
          items: { type: "object" },
          type: "array",
        },
      ],
      description:
        "Filter configuration: a reactive $ref binding, a single filter object, or an ordered " +
        "array of rules.",
    },
    headers: { additionalProperties: { type: "string" }, type: "object" },
    indexes: {
      items: {
        properties: {
          keyPath: {
            oneOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }],
          },
          name: { type: "string" },
          unique: { type: "boolean" },
        },
        required: ["name", "keyPath"],
        type: "object",
      },
      type: "array",
    },
    items: {},
    key: { type: "string" },
    keyPath: { type: "string" },
    manual: { type: "boolean" },
    map: { $ref: "#/$defs/ElementDef" },
    maxAge: { type: "integer" },
    method: {
      enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
      type: "string",
    },
    name: { type: "string" },
    path: { type: "string" },
    responseType: {
      enum: ["json", "text", "blob", "arraybuffer", "document", ""],
      type: "string",
    },
    sameSite: { enum: ["strict", "lax", "none"], type: "string" },
    secure: { type: "boolean" },
    sort: {
      anyOf: [
        { $ref: "#/$defs/RefObject" },
        { description: "A single sort rule, e.g. { field, order }.", type: "object" },
        {
          description: 'Ordered sort rules, e.g. [{ field: "date", order: "desc" }].',
          items: { type: "object" },
          type: "array",
        },
      ],
      description:
        "Sort configuration: a reactive $ref binding, a single { field, order } rule, or an " +
        "ordered array of rules.",
    },
    src: {
      description: "Configuration property passed to external class constructor.",
      type: "string",
    },
    store: { type: "string" },
    timing: { enum: ["compiler", "server", "client"], type: "string" },
    url: { $ref: "#/$defs/StringOrRef" },
    version: { minimum: 1, type: "integer" },
  },
  required: ["$prototype"],
  type: "object",
} as const;
