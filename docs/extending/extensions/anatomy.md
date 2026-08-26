---
title: "Extension anatomy"
description: "What an extension package contains: layout and dependency rules, the project.json declaration model, section keys, and the jx-extension.json manifest."
spec:
  - extensions.md#2
  - extensions.md#3
  - extensions.md#3.1
  - extensions.md#4
code:
  - extensions/parser/jx-extension.json
  - extensions/parser/package.json
  - packages/schema/src/extension-registry.ts
  - scripts/check-dep-rules.ts
---

# Extension anatomy

Jx documents are JSON. Everything beyond plain JSON enters the system through **extension packages**: Markdown content, dynamic data tables, authentication, whatever you build next. The unit of admission is an npm package (or a local directory) shipping a `jx-extension.json` manifest; a project opts in with one line in `project.json`. The first-party extensions (`@jxsuite/parser`, `@jxsuite/connector`, `@jxsuite/auth`) use only these public hooks, so anything they do, your extension can do.

An extension contributes up to four kinds of things, all declared in JSON before any code runs:

- **Classes**: `.class.json` descriptors that become `$prototype`-visible names ([Custom classes](/docs/extending/extensions/classes)).
- **Formats**: file-extension handling for parsing, saving, and content loading ([Custom formats](/docs/extending/extensions/formats)).
- **Project sections**: top-level `project.json` keys with data loading and Studio settings UI ([Project sections and settings](/docs/extending/extensions/project-sections)).
- **Schema fragments**: JSON Schema documents composed into the project's effective schema ([Schema composition](/docs/extending/extensions/schema-composition)).

## Package layout

The parser is the reference extension, and its layout is the template:

```text
extensions/
  parser/                    # @jxsuite/parser — content collections, markdown, CSV
    package.json             # "jx": "./jx-extension.json"; exports manifest, schemas, classes
    jx-extension.json
    schemas/
      project.fragment.schema.json
      document.fragment.schema.json
    src/
      Markdown.class.json    # class descriptors (admission blocks + capability methods)
      markdown.ts            # implementations
  connector/                 # @jxsuite/connector — connections + dynamic data tables
  auth/                      # @jxsuite/auth — Better Auth sessions and permissions
```

Three files matter to hosts: `package.json` names the manifest in its `"jx"` field, the manifest enumerates classes and schema fragments, and each `.class.json` descriptor declares what its class actually does. Implementation modules (`markdown.ts`) are imported only when a host invokes a declared capability. Discovery is JSON all the way down.

Publish the manifest, descriptors, and fragments: they must appear in `package.json`'s `files` and `exports` so hosts can resolve `<package>/jx-extension.json` through the exports map.

## Dependency rules

In the Jx monorepo, `packages/*` is **core** and `extensions/*` is **extensions**. The arrow between them points one way:

- Extensions may depend on core packages and on each other. `@jxsuite/auth` depends on `@jxsuite/connector` for its database connection.
- Core packages may **never** list an extension in `dependencies`, `peerDependencies`, or `optionalDependencies`, and may never import `@jxsuite/<extension>` from `src/`. `devDependencies` are permitted for test fixtures only. CI enforces this in `scripts/check-dep-rules.ts`.
- Bundling carve-outs are explicit and allowlisted with rationale: `packages/desktop` (an offline app shipped as installers, never published to npm) bundles the first-party extensions. Carve-outs live at the app layer, never in core libraries.

Third-party extensions live outside the monorepo, but the same shape applies: depend on `@jxsuite/*` core packages and other extensions freely; nothing in core will ever know your package exists.

## Declaring extensions in a project

A project enables extensions in `project.json`:

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

- Entries are bare package names or relative paths (for local, unpublished extensions). Package names resolve **project-first**: the project's own `node_modules`, then the host's. Projects own their extension dependencies, so a scaffolded project lists `@jxsuite/parser` in its `package.json`.
- `imports` keeps its original, reduced job: mapping `$prototype` names to **project-local** class files. It does not register formats or extensions.
- **Name visibility**: the manifest's class keys become `$prototype`-visible names. On a collision, a project-local `imports` entry wins over a manifest class; two extensions exporting the same class name is a registry error. Rename via a local wrapper class to disambiguate.
- **No implicit defaults.** A project with no `extensions` supports only `.json` documents and core state prototypes.

## Section keys

Extensions contribute top-level `project.json` keys ("sections"): `content` (parser), `connections` and `data` (connector), `auth` (auth). By convention section keys are single words, and the key is used verbatim as:

- the property name in `project.json`,
- the key under `_project` in resolved scope (`config._project.content`),
- the wire-path segment where applicable.

Two extensions claiming the same section key is a registry error. See [Project sections and settings](/docs/extending/extensions/project-sections) for what owning a section means.

## The `jx-extension.json` manifest

The manifest lives at the package root, referenced by `"jx": "./jx-extension.json"` in `package.json`. The parser's real manifest, in full:

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
| `title`       | `string`                 | Human-readable name for Studio surfaces.                                                                       |
| `description` | `string`                 | One-line description.                                                                                          |
| `classes`     | `Record<string, string>` | `$prototype`-visible name → class descriptor path, relative to the manifest.                                   |
| `schemas`     | `object`                 | Schema fragments this package contributes: `project` (project.json sections), `document` (document positions). |

The manifest is pure data, validated by the generated `extension-manifest.schema.json` from `@jxsuite/schema`. It enumerates; it does not define behavior. That lives in the class descriptors it points to.

:::doc-note
The registry implementing manifest discovery is `buildExtensionRegistry()` in `@jxsuite/schema/extension-registry`, with injected I/O so the identical logic serves node and browser hosts. It also enforces the conflict rules: duplicate class names, duplicate section keys, and overlapping server mounts all fail the registry build with a named error.
:::

## Related

- [Schema composition](/docs/extending/extensions/schema-composition): what the `schemas` fragments contribute
- [Custom classes](/docs/extending/extensions/classes): the descriptors the `classes` map points to
- [Tutorial: a TOML format extension](/docs/extending/extensions/tutorial-toml-format): a complete third-party package, end to end
- [First-party extensions](/docs/extending/extensions/first-party): what parser, connector, and auth each provide
