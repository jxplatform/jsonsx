<p align="center">
  <img src="branding/jx_flattened.svg" alt="Jx" width="80" height="80">
</p>

<p align="center">
  A full-stack web framework with a visual editor, built on plain JSON and Markdown.<br>
  Pages, styles, state, data, and server logic are all declarative documents — edit them in code, on a canvas, or with an agent.
</p>

<p align="center">
  <a href="https://jxsuite.com">Website</a> &middot;
  <a href="https://jxsuite.com/docs/start">Docs</a> &middot;
  <a href="https://jxsuite.com/docs/framework">Framework</a> &middot;
  <a href="specs">Spec</a>
</p>

---

[![codecov](https://codecov.io/gh/jxsuite/jx/graph/badge.svg?token=4ZDC9K0CDD)](https://codecov.io/gh/jxsuite/jx)

## What is Jx?

A Jx project is a directory of JSON and Markdown files. Routes come from the filesystem. Components
are JSON documents whose property names mirror the DOM API. Reactivity is
[`@vue/reactivity`](https://github.com/vuejs/core/tree/main/packages/reactivity). State entries
marked `timing: "server"` run on the server.

```json
{
  "$id": "Counter",
  "state": {
    "count": 0,
    "increment": { "$prototype": "Function", "body": "state.count++" }
  },
  "tagName": "my-counter",
  "children": [
    { "tagName": "span", "textContent": "${state.count}" },
    { "tagName": "button", "textContent": "+", "onclick": { "$ref": "#/state/increment" } }
  ]
}
```

Every document validates against a JSON Schema 2020-12 meta-schema generated from the live web
platform, so the same file is legible to a person, a visual editor, and a model. The full format —
state shapes, bindings, repeaters, props, statements, styling — is documented under
[Framework](https://jxsuite.com/docs/framework).

## The stack

| Layer       | What ships                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------- |
| **Routing** | File-based. `[param].json` and `[...path].json` catch-alls, enumerated at build time via `$paths`   |
| **Content** | Markdown collections with frontmatter schemas, Jx Markdown directives, relationships                |
| **Styling** | Design tokens, breakpoints, states and selectors, a forced color-scheme contract                    |
| **Logic**   | Reactive state, template expressions, declarative statements, sidecar JS modules                    |
| **Server**  | `timing: "server"` state entries compile to `POST /_jx/server/<fn>`; secrets never leave the server |
| **Data**    | D1, Supabase, and SQLite connections; CRUD over `/_jx/data`; additive schema sync via `jx db push`  |
| **Auth**    | Better Auth sessions, sign-in flows, and per-table permission rules over `/_jx/auth`                |
| **Search**  | A build-time index over your content collections plus a headless browser client                     |
| **Assets**  | Responsive image pipeline (WebP/AVIF), sitemap, robots, redirects                                   |
| **Output**  | Static HTML by default; adapters for `cloudflare-workers`, `cloudflare-pages`, `node`, and `bun`    |

Pages are prerendered at build time and interactivity hydrates as islands — static pages ship no
JavaScript. The generated worker serves `/_jx/*` (server functions, data, auth) and your static
assets; it does not render pages per request.

## Quick start

```bash
bun create @jxsuite my-site
cd my-site
bun run dev
```

The `jx` CLI drives the rest:

```bash
jx dev        # dev server with live reload
jx build      # compile the site to dist/
jx preview    # serve an already-built dist/
jx schema     # generate self-contained JSON Schemas for the project
jx validate   # validate project.json, documents, classes, and extension fragments
jx db push    # sync data tables to their connections (additive only)
```

Start from a blank project or one of 12 starters. Publishing is git-push-driven — commit, and your
host builds. See [Build output and adapters](https://jxsuite.com/docs/framework/site/deployment).

## Studio

Jx Studio is a desktop application for editing Jx projects — the visual editor runs as the desktop
app, and there is no hosted, sign-in version. Contributors working in this repository can also run
it in the browser via the dev server.

<p align="center">
  <img src="docs/images/hero.png" alt="Jx Studio editing the jxsuite.com homepage — layers panel, live canvas, and element inspector" width="800">
</p>

Four modes over the same files: **Manage** (project explorer, content models, media), **Edit**
(inline WYSIWYG authoring that saves as Markdown), **Design** (canvas, breakpoints, CSS inspector,
tokens), and **Script** (state, data, events, and a Monaco editor for functions). Git is built in —
stage, diff, commit, branch, and push without leaving the app. Multiple people can co-edit one
project in real time against a shared backend.

[Download Jx Studio](https://jxsuite.com/download) for macOS, Windows, or Linux.

## Built for agents

The document format is the contract, so a model works on exactly the artifact a person does:

- **`jx schema`** emits self-contained schemas for your project — they resolve with no
  `node_modules` and no network, so any validator can check generated output offline.
- **`jx validate`** is a deterministic pass/fail over the whole project, which makes it a usable CI
  gate for machine-written documents.
- **Studio's assistant** edits through the same document operations a person uses, so an AI change
  lands in the undo stack and in your git diff like any other edit. Bring your own key; Studio ships
  no account and no hosted model, and sends nothing anywhere until you connect a provider.
- **[`.claude/commands/jx.md`](.claude/commands/jx.md)** is a ready-made `/jx` authoring command for
  coding agents working in a Jx project.

## Extending

An extension is an npm package with a `jx-extension.json` manifest contributing classes, JSON Schema
fragments, and capability methods. Core packages never depend on extensions — a CI rule enforces it
— so the first-party extensions below use the same public hooks yours would.

## Packages

| Package                                      | What it is                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| [`@jxsuite/schema`](packages/schema)         | JSON Schema 2020-12 meta-schema generated from the live web platform   |
| [`@jxsuite/runtime`](packages/runtime)       | JSON-native reactive web component runtime                             |
| [`@jxsuite/compiler`](packages/compiler)     | Static compiler, island detector, site builder — and the `jx` CLI      |
| [`@jxsuite/server`](packages/server)         | Dev server: live reload, proxy resolution, Studio backend              |
| [`@jxsuite/studio`](packages/studio)         | The visual editor, as a backend-agnostic application                   |
| [`@jxsuite/desktop`](packages/desktop)       | Jx Studio packaged for the desktop with Electrobun                     |
| [`@jxsuite/protocol`](packages/protocol)     | The Studio Backend Protocol — wire types and the canonical route table |
| [`@jxsuite/collab`](packages/collab)         | Real-time co-editing — Y.Doc schema, op bridge, structural differ      |
| [`@jxsuite/ai`](packages/ai)                 | Streaming LLM client, tool registry, and reactive chat state           |
| [`@jxsuite/create`](packages/create)         | Project scaffolding behind `bun create @jxsuite`                       |
| [`@jxsuite/starters`](packages/starters)     | Starter site templates                                                 |
| [`@jxsuite/import`](packages/import)         | Clone a live website into a Jx project                                 |
| [`@jxsuite/markup`](packages/markup)         | HTML to Jx nodes, Markdown to sanitized HTML                           |
| [`@jxsuite/formulas`](packages/formulas)     | Composite pure formulas authored as declarative expressions            |
| [`@jxsuite/parser`](extensions/parser)       | Markdown, CSV, and content collections                                 |
| [`@jxsuite/connector`](extensions/connector) | Database connections and dynamic data tables                           |
| [`@jxsuite/auth`](extensions/auth)           | Sessions, sign-in flows, and table permissions                         |
| [`@jxsuite/search`](extensions/search)       | Build-time search index and headless client                            |

## Development

```bash
git clone https://github.com/jxsuite/jx.git
cd jx
bun install

bun run dev            # dev server with the examples project
bun test --isolate     # test suite
bun run all-the-things # build, test, lint, typecheck
bun run desktop        # launch the desktop app
```

Behavior is specified in [`specs/`](specs) and documented in [`docs/`](docs); both travel with the
code in the same change set. See
[Working in the monorepo](https://jxsuite.com/docs/extending/contributing/monorepo).

## License

MIT — see [LICENSE](LICENSE).
