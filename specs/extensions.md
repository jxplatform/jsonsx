# Jx Extensions Specification

## Extension Packages, Schema Composition, and the Capability Contract

**Version:** 0.3.3-draft
**Status:** Partial
**Updated:** 2026-07-25
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
  connector/                 # @jxsuite/connector — database connections + dynamic data tables over /_jx/data
  auth/                      # @jxsuite/auth — Better Auth sessions and sign-in flows over /_jx/auth, plus the ctx.auth permission evaluator the data mount authorizes against
  search/                    # @jxsuite/search — build-time search index + headless browser query client
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

`jx schema` writes two committed files into the project root, each a
**self-contained, single-resource schema**: the core schema and every enabled
extension's fragments are embedded under `$defs`, and **every `$ref` is a
root-relative JSON Pointer** (`#/$defs/project-core-v2/$defs/StyleObject`).
Generation is two passes — bundle (resolve each fragment file and embed it,
keyed by `$id`) then flatten (§5.4: rekey the embeds to readable slugs, drop
their `$id`s, rewrite every ref to a root pointer). Neither the relative
`./node_modules/...` paths of the intermediate form nor the canonical `$id`
refs of the bundled form survive into the committed file, because neither
resolves everywhere: relative paths need Node module resolution, which editors
do not perform (hoisted workspaces leave in-repo projects without their own
`node_modules`), and `$id`-scoped refs inside a compound document need a fully
compliant validator, which the editors are not (§5.4). Root pointers are the
one form ajv `jx validate`, VS Code's JSON language service, and the studio's
Monaco all resolve identically. `jx dev` does not run it on startup (it builds
the site); live regeneration happens **on demand** instead: the dev server's
`GET /__studio/project-schemas` endpoint (behind the studio's
`fetchProjectSchemas` PAL member) regenerates entry documents that are
missing or older than `project.json` — so a studio settings save (which
rewrites `project.json`) is picked up on the next fetch. The two files:

**`<project>/project.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$comment": "Generated by `jx schema` from project.json#/extensions — do not edit.",
  "type": "object",
  "allOf": [{ "$ref": "#/$defs/project-core-v2" }, { "$ref": "#/$defs/ext-parser-project-v1" }],
  "unevaluatedProperties": false,
  "$defs": {
    "Fields": {
      "anyOf": [
        { "$ref": "#/$defs/project-core-v2/$defs/JxFieldSchema" },
        { "$ref": "#/$defs/project-core-v2/$defs/RelationshipRef" }
      ]
    },
    "project-core-v2": { "...": "embedded core fragment, $id dropped" },
    "ext-parser-project-v1": { "...": "embedded parser fragment, $id dropped" }
  }
}
```

Each `$defs` slug is derived from the resource's `$id` — scheme, authority and
the conventional `schema/` segment dropped, remaining path segments joined with
dashes (`https://jxsuite.com/schema/project/core/v2` → `project-core-v2`),
numeric suffix on collision.

**`<project>/document.schema.json`** — the core document schema
(`@jxsuite/schema/schema.json`, `$id` `https://jxsuite.com/schema/v1`) embedded
the same way and referenced as `"allOf": [{ "$ref": "#/$defs/v1" }]`, plus the
paths union resource (`https://jxsuite.com/schema/document/paths/v2`) re-embedded
under `$defs.PathsValue` as the union of extension-contributed `$paths` shapes,
with each contributing document fragment embedded alongside it. The core
reference sits in a single-member `allOf` and **never** as a root-level `$ref`:
VS Code resolves a `$ref` by shallow-merging the target's keys into the
referencing node, so from the root that overwrites the entry's own `$defs` with
the core resource's, breaking every `#/$defs/<embed>/...` pointer.

The emitter composes with project-relative fragment paths as an intermediate
form only; the committed output is always run through the bundler and then the
flattener (§5.4). Both passes are idempotent on an already-committed document —
a resource whose `$id` is already present is never embedded twice, and a
document with no `$id`s and no relative refs has nothing left to rewrite — so
re-processing a committed entry document is a no-op.

`project.json` binds via `"$schema": "./project.schema.json"`.

### 5.3 The two union resources ($id shadowing)

Two positions are **open recursion points** where fragments must reference the
_effective_ union without knowing it. Each is a well-known schema resource
that core ships as a default and the generated entry document **re-embeds
under the same `$id` with the effective union** — compound-document `$id`
resolution then lands every reference on the entry document's embed instead of
the shipped default. The override is decided during generation, not at
validation time: the flattener (§5.4) rewrites each canonical-`$id` reference
to the root pointer of the entry's embed, so the committed file states the
outcome outright and no consumer has to implement `$id` shadowing to get it
right.

| Resource $id                                   | Position                                                                                                                               | Shipped default → entry-document union                                                                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://jxsuite.com/schema/project/fields/v2` | Field-schema values inside section entry schemas (content frontmatter fields, table columns) — recursive through `properties`/`items`. | Default: core `JxFieldSchema` + `RelationshipRef`. Entry adds extension field extras (e.g. connector column shapes).                                                                                                                                       |
| `https://jxsuite.com/schema/document/paths/v2` | The `$paths` value of a document.                                                                                                      | Default: the core source shapes (`values`, data-file `$ref`, legacy array) plus an unknown-source escape hatch. Entry drops the escape hatch and unions each extension's paths shape (parser's `ContentPathsSource`; a connector table source is planned). |

Fragments write `{ "$ref": "https://jxsuite.com/schema/project/fields/v2" }`
at field positions — no local fallbacks needed.

**Unions are additive, and the two differ in one member.** An entry embed
shadows the shipped default outright rather than extending it, so it must
restate the core members or they stop validating the moment an extension
contributes one. The paths union carries one member the entry union does not:
a permissive "source shape from an extension this schema cannot see" branch.
A shipped default has no way to know which extensions a project enables, so
without it every `{ "contentType": "blog" }` would be a false error wherever
the default is what is in play — the studio's offline fallback before
per-project schemas arrive, and clients fetching the canonical URL. The entry
document does know, so it omits that branch and validates `$paths` exactly:
an unrecognized source (a misspelled discriminator, a shape whose extension is
not enabled) is an error rather than a route that silently expands to nothing.

Standalone validation registers the shipped defaults
(`@jxsuite/schema/schemas/project.fields.schema.json`,
`schemas/document.paths.schema.json`); composed validation gets the entry
embeds. Because `RelationshipRef` is part of the shipped default, and because
the paths default carries its unknown-source branch, a validator that only sees
the defaults never reports false errors — extension extras are the only
entry-exclusive shapes, and the entry is where they are checked exactly.

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

- Every consumer resolves the committed entry documents **offline with no file
  access at all**: they are self-contained single-resource schemas (§5.2), so
  every `$ref` is a root-relative JSON Pointer into the same document. No
  `node_modules`, no network, no editor configuration.

  **Why root pointers and not a `$id`-keyed compound document.** VS Code's JSON
  language service — which Monaco embeds, so this covers the studio too —
  implements neither half of compound-document resolution. It resolves a
  `#/pointer` ref against the DOCUMENT ROOT, never re-based on an enclosing
  `$id`, so an embedded fragment's own `#/$defs/StyleObject` reports
  `$ref '/$defs/StyleObject' ... can not be resolved`; and it treats any ref
  with a non-empty part before `#` as external, fetching
  `https://jxsuite.com/schema/...` over the network rather than matching the
  embedded resource sitting in the same file. Offline that fails outright;
  online it silently substitutes the shipped defaults for the project's
  effective unions, which is the §5.3 override quietly not applying. Only the
  first resolve error surfaces as a diagnostic, so one visible complaint can
  hide many. Root pointers avoid both paths, and cost nothing under ajv.

  **The `$schema` binding must be satisfied by registration, not by fetching.**
  A file's own `$schema` (§5.2) OVERRIDES any file-pattern association the host
  configured — the language service resolves it first and returns — so a host
  that registers the entry documents only by pattern leaves every bound file
  resolving a URI it has no way to load. That is not a partial failure: the file
  then validates against an empty schema, so one "cannot load schema"
  diagnostic hides every real error in it. A host holding the entry documents
  in memory (the studio, via `fetchProjectSchemas`) must therefore ALSO
  register them under the id the pointer resolves to — for a project mounted at
  the root, `file:///project.schema.json` and `file:///document.schema.json` —
  which keeps resolution offline and makes the binding equivalent to the
  pattern association. Enabling a schema-request service is not an alternative:
  the resolved id carries a `file:` scheme, and fetching would reopen the
  external-`$ref` hazard the flattening exists to close.

  A relative pointer resolves against the file's OWN directory, so it needs one
  `../` per level (`../document.schema.json` from `pages/`, `../../` from
  `pages/blog/`). A pointer with too few names a file that does not exist, and
  fails identically in every consumer — it is an authoring error, not something
  a host compensates for.

- `jx validate` (compiler CLI) validates the WHOLE project tree: `project.json`
  against `./project.schema.json` (ajv-2020; a restricted file loader with a
  host-resolution fallback still handles legacy unbundled entry documents);
  every document under `components/`, `pages/`, and `layouts/` against the
  bundled document schema; every project-local `*.class.json` against the
  class schema; each enabled extension's fragments compiled standalone against
  the shipped default unions; and a self-containment check that flags any
  residual relative `$ref` in a committed entry document ("regenerate with
  `jx schema`"). CI runs this over every project root in the repo
  (`bun run schema:validate-all`).
- The generic bundler (embed fragments under `$defs` keyed by `$id`,
  preserving resource boundaries) is the mechanism behind the committed form,
  not just an escape hatch: `jx schema` bundles before writing, and the dev
  server / cloud studio serve the same bundles via `fetchProjectSchemas`.
  Where a client fetches the canonical URLs instead (they are served from
  jxsuite.com), it gets the shipped defaults — degradation is
  _under-suggestion_ of extension field extras, never false errors.

### 5.5 Composition is host-agnostic

Composition itself — core fragment plus each enabled extension's fragments,
bundled then flattened — is one pure function taking an injected JSON loader.
Every host supplies only the loader and the refs; none supplies the algorithm.
A project's entry documents therefore cannot depend on which host generated
them, which is what lets a project move between a laptop, the desktop app and
the cloud without its validation changing.

The loader is the entire host-specific surface:

| Host                             | Loader                                                                                    | Refs                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `jx schema`, dev server, desktop | Filesystem, restricted to the project root, with host resolution for `./node_modules/...` | Project-relative paths                                                        |
| Cloud session                    | A build-time table of bundled artifacts, plus the session's working tree                  | Bare specifiers for bundled packages; tree paths for project-local extensions |

The cloud composes **on demand and writes nothing back**: a cloud project needs
no committed `*.schema.json` to get full editor validation. Its constraint is
that a Worker ships a fixed set of extension packages, so an extension the
platform does not bundle is dropped from the registry before composition rather
than passed to it — the composer fails loudly on a fragment it cannot load,
because emitting an entry document that silently under-validates would be worse
than an error. Dropping the extension instead lands on the §5.3 degradation:
under-suggestion of that extension's extras, never false errors.

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

| Role             | Block       | Signature                                                                   | Consumers                                                                          |
| ---------------- | ----------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `parse`          | `format`    | `(source, options?) → JxDocument`                                           | compiler, server, studio (open file)                                               |
| `serialize`      | `format`    | `(doc, options?) → string`                                                  | studio (save), site build (export sidecars)                                        |
| `discover`       | `format`    | `(source, { baseDir }) → string[]`                                          | content loading (list entry files)                                                 |
| `load`           | `format`    | `(path, { schema, directiveOptions }) → ContentLoaderEntry[]`               | content loading (parse one source)                                                 |
| `projectData`    | `project`   | `(sectionValue, { projectConfig, root, registry, io }) → unknown`           | compiler site build, dev server resolve — result stored as `_project[<key>]`       |
| `resolvePaths`   | `project`   | `(pathsDef, { data, projectConfig, root }) → Record<string, unknown>[]`     | pages discovery (`$paths` expansion), studio preview                               |
| `lower`          | any         | `(def, context) → JxStateDefinition`                                        | compiler — rewrites a state def into a core shape for client output                |
| `emit`           | `project`   | `(sectionValue, { projectConfig, root, sections, routes }) → EmitFile[]`    | compiler site build — writes derived assets into the build output (§8.4)           |
| `assets`         | `project`   | `(sectionValue, { projectConfig, root }) → AssetMount[]`                    | compiler site build, dev server — publishes source directories at site URLs (§8.5) |
| `mount`          | `server`    | `(options, ctx) → (request: Request, env) => Promise<Response>`             | generated site worker, dev server                                                  |
| `dialect`        | `connector` | `(connection, env) → Kysely Dialect`                                        | data mounts, auth, deploy                                                          |
| `deploySchema`   | `connector` | `(tables, connection, { env, dryRun }) → { statements, applied, warnings }` | `jx db push`, studio push                                                          |
| `bindings`       | `connector` | `(connection) → wrangler config fragment`                                   | scaffolding, `jx db push`                                                          |
| `testConnection` | `connector` | `(connection, env) → { ok, error? }`                                        | studio connections UI, CLI                                                         |

`resolvePaths` methods declare a `"discriminator"` — the `$paths` key that
routes to them (parser: `contentType`). Hosts dispatch on which discriminator
key is present in the `$paths` value. A connector `table` discriminator
(dynamic-table-driven page paths) is **planned**; no connector descriptor
declares one today — `contentType` is the only registered discriminator.

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

A lowered def may carry a `$bundle: string[]` key naming client modules it
depends on (typically `npm:` specifiers, e.g. a browser client the def
dynamic-imports). The compiler registers each specifier with the sidecar
bundler (spec.md §5.3 "Compiled-site delivery") and strips `$bundle` from the
def — it is host metadata, never part of the emitted core shape. The def
obtains its bundle URL from the shared deterministic mapping
(`@jxsuite/schema/asset-paths` `sidecarAssetPath`), so extension and compiler
agree on the path without coordination at lower time.

### 8.4 `emit`

`emit` lets a section-owner class contribute derived build artifacts — search
indexes, feeds, export manifests — to the compiled site:

```
emit(sectionValue, { projectConfig, root, sections, routes })
  → { path: string, content: string | Uint8Array }[]
```

- **Timing** is `["compiler"]`; the site build invokes it after routes,
  components, and the worker are generated, before redirects and the
  `public/` copy.
- **Gating**: when the class owns a project section (`project.key`), `emit`
  runs only if the project declares a non-empty value for that key — the same
  gating as section loading and server mounts. Classes without a `project`
  block always run.
- **The host writes the files.** `path` is outDir-relative (a leading `/` is
  tolerated); the host creates directories, guards against path traversal
  (a path escaping the build output is a build error), and counts the files
  in the build summary. Extensions return data and never touch the
  filesystem, keeping `emit` pure and testable.
- **Errors** from one emitter are collected like route errors — they fail the
  build report without aborting other emitters. Files earlier in a returned
  batch are already written when a later path is rejected.
- **Ordering**: the `public/` copy runs after `emit`, so a same-named file in
  `public/` shadows an emitted file — the same semantics as `sitemap.xml`.
- **Context**: `sections` holds the loaded project sections (e.g. the
  parser's content collections keyed by collection name), `routes` the
  expanded route table. Emitters derive their output from this loaded data
  rather than re-reading source files.

### 8.5 `assets`

> **Status: Implemented.**

`assets` publishes a directory the section already reads from at a site URL,
so files that live beside a section's sources — an external content
collection's co-located images, most of all — resolve for every host:

```
assets(sectionValue, { projectConfig, root }) → { urlPrefix: string, dir: string }[]
```

A returned pair is an **asset mount**: `urlPrefix` is a site-absolute URL
prefix (a leading slash is added if missing, a trailing one dropped), `dir`
the absolute directory it maps onto. `dir` may sit outside the project root —
that is the point: a `content` source of `../../docs` is unreachable by every
other path the host knows.

- **Timing** is `["compiler", "server"]`, and the call is a pure function of
  the section's configuration — no loaded entries, no filesystem walk beyond
  checking that a source directory exists. Hosts may call it per build, per
  project-context load, or per request.
- **Gating** matches `emit`: a class owning a project section contributes only
  when the project declares a non-empty value for that key.
- **Prefix exclusivity**: two mounts may share a `dir`, but a `urlPrefix`
  claimed for two different directories is a configuration error, reported
  like a route error. The first declaration wins.
- **URL mapping** is deterministic and hash-free, shared by every host through
  `@jxsuite/schema/asset-paths` (`assetUrlFor`, `resolveAssetUrl`,
  `collectAssetUrls`). Reverse mapping decodes a URL exactly once, refuses a
  still-encoded dot or slash, and refuses `.`/`..` and empty segments, so a
  mounted URL can never escape its directory.

Hosts consume mounts in three places:

- **The site build** resolves mounted URLs while optimizing images (so a
  mounted image gets the same `srcset` treatment as one in `public/`), scans
  its compiled HTML and CSS for mounted URLs, and copies **only the
  referenced files** into the build output at their URL path. Entry files
  beside them never reach `dist/`. A referenced URL with no file behind it is
  reported as a warning, not a build error. The copy runs after `emit` and
  before the `public/` copy, so `public/` still shadows.
- **The dev and desktop servers** serve mounts ahead of the project root and
  `public/`, each contained against its own `dir` — so a preview renders the
  same URLs the built site will.
- **`jx preview`** needs nothing: it serves `dist/`, where the files already
  are.

Statically referenced assets are the contract. A `src` a page computes at
runtime cannot be discovered by the build scan, so those files belong in
`public/`.

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

### 11.1 Section-owner `deploySchema` (push contributions)

A **non-connector** `project` class may also declare a `deploySchema`
capability, letting its section contribute steps to the schema push
(`jx db push`, the studio push button). The signature differs from the
connector variant — there is no single connection def to hand over:

```
deploySchema(sectionValue, projectConfig, { env, dryRun?, connection?, connectors? })
  → { steps, applied, warnings, connection }
```

`steps` are ready push-plan entries (`{ kind, table?, summary, sql?,
connection? }`); hosts append them **after** the connector plan and default
each step's `kind` to the contributing section key — the auth extension's
Better Auth system-table migration lands as `kind: "auth"` steps this way.
`connectors` carries the same provider stand-ins the mounts receive, so dev
pushes hit the `local:` stand-in databases. When a push is filtered to a
`connection` the section does not live on, the capability returns empty
steps. Hosts stay extension-agnostic: registry dispatch only, no extension
imports, no hardcoded section names.

---

## 12. The `connector` block

A class provides database connections iff it has a top-level `connector`
object plus the connector capabilities (§8):

```json
"connector": {
  "provider": "d1",
  "kind": "sqlite",
  "local": "sqlite",
  "serve": "@jxsuite/connector/worker",
  "module": "@jxsuite/connector/d1"
}
```

| Key        | Meaning                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` | Identifier for the backing service (`d1`, `supabase`, `sqlite`).                                                                                                                                                                                                                                                                                        |
| `kind`     | SQL dialect family: `"sqlite"` \| `"postgres"`. Consumed by dependents needing a dialect type (e.g. auth).                                                                                                                                                                                                                                              |
| `local`    | When `"sqlite"`, the dev server stands this connector in with a local SQLite file (auto-synced on first use).                                                                                                                                                                                                                                           |
| `serve`    | The data-mount module serving this connector's tables.                                                                                                                                                                                                                                                                                                  |
| `module`   | Bare import specifier for the provider's implementation. The generated site worker imports the provider class from it statically (`import { D1 } from "@jxsuite/connector/d1"`) and hands it to mounts via `options.connectors`; required for a deployable build when any section entry names this `provider` (Workers cannot import filesystem paths). |

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
2. **Table** — the section class declares a section-owner `deploySchema`
   capability (§11.1) contributing the guestbook table's migration steps
   (columns `name`, `message`) to `jx db push` — the same channel the auth
   extension uses for its Better Auth system tables; the steps land as
   `kind: "guestbook"` in the push plan.

   > **Open design note.** There is no registry hook yet by which a
   > non-connector section could _materialize_ a `data`-section table
   > definition — one that would ride the connector's own DDL sync,
   > standard data mount, and permission rules (`permissions: { read:
"public", insert: "authenticated" }`) without declaring its own
   > `deploySchema`. Until that hook is designed, the section-owner
   > `deploySchema` channel is today's supported mechanism for
   > extension-owned tables.

3. **Mount** — a `server` block (`/_jx/guestbook`, order 30) with a `mount`
   returning a fetch handler that reads `ctx.auth` for session lookups and
   performs moderated guestbook reads/writes against the connection through
   the shared connector providers (`options.connectors`).
4. **Page** — a form posting via a lowered `TableInsert` action; a
   `TableQuery` state entry listing approved entries.

A project adds `"@acme/jx-guestbook"` to `extensions`, runs `jx schema && jx
db push`, and has a moderated, auth-gated guestbook — with project.json
validation, a studio settings section, and dev-server parity, none of it
requiring changes to any core package.

## Changelog

- **0.3.3-draft** (2026-07-25) — Composition is host-agnostic: one pure function with an injected loader, so the cloud session composes the same entry documents in-Worker with no filesystem (§5.5).
- **0.3.2-draft** (2026-07-25) — $schema bindings must be satisfied by by-id registration, never fetching — an in-document $schema overrides fileMatch and an unresolvable one voids validation entirely (§5.4).
- **0.3.1-draft** (2026-07-25) — $paths validates against the source union instead of accepting any object (§5.3).
- **0.3.0-draft** (2026-07-25) — Committed entry documents are single-resource: every $ref a root pointer (§5.2, §5.4).
- **0.2.9-draft** (2026-07-24) — §2 package layout: correct the auth package description, note that /_jx/auth serves the Better Auth routes while table permission rules are enforced at /_jx/data, and add the missing search extension to the tree.
- **0.2.8-draft** (2026-07-23) — Add the assets capability (§8.5): section owners publish source directories at site URLs.
- **0.2.7-draft** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.2.6-draft** (2026-07-22) — Machine-readable spec status vocabulary + generated status page (`79daba23`).
- **0.2.5-draft** (2026-07-22) — Align specs and docs with the bundled-schema validation contract (`ae861ff6`).
- **0.2.4-draft** (2026-07-17) — Sidecar bundling, extension emit capability, heading anchors (`07e28bc3`).
- **0.2.3-draft** (2026-07-17) — Align spec.md, site-architecture, desktop, server, extensions with reality (`c61ba567`).
- **0.2.2-draft** (2026-07-11) — Better Auth extension — sessions, permissions, auth-gated data (`bf472285`).
- **0.2.1-draft** (2026-07-08) — Shipped schema fragments + per-project schema emitters (`9e4a8936`).
- **0.2.0-draft** (2026-07-08) — Extensions v2 framework + docs (`3fb8795f`).
- **0.1.0-draft** (2026-06-10) — Consolidate markdown and csv handling to the parser package (`8b1ba6da`).

---

_Jx Extensions Specification v0.3.3-draft_
