---
title: "Project sections and settings"
description: "Owning a project.json section: the project block, projectData and resolvePaths capabilities, and contributing a settings section to Studio."
spec:
  - extensions.md#9
  - extensions.md#9.1
  - extensions.md#8.5
code:
  - extensions/parser/src/Content.class.json
  - extensions/auth/src/Auth.class.json
---

# Project sections and settings

A project section is a top-level `project.json` key owned by an extension class — `content` (parser), `connections` and `data` (connector), `auth` (auth). Owning a section means three things: your fragment defines its schema, your capabilities load it and expand its `$paths`, and your `$studio` block gives it a settings page. A class claims a section iff its descriptor has a top-level `project` object.

## The `project` block

The parser's `Content.class.json` declares, verbatim:

```json
"project": {
  "key": "content",
  "title": "Content Types",
  "description": "File-based content collections loaded at build and dev-serve time",
  "referenceable": true
}
```

| Key             | Type      | Default | Meaning                                                                                                                   |
| --------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `key`           | `string`  | —       | The project.json top-level property this class owns (single word by convention; exclusive across extensions).             |
| `title`         | `string`  | —       | Studio label.                                                                                                             |
| `description`   | `string`  | —       | Studio help text.                                                                                                         |
| `referenceable` | `boolean` | `false` | Opts the section's named entries into the relationships vocabulary ([Relationships](/docs/framework/site/relationships)). |

The section's **value schema is not duplicated here** — it lives in the package's project fragment (the manifest's `schemas.project`, see [Schema composition](/docs/extending/extensions/schema-composition)). Hosts that need the entry shape — Studio settings forms, reference pickers — read `properties[<key>]` from the fragment via the registry.

## Loading section data: `projectData`

Behavior attaches through [capability methods](/docs/extending/extensions/capabilities) on the same class. The `projectData` capability turns the raw section value into loaded data:

```
projectData(sectionValue, { projectConfig, root, registry, io }) → unknown
```

The compiler's site build and the dev server's resolve path both call it, storing the result as `_project[<key>]` in resolved scope — so the parser's `projectData` loads every content type through the format registry and pages see the entries as `config._project.content`. The auth extension's `projectData` is nearly a passthrough: it exposes the section's identifiers under `_project.auth` (never secrets).

## Expanding routes: `resolvePaths` and discriminators

A dynamic route's `$paths` value is dispatched to the section class whose `resolvePaths` capability declares the matching **discriminator** — the key that routes to it. The parser's discriminator is `contentType`, so this page head:

```json
{ "$paths": { "contentType": "blog", "param": "slug" } }
```

dispatches to `Content.resolvePaths(pathsDef, { data, projectConfig, root })`, which returns one route-param object per entry (`[{ "slug": "hello-world" }, …]`). Hosts dispatch purely on which discriminator key is present — no central switch statement, no extension aware of any other. The contributed `$paths` shape is also what your document fragment unions into the paths schema resource, so editors validate it. See [Routing](/docs/framework/site/routing) for the authoring side.

## Publishing files: `assets`

If your section reads from directories, the `assets` capability publishes them at a site URL so the files beside its sources are reachable:

```
assets(sectionValue, { projectConfig, root }) → [{ urlPrefix: "/content/blog", dir: "/abs/content/blog" }]
```

The parser returns one mount per content type with a directory source. The site build resolves those URLs for image optimization and copies the referenced files into `dist/`; the dev server serves them from the source. That is what makes a collection's co-located images work — including when the source lives outside the project. Details in [Capability methods](/docs/extending/extensions/capabilities).

## Studio settings: `$studio.settings`

The section class's `$studio` block may declare a settings section, rendered generically by Studio under _Settings_. The auth extension's, verbatim:

```json
"$studio": {
  "settings": {
    "icon": "sp-icon-lock-closed",
    "label": "Authentication",
    "order": 58,
    "layout": "form",
    "entry": {
      "ui": {
        "connection": { "enum": { "$ref": "#/$context/connections" } },
        "secretEnv": { "control": "secret" }
      }
    }
  }
}
```

| Key              | Meaning                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `icon`           | Section icon in the settings nav.                                                                                                                                          |
| `label`          | Section label (defaults to `project.title`).                                                                                                                               |
| `order`          | Sort position among contributed sections.                                                                                                                                  |
| `layout`         | `"form"` (default) — one form over the whole section value. `"map"` — master-detail for `type: object` + `additionalProperties` sections: key list left, entry form right. |
| `entry.ui`       | Per-field control overrides for the entry form: `{ "<field>": { "control": "<name>" } }`.                                                                                  |
| `entry.newEntry` | Template for freshly created entries, with `${key}` substitution.                                                                                                          |
| `renderer`       | Escape hatch: names a Studio-registered custom section renderer. First-party extensions use the generic path.                                                              |

Everything else — field labels, types, required marks — comes from the project fragment's schema for the section, so the form stays in sync with validation for free.

The parser's `Content` class shows the `map` layout: its section is a map of content types, so Studio renders a key list (add/rename/delete, slugified) beside an entry form, seeds new entries from `entry.newEntry` (`"source": "./content/${key}/"` — `${key}` becomes the new entry's name), and swaps the `schema` field for the visual `schema-builder` control. That is the entire implementation of the [Content types](/docs/studio/projects/content-types) surface — no parser-specific Studio code exists.

### Controls and dynamic enums

Built-in controls you can name in `entry.ui`:

- `"schema-builder"` — the visual JSON-Schema field editor.
- `"secret"` — the value is committed via the platform's secret store, **never** project.json.
- `"binding"` — signal/route-param binding.
- Implicit defaults per type, enum, and format cover everything else.

Enum choices may be dynamic via `{ "$ref": "#/$context/<pointer>" }` — a JSON-pointer walk over the project config (with `{@param}` segment substitution and the `$formats` virtual root). Auth's `connection` field above lists the keys of the project's `connections` section; `#/$context/auth/roles` would list configured roles.

:::doc-warning
Secrets never enter `project.json`. Committed config carries identifiers and env-var _names_ only (`"secretEnv": "BETTER_AUTH_SECRET"`); the `secret` control writes actual values to the platform's secret store, and locally they live in the git-ignored `.dev.vars`. See [Security and secrets](/docs/extending/extensions/security).
:::

## Related

- [Schema composition](/docs/extending/extensions/schema-composition) — where the section's value schema lives
- [Capability methods](/docs/extending/extensions/capabilities) — `projectData` and `resolvePaths` contracts
- [Server mounts](/docs/extending/extensions/server) — giving a section a route subtree
- [Project settings in Studio](/docs/studio/projects/settings) — what users see
