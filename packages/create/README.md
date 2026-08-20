# `@jxsuite/create`

> Project scaffolder for Jx — the package behind `bun create @jxsuite`.

## Overview

`@jxsuite/create` turns an empty directory into a working Jx project. It is two things at once: an
interactive CLI, and the library whose `generateProject()` is the single generation engine shared by
every creation surface in the monorepo — the CLI imports it directly, and the dev server's Studio
API and the packaged desktop backend dynamic-import it (`packages/server/src/studio-api.ts`,
`packages/desktop/src/project-session.ts`).

The package publishes **raw TypeScript**: there is no build step, the `create-jxsuite` bin points at
`./index.ts`, and every `exports` target is a `.ts` or `.json` source file. Its only runtime
dependency is `@jxsuite/starters`.

## CLI

```sh
bun create @jxsuite <directory> [--template <id>]
```

The first argument that is not part of `--template` is the destination directory; it is required (a
bare invocation prints usage and exits 1). `--template <id>` and `--template=<id>` are both accepted,
and no other flag is recognized — an unrecognized one is taken as the destination.

Prompts, in order — everything except the destination is asked interactively:

| Prompt                                   | Default when blank                                    |
| ---------------------------------------- | ----------------------------------------------------- |
| `Project name (<dir>): `                 | basename of the destination directory                 |
| `Description: `                          | `""`                                                  |
| `Production URL (https://example.com): ` | `""` — `generateProject` writes `https://example.com` |
| `Template [1]: `                         | Blank — skipped entirely when `--template` is given   |
| `Adapter [1]: `                          | `static`                                              |

The template menu numbers the four built-in templates 1-4, then the starters from
`@jxsuite/starters` 5 and up. The adapter menu is `1) static`, `2) cloudflare-pages`, `3) node`,
`4) bun`, `5) cloudflare-workers`; any unrecognized answer to either prompt falls back to the
default.

## Templates and starters

Two disjoint id namespaces feed `--template`. A **built-in template id wins**; otherwise a starter id
is matched; an id in neither namespace **silently falls back to blank** rather than erroring.

| Built-in id     | What it produces                                                                      |
| --------------- | ------------------------------------------------------------------------------------- |
| `blank`         | The shared skeleton, desktop-first `$media`                                           |
| `desktop-first` | Byte-identical to `blank`                                                             |
| `mobile-first`  | Same files, mobile-first `$media` (min-width queries, 375px base)                     |
| `mobile-app`    | Mobile-first `$media`, `viewport-fit=cover`, a `theme-color` meta, and a file overlay |

`template/` (singular) is the shared skeleton copied on every non-starter scaffold — `gitignore` →
`.gitignore`, `layouts/`, `pages/`. `templates/` (plural) holds per-template overlay trees copied
**after** the skeleton with `force: true`, and today contains exactly one: `mobile-app/`, which
replaces `layouts/base.json` with an app shell (bottom nav bar, safe-area insets) and
`pages/index.md` with an app-flavored home page, and adds `pages/explore.md` and
`pages/profile.md`. So `blank`, `desktop-first` and `mobile-first` differ only in the generated
`project.json` — zero file differences. Breakpoint maps live in `templates.ts`
(`mediaForTemplate`).

Starter ids come from [`@jxsuite/starters`](../starters/README.md) — its `registry.json` is the
current list. A starter clone copies the starter tree verbatim except `node_modules`, `dist`,
`.cache`, `.jx-cache`, `.git`, and `images.json`, then re-stamps `project.json` in place: `name`
always, `url` only when non-empty, `build.adapter` only when the adapter is not `static`, and the
`<meta name="description">` content only when a description was given. The starter's design tokens,
content collections, image pipeline, and the rest of `$head` survive; its `package.json` does not —
it is rebuilt from scratch (see below).

## What gets generated

`project.json` leads with `$schema: "./project.schema.json"` and carries `$head`, `$media`, `build`
(`{ outDir: "./dist", trailingSlash: "always" }`, plus `adapter` when it is not `static`),
`content: {}`, `defaults: { lang: "en", layout: "./layouts/base.json" }`,
`extensions: ["@jxsuite/parser"]`, `name`, `style`, and `url`.

`package.json` is `private: true`, MIT, with `build`/`dev`/`preview` scripts calling the `jx` CLI. Its
name is the project name lowercased with non-alphanumerics collapsed to hyphens. `@jxsuite/parser` is
a dependency; `@jxsuite/compiler`, `@jxsuite/runtime` and `@jxsuite/server` are devDependencies. Any
non-static adapter adds `hono: "^4"`; the two Cloudflare adapters additionally add `wrangler: "^4"`, a
`deploy` script (`wrangler deploy` or `wrangler pages deploy dist`), and a generated `wrangler.jsonc`.

A blank scaffold also creates empty `components/`, `public/`, and `content/` directories.

## Programmatic API

```ts
import { generateProject } from "@jxsuite/create/generate";

await generateProject("/abs/path/to/my-site", {
  name: "My Site",
  description: "",
  url: "https://example.com",
  adapter: "static", // | "cloudflare-pages" | "cloudflare-workers" | "node" | "bun"
  starter: "blank", // a starter id overrides `template` outright
  template: "blank", // | "desktop-first" | "mobile-first" | "mobile-app"
});
```

`design` (optional) applies a colors/fonts/logo/breakpoints quickstart on top of the scaffold — see
`DesignOptions` in `generate.ts`.

| Export                                   | Description                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `@jxsuite/create/generate`               | `generateProject`, `ProjectOptions`, `DesignOptions`                                          |
| `@jxsuite/create/templates`              | `TEMPLATES`, `listTemplates`, `isTemplateId`, `mediaForTemplate`                              |
| `@jxsuite/create/scaffold`               | `adapterNeedsWrangler`, `buildWranglerJsonc`, `updateWranglerConfig`, `applyBindingFragments` |
| `@jxsuite/create/template-versions.json` | The `@jxsuite/*` semver ranges stamped into scaffolded projects                               |

`scaffold.ts` has **zero node imports** by design, so it runs in a browser and against a Git Data
API. `@jxsuite/studio` imports `updateWranglerConfig` for its Cloudflare Pages publish flow, and
`@jxsuite/compiler` imports `applyBindingFragments` for `jx db push` — adding `node:fs` there breaks
both. `isTemplateId` is used server-side as request validation: the Studio API rejects an unknown
template with a 400 before generating.

## Dependency ranges

Every `@jxsuite/*` range a scaffold emits — including a starter clone's rebuilt `package.json` —
comes from `template-versions.json`, never from a literal in code. A test asserts exactly that, so a
future hardcoded range fails there.

**Never hand-edit that file.** In the normal case release-please rewrites it inside the release
commit (each of the four owning packages declares a jsonpath into it via `extra-files` in
`release-please-config.json`). The gate is `bun run templates:check`, which requires every range to
be exactly `^<workspace version>` across both shipping surfaces (this file and
`packages/starters/sites/*/package.json`) and runs on every PR; `bun run templates:sync` is the fixer
for drift that predates release-please. The gate exists because these ranges once drifted four
majors, so scaffolded projects installed a toolchain older than their own template.

## Surprises worth knowing

- **Generation refuses a non-empty destination** — `Directory "<path>" is not empty`. An existing but
  empty directory is fine.
- **`$schema` points at a file this package does not write.** `project.schema.json` comes from
  `jx schema` (specs/extensions.md §5.2), so a fresh scaffold has a dangling reference until that
  runs.
- **A starter's `package.json` is rebuilt, not copied** — anything its manifest declared beyond
  name/scripts/deps is lost by design.
- **The design quickstart is best-effort on a starter**: an override only lands on a key the
  starter's style already declares, and `--color-primary-hover` is deliberately left alone. On a
  blank scaffold values are written directly. A non-empty `design.media` replaces `$media` wholesale;
  an empty one is treated as absent.
- **`design.logo.name` is the only untrusted-input path to the filesystem.** It is flattened to its
  basename and must match `/\.(svg|png|jpe?g|webp|gif|ico)$/i` or generation throws. That is a
  security boundary, not a convenience check.
- **`index.ts` exports `ready`, not a top-level await.** Bun's test runtime drops a
  dynamically-imported module's top-level-await continuation, so the interactive run is a promise
  tests can await; the no-arg usage guard stays at module scope so a bare invocation still exits
  during evaluation.
- **`template/` and `templates/` resolve from `import.meta.dirname`**, which is why the desktop build
  stages them to exact paths and `packages/desktop/scripts/verify-bundle.ts` fails the packaged build
  when they are missing.
- **`generate.ts` imports `@jxsuite/starters` lazily**, inside the starter path only, so a blank
  scaffold never loads it; the CLI entry imports `listStarters` eagerly, because the menu needs it.
  An unknown starter id passed programmatically throws `Unknown starter: "<id>"`.

## Testing

```sh
bun test --isolate            # from packages/create
bun test --isolate --coverage
```

Per-file coverage thresholds live in `packages/create/bunfig.toml`.

## Docs

User-facing documentation for this surface is `docs/framework/build/cli.md`, whose `code:`
frontmatter already lists `index.ts`, `cli-args.ts`, `templates.ts` and `generate.ts` — a behavior
change here trips `bun run docs:sync`.

## License

MIT
