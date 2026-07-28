---
title: "Media"
description: "Add images, video, audio, and fonts to a Jx project by dragging them onto the canvas, the Files panel, or Manage — or upload straight from any image field."
spec:
  - site-architecture.md#9
  - studio.md#9
code:
  - packages/studio/src/files/media-upload.ts
  - packages/studio/src/browse/browse.ts
  - packages/studio/src/ui/media-picker.ts
  - packages/studio/src/editor/file-drop-action.ts
---

# Media

Your site's media — images, video, audio, PDFs, and fonts — lives in your project alongside everything else, and Studio can add it from wherever you already are. Drag a file onto the page you are designing, onto a folder in the Files panel, or onto the Manage view; or click **Upload** on any image field.

![The Manage view with live previews and thumbnails of every project file](../../images/mode-manage.png)

## Drag onto the canvas

Drag an image from your desktop onto the page:

- **Onto empty space** — Studio uploads it and drops an image in at that spot. You'll see the same insertion line you get when dragging an element from the Elements panel.
- **Onto an image that's already there** — the picture is highlighted, and dropping swaps it for the new one. Nothing else about the element changes: its size, alt text, and styling all stay put.

Video, audio, and other files work too. A video becomes a `<video>` player, audio becomes an `<audio>` player, and anything else (a PDF, say) becomes a download link labelled with the filename. Drop several files at once and they land in order.

:::doc-tip
Dropping onto a component that takes a single image — a card with a cover picture, for instance — replaces that picture, not the whole component.
:::

## Upload from an image field

Wherever Studio asks for an image or file — an image's **Properties**, a frontmatter field, the **Document** activity's icon and social-image fields — the field has an **Upload** button beside the browse button. Click it, pick a file, and Studio adds it to the project and fills the field in for you.

![The media picker popover open over an image's Properties, showing the search field and thumbnail list](../../images/media-picker.png)

## Drag into the Files panel

Drag files onto any folder in the Files panel and they upload into that folder — the folder highlights as you hover it, and expands once the files land. Dropping onto a file puts the upload beside it, in the same folder. Dropping onto empty space in the panel puts it at the top level of your project.

You can also right-click a folder and choose **Upload Files…** to pick from a dialog instead.

## Drag into Manage

Open Manage with the **Manage** button in the toolbar, then drag files anywhere onto it — or click **Upload**. Files land in the folder for whichever category filter is active: with **Media** selected they go to `public/`, with **Layouts** selected they go to `layouts/`, and so on.

![The Manage view highlighted as a drop target while files are dragged onto it](../../images/media-upload.png)

Right-click any asset to **rename**, **duplicate**, or **delete** it. Renaming preselects just the name, so typing replaces `hero` in `hero.jpg` and leaves the extension alone.

## Where your files go

When you don't pick a folder yourself, Studio decides from what you're editing:

| You're editing             | Files land in                  | Referenced as       |
| -------------------------- | ------------------------------ | ------------------- |
| A content collection entry | `content/<collection>/images/` | `./images/hero.jpg` |
| Anything else              | `public/`                      | `/hero.jpg`         |

Everything in `public/` is served from your site's root, so `public/hero.jpg` becomes `/hero.jpg` on the published site. Media kept beside a content entry travels with it — useful when a blog post's pictures belong to that post rather than to the site as a whole. The folder layout is documented in [Site architecture](/docs/framework/site).

:::doc-note
Uploads never overwrite. If a file of the same name is already there, the new one becomes `hero-1.jpg`, then `hero-2.jpg`, and so on — the original is left alone.
:::

## What the build does to images

You only ever upload one copy of an image, at full quality. When your site is built for publishing, each image is optimized automatically: the build generates multiple sizes and modern formats (WebP, AVIF) and wires them up so every visitor's browser downloads the smallest version that looks sharp on their screen. There is nothing to configure in Studio — the pipeline is described in **[Site architecture](/docs/framework/site)**.

## Next

- **[Browse your project](/docs/studio/projects/browse)** — the rest of the Manage view
- **[Publish](/docs/studio/publish)** — how the optimized site goes live
