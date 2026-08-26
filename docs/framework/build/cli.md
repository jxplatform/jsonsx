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
  - packages/compiler/src/site/validate-command.ts
  - packages/compiler/src/site/db-push.ts
---

# CLI commands

Jx has two command-line surfaces: `bun create @jxsuite`, which scaffolds a new project once, and the `jx` CLI, which ships with `@jxsuite/compiler` (a devDependency of every scaffolded project) and operates on an existing project. Every `jx` command takes an optional project root as its first positional argument and defaults to the current directory.

## `bun create @jxsuite`

Scaffold a new Jx project.

```bash
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

The new project is always writable, whatever permissions the templates themselves carry. Templates are copied from wherever `@jxsuite/create` and `@jxsuite/starters` are installed, and a read-only install — every path under `/nix/store` is read-only by construction — would otherwise hand you a project you could not edit, install into, or build.

A scaffold that fails partway cleans up after itself, so a retry sees the destination it expects rather than the debris of the previous attempt. Only what the scaffolder wrote is removed: a directory it created is deleted, a directory that already existed is emptied, and a destination that already had content is refused before anything is written at all.

## `jx build`

Build the site to the configured `outDir` (default `dist/`). See [How compilation works](/docs/framework/build) for what happens inside.

```bash
jx build [root] [--verbose] [--no-clean]
```

| Flag         | What it does                             |
| ------------ | ---------------------------------------- |
| `--verbose`  | Print detailed build progress.           |
| `--no-clean` | Don't remove the output directory first. |

Prints a summary (`Done: 12 routes → 34 files`) on success; lists route errors and exits `1` if any page failed to compile.

## `jx dev`

Start the dev server for a project: builds the site, serves the built pages with live reload (edits rebuild before the browser refreshes), and exposes the Studio backend API. Requires [Bun](https://bun.sh) and `@jxsuite/server` in the project's devDependencies — both part of every scaffolded project; `jx dev` prints an install hint when either is missing.

```bash
jx dev [root] [--port <n>]
```

| Flag         | What it does                        |
| ------------ | ----------------------------------- |
| `--port <n>` | Port to listen on (default `3000`). |

See [The dev server](/docs/framework/build/dev-server) for what runs underneath.

## `jx preview`

Serve an already-built `dist/` directory — a dependency-free static server for checking the production build locally. Run `jx build` first.

```bash
jx preview [root] [--port <n>]
```

| Flag         | What it does                        |
| ------------ | ----------------------------------- |
| `--port <n>` | Port to listen on (default `4173`). |

Directory URLs map to their `index.html` (with or without a trailing slash) and `404.html` is served for missing routes when present.

## `jx schema`

Generate the project's JSON Schema entry documents — `project.schema.json` and `document.schema.json` — by composing the core schemas with the fragments shipped by each extension in `project.json`'s `extensions`. The outputs are written into the project root as committed, **self-contained** artifacts: the core and fragment resources are embedded under `$defs` keyed by their canonical `$id`s, so editors resolve them offline with no `node_modules`, network, or editor configuration. No flags.

```bash
jx schema [root]
```

Re-run it whenever you change the `extensions` list so editors and `jx validate` see the current schema.

## `jx validate`

Validate the whole project tree (run `jx schema` first). No flags.

```bash
jx validate [root]
```

Checks, in order: that both committed entry documents are self-contained (every `$ref` a root-relative JSON Pointer that resolves in the same file — otherwise it asks you to regenerate with `jx schema`, and stops there, since the remaining checks compile those files); `project.json` against the generated `project.schema.json`; every document under `components/`, `pages/`, and `layouts/` against the bundled document schema; every project-local `*.class.json` against the class schema; and each enabled extension's schema fragments compile standalone.

Prints `Project is valid (N files checked)` on success; otherwise lists each file's violations with their instance paths and exits `1`.

:::doc-note
`jx validate` never writes. If an entry document is older than `project.json` it composes a current one in memory for the duration of the run and leaves the committed file exactly as it is — run `jx schema` when you want the file itself updated. A checker that edits what it is checking can report green on bytes it just wrote.
:::

The output shape is meant to be read by whatever wrote the file — a person or a generator: one line naming the file, then one `- <instance path>: <message>` line per violation. Paired with the non-zero exit it drops straight into a write-check-fix loop. Because `jx schema` embeds every core and fragment resource under `$defs` keyed by its canonical `$id`, the document checks resolve from the committed entry documents alone — no network fetch and no module resolution — so an editor's inline squiggles and this command are looking at exactly the same schema.

## `jx db push`

Additively sync the tables declared in `project.json`'s `data` section to their `connections` databases, through each connection's connector. Credentials come from the environment merged with the project's `.dev.vars` file. After a real (non-dry-run) apply, each connector's binding fragments are merged into `wrangler.jsonc`, preserving your keys.

```bash
jx db push [root] [--dry-run] [--connection <name>]
```

| Flag                  | What it does                                     |
| --------------------- | ------------------------------------------------ |
| `--dry-run`           | Print the SQL statements without executing them. |
| `--connection <name>` | Restrict the push to one `connections` entry.    |

The sync is additive-only — it creates missing tables and columns and never drops or rewrites existing ones. Per-connection output lists the tables, statements, and warnings; a missing `connections` section or an unknown connection name is an error.

The CLI talks to each connection exactly as declared: a `d1` connection reaches the real D1 database (through its binding, or the D1 HTTP API with `CLOUDFLARE_API_TOKEN` plus the account and database ids). Studio's **Push Schema** button runs through the dev server, which substitutes a local stand-in for any provider that declares one — so a D1 connection pushed from Studio lands in `.jx/data/<connection>.sqlite`, while the same connection pushed from a terminal lands in D1 itself.

:::doc-warning
`jx db push` covers the `data` section only. The auth extension's account tables (`user`, `session`, `account`, `verification`) come from a separate push step that Studio's **Push Schema** button and the dev server run, and the dev server also creates them on its first request to `/_jx/auth` — the CLI push does not include them today. A database whose schema only ever came from `jx db push` has no account tables, and sign-in fails against it at runtime.
:::

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
- [Data tables](/docs/studio/data/tables) — the tables and push plan behind `jx db push`
