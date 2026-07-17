# Spec-vs-implementation drift — found during the docs build-out (July 2026)

> **Resolution (July 2026 follow-up).** The drift below was resolved in the
> July 2026 drift-resolution follow-up (commits `03ac07ff`, `e77a1f23`,
> `c0ff0d9d` plus the coordinated spec refresh). Implementation fixes: redo
> and commit shortcuts, intrinsic image dimensions, auto `og:url` /
> `og:site_name`, redirect-collision warnings, relationship-validation
> warnings, protocol route-table completeness, the Auth `deploySchema`
> descriptor, blessed `Intl` helpers, `jx dev` / `jx preview`, and
> `build.format` retirement (reserved). Spec updates landed across `spec.md`,
> `site-architecture.md`, `desktop.md`, `server.md`, `extensions.md`, and the
> parser README. Each item below carries an inline status marker —
> **[fixed — implementation]**, **[fixed — spec updated]**, or
> **[open follow-up]** — and the original text stands unchanged as the
> historical record.

While drafting `/docs` (every page source-verified), these divergences between the
specs and the implementation surfaced. The docs document **implemented behavior**;
each item below needs either a spec update or an implementation fix. Compiled from
the per-cluster drafting reports.

## Product bugs (implementation should probably change)

1. **[fixed — implementation]** (`jx dev` + `jx preview` shipped, `c0ff0d9d`;
   Studio-in-browser for standalone `jx dev` remains **[open follow-up]**)
   **`jx dev` does not exist, but everything tells users to run it.** The
   scaffolder (`packages/create/generate.ts`) writes `"dev": "jx dev"` into every
   new project, all 12 starters use it, and the create flow's "Next steps" says
   `bun run dev` — which prints `Unknown command: dev` and exits 1. `jx preview`
   (site-architecture §12.2) is likewise unimplemented. Docs carry warnings
   (`docs/framework/build/cli.md`, `docs/start/install.md`) until this ships.
2. **[fixed — implementation]** (`03ac07ff` matches both `"z"`/`"Z"`)
   **Redo shortcut may never fire.** `editor/shortcuts.ts` matches `case "z"` with
   `e.shiftKey`, but with Shift held `e.key` is `"Z"` — the case may be dead.
   Verify in a live session; docs document the coded intent (Ctrl/⌘+Shift+Z).
3. **[fixed — implementation]** (`03ac07ff` accepts ⌘Enter)
   **Commit shortcut is Ctrl-only** (`git-panel.ts` checks `ctrlKey`, not
   `metaKey`) — no ⌘Enter on macOS.

## spec.md

- **[fixed — spec updated]** §5.6 says private `#` state is "not yet enforced in the runtime or studio" —
  Studio filters `#` entries today (`component-props.ts`, `cem-export.ts`).
- **[fixed — spec updated]** §7.4's resolution order omits `$args/` (added by §19.5 as an amendment); the
  two lists disagree unless read together.
- **[fixed — spec updated]** §11.3 marks `timing: "compiler"` "Pending" — it is implemented (shared.ts,
  site-build.ts, prototype-resolver.ts).
- **[fixed — spec updated]** §12.3/12.4 call the method output schema `returns`; every real descriptor uses
  `returnType` (+ `returnTypes` `$defs` per compiler.md §5.3).
- **[fixed — spec updated]** §14 never mentions that `renderSwitch` always creates a container element
  (`def.tagName ?? "div"`), that inline element cases are supported, or the
  scope difference between inline and external cases.
- **[fixed — spec updated]** §5.3 4d restricts `parameters` to CEM objects, but §20.1's own example (and
  schema + runtime) accept bare string names.
- **[fixed — implementation]** (`e77a1f23`: blessed `Intl/formatNumber` /
  `Intl/formatDate` / `Intl/formatRelativeTime` helpers; the schema text now
  names them) §19.4c "Intl to follow": schema.json's `call` description already lists
  `Intl.*` but `BLESSED_GLOBALS` has none — schema-doc vs runtime drift.

## site-architecture.md

- **[fixed — spec updated]** §2/§6.1/§6.5 use `collections` / `contentTypes` keys (and some garbled text);
  the real project.json key is `content`.
- **[fixed — spec updated]** §6.4 relationship refs are shown as `#/collections/…`; implemented prefix is
  `#/content/<type>`.
- **[fixed — spec updated]** §6.2 lists formats `md`/`csv`/`yaml`; real values are class names
  (`Markdown`, `Csv`); no YAML class exists.
- **[fixed — spec updated]** (spec now describes warning-based validation; see
  also the relationship-warning fix below) §6.3 promises compile errors with line numbers; validation is console.warn
  by type/entry-id.
- **[fixed — spec updated]** §5.2/§5.4 show page-relative `$layout` paths; the resolver is
  project-root-relative.
- **[fixed — spec updated]** §4.5's `${$params.slug}` template binding doesn't exist — params surface as
  `$page.params` and `#/$params/<name>` refs.
- **[fixed — spec updated]** §3.1's property table omits `content`, `copy`, `extensions`, `$defs`,
  `$elements`.
- **[fixed — implementation]** (`03ac07ff`: auto `og:url`/`og:site_name`,
  author-supplied win) §8.4 claims auto `og:url`/`og:site_name`; head-merger auto-adds only
  canonical/charset/viewport/title/lang.
- **[fixed — implementation]** (`03ac07ff`: intrinsic width/height injected on
  both DOM and innerHTML paths; author values win, remote sources skip)
  §9.2.2 (and compiler §7.2) claim width/height injection on `<img>`; the
  transform injects only srcset/sizes/loading/decoding.
- **[fixed — spec updated]** §9.3 "paths relative to the referring file" — implementation resolves `/…`
  into `public/` and relative paths from the project root.
- **[fixed — implementation]** (`03ac07ff`: a redirect colliding with a
  compiled page route now warns) + **[fixed — spec updated]** (the remaining
  URLPattern/`vercel.json`/loop-detection claims were rewritten to match)
  §11 redirects: no URLPattern validation, no `vercel.json`, no loop/conflict
  detection (a redirect can silently overwrite a compiled page).
- **[fixed — implementation]** (`c0ff0d9d`: `build.format` retired — scaffolder
  stops writing it, schema marks it reserved) + **[fixed — spec updated]**
  (§14.2 output layout rewritten to the real per-component `dist/components/`
  story) §14.1.1 `build.format` is accepted but unused; §14.2's hashed `_assets/`
  layout doesn't match the real per-component `dist/components/` output.
- **[fixed — implementation]** (`03ac07ff`: dangling ids and unknown target
  types now warn) §4 relationships: dangling ids are left untouched (spec says validation
  error).

## desktop.md / protocol

- **[fixed — spec updated]** §3.1's `StudioPlatform` sketch (~14 members) vs the real interface (~70:
  git, packages, collab, data/secrets, publish, multi-window).
- **[fixed — spec updated]** §3.3's module-level `_platform` registration → real mechanism is
  `globalThis.__jxPlatform`.
- **[fixed — spec updated]** §5.3 makes `codeService` optional; real interface: required, null-returning.
- **[fixed — implementation]** (`03ac07ff`: `STUDIO_ROUTES` gains the code
  services and import-site routes, and documents `files?glob=`) +
  **[fixed — spec updated]** (the `/__studio/search` claim corrected)
  §5.1's `GET /__studio/search` doesn't exist (adapter uses `files?glob=`);
  `/__studio/code/*` and `/__studio/import-site` are served but absent from
  `STUDIO_ROUTES`.
- **[fixed — spec updated]** §5.4 names `resolvePrototype`/`executeServerFunction` PAL methods that don't
  exist — the runtime posts to `/__jx_resolve__`/`/__jx_server__` (desktop
  bridges via fetch patch).
- **[open follow-up]** (single-file output / desktop single-file mode still has
  no user-facing entry point) §4.3 single-file mode has no user-facing entry point in current builds.

## server.md

- **[fixed — spec updated]** (rewritten against the current implementation)
  A v2.0.0-draft time capsule: names `.js` modules, lists 8 studio endpoints
  (vs ~60), calls the security helper `assertUnderRoot()` (now
  `assertAccessible()` + two-root activation), and predates `/_jx/*` mounts,
  collab, and project-server.ts. §2's `buildOptions` is really `builds`.

## extensions.md / extension packages

- **[fixed — spec updated]** (§8 now marks the connector discriminator as
  planned; shipping it is an **[open follow-up]**) §8 claims the connector registers a `resolvePaths` discriminator `table`;
  no connector descriptor declares one.
- **[fixed — implementation]** (`03ac07ff` corrected the Auth descriptor to
  `{ steps, applied, warnings, connection }`; spec §11.1, the descriptor, and
  the data-api.ts consumer now agree) §11.1 `deploySchema` return `{ steps, … }` vs Auth's declared
  `{ statements, applied, warnings, connection }`.
- **[fixed — spec updated]** (§12 documents `module` — the bare import
  specifier the generated worker uses for the provider class) §12's connector-block key table omits the `module` key that `D1.class.json`
  carries.
- **[fixed — spec updated]** (§15 reworded to the section-owner `deploySchema`
  channel per §11.1, with an explicit open-design note; the registry hook
  itself is an **[open follow-up]**) §15's guestbook "materializes a data table" mechanism has no specified
  registry hook for non-connector sections.
- **[fixed — spec updated]** (§5.2 now states the real path: `jx dev` exists,
  `c0ff0d9d`, but does not run `jx schema`; regeneration is on-demand via the
  dev server's `/__studio/project-schemas` stale-check) §5.2 says `jx schema` runs on `jx dev` startup (see product bug #1); the
  live path is the dev server's stale-check on `/__studio/project-schemas`.
- **[fixed — spec updated]** (README refreshed to the v2 model as part of the
  follow-up) `extensions/parser/README.md` predates the v2 model (`MarkdownFile`,
  imports-based registration).

## Misc

- **[fixed — spec updated]** (specs swept; no `__jsonsx_*` endpoint names
  remain outside this historical note) Old references to `__jsonsx_resolve__`/`__jsonsx_server__` endpoints: the
  implemented names are `/__jx_resolve__` and `/__jx_server__`.
- **[open follow-up]** (sign-in components / user-management panel still
  unbuilt; state it in §13/auth docs when that changes)
  Auth's Studio surface is one settings section; no sign-in components or
  user-management panel exist yet (README v1 cuts) — worth stating in §13/auth
  docs when that changes.
