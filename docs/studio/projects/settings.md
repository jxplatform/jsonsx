---
title: "Project settings"
description: "A tour of the Settings modal in Jx Studio: general options, head tags, CSS variables, definitions, dependencies, and extension-added sections."
code:
  - packages/studio/src/settings/settings-modal.ts
  - packages/studio/src/settings/general-settings.ts
  - packages/studio/src/settings/head-editor.ts
  - packages/studio/src/settings/css-vars-editor.ts
  - packages/studio/src/settings/defs-editor.ts
  - packages/studio/src/settings/dependencies-editor.ts
  - packages/studio/src/settings/extension-sections.ts
---

# Project settings

The Settings modal holds everything that applies to your whole site rather than one page — the favicon, fonts, design tokens, and dependencies. Open it with the **Settings** gear at the bottom of the activity bar; a navigation list on the left switches between sections.

![The Settings modal open on the General section, with the section list on the left](/screenshots/settings-modal.png)

Changes save as you make them — there is no separate save button.

## General

The basics of the site:

- **Favicon** — click **Upload Favicon** and pick an image; Studio copies it into your project and shows the current one beside the button.
- **Platform Adapter** — how the build packages the site for your host: **Static**, **Bun**, **Node**, **Cloudflare Workers**, or **Cloudflare Pages**. This is the same choice you made when [creating the project](/docs/studio/projects/create); **Static** works for any host that serves files.
- **Breakpoints** — the screen sizes your design responds to, as name/value rows. The **Base** row is your default canvas width; **+ Add Breakpoint** adds another, and the × button removes one.
- **Global Styles** — a shortcut that opens the project file where site-wide default styles live.

## Head

What goes into every page's `<head>` — the invisible part of a web page that loads fonts, styles, and services:

- **Google Fonts** — type a font family name and click **+ Add** to load it across the whole site. Loaded fonts are listed with a delete button each.
- **Head tags** — add a **Link** (external stylesheet), **Meta** (page metadata), **Script**, or **Style** entry and fill in its fields. Script and Style entries get a text box for their body — this is where an analytics snippet or a custom style block goes.

## CSS Variables

Your design tokens — the named colors, fonts, and sizes your styles refer to, grouped into **Colors** (each with a color swatch you can click to pick), **Fonts** (each with a live preview line), **Sizes & Spacing**, and **Other**. Edit a value and every element that uses the token updates; sizes can also carry per-breakpoint overrides so spacing tightens on small screens.

## Definitions

Reusable field schemas — descriptions of data shapes (an API response, a shared record type) that other parts of the project can refer to. Definitions use the same visual field builder as content types: named fields with a type, an optional format, and a required toggle. Most sites never need this section; for modeling your content itself, use **[Content types](/docs/studio/projects/content-types)** instead.

## Dependencies

The npm packages your project uses, as a table of name, current version, and the latest available version:

- Type a package name and click **Add** to install one.
- A refresh icon appears on any row with an update available; **Update all** takes every row to its latest at once.
- **Reinstall** re-installs everything from scratch — the fix-it button if packages ever end up in a bad state.

Adding packages and choosing which of their components your site uses is covered in **[Dependencies and imports](/docs/studio/projects/dependencies)**.

## Sections added by extensions

Extensions can contribute their own settings sections, which appear in the same list. **Content Types** — the section where you model your site's content — arrives this way, and has its own page: **[Content types](/docs/studio/projects/content-types)**.

:::doc-note
Every section of this modal edits `project.json` at the root of your project — the same file the New Project modal first wrote. The full shape is documented in [Site architecture](/docs/framework/site).
:::

## Next

- **[Content types](/docs/studio/projects/content-types)** — model your content in the Content Types section
- **[Dependencies and imports](/docs/studio/projects/dependencies)** — packages and component imports in depth
