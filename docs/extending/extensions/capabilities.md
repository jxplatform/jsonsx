---
title: "Capability methods"
description: "The static method contract behind every extension integration point: well-known roles, timing, options as parameters, and the lower compile-away hook."
spec:
  - extensions.md#8
  - extensions.md#8.1
  - extensions.md#8.2
  - extensions.md#8.3
  - extensions.md#8.5
code:
  - packages/schema/src/asset-paths.ts
  - packages/compiler/src/site/asset-mounts.ts
  - extensions/parser/src/Content.class.json
  - extensions/parser/src/Markdown.class.json
  - extensions/connector/src/TableQuery.class.json
---

# Capability methods

Capabilities are how a class's declarations turn into behavior. They are declared in the descriptor's `$defs.methods` using well-known `role` values, and they are all `scope: "static"` — hosts call them on the implementation class without constructing an instance. The instance `resolve()` method remains the runtime's on-demand access path; capabilities serve the build, the servers, and Studio.

## The contract

A capability declaration is an ordinary method entry with a reserved `role`. The parser's `Content` class declares its `$paths` expansion capability like this (abbreviated):

```json
"resolvePaths": {
  "role": "resolvePaths",
  "scope": "static",
  "identifier": "resolvePaths",
  "discriminator": "contentType",
  "timing": ["compiler", "server"],
  "parameters": [
    {
      "identifier": "pathsDef",
      "type": {
        "type": "object",
        "properties": {
          "contentType": { "type": "string" },
          "param": { "type": "string", "default": "slug" },
          "field": { "type": "string", "default": "id" }
        },
        "required": ["contentType"]
      }
    },
    { "identifier": "ctx", "type": { "type": "object" } }
  ],
  "returnType": { "$ref": "#/$defs/returnTypes/PathEntries" }
}
```

To find and invoke a capability, a host scans `$defs.methods` for the `role`, takes the method's `identifier` (fallback: its key) as the static method name, imports `$implementation`, and calls `Export[identifier](...args)`. So the declaration above is fulfilled by `Content.resolvePaths(pathsDef, ctx)` in `content-loader.ts` — a plain exported static method, no framework API to implement.

## The roles

| Role             | Block       | Signature                                                                   | Consumers                                                   |
| ---------------- | ----------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `parse`          | `format`    | `(source, options?) → JxDocument`                                           | compiler, server, Studio (open file)                        |
| `serialize`      | `format`    | `(doc, options?) → string`                                                  | Studio (save), site build (export sidecars)                 |
| `discover`       | `format`    | `(source, { baseDir }) → string[]`                                          | content loading (list entry files)                          |
| `load`           | `format`    | `(path, { schema, directiveOptions }) → ContentLoaderEntry[]`               | content loading (parse one source)                          |
| `projectData`    | `project`   | `(sectionValue, { projectConfig, root, registry, io }) → unknown`           | site build, dev server — result stored as `_project[<key>]` |
| `resolvePaths`   | `project`   | `(pathsDef, { data, projectConfig, root }) → Record<string, unknown>[]`     | pages discovery (`$paths` expansion), Studio preview        |
| `lower`          | any         | `(def, context) → JxStateDefinition`                                        | compiler — rewrites a state def into a core shape           |
| `emit`           | `project`   | `(sectionValue, { projectConfig, root, sections, routes }) → EmitFile[]`    | site build — writes derived assets into the build output    |
| `assets`         | `project`   | `(sectionValue, { projectConfig, root }) → AssetMount[]`                    | site build, dev server — publishes directories at site URLs |
| `mount`          | `server`    | `(options, ctx) → (request, env) => Promise<Response>`                      | generated site worker, dev server                           |
| `dialect`        | `connector` | `(connection, env) → Kysely Dialect`                                        | data mounts, auth, deploy                                   |
| `deploySchema`   | `connector` | `(tables, connection, { env, dryRun }) → { statements, applied, warnings }` | `jx db push`, Studio push                                   |
| `bindings`       | `connector` | `(connection) → wrangler config fragment`                                   | scaffolding, `jx db push`                                   |
| `testConnection` | `connector` | `(connection, env) → { ok, error? }`                                        | Studio connections UI, CLI                                  |

`resolvePaths` methods additionally declare a `discriminator` — the `$paths` key that routes to them. The parser's is `contentType`, so a page with `"$paths": { "contentType": "blog" }` dispatches to `Content.resolvePaths`. Hosts dispatch purely on which discriminator key is present in the `$paths` value; two extensions can coexist without either knowing the other's shape.

The format roles are covered in depth in [Custom formats](/docs/extending/extensions/formats); the project roles in [Project sections and settings](/docs/extending/extensions/project-sections); `mount`, `dialect`, `deploySchema`, `bindings`, and `testConnection` in [Server mounts](/docs/extending/extensions/server) and [Connectors](/docs/extending/extensions/connectors).

## `timing`

Each capability may declare a `timing` array — the environments allowed to invoke it directly:

- Values: `"compiler"`, `"server"`, `"client"`. Default when omitted: `["compiler", "server"]` — assume node-only.
- A host whose environment is excluded round-trips through the dev server (`POST /__studio/format`, `POST /__jx_resolve__`) instead of importing the implementation.
- Capabilities that are browser-safe — no `fs`, `glob`, or node imports anywhere on their code path — should declare `"client"` so Studio can call them in-process. `Markdown.parse` declares all three, which is why typing in Studio's Markdown editor never touches the network; `Markdown.discover` reads the filesystem, so it stays `["compiler", "server"]`.

:::doc-tip
`timing` is per-method, not per-class. Mixed classes are normal: declare `"client"` on the pure-string transforms and let the filesystem-touching ones delegate.
:::

## Options as parameters

Capability options are declared as ordinary `parameters` with JSON-Schema types — there is no separate options vocabulary. `Markdown.serialize` declares its second parameter as:

```json
{
  "identifier": "options",
  "type": {
    "type": "object",
    "properties": {
      "mode": { "type": "string", "enum": ["roundtrip", "export"], "default": "roundtrip" },
      "frontmatter": { "type": "boolean", "default": true }
    }
  }
}
```

Because the types, enums, and defaults are right there in the descriptor, Studio can render an options UI for any extension's capability without host-side knowledge of the extension — an enum becomes a picker, a boolean a toggle, a default the initial value.

## `lower`

`lower` lets a state class compile away. At build time, when a state entry's [timing](/docs/framework/concepts/timing) excludes the compiler, the compiler checks the class descriptor for a `lower` capability and, if present, replaces the def in place with the returned core-shape def (`Request`, `Function`, …). The connector's `TableQuery` declares:

```json
"lower": {
  "role": "lower",
  "scope": "static",
  "identifier": "lower",
  "timing": ["compiler"],
  "parameters": [
    { "identifier": "def", "type": { "type": "object" } },
    { "identifier": "context", "type": { "type": "object" } }
  ],
  "returnType": { "type": "object" },
  "description": "Rewrite into a core Request def targeting /_jx/data"
}
```

A page authored with `{ "$prototype": "TableQuery", "table": "posts", "timing": "client" }` compiles into a plain reactive fetch of `/_jx/data/posts?…` — dynamic-data queries work in compiled sites with **no extension code shipped to the browser**. `lower` may appear on a class with any admission block (or none).

## `assets`

`assets` publishes a directory your section already reads from at a site URL, so the files beside its sources are reachable:

```json
"assets": {
  "role": "assets",
  "scope": "static",
  "identifier": "assets",
  "timing": ["compiler", "server"],
  "parameters": [
    { "identifier": "sectionValue", "type": { "type": "object" } },
    { "identifier": "ctx", "type": { "type": "object" } }
  ],
  "returnType": { "type": "array" }
}
```

Each returned pair is an **asset mount**: `{ "urlPrefix": "/content/blog", "dir": "/abs/path/to/content/blog" }`. The parser returns one per content type with a directory source, which is what lets a Markdown entry reference `./images/hero.png` and still resolve everywhere.

Hosts do three things with a mount, and your extension writes none of them:

- the site build resolves mounted URLs for [image optimization](/docs/framework/site/images), then copies **only the files the compiled output references** to their URL path in `dist/`;
- the dev and desktop servers serve the mount ahead of the project root, so previews match the built site;
- `jx preview` needs nothing — it serves `dist/`, where the files already are.

`dir` may sit outside the project root — that is the point. Return the mount from the section's config alone: the call is expected to be cheap and side-effect-free, and hosts may make it per request. A `urlPrefix` claimed for two different directories is a configuration error; sharing one `dir` across prefixes is fine.

## Related

- [Custom classes](/docs/extending/extensions/classes) — the descriptors capabilities live in
- [Custom formats](/docs/extending/extensions/formats) — the four format roles in context
- [Project sections and settings](/docs/extending/extensions/project-sections) — `projectData` and `resolvePaths` in context
- [Timing](/docs/framework/concepts/timing) — the state-entry timing model `lower` keys off
