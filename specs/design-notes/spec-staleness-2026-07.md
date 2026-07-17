# Spec-vs-implementation drift — found during the docs build-out (July 2026)

While drafting `/docs` (every page source-verified), these divergences between the
specs and the implementation surfaced. The docs document **implemented behavior**;
each item below needs either a spec update or an implementation fix. Compiled from
the per-cluster drafting reports.

## Product bugs (implementation should probably change)

1. **`jx dev` does not exist, but everything tells users to run it.** The
   scaffolder (`packages/create/generate.ts`) writes `"dev": "jx dev"` into every
   new project, all 12 starters use it, and the create flow's "Next steps" says
   `bun run dev` — which prints `Unknown command: dev` and exits 1. `jx preview`
   (site-architecture §12.2) is likewise unimplemented. Docs carry warnings
   (`docs/framework/build/cli.md`, `docs/start/install.md`) until this ships.
2. **Redo shortcut may never fire.** `editor/shortcuts.ts` matches `case "z"` with
   `e.shiftKey`, but with Shift held `e.key` is `"Z"` — the case may be dead.
   Verify in a live session; docs document the coded intent (Ctrl/⌘+Shift+Z).
3. **Commit shortcut is Ctrl-only** (`git-panel.ts` checks `ctrlKey`, not
   `metaKey`) — no ⌘Enter on macOS.

## spec.md

- §5.6 says private `#` state is "not yet enforced in the runtime or studio" —
  Studio filters `#` entries today (`component-props.ts`, `cem-export.ts`).
- §7.4's resolution order omits `$args/` (added by §19.5 as an amendment); the
  two lists disagree unless read together.
- §11.3 marks `timing: "compiler"` "Pending" — it is implemented (shared.ts,
  site-build.ts, prototype-resolver.ts).
- §12.3/12.4 call the method output schema `returns`; every real descriptor uses
  `returnType` (+ `returnTypes` `$defs` per compiler.md §5.3).
- §14 never mentions that `renderSwitch` always creates a container element
  (`def.tagName ?? "div"`), that inline element cases are supported, or the
  scope difference between inline and external cases.
- §5.3 4d restricts `parameters` to CEM objects, but §20.1's own example (and
  schema + runtime) accept bare string names.
- §19.4c "Intl to follow": schema.json's `call` description already lists
  `Intl.*` but `BLESSED_GLOBALS` has none — schema-doc vs runtime drift.

## site-architecture.md

- §2/§6.1/§6.5 use `collections` / `contentTypes` keys (and some garbled text);
  the real project.json key is `content`.
- §6.4 relationship refs are shown as `#/collections/…`; implemented prefix is
  `#/content/<type>`.
- §6.2 lists formats `md`/`csv`/`yaml`; real values are class names
  (`Markdown`, `Csv`); no YAML class exists.
- §6.3 promises compile errors with line numbers; validation is console.warn
  by type/entry-id.
- §5.2/§5.4 show page-relative `$layout` paths; the resolver is
  project-root-relative.
- §4.5's `${$params.slug}` template binding doesn't exist — params surface as
  `$page.params` and `#/$params/<name>` refs.
- §3.1's property table omits `content`, `copy`, `extensions`, `$defs`,
  `$elements`.
- §8.4 claims auto `og:url`/`og:site_name`; head-merger auto-adds only
  canonical/charset/viewport/title/lang.
- §9.2.2 (and compiler §7.2) claim width/height injection on `<img>`; the
  transform injects only srcset/sizes/loading/decoding.
- §9.3 "paths relative to the referring file" — implementation resolves `/…`
  into `public/` and relative paths from the project root.
- §11 redirects: no URLPattern validation, no `vercel.json`, no loop/conflict
  detection (a redirect can silently overwrite a compiled page).
- §14.1.1 `build.format` is accepted but unused; §14.2's hashed `_assets/`
  layout doesn't match the real per-component `dist/components/` output.
- §4 relationships: dangling ids are left untouched (spec says validation
  error).

## desktop.md / protocol

- §3.1's `StudioPlatform` sketch (~14 members) vs the real interface (~70:
  git, packages, collab, data/secrets, publish, multi-window).
- §3.3's module-level `_platform` registration → real mechanism is
  `globalThis.__jxPlatform`.
- §5.3 makes `codeService` optional; real interface: required, null-returning.
- §5.1's `GET /__studio/search` doesn't exist (adapter uses `files?glob=`);
  `/__studio/code/*` and `/__studio/import-site` are served but absent from
  `STUDIO_ROUTES`.
- §5.4 names `resolvePrototype`/`executeServerFunction` PAL methods that don't
  exist — the runtime posts to `/__jx_resolve__`/`/__jx_server__` (desktop
  bridges via fetch patch).
- §4.3 single-file mode has no user-facing entry point in current builds.

## server.md

- A v2.0.0-draft time capsule: names `.js` modules, lists 8 studio endpoints
  (vs ~60), calls the security helper `assertUnderRoot()` (now
  `assertAccessible()` + two-root activation), and predates `/_jx/*` mounts,
  collab, and project-server.ts. §2's `buildOptions` is really `builds`.

## extensions.md / extension packages

- §8 claims the connector registers a `resolvePaths` discriminator `table`;
  no connector descriptor declares one.
- §11.1 `deploySchema` return `{ steps, … }` vs Auth's declared
  `{ statements, applied, warnings, connection }`.
- §12's connector-block key table omits the `module` key that `D1.class.json`
  carries.
- §15's guestbook "materializes a data table" mechanism has no specified
  registry hook for non-connector sections.
- §5.2 says `jx schema` runs on `jx dev` startup (see product bug #1); the
  live path is the dev server's stale-check on `/__studio/project-schemas`.
- `extensions/parser/README.md` predates the v2 model (`MarkdownFile`,
  imports-based registration).

## Misc

- Old references to `__jsonsx_resolve__`/`__jsonsx_server__` endpoints: the
  implemented names are `/__jx_resolve__` and `/__jx_server__`.
- Auth's Studio surface is one settings section; no sign-in components or
  user-management panel exist yet (README v1 cuts) — worth stating in §13/auth
  docs when that changes.
