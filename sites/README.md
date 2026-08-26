# Jx Sites

First-party Jx projects that are neither published packages nor user-facing templates. Each
subdirectory is a real Jx project — a `project.json` plus JSON/Markdown documents, laid out per
[specs/site-architecture.md](../specs/site-architecture.md) §2 — consumed by this repo's own tooling
rather than by users. `scripts/check-dep-rules.ts` classifies `sites/*` as **leaf apps** ("exempt
consumers, like user projects"), so the core/extension dependency rules of
[specs/extensions.md](../specs/extensions.md) §2 do not apply here; nothing in the monorepo imports
code out of this directory.

| Site                           | Purpose                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| [`jxsuite.com`](./jxsuite.com) | The public marketing + docs site, built by Jx itself — the monorepo's dogfooding surface |
| [`test-blank`](./test-blank)   | A deliberately minimal fixture site: Studio's default AI-eval canvas, never shipped      |

## jxsuite.com

The only Bun workspace member here (`@jxsuite/site-jxsuite.com`, private). Edit it as Jx content —
JSON documents and Markdown with parser directives — not as TypeScript. Its `project.json` enables
`@jxsuite/parser` and `@jxsuite/search`, sources the repo's own [`../../docs`](../docs/README.md)
tree as a content collection ([specs/site-architecture.md](../specs/site-architecture.md) §6) with
`../../docs/nav.json` alongside it, renders every docs entry from the single dynamic route
`pages/docs/[...slug].json` (the `/docs/` landing page itself is the static
`pages/docs/index.json`), and republishes the canonical Jx JSON Schemas at stable `/schema/**` URLs
via `copy`.

```sh
bun run generate:schema && bun run build:parser && bun run build:compiler
bun run --cwd sites/jxsuite.com build            # bunx jx build + the llms.txt post-step
```

That first line is the prerequisite sequence [deploy-site.yml](../.github/workflows/deploy-site.yml)
runs before the site build; `bunx jx` loads `packages/compiler/dist`.

Open it in Studio locally (see [AGENTS.md](../AGENTS.md)):

```
http://localhost:3000/packages/studio/index.html?project=~/Development/jx/sites/jxsuite.com/project.json
```

Deployment is [.github/workflows/deploy-site.yml](../.github/workflows/deploy-site.yml) → GitHub
Pages, from `sites/jxsuite.com/dist` (gitignored, zero tracked files). The custom domain is the
committed passthrough `public/CNAME`.

## Rules

- **Everything under `jxsuite.com/pages/` is a public product claim** and is gated by
  `bun run docs:claims` ([scripts/docs/check-site-claims.ts](../scripts/docs/check-site-claims.ts)),
  which scans that tree plus the root `README.md`. A pattern hit ships only with an allow entry in
  [scripts/docs/claims.json](../scripts/docs/claims.json) whose `id` **and** `file` match and whose
  `text` is a substring of the offending line, carrying `evidence` (a repo path, or
  `specs/<file>#<anchor>`) or `reason`. Fenced code blocks in Markdown are exempt; JSON pages are
  scanned line-by-line with no exemption. See CLAUDE.md, "Marketing & Claims Policy".
- **Rewording gated copy is a two-sided edit.** An allow entry that matches nothing is itself a
  failure ("stale allow entry … matched nothing — remove it"), as is an `evidence` path missing from
  disk. Change the copy, re-justify the entry.
- **Never write a starter count into a page.** The gate parses digits and number words before
  "starter(s)" and fails on any disagreement with
  [packages/starters/registry.json](../packages/starters/registry.json); it also asserts the
  `::starter-card` slug set on `pages/templates.md` equals the registry id set in both directions.
- **Download and signing language derives from one file.** A `releases/latest/download/<asset>` URL
  must name an asset with `downloadable: true` in
  [packages/desktop/release-assets.json](../packages/desktop/release-assets.json), and the bare words
  "signed"/"notarized" fail on sight unless allowlisted for an asset marked `signed: true`.
- **Screenshot references are checked against the manifest.** Site pages address shots through the
  docs asset mount (`/content/docs/images/<name>.png`); each must be a shot the screenshot manifest
  produces or an existing file in `docs/images/`.
- **Generated files are never hand-edited.** `*/project.schema.json` and `*/document.schema.json`
  come from `bun run schema:generate-all`; `jxsuite.com/public/starters/*.jpg` come from
  `bun run screenshots:thumbnails`; `sites/*/components/*.js` are compiler sidecars and are
  gitignored.
- **`test-blank` stays pristine.** `packages/studio/tests/harness/load-fixture.ts` copies it into a
  throwaway temp dir before any write, so the committed fixture is never mutated. Editing it to make
  an eval pass defeats the harness.

## Gates

| Command                     | Enforces                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------- |
| bun run docs:claims         | Marketing copy, download links, starter counts and card slugs, screenshot references  |
| bun run docs:check          | Docs `code:` frontmatter resolves — several pages name files in `jxsuite.com` by path |
| bun run schema:validate-all | Every project root here validates end-to-end against its composed schema              |
| bun run schema:verify       | Every committed schema matches its generator (`schema:sync` fixes; CI pushes the fix) |

`docs:claims` runs both in the ungated `checks` job on every PR and, before anything is built, as the
site deploy's first gate.

## Surprises

- **No site here is in the CI coverage matrix.** `scripts/lib/workspaces.ts` restricts
  `WORKSPACE_ROOTS` to `packages` and `extensions`, and no site here has a `bunfig.toml`, so CLAUDE.md's
  per-file coverage ratchet does not reach here. `jxsuite.com/tests/placeholder.test.js` exists only so
  `bun run test:workspaces` does not fail on a workspace with a `test` script and no test file.
- **`test-blank` is not a workspace member** despite the `sites/*` glob in the root `package.json` — it
  has no `package.json` at all, and no entry in `bun.lock`.
- **Editing pages triggers zero test workspaces.** `scripts/ci/affected.ts` lists `sites/**` under
  `NO_TESTS`; only a change to a `project.json` or anywhere under `test-blank/` seeds `packages/studio`,
  via an `EXTRA_EDGES` entry whose cited evidence files are `existsSync`-asserted by the `changes` job
  that builds the matrix. The claims and docs gates live in the ungated `checks` job and still run.
- **Core-package changes do not redeploy the site.** `deploy-site.yml` fires only on pushes to `main`
  touching `sites/jxsuite.com/**`, `docs/**`, or `scripts/docs/**`; a schema, compiler, or runtime change
  that alters rendered output needs a manual `workflow_dispatch`.
- **`bunx jx build` runs the prebuilt compiler** (`packages/compiler/bin/jx.js` → `../dist/cli.js`).
  Building locally without `bun run build:compiler` first silently uses stale compiler output. The
  extensions are exempt — `@jxsuite/parser` and `@jxsuite/search` export `./src/*.ts` directly.
- **Renaming a file named in docs `code:` frontmatter reds `bun run docs:check`**:
  `jxsuite.com/components/site-search.json`, `jxsuite.com/project.json`, and
  `jxsuite.com/project.schema.json` are named in the `code:` frontmatter of
  [docs/framework/site/search.md](../docs/framework/site/search.md),
  [docs/framework/agents/machine-readable.md](../docs/framework/agents/machine-readable.md), and
  [docs/extending/extensions/schema-composition.md](../docs/extending/extensions/schema-composition.md).
- **`jxsuite.com/concept_homepage.md` is not scanned.** It sits outside `pages/`, so the claims gate
  never sees it; it is a strategy brief full of unvetted marketing language, and copying a line from it
  into `pages/` will likely trip a pattern.
