We're crafting a comprehensive web-based application suite that aims to encompass all available web platform APIs within a JSON Schema and provides a runtime, compiler, visual builder, and extension layer (content collections, search, authentication, database connectors) to facilitate website and full-application builds with this schema. Jx targets apps with accounts and data, not only brochure sites: pages are always prerendered at build time and hydrate as islands, while sessions and application data come from extension server mounts which — together with any `timing: "server"` state entries — compile into one generated Hono worker serving `/_jx/*` next to the static output whenever `build.adapter` is set. A project with an active mount (a non-empty `data` or `auth` section) must set one, or the build fails; with no adapter, `timing: "server"` entries fall back to a standalone per-page `_server.js` handler.

- Prefer WHATWG and ECMA standard alignment (current or emerging) for all nomenclature and architectural paradigms.
- Code in strongly typed Typescript. Ensure all linting, typechecking, and tests pass following all changes.
- Implement tests in parallel with features—use native Bun + Happy DOM and other mock API providers, as appropriate.
- Reference the general and package-specific specs (./specs) prior to planning and implementing features, update specs to reflect user requests prior to adding new features. Edit spec sections in place — never renumber headings (user docs anchor them).
- Every substantive spec edit is a release: run `bun run spec:bump <spec.md> <major|minor|patch> -m "<what changed>"` to advance the version, restamp `**Updated:**`, and add a `## Changelog` entry, then `bun run docs:generate`. CI blocks a changed spec body that wasn't released (`bun run docs:spec-release`). See ./specs/README.md.
- User documentation (./docs, published at jxsuite.com/docs) must track shipped behavior: behavior-changing work updates the affected docs pages in the same change set. Run `bun run docs:sync` to map your diff to affected pages/specs, and `bun run docs:check` before finishing. Plans must include a "Specs & docs" step.
- Do not wrap Markdown source: write one paragraph per line, and make a line break that carries meaning an explicit `\` hard break. `bun run format:md` fixes a file. Much of the tree is still wrapped from before the rule and the sweep is pending, so match the rule in what you write rather than reflowing what you touch. See ./CLAUDE.md.
- Use Chrome MCP to test new UI/UX changes prior to finishing the task.

## Studio UI Rules

- **Lit-html rendering only**: All UI must be rendered via `lit-html` templates (`html` tagged literals + `litRender`). Never use `document.createElement`, `element.style.cssText`, or other imperative DOM construction for UI.
- **Spectrum Web Components**: Use stock `sp-*` components for all controls (buttons, dialogs, text fields, menus, etc.). Never build custom DOM equivalents of components that Spectrum provides. All Spectrum components used must be registered in `packages/studio/src/ui/spectrum.js`.
- **No inline styles**: Spectrum components are styled by the design system. Do not set `style` attributes or `style.cssText` on Spectrum components. Use CSS classes in `index.html` only when Spectrum doesn't cover the layout need.
- **Dialog pattern**: Use `sp-dialog-wrapper` with `open`, `underlay`, `headline`, `confirm-label`, `cancel-label` attributes and `@confirm`/`@cancel`/`@close` events. Do not create manual backdrops or modal overlays.

## NixOS Development Environment Considerations

If running on NixOS:

- A development server is already running on port 3000
- The studio interface can be accessed via: http://localhost:3000/packages/studio/index.html
- The jxsuite.com project can be accessed via: http://localhost:3000/packages/studio/index.html?project=~/Development/jx/sites/jxsuite.com/project.json
- Tests and validations are run at the project root level via `bun run all-the-things`
- Tests must be run with `--isolate`
