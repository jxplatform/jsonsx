---
title: "CLI commands"
description: "Reference for bun create @jxsuite and the jx CLI — build, schema, validate, and db push — with every flag as implemented."
spec:
  - extensions.md#5.2 # generated entry documents (jx schema)
  - extensions.md#5.4 # validation (jx validate)
code:
  - packages/create/index.ts
  - packages/create/cli-args.ts
  - packages/create/templates.ts
  - packages/create/generate.ts
  - packages/compiler/bin/jx.js
  - packages/compiler/src/cli.ts
  - packages/compiler/src/site/schema-command.ts
  - packages/compiler/src/site/db-push.ts
---

# CLI commands

Jx has two command-line surfaces: `bun create @jxsuite`, which scaffolds a new project once, and the `jx` CLI, which ships with `@jxsuite/compiler` (a devDependency of every scaffolded project) and operates on an existing project. Every `jx` command takes an optional project root as its first positional argument and defaults to the current directory.

## `bun create @jxsuite`

Scaffold a new Jx project.

```
bun create @jxsuite <directory> [--template <id>]
```

| Flag              | What it does                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--template <id>` | Skip the template prompt. Accepts a built-in template id (`blank`, `desktop-first`, `mobile-first`, `mobile-app`) or a starter id; built-in ids win over starter ids, and an unknown id falls back to `blank`. |

The scaffolder then prompts for a project name, description, production URL, a template (when `--template` wasn't given — the built-in variants plus the starter sites), and a deployment adapter: `static` (default), `cloudflare-pages`, `node`, `bun`, or `cloudflare-workers`.

A blank scaffold produces:

- `project.json` — bound to `./project.schema.json`, with a viewport `$head`, `$media` breakpoints matching the template (desktop-first `max-width` queries or mobile-first `min-width` queries), a `build` block (`outDir: "./dist"`, `format: "directory"`, `trailingSlash: "always"`, plus `adapter` when not static), `extensions: ["@jxsuite/parser"]`, an empty `content` section, base `style`, and `defaults` pointing at `./layouts/base.json`
- `package.json` — `@jxsuite/parser` as a dependency, `@jxsuite/compiler` and `@jxsuite/runtime` as devDependencies, and `build`/`dev` scripts (plus a `deploy` script and `wrangler` for the Cloudflare adapters)
- `layouts/base.json`, `pages/index.md`, empty `components/`, `content/`, and `public/` directories, and a `.gitignore`
- `wrangler.jsonc` for the Cloudflare adapters; the `mobile-app` template overlays an app-shell layout and home page

Choosing a starter instead copies the starter site verbatim (minus build artifacts), then re-stamps `project.json` with your name, URL, description, and adapter, and rebuilds `package.json` with current dependency ranges.

## `jx build`

Build the site to the configured `outDir` (default `dist/`). See [How compilation works](/docs/framework/build) for what happens inside.

```
jx build [root] [--verbose] [--no-clean]
```

| Flag         | What it does                             |
| ------------ | ---------------------------------------- |
| `--verbose`  | Print detailed build progress.           |
| `--no-clean` | Don't remove the output directory first. |

Prints a summary (`Done: 12 routes → 34 files`) on success; lists route errors and exits `1` if any page failed to compile.

## `jx dev`

Start the dev server for a project: builds the site, serves the built pages with live reload (edits rebuild before the browser refreshes), and exposes the Studio backend API. Requires [Bun](https://bun.sh) and `@jxsuite/server` in the project's devDependencies — both part of every scaffolded project; `jx dev` prints an install hint when either is missing.

```
jx dev [root] [--port <n>]
```

| Flag         | What it does                        |
| ------------ | ----------------------------------- |
| `--port <n>` | Port to listen on (default `3000`). |

See [The dev server](/docs/framework/build/dev-server) for what runs underneath.

## `jx preview`

Serve an already-built `dist/` directory — a dependency-free static server for checking the production build locally. Run `jx build` first.

```
jx preview [root] [--port <n>]
```

| Flag         | What it does                        |
| ------------ | ----------------------------------- |
| `--port <n>` | Port to listen on (default `4173`). |

Directory URLs map to their `index.html` (with or without a trailing slash) and `404.html` is served for missing routes when present.

## `jx schema`

Generate the project's JSON Schema entry documents — `project.schema.json` and `document.schema.json` — by composing the core schemas with the fragments shipped by each extension in `project.json`'s `extensions`. The outputs are written into the project root as committed, **self-contained** artifacts: the core and fragment resources are embedded under `$defs` keyed by their canonical `$id`s, so editors resolve them offline with no `node_modules`, network, or editor configuration. No flags.

```
jx schema [root]
```

Re-run it whenever you change the `extensions` list so editors and `jx validate` see the current schema.

## `jx validate`

Validate the whole project tree (run `jx schema` first). No flags.

```
jx validate [root]
```

Checks, in order: `project.json` against the generated `project.schema.json`; that both committed entry documents are self-contained (no relative `$ref`s — otherwise it asks you to regenerate with `jx schema`); every document under `components/`, `pages/`, and `layouts/` against the bundled document schema; every project-local `*.class.json` against the class schema; and each enabled extension's schema fragments compile standalone.

Prints `Project is valid (N files checked)` on success; otherwise lists each file's violations with their instance paths and exits `1`.

## `jx db push`

Additively sync the tables declared in `project.json`'s `data` section to their `connections` databases, through each connection's connector. Credentials come from the environment merged with the project's `.dev.vars` file. After a real (non-dry-run) apply, each connector's binding fragments are merged into `wrangler.jsonc`, preserving your keys.

```
jx db push [root] [--dry-run] [--connection <name>]
```

| Flag                  | What it does                                     |
| --------------------- | ------------------------------------------------ |
| `--dry-run`           | Print the SQL statements without executing them. |
| `--connection <name>` | Restrict the push to one `connections` entry.    |

The sync is additive-only — it creates missing tables and columns and never drops or rewrites existing ones. Per-connection output lists the tables, statements, and warnings; a missing `connections` section or an unknown connection name is an error.

## What the scaffolded scripts run

| Script                     | Runs                                             |
| -------------------------- | ------------------------------------------------ |
| `bun run build`            | `jx build`                                       |
| `bun run dev`              | `jx dev`                                         |
| `bun run preview`          | `jx preview`                                     |
| `bun run deploy` (CF only) | `wrangler deploy` / `wrangler pages deploy dist` |

## Related

- [How compilation works](/docs/framework/build) — what `jx build` produces and why
- [The dev server](/docs/framework/build/dev-server) — local development without a build
- [Site architecture](/docs/framework/site) — the project layout these commands operate on
