---
title: "Browse your project"
description: "The Manage surface in Jx Studio: browse your project, create pages and content, upload media, and define content models."
code:
  - packages/studio/src/browse/browse.ts
---

# Manage

Manage is your project's home base — the file layer and the CMS layer in one place. Open it from the toolbar to see everything your site is made of, with live previews.

![Jx Studio Manage Files modal with live previews of every project file](../../images/mode-manage.png)

## Browse your project

The Manage modal groups everything by kind — **Pages**, **Layouts**, **Components**, **Content**, and **Media** — with a live preview of each page and component and a thumbnail for every asset. Filter and search to jump to a file, and switch between grid and table views.

Right-click any file to **open**, **rename**, **duplicate**, or **delete** it.

## Create pages and content

Use **New** to add a Page, Layout, or Component. Studio asks for a name in a dialog — it tells you which folder the file lands in, and turns what you type into a file name (`About Us` becomes `about-us`). Studio also lists an entry for each **content type** your project defines, so creating a blog post or a doc is one click — Studio pre-fills the frontmatter from that type's schema.

## Upload media

Drag images, video, audio, PDFs, or fonts into Manage — or click **Upload** — and Studio writes them into your project, ready to reference. Files land in the folder for whichever category filter is active, so with **Media** selected they go to `public/`. An upload never overwrites: a file whose name is already taken becomes `hero-1.jpg`. The site build optimizes images automatically (responsive `srcset`, WebP/AVIF).

Manage is one of four places you can add media from — see **[Media](/docs/studio/projects/media)** for the canvas, Files-panel, and image-field routes.

## Model your content

Content types are your CMS schema — each one defines where a collection lives, what format its entries use, and what fields they carry. Define and edit them in **[Content types](/docs/studio/projects/content-types)**.

## Next

- Author content in **[Edit](/docs/studio/editing)**
- Design components in **[Design](/docs/studio/design)**
