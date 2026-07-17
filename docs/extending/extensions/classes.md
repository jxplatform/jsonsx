---
title: "Custom classes"
description: "Writing .class.json descriptors: the external class contract, $implementation, admission blocks, host introspection, and capability methods."
spec:
  - extensions.md#6
  - extensions.md#6.1
  - spec.md#12.3
  - spec.md#12.4
  - compiler.md#5
code:
  - extensions/parser/src/Markdown.class.json
  - packages/schema/src/extension-registry.ts
---

# Custom classes

An extension's classes are ordinary Jx `.class.json` descriptors: JSON Schema 2020-12 documents that describe a class — its constructor parameters, fields, and methods — with an optional `$implementation` key pointing at the JavaScript module that implements it. Hosts read the descriptor to learn everything about the class; they import the implementation only to invoke it.

Each class named in the [manifest](/docs/extending/extensions/anatomy)'s `classes` map becomes a `$prototype`-visible name in any project that enables the extension. A page can then use it as state with no `$src`:

```json
{
  "state": {
    "about": { "$prototype": "Markdown", "src": "./content/about.md" }
  }
}
```

## A descriptor at a glance

The parser's `Markdown.class.json`, heavily abbreviated:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Markdown",
  "$prototype": "Class",
  "extends": "Object",
  "$implementation": "./markdown.js",
  "format": { "extensions": [".md"], "mediaType": "text/markdown", "…": "…" },
  "$defs": {
    "parameters": {
      "src": { "identifier": "src", "type": { "type": "string" } },
      "…": {}
    },
    "constructor": {
      "role": "constructor",
      "parameters": [{ "$ref": "#/$defs/parameters/src" }, "…"],
      "body": ["this.config = config;"]
    },
    "methods": {
      "resolve": { "role": "method", "scope": "instance", "identifier": "resolve" },
      "parse": { "role": "parse", "scope": "static", "timing": ["compiler", "server", "client"] },
      "serialize": { "role": "serialize", "scope": "static", "…": "…" },
      "…": {}
    }
  }
}
```

The `$defs` object is organized into well-known categories:

| Category      | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `parameters`  | Constructor parameter properties (config object fields)                  |
| `fields`      | Instance fields (private if `#`-prefixed)                                |
| `constructor` | Constructor body and super args                                          |
| `methods`     | Instance methods and accessors, plus static capability methods by `role` |
| `returnTypes` | Named return-type schemas for tooling                                    |

## The external class contract

Every class — extension-shipped or project-local — satisfies the same runtime contract:

- **Constructor** receives a single `config` object containing all `state` properties except the reserved keywords (`$prototype`, `$src`, `$export`, `timing`, `default`, `description`). For the state entry above, `config` is `{ src: "./content/about.md" }`.
- **Value resolution** is checked in order: `instance.resolve()` (async, awaited) → `instance.value` (getter or property) → the instance itself.
- **Reactivity is optional**: implement `subscribe(callback)` / `unsubscribe()` and the runtime re-renders when you notify.

Methods declare their output shape with a JSON Schema in `returnType` (often a `$ref` into `$defs/returnTypes`). Tooling uses this to reason about a class without executing it — a `resolve` whose `returnType` is an array marks instances as valid sources for mapped iteration, so Studio offers the class in repeater pickers.

## `$implementation`

`$implementation` is resolved relative to the `.class.json` file and names the module exporting the class; the export is named by the descriptor's `title`. The parser ships TypeScript in `src/` and points `$implementation` at the built neighbor (`./markdown.js`).

When `$implementation` is **absent**, the class is self-contained: the compiler generates an ES class from the schema itself — constructor (with `super()` support), private `#fields`, getters/setters, async methods, and the `extends` clause all come from the descriptor. This is how small classes ship with no JavaScript at all; structured `body` statements are covered in [Functions](/docs/framework/concepts/functions).

## Admission blocks

A plain class with nothing but the contract above is a state prototype — construct, `resolve()`, done. A class additionally participates in **host dispatch** through one or more top-level admission blocks:

| Block       | Grants                                                                                      | Covered in                                                      |
| ----------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `format`    | File-extension dispatch: parsing, serialization, content discovery/loading, Studio editing. | [Custom formats](/docs/extending/extensions/formats)            |
| `project`   | Ownership of a project.json section: data loading, `$paths` resolution, Studio settings UI. | [Project sections](/docs/extending/extensions/project-sections) |
| `server`    | A mounted route subtree in the deployed-site worker and the dev server.                     | [Server mounts](/docs/extending/extensions/server)              |
| `connector` | A database connection provider: dialect, schema deploy, bindings, connection testing.       | [Connectors](/docs/extending/extensions/connectors)             |

`Markdown` carries a `format` block; the connector's `Data` class carries `project` **and** `server` (it owns the `data` section and mounts `/_jx/data`). Blocks compose freely on one class.

## How hosts introspect

Hosts follow a strict JSON-first contract — the registry (`buildExtensionRegistry()` in `@jxsuite/schema/extension-registry`) implements it once for node and browser hosts:

1. Resolve each `extensions` entry to a package root; read the manifest named by its `"jx"` field; read each listed `.class.json`.
2. Detect participation via the admission blocks.
3. Find capabilities by scanning `$defs.methods` for well-known `role` values; the method's `identifier` (fallback: its key) names the static method.
4. To invoke: import `$implementation`, take the export named by the class `title`, call `Export[identifier](...args)`.
5. Respect `timing`: if the host's environment is not listed, delegate to the dev server.

Step 4 is the only point where extension code runs in a host. Everything Studio shows — settings forms, format icons, capability option UIs — comes from steps 1–3.

## Capability methods

Capabilities are the static methods step 3 discovers: `parse`, `load`, `projectData`, `mount`, `lower`, and the rest of the well-known roles. Their contract — timing, options-as-parameters, and the compile-away `lower` hook — is the subject of [Capability methods](/docs/extending/extensions/capabilities).

## Related

- [Capability methods](/docs/extending/extensions/capabilities) — the static method contract in depth
- [Custom formats](/docs/extending/extensions/formats) — the `format` admission block
- [Data prototypes](/docs/framework/concepts/data-prototypes) — the built-in classes yours sit beside
- [Tutorial: a TOML format extension](/docs/extending/extensions/tutorial-toml-format) — a full descriptor built from scratch
