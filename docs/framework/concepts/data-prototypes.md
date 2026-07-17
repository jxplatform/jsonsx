---
title: "Data prototypes"
description: "The $prototype model in Jx: built-in Web-API data sources, content collections, external classes with .class.json, and import maps."
spec:
  - spec.md#11
  - spec.md#12
---

# Data prototypes

> **Studio writes this format for you.** The source editors in the State panel ([Data sources](/docs/studio/logic/data-sources)) generate these entries field by field — this page documents the underlying model.

A `$prototype` entry declares where a state value comes from instead of what it is. The prototype names a class — a built-in Web-API wrapper, a content loader, or your own — and the entry's remaining keys are its configuration. The resolved value is reactive: when the source changes, everything bound to it updates.

The smallest complete data prototype — an HTTP request whose URL tracks another state value:

```json
{
  "state": {
    "userData": {
      "$prototype": "Request",
      "url": "/api/users/",
      "urlParams": { "$ref": "#/state/userId" },
      "method": "GET"
    }
  }
}
```

## Built-in Web-API prototypes

These resolve automatically, with no imports or `$src`, and each maps to a genuine Web API:

- `Request` — HTTP fetch with reactive URL parameters, debouncing, and manual mode.
- `LocalStorage` — a persistent key-value entry that survives closing the browser.
- `SessionStorage` — the same, scoped to the visit.
- `Cookie` — a cookie with `maxAge`, `path`, `domain`, `secure`, and `sameSite`.
- `IndexedDB` — a browser database store with indexes and CRUD helpers.
- `FormData` — form fields assembled for submission.
- `URLSearchParams` — a computed query string.
- `Set` / `Map` — reactive wrappers over the corresponding collections.
- `Blob` — binary data from parts and a MIME type.
- `Array` — a reactive array driving a [mapped list](/docs/framework/concepts/lists).

Field-level documentation for each source lives in [Data sources](/docs/studio/logic/data-sources). A storage entry is as small as:

```json
{
  "theme": { "$prototype": "LocalStorage", "key": "theme", "default": "light" }
}
```

## Content prototypes

Content loaders are built in too, and resolve at build time (`timing: "compiler"` — see [Timing](/docs/framework/concepts/timing)):

- `MarkdownFile` — parses one `.md` file into frontmatter and a content tree.
- `MarkdownCollection` — globs and parses many `.md` files.
- `ContentCollection` — a schema-validated, multi-format content source.
- `ContentEntry` — a single entry within a collection.

```json
{
  "posts": {
    "$prototype": "MarkdownCollection",
    "src": "./content/posts/*.md",
    "timing": "compiler"
  }
}
```

These names map internally to `.class.json` implementations shipped with Jx — no configuration needed.

## External classes

Any other prototype name is an **external class**. Its `$src` must point to a `.class.json` file — a JSON Schema document describing the class's parameters, fields, and methods, optionally delegating to a JS module via `$implementation`:

```json
{
  "forecast": {
    "$prototype": "WeatherForecast",
    "$src": "./lib/WeatherForecast.class.json",
    "location": "Lancaster, PA",
    "days": 5
  }
}
```

The class contract is small: the constructor receives one configuration object (the entry minus reserved keys), and the value resolves through `instance.resolve()` (async), then `instance.value`, then the instance itself. A class may also expose `subscribe`/`unsubscribe` for push updates, and its methods may declare `returns` schemas so tooling knows, for example, that instances can feed mapped iteration. Authoring your own `.class.json` classes is covered in depth in the Extending section.

## Import maps

To avoid repeating `$src` on every entry, declare a top-level `imports` map from prototype names to `.class.json` paths:

```json
{
  "imports": {
    "WeatherForecast": "@acme/weather/WeatherForecast.class.json",
    "GeoLocation": "./lib/GeoLocation.class.json"
  },
  "state": {
    "forecast": { "$prototype": "WeatherForecast", "location": "Lancaster, PA" },
    "coords": { "$prototype": "GeoLocation", "address": "123 Main St" }
  }
}
```

`imports` in `site.json` cascade to every page; page-level entries win on collision, and an explicit `imports` entry may even override a built-in prototype mapping.

## How it works

The scope builder injects any import-mapped `$src`, constructs the class with the entry's configuration, and wraps the resolved value in a reactive reference automatically. Resolution order for `$src` is: explicit `$src` → page `imports` → site `imports` → built-in mappings → unknown-prototype warning. Configuration values that are `$ref`s are reactive — a `Request` whose `urlParams` reference state re-fetches when that state changes. The `timing` field decides where resolution happens: in the browser, on the server, or at build time — see [Timing](/docs/framework/concepts/timing).

## Rules

- A non-Function `$src` **must** point to a `.class.json` file — direct `.js` sources are for `$prototype: "Function"` only (see [Functions and sidecars](/docs/framework/concepts/functions)).
- Reserved keys (`$prototype`, `$src`, `$export`, `timing`, `default`, `description`) are never passed to the constructor.
- Import-map values must end in `.class.json`; anything else is warned about and skipped.
- An entry's own `$src` always beats the import map.
- Built-in prototypes need no `imports` entry and are unaffected by the map unless explicitly overridden.

## Related

- [Timing](/docs/framework/concepts/timing) — client, server, and compiler resolution
- [State](/docs/framework/concepts/state) — the grammar prototypes live inside
- [Lists](/docs/framework/concepts/lists) — iterating over a source's resolved array
- [Reactivity](/docs/framework/concepts/reactivity) — how resolved values propagate
- [Data sources in Studio](/docs/studio/logic/data-sources) — every field, source by source
- [Data explorer in Studio](/docs/studio/logic/data-explorer) — inspecting resolved values live
