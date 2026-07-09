# Jx Extensions Specification

## Extension Packages, Schema Composition, and the Capability Contract

**Version:** 2.0.0-draft
**Status:** In Progress
**License:** MIT

Supersedes v1 ("Format-Extension Classes and the Capability Contract"). The
format-class contract from v1 survives unchanged (§6–§8); v2 adds the package
layer around it: extension packages, manifest-driven registration, JSON-Schema
composition, project sections, server mounts, and the studio settings
vocabulary. The relationships vocabulary has a companion spec:
[relationships.md](./relationships.md).

---

## 1. Overview and principles

Jx documents are JSON. Everything else — markdown and CSV content, dynamic
data tables, authentication, payments, or anything a third party dreams up —
enters the system through **extension packages**. The core story:

> Jx provides the canvas. Each project defines its own shape. Any developer
> can extend the framework in every way the core extensions do — without
> forking or refactoring the core packages.

Principles:

1. **Extensions are packages.** The unit of admission is an npm package (or a
   local directory) shipping a `jx-extension.json` manifest. A project opts in
   with one line.
2. **Core never depends on extensions.** Extension packages live in the
   repository's top-level `extensions/` tree and may depend on core packages
   (`packages/*`) and on each other. No core package may declare a runtime
   dependency on an extension package or import from one in `src/`. CI
   enforces this (`scripts/check-dep-rules.ts`).
3. **JSON introspection first.** Hosts read JSON (manifests, `.class.json`
   descriptors, schema fragments) to discover what an extension provides, and
   import implementation code only to invoke declared static capability
   methods by `role`.
4. **JSON-Schema-native validation.** A project's effective schema is a plain
   JSON Schema 2020-12 document composed from the core schema and each
   extension's shipped schema fragment. Any compliant validator can validate a
   project offline — there is no jx-specific composition runtime.
5. **`.json` is the single native built-in.** Jx _is_ JSON, so hosts handle
   `.json` inline and consult the registry for everything else.

`@jxsuite/parser` is the reference extension: its content collections are
wired exactly the way a third-party extension would wire them. Swap it out or
add new extensions, and every integration point (build, dev server, studio
editing, runtime data access, deployed-site serving) keeps working.

---

## 2. Package layout and dependency rules

```
extensions/
  parser/                    # @jxsuite/parser — content collections, markdown, CSV
    package.json             # "jx": "./jx-extension.json"; exports manifest, schemas, classes
    jx-extension.json
    schemas/
      project.fragment.schema.json
      document.fragment.schema.json
    src/
      *.class.json           # class descriptors (format/project/server/connector blocks)
      *.ts                   # implementations
  connector/                 # @jxsuite/connector — connections + dynamic data tables
  auth/                      # @jxsuite/auth — Better Auth user convention
```

Rules:

- `packages/*` = **core**, `extensions/*` = **extensions**, `examples` and
  `sites/*` = leaf apps (exempt consumers, like user projects).
- Extensions may list core packages and other extensions in `dependencies`.
- Core packages may **never** list an extension in `dependencies`,
  `peerDependencies`, or `optionalDependencies`, and may never import
  `@jxsuite/<extension>` from `src/`. `devDependencies` are permitted (test
  fixtures only) — the publish graph uses runtime deps.
- **Bundling carve-outs** are explicit, allowlisted with rationale in
  `scripts/check-dep-rules.ts`: `packages/desktop` (an offline app shipping a
  complete environment as installers; never published to npm) bundles the
  first-party extensions. A cloud studio distribution may do the same in its
  own app build. Carve-outs live at the app layer, never in core libraries.
- Extension packages follow the same conventions as core packages: published
  as TypeScript source under `@jxsuite/*`, `workspace:^` intra-repo deps,
  per-package `bunfig.toml` coverage ratchet, release-please versioning.

---

## 3. Declaration model

A project declares its extensions in `project.json`:

```json
{
  "$schema": "./project.schema.json",
  "extensions": ["@jxsuite/parser", "@jxsuite/connector", "./my-local-ext"],
  "imports": { "PostCard": "./components/post-card.class.json" },
  "content": {
    "posts": { "source": "./content/posts/", "format": "Markdown", "schema": {} }
  }
}
```

- `extensions` entries are bare package names or relative paths (for local /
  unpublished extensions). Package names resolve **project-first**: the
  project's own `node_modules`, then the host's (the `createNodeFormatIO`
  resolution order). Projects own their extension dependencies — a scaffolded
  project lists `@jxsuite/parser` in its `package.json`.
- `imports` retains its original, reduced job ([imports.md](./imports.md)):
  mapping `$prototype` names to **project-local** class files. It no longer
  registers formats or extensions; imports-based auto-discovery is gone.
- Name visibility: the manifest's class keys become `$prototype`-visible
  names. On a name collision, a project-local `imports` entry wins over a
  manifest class; two extensions exporting the same class name is an error
  the registry reports (rename via a local wrapper class to disambiguate).
- **No implicit defaults.** A project with no `extensions` supports only
  `.json` documents and core state prototypes.

### 3.1 Section keys

Extensions contribute top-level `project.json` keys ("sections") — `content`
(parser), `connections` and `data` (connector), `auth` (auth). By convention
section keys are single words. The section key is used verbatim as:

- the property name in `project.json`,
- the key under `_project` in resolved scope (`config._project.content`),
- the wire-path segment where applicable.

Two extensions claiming the same section key is a registry error.

---

## 4. The `jx-extension.json` manifest

Located at the package root, referenced by a `"jx"` field in `package.json`
(`"jx": "./jx-extension.json"`) and included in `exports` and `files`.

```json
{
  "name": "@jxsuite/parser",
  "title": "Content & Markdown",
  "description": "File-based content collections with Markdown and CSV formats",
  "classes": {
    "Markdown": "./src/Markdown.class.json",
    "Csv": "./src/Csv.class.json",
    "MarkdownCollection": "./src/MarkdownCollection.class.json",
    "ContentCollection": "./src/ContentCollection.class.json",
    "ContentEntry": "./src/ContentEntry.class.json",
    "Content": "./src/Content.class.json"
  },
  "schemas": {
    "project": "./schemas/project.fragment.schema.json",
    "document": "./schemas/document.fragment.schema.json"
  }
}
```

| Key           | Type                     | Meaning                                                                                                        |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `name`        | `string` (required)      | Package name; must match `package.json`.                                                                       |
| `title`       | `string`                 | Human-readable name for studio surfaces.                                                                       |
| `description` | `string`                 | One-line description.                                                                                          |
| `classes`     | `Record<string, string>` | `$prototype`-visible name → class descriptor path, relative to the manifest.                                   |
| `schemas`     | `object`                 | Schema fragments this package contributes: `project` (project.json sections), `document` (document positions). |

The manifest is pure data, validated by the generated
`extension-manifest.schema.json` (`@jxsuite/schema`). It enumerates; it does
not define behavior — behavior lives in the class descriptors it points to.

---

## 5. Schema composition

### 5.1 Fragments

- **Core** ships `@jxsuite/schema/schemas/project.core.schema.json`: the core
  project properties (`name`, `url`, `build`, `imports`, `extensions`,
  `$schema`, …) plus two published `$defs`: `JxFieldSchema` (the
  JSON-Schema-subset field shape used by content/table schemas) and
  `RelationshipRef` (see [relationships.md](./relationships.md)). The core
  fragment is **open** (no `additionalProperties: false`) — closure happens in
  the generated entry document.
- **Each extension** ships fragments named in its manifest. A project fragment
  contributes plain `properties` for its section keys. Fragments must be
  **standalone-valid** 2020-12 schema documents with their own `$id`.

### 5.2 Generated entry documents

`jx schema` (also run by `jx dev` on startup/watch of `extensions`, and by
studio on settings save) writes two committed files into the project root:

**`<project>/project.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$comment": "Generated by `jx schema` from project.json#/extensions — do not edit.",
  "type": "object",
  "allOf": [
    { "$ref": "./node_modules/@jxsuite/schema/schemas/project.core.schema.json" },
    { "$ref": "./node_modules/@jxsuite/parser/schemas/project.fragment.schema.json" }
  ],
  "unevaluatedProperties": false,
  "$defs": {
    "Fields": {
      "$id": "https://jxsuite.com/schema/project/fields/v2",
      "anyOf": [
        { "$ref": "https://jxsuite.com/schema/project/core/v2#/$defs/JxFieldSchema" },
        { "$ref": "https://jxsuite.com/schema/project/core/v2#/$defs/RelationshipRef" }
      ]
    }
  }
}
```

**`<project>/document.schema.json`** — a thin wrapper around the core document
schema (`@jxsuite/schema/schema.json`), re-embedding the paths union resource
(`https://jxsuite.com/schema/document/paths/v2`) as the union of
extension-contributed `$paths` shapes.

`project.json` binds via `"$schema": "./project.schema.json"`.

### 5.3 The two union resources ($id shadowing)

Two positions are **open recursion points** where fragments must reference the
_effective_ union without knowing it. Each is a well-known schema resource
that core ships as a default and the generated entry document **re-embeds
under the same `$id` with the effective union** — standard compound-document
`$id` resolution then lands every reference on the entry document's embed
instead of the shipped default. Inside an embed, all refs are canonical URIs
(a `$ref` inside a resource with an absolute `$id` resolves against that
`$id`, never the file location).

| Resource $id                                   | Position                                                                                                                               | Shipped default → entry-document union                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `https://jxsuite.com/schema/project/fields/v2` | Field-schema values inside section entry schemas (content frontmatter fields, table columns) — recursive through `properties`/`items`. | Default: core `JxFieldSchema` + `RelationshipRef`. Entry adds extension field extras (e.g. connector column shapes).      |
| `https://jxsuite.com/schema/document/paths/v2` | Values of `$paths` in documents.                                                                                                       | Default: permissive. Entry unions each extension's paths shape (parser's `ContentPathsSource`, connector's table source). |

Fragments write `{ "$ref": "https://jxsuite.com/schema/project/fields/v2" }`
at field positions — no local fallbacks needed. Standalone validation
registers the shipped defaults (`@jxsuite/schema/schemas/project.fields.schema.json`,
`schemas/document.paths.schema.json`); composed validation gets the entry
embeds. Because `RelationshipRef` is part of the shipped default, a validator
that only sees the defaults never reports false errors on relationship
fields — extension extras are the only entry-exclusive shapes.

> **Why not `$dynamicRef`?** The 2020-12 dynamic-anchor keywords are the
> textbook fit on paper, but ajv (8.x) supports `$dynamicAnchor` only at
> schema-resource roots — and our recursion unit (a field schema) is not the
> document root, so the entry document cannot legally host the override
> anchor. `$id` shadowing achieves the identical outermost-wins override with
> plain `$ref`s and first-class validator support (verified against ajv 8.20;
> see `packages/schema/tests/project-schemas.test.ts`).

**Everything else is plain composition.** Top-level section keys combine via
`allOf` + `unevaluatedProperties: false` at the entry document (2020-12
`unevaluatedProperties` sees annotations from adjacent `allOf` branches — its
designed use). Cross-extension unions and enums (format names, connection
names) are emitted by the generator, which is the single aggregation party.

### 5.4 Validation

- Any compliant validator resolves the entry documents offline: `allOf` refs
  are relative file paths into the project's `node_modules` (workspace
  symlinks resolve transparently); canonical-URI refs resolve from the `$id`s
  of the already-loaded fragments and embeds.
- `jx validate` (compiler CLI) validates `project.json` against
  `./project.schema.json` using ajv-2020 with a file loader restricted to the
  project root and `node_modules` (injecting the entry file's URL as `$id` at
  load time so relative refs resolve). CI validates every starter.
- Editor support matrix: VS Code's JSON language service follows relative
  `$schema`/`$ref` natively and indexes embedded `$id`s. Where an editor
  fetches the canonical URLs instead (they are served from jxsuite.com),
  it gets the shipped defaults — degradation is _under-suggestion_ of
  extension field extras, never false errors. A generic bundler (embed
  fragments under `$defs` keyed by `$id`, preserving resource boundaries) is
  the escape hatch for hosts that cannot fetch files (cloud studio).

---

## 6. Class descriptors and admission blocks

An extension's classes are ordinary Jx `.class.json` descriptors. A class
participates in host dispatch through one or more **admission blocks**:

| Block       | Grants                                                                                      | Spec section |
| ----------- | ------------------------------------------------------------------------------------------- | ------------ |
| `format`    | File-extension dispatch: parsing, serialization, content discovery/loading, studio editing. | §7           |
| `project`   | Ownership of a project.json section: data loading, `$paths` resolution, studio settings UI. | §9           |
| `server`    | A mounted route subtree in the deployed-site worker and the dev server.                     | §11          |
| `connector` | A database connection provider: dialect, schema deploy, bindings, connection testing.       | §12          |

Classes with no admission block are plain external classes (state
`$prototype` targets) — the standard contract: a constructor taking a single
`config` object, an instance `resolve()` returning JSON-serializable data,
optional `subscribe()` for reactive updates.

### 6.1 Host introspection contract

Hosts **introspect JSON only** and import code only to invoke:

1. Resolve each `extensions` entry to a package root; read the manifest named
   by its `"jx"` field; read each listed `.class.json`.
2. Detect participation via the admission blocks.
3. Find capabilities by scanning `$defs.methods` for well-known `role` values;
   the method's `identifier` (fallback: its key) names the static method.
4. To invoke: import `$implementation` (resolved relative to the `.class.json`
   location), take the export named by the class `title`, call
   `Export[identifier](...args)`.
5. Respect `timing`: if the host's environment is not listed, delegate to the
   dev server.

The registry implementing this contract lives at
`@jxsuite/schema/extension-registry` (`buildExtensionRegistry(extensions, io,
projectRoot)`) with injected I/O so the identical logic serves node and
browser hosts.

---

## 7. The `format` block

Unchanged from v1. A class participates in format dispatch iff it has a
top-level `format` object:

```json
"format": {
  "extensions": [".md"],
  "mediaType": "text/markdown",
  "documentKinds": ["page", "component", "content"],
  "exportTarget": true,
  "remote": false
}
```

| Key             | Type                                 | Default | Meaning                                                                                                                                                                           |
| --------------- | ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions`    | `string[]` (required)                | —       | File extensions claimed, with leading dot.                                                                                                                                        |
| `mediaType`     | `string`                             | —       | MIME type; used for icons, labels, HTTP responses.                                                                                                                                |
| `documentKinds` | `("page"\|"component"\|"content")[]` | `[]`    | `page`/`component` admit the extension into pages/components discovery globs; `content` admits it as a content source.                                                            |
| `exportTarget`  | `boolean`                            | `false` | When true, site builds emit a serialized sidecar per page in this format (requires a `serialize` capability).                                                                     |
| `remote`        | `boolean`                            | `false` | When true, the `load` capability accepts `http(s)` URLs as sources. Remote content sources **must** name a remote-capable format explicitly — there is no implicit remote format. |

Two classes may claim the same extension **only with disjoint capabilities**;
the registry build fails on an ambiguous `(extension, capability)` pair. A
registry never claims `.json`.

---

## 8. Capability methods

Capabilities are declared in `$defs.methods` using well-known `role` values.
All capability methods are `scope: "static"` — hosts call them on the
implementation class without constructing an instance. The instance
`resolve()` method remains the runtime's on-demand access path.

| Role             | Block       | Signature                                                                   | Consumers                                                                    |
| ---------------- | ----------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `parse`          | `format`    | `(source, options?) → JxDocument`                                           | compiler, server, studio (open file)                                         |
| `serialize`      | `format`    | `(doc, options?) → string`                                                  | studio (save), site build (export sidecars)                                  |
| `discover`       | `format`    | `(source, { baseDir }) → string[]`                                          | content loading (list entry files)                                           |
| `load`           | `format`    | `(path, { schema, directiveOptions }) → ContentLoaderEntry[]`               | content loading (parse one source)                                           |
| `projectData`    | `project`   | `(sectionValue, { projectConfig, root, registry, io }) → unknown`           | compiler site build, dev server resolve — result stored as `_project[<key>]` |
| `resolvePaths`   | `project`   | `(pathsDef, { data, projectConfig, root }) → Record<string, unknown>[]`     | pages discovery (`$paths` expansion), studio preview                         |
| `lower`          | any         | `(def, context) → JxStateDefinition`                                        | compiler — rewrites a state def into a core shape for client output          |
| `mount`          | `server`    | `(options, ctx) → (request: Request, env) => Promise<Response>`             | generated site worker, dev server                                            |
| `dialect`        | `connector` | `(connection, env) → Kysely Dialect`                                        | data mounts, auth, deploy                                                    |
| `deploySchema`   | `connector` | `(tables, connection, { env, dryRun }) → { statements, applied, warnings }` | `jx db push`, studio push                                                    |
| `bindings`       | `connector` | `(connection) → wrangler config fragment`                                   | scaffolding, `jx db push`                                                    |
| `testConnection` | `connector` | `(connection, env) → { ok, error? }`                                        | studio connections UI, CLI                                                   |

`resolvePaths` methods declare a `"discriminator"` — the `$paths` key that
routes to them (parser: `contentType`; connector: `table`). Hosts dispatch on
which discriminator key is present in the `$paths` value.

### 8.1 `timing`

Each capability method may declare a `timing` array — the environments allowed
to invoke it directly:

- Values: `"compiler"`, `"server"`, `"client"`. Default when omitted:
  `["compiler", "server"]` (assume node-only).
- A host whose environment is excluded round-trips through the dev server
  (`POST /__studio/format`, `POST /__jx_resolve__`) instead of importing the
  implementation.
- Browser-safe capabilities (no `fs`/`glob`/node imports on their code path)
  should declare `"client"` so the studio can call them in-process.

### 8.2 Options as parameters

Capability options are declared as ordinary `parameters` with JSON-Schema
types. This gives the studio enough metadata to render option UIs without any
host-side knowledge of the extension.

### 8.3 `lower`

`lower` lets a state class compile away: at build time, when a state entry's
timing excludes the compiler, the compiler checks the class descriptor for a
`lower` capability and, if present, replaces the def in place with the
returned core-shape def (`Request`, `Function`, …). This is how dynamic-data
queries become plain reactive fetches in compiled sites with no extension
code shipped to the browser.

---

## 9. The `project` block

A class owns a project.json section iff it has a top-level `project` object:

```json
"project": {
  "key": "content",
  "title": "Content Types",
  "description": "File-based content collections",
  "referenceable": true
}
```

| Key             | Type      | Default | Meaning                                                                                                      |
| --------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `key`           | `string`  | —       | The project.json top-level property this class owns (single word by convention).                             |
| `title`         | `string`  | —       | Studio label.                                                                                                |
| `description`   | `string`  | —       | Studio help text.                                                                                            |
| `referenceable` | `boolean` | `false` | Opts the section's named entries into the relationships vocabulary ([relationships.md](./relationships.md)). |

The section's **value schema is not duplicated here** — it lives in the
package's project fragment (`manifest.schemas.project`, §5.1). Hosts needing
the entry shape (studio settings forms, reference pickers) read
`properties[<key>]` from the fragment via the registry.

Behavior attaches through capabilities on the same class: `projectData` loads
the section into `_project[<key>]`; `resolvePaths` expands `$paths` values
carrying its discriminator.

### 9.1 `$studio.settings`

The `project` class's `$studio` block may declare a settings section, rendered
generically by the studio:

```json
"$studio": {
  "settings": {
    "icon": "sp-icon-view-grid",
    "label": "Content Types",
    "order": 50,
    "layout": "map",
    "entry": {
      "ui": { "schema": { "control": "schema-builder" } },
      "newEntry": { "source": "./content/${key}/", "schema": { "type": "object", "properties": {}, "required": [] } }
    }
  }
}
```

| Key              | Meaning                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `icon`           | Section icon in the settings nav.                                                                                                                                                                         |
| `label`          | Section label (defaults to `project.title`).                                                                                                                                                              |
| `order`          | Sort position among contributed sections.                                                                                                                                                                 |
| `layout`         | `"map"` — master-detail for `type: object` + `additionalProperties` sections: key list left (add/rename/delete, slugified), entry form right. `"form"` (default) — one form over the whole section value. |
| `entry.ui`       | Per-field control overrides for the entry form: `{ "<field>": { "control": "<name>" } }`.                                                                                                                 |
| `entry.newEntry` | Template for freshly created entries, with `${key}` substitution.                                                                                                                                         |
| `renderer`       | Escape hatch: names a studio-registered custom section renderer. First-party extensions use the generic path.                                                                                             |

Built-in controls: `"schema-builder"` (visual JSON-Schema field editor),
`"secret"` (value committed via the platform's secret store, **never**
project.json), `"binding"` (signal/route-param binding), plus implicit
defaults per type/enum/format. Enum choices may be dynamic via
`{ "$ref": "#/$context/<pointer>" }` — a JSON-pointer walk over the project
config (with `{@param}` segment substitution and the `$formats` virtual root),
e.g. `#/$context/connections`, `#/$context/auth/roles`.

---

## 10. Studio format hints

Unchanged from v1: format classes describe their studio control surface
declaratively in `$studio` — `icon`, `modes`, `documentMode`,
`newFileTemplate`, and the `elements` allowlist/nesting constraints gating
structural editing. The studio interprets this data generically; it never
hard-codes per-format element sets.

Additional generic hint: `$studio.stateDefaults` — an object merged into
state defs the studio creates for this prototype (e.g. `{ "timing":
"client" }` for browser-only classes).

---

## 11. The `server` block

A class contributes routes to the deployed-site worker (and the dev server)
iff it has a top-level `server` object plus a `mount` capability:

```json
"server": { "basePath": "/_jx/auth", "order": 10, "module": "@jxsuite/auth/worker" }
```

| Key        | Meaning                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `basePath` | The route subtree this mount owns. Must be under `/_jx/`. Conflicts are a registry error.             |
| `order`    | Mount order (ascending). Earlier mounts run first and may populate the shared context.                |
| `module`   | Bare specifier the generated worker imports (robust under bundlers); falls back to `$implementation`. |

Contract:

- `mount(options, ctx)` is static, `timing: ["server"]`. It returns a
  **fetch-style handler** `(request: Request, env: Record<string, unknown>) =>
Promise<Response>`. Mount providers need no HTTP framework; the generated
  worker wraps handlers (`app.all('<basePath>/*', c => handler(c.req.raw,
c.env))`), and the dev server dispatches to them directly.
- `options` is JSON inlined at generation time (identifiers only — see §13)
  plus host-provided values (the section manifest, resolved class
  constructors).
- `ctx` is one shared mutable `JxServerContext` object created per worker
  isolate and passed to every mount in `order`. Mounts communicate through
  it. The auth extension (order 10) sets `ctx.auth`; the connector data mount
  (order 20) consumes it:

```ts
interface JxServerContext {
  auth?: {
    getSession(request: Request, env: Record<string, unknown>): Promise<SessionInfo | null>;
    authorize(input: AuthorizeInput, env: Record<string, unknown>): Promise<AuthorizeDecision>;
  };
  [key: string]: unknown;
}
```

- **Fail-closed rule**: a mount that gates writes on authorization must deny
  everything except explicitly-public rules when `ctx.auth` is absent.

The connector's data mount serves the canonical wire contract:

```
GET    /_jx/data/:table        ?filter=<json>&sort=<json>&limit=&offset=&include=
GET    /_jx/data/:table/:id
POST   /_jx/data/:table
PATCH  /_jx/data/:table/:id
DELETE /_jx/data/:table/:id
```

---

## 12. The `connector` block

A class provides database connections iff it has a top-level `connector`
object plus the connector capabilities (§8):

```json
"connector": { "provider": "d1", "kind": "sqlite", "local": "sqlite", "serve": "@jxsuite/connector/worker" }
```

| Key        | Meaning                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `provider` | Identifier for the backing service (`d1`, `supabase`, `sqlite`).                                              |
| `kind`     | SQL dialect family: `"sqlite"` \| `"postgres"`. Consumed by dependents needing a dialect type (e.g. auth).    |
| `local`    | When `"sqlite"`, the dev server stands this connector in with a local SQLite file (auto-synced on first use). |
| `serve`    | The data-mount module serving this connector's tables.                                                        |

---

## 13. Security and secrets

- **Secrets never enter `project.json`.** Committed config carries
  identifiers and env-var _names_ only (`urlEnv: "SUPABASE_DB_URL"`,
  `secretEnv: "BETTER_AUTH_SECRET"`).
- Local development: values live in `<project>/.dev.vars` (git-ignored;
  wrangler convention). The dev server merges it over `process.env` when
  constructing mount environments.
- Production: `wrangler secret put <NAME>` (or the platform's secret store).
- Studio secret entry goes through the platform's secrets surface
  (`/__studio/secrets` — list returns **names only**, never values); the
  `"secret"` form control writes there, never to project.json.
- Dev-server studio data routes (`/__studio/data/*`) are the owner console:
  they intentionally bypass table permission rules and are protected by the
  dev server's loopback/token boundary. Cloud backends must gate them on
  collaboration permission.

---

## 14. Worked example: a third-party TOML format

A hypothetical `@acme/jx-toml` package ships:

**`package.json`** (excerpt)

```json
{
  "name": "@acme/jx-toml",
  "type": "module",
  "jx": "./jx-extension.json",
  "files": ["src/", "jx-extension.json"],
  "exports": {
    ".": "./src/toml.ts",
    "./jx-extension.json": "./jx-extension.json",
    "./Toml.class.json": "./src/Toml.class.json"
  }
}
```

**`jx-extension.json`**

```json
{
  "name": "@acme/jx-toml",
  "title": "TOML",
  "classes": { "Toml": "./src/Toml.class.json" }
}
```

**`src/Toml.class.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Toml",
  "description": "TOML content files as Jx content entries",
  "$prototype": "Class",
  "$implementation": "./toml.js",
  "format": {
    "extensions": [".toml"],
    "mediaType": "application/toml",
    "documentKinds": ["content"]
  },
  "$defs": {
    "parameters": {
      "src": { "identifier": "src", "type": { "type": "string" } }
    },
    "constructor": {
      "role": "constructor",
      "parameters": [{ "$ref": "#/$defs/parameters/src" }],
      "body": ["this.config = config;"]
    },
    "methods": {
      "resolve": {
        "role": "method",
        "scope": "instance",
        "identifier": "resolve",
        "returnType": { "type": "object" }
      },
      "parse": {
        "role": "parse",
        "scope": "static",
        "identifier": "parse",
        "timing": ["compiler", "server", "client"],
        "parameters": [{ "identifier": "source", "type": { "type": "string" } }],
        "returnType": { "type": "object" }
      },
      "discover": {
        "role": "discover",
        "scope": "static",
        "identifier": "discover",
        "timing": ["compiler", "server"],
        "parameters": [
          { "identifier": "source", "type": { "type": "string" } },
          { "identifier": "options", "type": { "type": "object" } }
        ],
        "returnType": { "type": "array", "items": { "type": "string" } }
      },
      "load": {
        "role": "load",
        "scope": "static",
        "identifier": "load",
        "timing": ["compiler", "server"],
        "parameters": [
          { "identifier": "path", "type": { "type": "string" } },
          { "identifier": "options", "type": { "type": "object" } }
        ],
        "returnType": { "type": "array" }
      }
    }
  }
}
```

A project enables it with one line:

```json
{
  "extensions": ["@jxsuite/parser", "@acme/jx-toml"],
  "content": {
    "settings": { "source": "./content/settings/", "format": "Toml" }
  }
}
```

With that entry in place: the content loader discovers and loads `.toml`
entries through the class, `ContentCollection`/`ContentEntry` queries work
unchanged, pages can declare `{ "$prototype": "Toml", "src": "./x.toml" }`
state for runtime access, and the studio lists `.toml` files with the class's
`$studio` hints. No host package changes.

---

## 15. Worked example: a guestbook extension

`@acme/jx-guestbook` demonstrates the full surface: a dynamic table, a studio
form, a server mount, and an auth gate — using the connector and auth
extensions as dependencies.

1. **Manifest + fragment** — the package contributes a `guestbook` section
   whose fragment schema defines `{ table, moderation }`; the section class
   declares `project: { "key": "guestbook" }` with a `$studio.settings` form
   (`layout: "form"`).
2. **Table** — its `projectData` capability materializes a `data` table
   definition (columns `name`, `message`; `permissions: { read: "public",
insert: "authenticated" }`) so entries flow through the connector's
   standard mount and DDL sync — no custom SQL.
3. **Mount** — a `server` block (`/_jx/guestbook`, order 30) with a `mount`
   returning a fetch handler that reads `ctx.auth` for session lookups and
   proxies moderated writes into `/_jx/data/guestbook`.
4. **Page** — a form posting via a lowered `TableInsert` action; a
   `TableQuery` state entry listing approved entries.

A project adds `"@acme/jx-guestbook"` to `extensions`, runs `jx schema && jx
db push`, and has a moderated, auth-gated guestbook — with project.json
validation, a studio settings section, and dev-server parity, none of it
requiring changes to any core package.

---

_Jx Extensions Specification v2.0.0-draft_
