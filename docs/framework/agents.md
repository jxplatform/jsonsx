---
title: "Working with agents"
description: "Why a Jx project is tractable for a language model, the three places an agent meets one, and the generate-validate-fix loop that keeps its work honest."
code:
  - packages/compiler/src/site/schema-command.ts
  - packages/compiler/src/site/validate-command.ts
  - packages/schema/schema.json
---

# Working with agents

A Jx project is a folder of JSON documents, and that one fact changes what it means to hand a website to a language model. The model edits the same `pages/index.json` a person edits in Studio, not a generated intermediate and not a pile of framework code standing in for the page. There is one artifact, and everybody works on it: you, Studio, and the agent.

This page explains why that shape suits a model, where agents plug in, and the loop that turns a plausible answer into a checked one.

## Why documents are tractable where code is not

Prompt-to-code tools produce programs. A program is "correct" only in the sense that it runs, and finding out whether it runs means executing it, in an environment, with a browser attached. A Jx document is a different kind of output:

- **The shape is bounded.** Every Jx file validates against one of three published JSON Schemas: one for documents, one for `project.json`, one for `.class.json`. A key either exists in the schema or it does not, and an invented `"styles"` where the schema says `"style"` is caught by a validator rather than by a blank page.
- **Edits are structural, not textual.** A page is a tree of addressable nodes, so "add a button to the header" is an insertion at a path, not a search-and-replace over source text. That is how Studio's assistant edits the canvas live, and why an external agent can change one property without touching the rest of the file.
- **Every change is a reviewable diff.** JSON diffs on property boundaries, so a small change in `git diff` is a small change in the page. Machine-written work needs review more than hand-written work does, and this is the format that makes review cheap.

None of this makes a model correct. It makes a model **checkable**, and that is the property you can build a workflow on.

## Three ways an agent meets a Jx project

### Studio's built-in assistant

A chat sidebar inside the editor that works on your project rather than talking about it: it creates pages and components, edits the document on the canvas while you watch, and answers questions by reading your files. It runs against an AI provider you connect, and everything it writes as a Jx document is validated before it lands. See **[AI assistant](/docs/studio/ai)**.

### An external coding agent

Claude Code, Cursor, or your own script, working on the project folder like any other repository. Nothing about the setup is Jx-specific; the agent reads and writes files. A briefing still pays for itself, because the schema encodes rules the model would otherwise guess at (style is an object, IDL properties sit on the element, layouts use `slot`). See **[Authoring rules for agents](/docs/framework/agents/authoring-rules)**.

### Validation in CI

`jx validate` exits non-zero on any violation, so the command an agent runs after each edit is the command your pipeline can run on the pull request. Agent work and hand-written work pass through one gate, and the gate does not care which is which.

## The generate-validate-fix loop

**1. Generate the project's schemas with `jx schema`.**

Run it once per project, and again after any change to `project.json`'s `extensions` array. It composes the core schemas with the fragments each enabled extension ships and writes two entry documents into the project root, `project.schema.json` and `document.schema.json`. Both are **self-contained single-resource schemas**: every referenced resource is embedded under `$defs` and every `$ref` is a root-relative JSON Pointer, so they resolve with no `node_modules` and no network. One resolution behavior for every consumer: your editor, Studio's Monaco, and `jx validate` alike. See [Schema composition](/docs/extending/extensions/schema-composition).

**2. Let the agent write files.**

`project.json` binds itself with `"$schema": "./project.schema.json"`, so an editor with JSON language support autocompletes and underlines as the agent types. Documents under `pages/`, `layouts/`, and `components/` carry no `$schema` key of their own. `document.schema.json` is the schema they are checked against, in step 3.

**3. Check the work with `jx validate`.**

The deterministic gate, run after every edit. It walks the project in five passes:

1. Both committed entry documents, for self-containment. A `$ref` that is a relative path, a URI, or a pointer to nothing means they are stale, and the fix is to re-run `jx schema`. This runs first and stops the walk, because every later pass compiles one of these files.
2. `project.json` against the generated entry schema.
3. Every document under `components/`, `pages/`, and `layouts/` against the bundled document schema.
4. Every project-local `*.class.json` against the class schema.
5. Each enabled extension's schema fragments, compiled standalone.

Clean runs print `Project is valid (N files checked in <root>)`. Failures print `Project is INVALID`, then one block per file:

```text
pages/about.json:
  - /children/0: must NOT have additional properties
```

**4. Feed the failures back verbatim.**

Each line already names the file, the JSON pointer into it, and what is wrong: a complete fix instruction with nothing left to infer. Loop until validation is clean, then run `jx build`.

:::doc-tip
Wire steps 1 and 3 into the agent's own instructions ("run `jx validate` after every file you write; do not report success until it passes") rather than running them yourself. An agent that can check its own work will, and the loop closes without you in it.
:::

## What an agent can build

The whole framework is reachable from JSON, so the ceiling is higher than "a static page":

- **Pages, layouts, and components**: routing from the `pages/` tree, shared shells with `slot`, reusable custom elements. See [Site architecture](/docs/framework/site).
- **Content collections**: folders of Markdown, JSON, or CSV files with schema validation, queried into pages. See [Content collections](/docs/framework/site/content-collections).
- **Databases**: the `connections` and `data` sections in `project.json` become real tables (D1, Supabase, or SQLite) with CRUD and form actions. See [Databases](/docs/studio/data).
- **Server functions**: a state entry with `timing: "server"` compiles into a server handler your secrets can live behind. See [Timing](/docs/framework/concepts/timing).
- **Accounts and sessions**: the auth extension adds sign-in, sessions, and per-table permissions. See [Auth and secrets](/docs/studio/data/auth-and-secrets).

One boundary is worth telling the agent up front: **pages are prerendered at build time**, and interactivity arrives as hydration islands. There is no per-request page rendering, and the route set is fixed when the build runs. A page that must exist per visitor is a client-side view over server data, not server-rendered HTML.

The other thing to say up front is the adapter. A project with connection-backed data tables **must** set a server-capable `build.adapter` (`cloudflare-workers`, `cloudflare-pages`, `node`, or `bun`), and the build fails on static. Server functions want one too, since that is what packages them into a worker a host will actually run. See [Build output and adapters](/docs/framework/site/deployment).

## Related

- [Authoring rules for agents](/docs/framework/agents/authoring-rules): the briefing to hand an external coding agent
- [Machine-readable docs](/docs/framework/agents/machine-readable): the schema and documentation endpoints an agent can fetch
- [CLI commands](/docs/framework/build/cli): every flag of `jx schema`, `jx validate`, and the rest
- [Schema composition](/docs/extending/extensions/schema-composition): how the entry documents are assembled
- [AI assistant](/docs/studio/ai): the agent that ships inside Studio
