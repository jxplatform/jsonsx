---
title: "Coming from WordPress"
description: "How WordPress concepts map to Jx — themes, blocks, custom post types, media, plugins, publishing — and what's honestly different when content is files."
---

# Coming from WordPress

Most of what you know transfers. You still design visually, write in place, model structured content, and publish from the same tool. What changes is the machinery underneath: your content isn't in a database, there's no `wp-admin`, and no PHP running anywhere — your pages are built ahead of time instead of assembled on every request. A Jx site is a folder of plain files that [Jx Studio](/docs/studio) edits on your machine, and publishing means pushing those files to git so your host can build them into the finished site. A site that needs a real database or server-side logic can have both — see [Databases](/docs/studio/data) — but that's a layer you opt into, not the substrate your pages sit on.

If Cwicly's shutdown is what brought you here: welcome — losing a good tool mid-project is rough, and you're in familiar company. It's also the failure mode Jx is designed to rule out. Your site is plain files in your own folder and your own repository, so it can't disappear with anyone's product.

## The concept map

| WordPress                         | Jx                                | Where to look                                        |
| --------------------------------- | --------------------------------- | ---------------------------------------------------- |
| Theme                             | Starter + Project Styles + tokens | [Starter templates](/docs/studio/projects/starters)  |
| Blocks                            | Elements and components           | [Elements](/docs/studio/design/elements)             |
| The block editor                  | Edit mode                         | [Edit mode](/docs/studio/editing)                    |
| Custom post types + custom fields | Content types                     | [Content types](/docs/studio/projects/content-types) |
| Media library                     | Media                             | [Media](/docs/studio/projects/media)                 |
| Plugins                           | Extensions and npm packages       | [Extending](/docs/extending)                         |
| Publish button                    | Commit and sync                   | [Publish](/docs/studio/publish)                      |

The rest of this page walks through each row, then gets honest about what's different.

## Themes

A WordPress theme bundles templates, default styles, and options into something you install — and switching themes means starting over. In Jx the same jobs are separate, ordinary parts of your project:

- A **[starter template](/docs/studio/projects/starters)** gives you complete pages, components, and content to reshape. Nothing about a starter is special afterward — it's plain files you own, with no parent theme to update or fight.
- The **[Project Styles](/docs/studio/design/stylebook)** sets the default look of every heading, button, link, and form control in one catalog.
- **[Design tokens](/docs/studio/design/tokens)** name your colors, fonts, and sizes once, so the whole site draws from one palette.

## Blocks and the editor

Gutenberg's blocks split into two ideas. **Elements** are the building parts — headings, images, sections, buttons — placed from the [Insert palette](/docs/studio/design/elements) by click or drag. **[Components](/docs/studio/design/components)** are your reusable patterns: select something you built, turn it into a component, and reuse it with per-use properties — closer to block patterns, except you make them from your own work instead of registering them with code.

Writing feels like the part of Gutenberg you liked. Open a content page in [Edit mode](/docs/studio/editing) and the canvas becomes the page itself: click any text and type, use slash commands for headings, lists, images, and tables. It saves as Markdown files, not rows in a `posts` table.

![Jx Studio's Edit mode with a content page open for inline writing on the canvas](../images/mode-edit.png)

## Custom post types and fields

If you've modeled content with custom post types and Advanced Custom Fields, **[content types](/docs/studio/projects/content-types)** are the same idea made first-class. Name a collection, define its fields — text, numbers, images, dates, required flags, even references from one type to another (a post pointing at its author) — and every entry gets a matching form.

Entries are files in a folder instead of database rows: Markdown, CSV, or JSON. You can edit a whole collection like a spreadsheet in [Grid mode](/docs/studio/editing/grid), and pages query collections to build listing and detail pages — the archive template and single template, reborn. Build one end to end in **[Your first collection](/docs/start/first-collection)**.

## Media

Drag files into the Library and they land in your project's `public/` folder — no attachment posts, no uploads table. When the site builds, every image is optimized automatically into multiple sizes and modern formats, which is the job you used to install an optimizer plugin for. See **[Media](/docs/studio/projects/media)**.

## Plugins

This is the honest gap. Jx has an [extension system](/docs/extending) — first-party extensions like the Markdown parser use the same public hooks yours would — and Studio can pull in npm packages of ready-made components through the [Imports panel](/docs/studio/projects/dependencies). But there is no plugin marketplace yet, and the catalog is a fraction of the WordPress directory's.

The counterweight: much of what plugins did for you is built in (image optimization, SEO metadata, forms UI, caching — a prebuilt page _is_ the cache) or unnecessary (security scanners, backup plugins — your repository is the backup). The server-backed ones — a members area, a form that stores what visitors send — are a third case: the parts ship with Jx, as [database tables](/docs/studio/data/tables) and [accounts and sessions](/docs/studio/data/auth-and-secrets), but you assemble the feature instead of activating someone else's.

## Publishing

There's no Publish button mutating a live server. When you're happy, open **Source Control**, write a message, and **Commit and sync** — Studio pushes your files to your repository, and your host rebuilds the site from them. The result is prebuilt pages served from a CDN. The whole flow is in **[Publish](/docs/studio/publish)**.

## What's different, in one list

- **Content isn't in a database.** Pages and posts are files you can read, search, and diff. The data that arrives while the site runs — comments, sign-ups, orders — goes in a real database you add on purpose ([Databases](/docs/studio/data)), kept apart from your writing.
- **No admin login.** _Editing_ happens in Studio on your machine, against your files — there's no hosted dashboard for bots to brute-force. Your site's own visitors can still have accounts; that's the [auth extension](/docs/studio/data/auth-and-secrets), and it's separate from how you edit.
- **No plugin marketplace yet.** Extensions and npm components exist; a browsable ecosystem doesn't, yet.
- **Publishing is git.** Studio handles the git parts with buttons, but a repository and a host are part of the setup.

## What you'll miss

- **The plugin directory.** Decades of plugins for every niche — commerce, memberships, event calendars. The server-backed pieces are buildable today: [data tables](/docs/studio/data/tables) give you real reads and writes, [auth](/docs/studio/data/auth-and-secrets) gives you accounts, sessions, and per-table permissions, and server-side functions cover the logic between them. What's missing is the shortcut — you build the feature instead of installing someone's finished one.
- **Editing from any browser.** `wp-admin` is a website; Studio is an app where your files are. Git lets you set up a second machine, but it's a clone, not a login.
- **The sheer size of the ecosystem** — hosts, agencies, themes, and twenty years of tutorials.

## What you gain

- **Nothing to maintain.** No core, plugin, or PHP updates; no security patching; the published pages are prebuilt files, with no admin login to break into.
- **Fast by default.** Prebuilt pages from a CDN and automatically optimized images, with no caching plugins to tune.
- **Version control of everything.** Design, settings, and content all live in git — every change is a reviewable commit you can roll back.
- **Portability.** Your content is Markdown any tool can open; moving hosts is a settings change, not a database migration.
- **A real design system.** Tokens and Project Styles instead of overriding theme CSS from a child theme.

## Start here

- **[Your first project](/docs/start/first-project)** — starter to published site in about ten minutes
- **[Your first collection](/docs/start/first-collection)** — build the Jx version of a custom post type
- **[A tour of Jx Studio](/docs/start/studio-tour)** — learn the workspace before diving in
