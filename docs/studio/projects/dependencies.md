---
title: "Dependencies and imports"
description: "The Imports activity in Jx Studio: add npm packages, cherry-pick their components for the site or one document, and keep everything up to date."
code:
  - packages/studio/src/panels/imports-panel.ts
  - packages/studio/src/settings/dependencies-editor.ts
  - packages/studio/src/packages/jxsuite-update.ts
  - packages/studio/src/packages/ensure-deps.ts
---

# Dependencies and imports

Imports is where you decide which building blocks a document — or the whole site — can use: components from your own project, and components from npm packages (the web's public library of ready-made building blocks). Open it by clicking **Imports** (the box icon) in the activity bar.

<!-- TODO(screenshot): imports-panel — the Imports activity showing a package section with per-component checkboxes -->

## Two contexts

The panel follows whatever tab is active:

- **A page, layout, or component open** — you're managing that document's imports: which components it can place.
- **`project.json` open** — you're managing the whole site: packages, site-wide component availability, and class imports.

## Import your own components

With a document open, the **Components** section lists what it already imports. Use the **Add component…** picker to import another component from your project — it becomes available to place in that document. The × beside an entry removes the import.

If you mostly build by placing blocks from the [Elements panel](/docs/studio/design/elements), you rarely open this list — it's the same wiring, made visible.

## Add an npm package

With `project.json` open:

1. Type the package's name into **Add Dependency** and press :kbd[Enter].
2. Studio installs it. If the package publishes a component catalog (a custom elements manifest), a new section appears for it, listing every component inside.

Packages can also be added from _Settings > Dependencies_ — same result, different door. See **[Project settings](/docs/studio/projects/settings)**.

## Cherry-pick components

Under each package section, every component has a checkbox. Nothing from a package is available until you tick it — you pick exactly the pieces you want instead of importing the whole library:

- Tick a component in the **`project.json`** context to make it available across the site.
- Tick it with a page, layout, or component open to enable it for that document only.

The × in a package's header (site context) removes the package entirely, along with everything you'd picked from it.

## Class imports

The site context also shows **Class Imports** — named behaviors your project's logic can refer to. This is advanced territory; most visual projects never touch it.

## Stay up to date

- _Settings > Dependencies_ shows each package's current and latest version, with per-row update buttons and **Update all**.
- When you open a project built with an older version of Jx, Studio offers to update its Jx packages to match — accept, and it rewrites the versions and reinstalls for you. Decline, and it won't ask again for that version.
- If a project's packages have never been installed on this machine (say, you just cloned it), Studio installs them automatically before the editor loads.

:::doc-note
Packages are recorded in your project's `package.json`; the components you tick are recorded as `$elements` entries — in `project.json` for site-wide picks, in the document's own file for per-document picks.
:::

## Next

- **[Project settings](/docs/studio/projects/settings)** — the Dependencies section of the Settings modal
- **[Pages, layouts, and components](/docs/studio/projects/pages-layouts-components)** — what components are and when to make your own
