# Jx Examples

The monorepo's feature-demo project is a real, buildable Jx project (`"name": "Jx Examples"`, declaring
`"url": "https://examples.jxsuite.dev"`, which no workflow here deploys) that doubles as the end-to-end
fixture for the toolchain. It is a Bun workspace member, so its `@jxsuite/*` dependencies are
`workspace:^` and resolve through symlinks back into this repo. The project enables exactly one
extension, `@jxsuite/parser`.

| Path                                             | Contents                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [`project.json`](./project.json)                 | Project definition: defaults, `$head`, the `posts` content collection, `build.outDir`, `extensions`                |
| [`pages/`](./pages)                              | Routes: `index.json` plus a `basics/` tier (one custom element each) and an `advanced/` tier                       |
| [`components/`](./components)                    | JSON component documents, two Markdown-authored ones (`todo-app.md`, `todo-item.md`), and `fetch-demo.js` (`$src`) |
| [`layouts/`](./layouts)                          | `base.json` (page shell) and `example.json`, which nests it via `$layout` and adds the sidebar nav                 |
| [`content/posts/`](./content/posts)              | The content collection `project.json` declares, and the fixture data behind the blog page                          |
| `project.schema.json`                            | **Generated.** Editor schema for `project.json`                                                                    |
| `document.schema.json`                           | **Generated.** Editor schema for every page, component, and layout here                                            |
| [`tests/`](./tests)                              | One placeholder `bun:test` file, so the workspace's `test` script has something to run                             |
| [`.dev-server-smoke.ts`](./.dev-server-smoke.ts) | Hand-run dev-server smoke check on port 5199. Nothing in the repo calls it                                         |

Between them the pages exercise reactive state, computed values, list rendering, forms, `Request` data
sources, `$switch` routing, responsive `$media`, nested custom elements, a `MarkdownCollection` blog,
Markdown-authored components, and third-party web components (Shoelace).

## Running it

```sh
bun run --cwd examples build   # jx build → examples/dist (gitignored)
bun run --cwd examples dev     # jx dev, rooted here
```

Root `bun run dev` boots the dev server at the **repo root** on port 3000 and serves this project's build
output at `/examples/dist/` alongside Studio at `/packages/studio/index.html`. It does not build it
(`server.js`'s `builds` array covers only the runtime and the Studio entrypoints), so on a fresh checkout
those routes 404 until `jx build` has run. The banner `server.js` prints scans `examples/dist` for
`index.html` files instead of listing routes, so it names exactly the two tiers that were built.
On a fresh checkout it says the directory is empty rather than advertising routes that 404.

## Rules

- **Leaf app, not a library.** [specs/extensions.md §2](../specs/extensions.md) classifies `examples` and
  `sites/*` as leaf apps (exempt consumers, like a user's own project), so the core/extension
  dependency rules do not apply here. [`scripts/check-dep-rules.ts`](../scripts/check-dep-rules.ts)
  enforces those rules and reads only `packages/` and `extensions/`, so it never opens this manifest.
  The `@jxsuite/*` ranges here are `workspace:^` because `examples` is a workspace member;
  `packages/starters/sites/*` is not one, so it must name published semver, kept current by
  [`scripts/check-template-versions.ts`](../scripts/check-template-versions.ts)
  (`bun run templates:check`).
- **`node_modules/` here is real and correct.** [`scripts/check-shadowed-core.ts`](../scripts/check-shadowed-core.ts)
  skips a symlink whose target still resolves (a workspace link pointing back into this repo),
  precisely so `bun run schema:clean-roots` leaves these links alone. A dangling one is still reported.
  Do not clean this directory the way a starter root is cleaned.
- **The two `*.schema.json` files are generated. Never hand-edit them.** `examples` is the first project
  root [`scripts/generate-schemas.ts`](../scripts/generate-schemas.ts) and
  [`scripts/validate-schemas.ts`](../scripts/validate-schemas.ts) walk. A change to `project.json`, to the
  schema emitters, or to an extension fragment means `bun run schema:generate-all` in the same PR
  (or just `bun run schema:sync`); `bun run schema:verify` and `bun run schema:validate-all` both
  block in CI, and `.github/workflows/schemas.yml` pushes the regeneration to your branch if you
  forget.
- **There is no coverage lane here.** The `bunfig.toml` coverage ratchet applies to the CI workspace graph,
  which is `packages/*` and `extensions/*` only. Do not add one expecting a gate.

## What else reads this directory

| Consumer                                                                                                              | Reads                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [`packages/compiler/tests/cli.test.ts`](../packages/compiler/tests/cli.test.ts)                                       | Spawns `jx build` against the whole directory         |
| [`packages/compiler/tests/compile-element.test.ts`](../packages/compiler/tests/compile-element.test.ts)               | `components/{task-item,task-stats,task-manager}.json` |
| [`packages/compiler/tests/compile-element-render.test.ts`](../packages/compiler/tests/compile-element-render.test.ts) | `components/todo-app.json`                            |
| [`extensions/parser/tests/markdown.test.ts`](../extensions/parser/tests/markdown.test.ts)                             | `content/posts/`                                      |
| [`extensions/parser/tests/jx-markdown.test.ts`](../extensions/parser/tests/jx-markdown.test.ts)                       | `components/todo-item.md`, `components/todo-app.md`   |
| [`packages/runtime/tests/class-json.test.ts`](../packages/runtime/tests/class-json.test.ts)                           | `content/posts/getting-started.md`                    |
| `data-source-request` in [`scripts/screenshots/manifest.json`](../scripts/screenshots/manifest.json)                  | `components/fetch-demo.json`, in Studio's design view |

So edits here are behavior-visible in other workspaces. Two consequences:

- **The CI test-gating edge is narrower than that table.**
  [`scripts/ci/affected.ts`](../scripts/ci/affected.ts) seeds only `packages/compiler` from `examples/**`,
  and parser and runtime are _upstream_ of compiler. A diff touching only `content/posts/` reports them
  as not affected while their suites read exactly those files. Run those suites by hand when you touch the
  posts or the Markdown components.
- **A `fetch-demo.json` edit can move a committed picture.** `examples/**` is in the screenshots workflow's
  `pull_request` paths filter (a derived list, guarded by `scripts/screenshots/shot-paths.test.ts`), so the
  lane re-captures and pushes rather than going red. The image lands on
  [docs/studio/logic/data-sources.md](../docs/studio/logic/data-sources.md). Re-read that page when it changes.
