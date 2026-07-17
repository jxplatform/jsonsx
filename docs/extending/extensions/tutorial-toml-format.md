---
title: "Tutorial: a TOML format extension"
description: "Build a third-party format extension end to end: package, manifest, class descriptor, parse and content capabilities, and .toml content in a project."
spec:
  - extensions.md#14
  - extensions.md#7
  - extensions.md#8
code:
  - extensions/parser/src/Markdown.class.json
  - extensions/parser/src/Csv.class.json
---

# Tutorial: a TOML format extension

By the end of this tutorial you have `@acme/jx-toml`, a standalone npm package that teaches every Jx host — build, dev server, Studio, runtime — to treat `.toml` files as content, with **no changes to any core package**. It is the worked example from the extensions spec, built step by step. Plan on about half an hour.

**Prerequisites**: you have read [The anatomy of an extension](/docs/extending/extensions/anatomy) and [Formats](/docs/extending/extensions/formats), and you have a Jx site project to test against ([Your first project](/docs/start/first-project)).

## 1. Scaffold the package

Create a package with a `jx` field pointing at the manifest, and export the manifest and class descriptor alongside the code:

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

The `"jx"` field is how hosts find the manifest; the `exports` entries make the JSON files importable by path, which matters once the package is consumed from `node_modules`.

## 2. Write the manifest

`jx-extension.json` at the package root enumerates what the package provides — here, a single class:

```json
{
  "name": "@acme/jx-toml",
  "title": "TOML",
  "classes": { "Toml": "./src/Toml.class.json" }
}
```

The manifest is pure data: it names things, and behavior lives in the class descriptors it points to. The class key `Toml` becomes the `$prototype`-visible name in every project that enables the extension.

## 3. Declare the format class

`src/Toml.class.json` is an ordinary Jx class descriptor. Its top-level `format` block is the [admission block](/docs/extending/extensions/classes) that puts it into file-extension dispatch:

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
  }
}
```

`documentKinds: ["content"]` admits `.toml` as a content-collection source only — it does not enter pages/components discovery the way the parser's Markdown format does.

:::doc-note
`$implementation` says `./toml.js` while the source file is `toml.ts` — the TypeScript convention of importing by emitted name. The first-party classes do the same (`Markdown.class.json` points at `./markdown.js`); Bun resolves it to the `.ts` source.
:::

## 4. Declare the constructor and runtime access

Next, the class's `$defs` describe its instance surface — the standard external-class contract of a `config`-taking constructor plus an instance `resolve()`:

```json
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
    }
  }
}
```

This is what makes `{ "$prototype": "Toml", "src": "./x.toml" }` work as a state entry at runtime.

## 5. Declare the parse capability

[Capability methods](/docs/extending/extensions/capabilities) are static methods declared by well-known `role` values, alongside `resolve` in `$defs.methods`:

```json
"parse": {
  "role": "parse",
  "scope": "static",
  "identifier": "parse",
  "timing": ["compiler", "server", "client"],
  "parameters": [{ "identifier": "source", "type": { "type": "string" } }],
  "returnType": { "type": "object" }
}
```

`timing` includes `"client"` because TOML parsing needs no filesystem — declaring it lets Studio parse in-process instead of round-tripping through the dev server.

## 6. Declare the content capabilities

`discover` lists entry files for a content source; `load` parses one source into entries. Both are node-only, so `timing` stops at `"server"`:

```json
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
```

## 7. Implement the statics

The spec leaves `src/toml.ts` to you, and so does this tutorial — the contract is the interesting part. Per the [host introspection contract](/docs/extending/extensions/anatomy), hosts import `$implementation` and take the export named by the class `title`: so `toml.ts` must export a `Toml` object (or class) whose static methods carry the declared identifiers — `parse` turning TOML source into an object with any TOML library, `discover` globbing `.toml` files under the source directory, `load` reading one file into content entries, and instance `resolve()` for runtime state access.

If you later want Studio saves or export sidecars for your format, add a `serialize` capability the same way — the parser's `Markdown.class.json` declares one; this example, like the spec's, elides it.

## 8. Use it in a project

A project enables the extension with one line, then names the format on a content type:

```json
{
  "extensions": ["@jxsuite/parser", "@acme/jx-toml"],
  "content": {
    "settings": { "source": "./content/settings/", "format": "Toml" }
  }
}
```

(`@jxsuite/parser` stays in the list because the `content` section itself belongs to it — your package contributes only the format.)

Run `jx schema` to regenerate the project's entry schema documents. This extension ships no [schema fragment](/docs/extending/extensions/schema-composition) — it contributes no `project.json` section — but the generator still picks up the class, so `"format": "Toml"` validates in the regenerated format-name enum.

You should now see the whole surface light up: the content loader discovers and loads `.toml` entries through your class, `ContentCollection`/`ContentEntry` queries work unchanged, pages can declare `{ "$prototype": "Toml", "src": "./x.toml" }` state for runtime access, and Studio lists `.toml` files (add a `$studio` block to the descriptor to refine its icon and editing modes).

## What you built

One package, three JSON files, and one implementation module: a manifest naming a class, a descriptor whose `format` block and capability roles tell every host what the class can do, and statics the hosts invoke — with no host knowing anything TOML-specific.

## Next steps

- [Tutorial: a guestbook extension](/docs/extending/extensions/tutorial-guestbook) — the same pattern extended to project sections, tables, and a server mount.
- [Formats](/docs/extending/extensions/formats) — everything the `format` block can declare, including `exportTarget` and `remote`.
- [Content collections](/docs/framework/site/content-collections) — the user-facing model your format now feeds.
