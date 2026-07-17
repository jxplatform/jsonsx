We're crafting a comprehensive web-based application suite that aims to encompase all available web platform APIs within a JSON Schema and provides a runtime, compiler, and visual builder to facilitate website and app builds with this schema.

- Prefer WHATWG and ECMA standard alignment (current or emerging) for all nomenclature and architectural paradigms.
- Code in strongly typed Typescript. Ensure all linting, typechecking, and tests pass following all changes.
- Implement tests in parallel with features—use native Bun + Happy DOM and other mock API providers, as appropriate.
- Reference the general and package-specific specs (./specs) prior to planning and implementing features, update specs to reflect user requests prior to adding new features. Edit spec sections in place — never renumber headings (user docs anchor them).
- User documentation (./docs, published at jxsuite.com/docs) must track shipped behavior: behavior-changing work updates the affected docs pages in the same change set. Run `bun run docs:sync` to map your diff to affected pages/specs, and `bun run docs:check` before finishing. Plans must include a "Specs & docs" step.
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
