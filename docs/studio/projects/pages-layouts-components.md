---
title: "Pages, layouts, and components"
description: "When to use a page, a layout, or a component in Jx Studio, how to create each one from the Library, and where each lives in your project folder."
spec:
  - site-architecture.md#2
code:
  - packages/studio/src/browse/library-model.ts
  - packages/studio/src/browse/library-pane.ts
  - packages/studio/src/services/references.ts
  - packages/studio/src/files/file-ops.ts
---

# Pages, layouts, and components

Everything you build in Studio is one of a few kinds of file. Knowing which is which, and when to reach for each, is most of what there is to learn about structuring a Jx site.

## Pages

A page is one address on your site. Each file in your project's `pages/` folder becomes one URL: the file named `index` is your home page, `about` becomes `/about`, and a file inside a `blog/` subfolder becomes `/blog/…`. Add a page and you've added a place visitors can go; delete it and the address is gone.

Routing details (dynamic addresses, catch-alls) live in **[Site architecture](/docs/framework/site)**.

## Layouts

A layout is the shared frame around your pages: the header, footer, and everything else that repeats on every page of a section. Layouts live in the `layouts/` folder, and each page picks the layout that wraps it, so changing the header in one layout changes it on every page that uses it.

Reach for a layout when you catch yourself rebuilding the same surroundings on a second page.

## Components

A component is a reusable building block: a card, a hero section, a testimonial, a navigation bar. Components live in the `components/` folder and can be placed on any page or layout, as many times as you like. Edit the component once and every place it appears updates.

Reach for a component when the same element shows up more than once, or when a page is getting big enough that you want to name its parts. The underlying idea is documented in **[Components](/docs/framework/concepts/components)**.

## Create one

All three are created the same way, from the [Library](/docs/studio/projects/browse):

1. Press :kbd[⌘K] and run **Open Library**.
2. Click **New** and choose **Page**, **Layout**, or **Component**. Each row names the folder the file will land in. (The menu also lists your project's content types. For a content entry, see [Content types](/docs/studio/projects/content-types).)
3. Type a file name in the dialog (with the extension you want, such as `about.md` or `hero.json`) and click **Create**. The dialog names the folder it is creating in and refuses a name that folder already holds. Studio writes the file and opens it in a tab, ready to edit.

![The Library open in a Studio pane, listing a project's pages and components as cards with live previews](../../images/mode-manage.png)

:::doc-note
Studio writes each new file into `pages/`, `layouts/`, or `components/` in your project folder. They are plain files you can rename, duplicate, or delete from the Library's right-click menu.
:::

## Where is it used?

Once a component is placed on a few pages, the useful question stops being "what does this do?" and becomes "what depends on it?" Select any component instance on the canvas and the inspector answers, right under its settings: **Used on 3 pages and 1 other file**. Expand it for the list, and click any row to open that file.

The same answer is reachable by name: **Find Usages** in the command palette, or in the right-click menu on a component.

:::doc-tip
The count separates **pages** from **other files** on purpose. A component used only inside another component has not been placed on your site yet; a component used on seven pages is load-bearing.
:::

### Before you delete or rename

Every delete and rename confirmation carries that same count, so you can see what an action breaks before you take it, not after.

- **Deleting** a file tells you how many references stop resolving, and that the files holding them stay exactly where they are. Only the references break.
- **Renaming** a file tells you how many references will be **updated automatically**. Studio rewrites every one of them across the project, and for a component it renames the element tag to match the new filename too.

If Studio cannot count (a backend without project search), the confirmation says so rather than showing a zero. "We could not check" and "nothing uses this" are never displayed as the same thing.

## Which one do I want?

- **A destination** people should be able to visit → a **page**.
- **The frame** that repeats around many pages → a **layout**.
- **An element** that repeats within pages → a **component**.

When in doubt, start with a page. You can always select part of it later and grow that part into a component once it earns reuse.

## Next

- **[Design mode](/docs/studio/design)**: style what you just created on the live canvas
- **[Edit mode](/docs/studio/editing)**: write content inline
- **[Site architecture](/docs/framework/site)**: the folder-by-folder anatomy underneath
