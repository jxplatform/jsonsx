---
title: "Frontmatter and page metadata"
description: "Fill in page titles, descriptions, social cards, and content-type fields with Jx Studio's Page panel and Document Header card — no YAML required."
code:
  - packages/studio/src/panels/head-panel.ts
  - packages/studio/src/panels/frontmatter-panel.ts
  - packages/studio/src/panels/frontmatter-fields.ts
---

# Frontmatter and page metadata

Every page carries information that isn't part of its visible text: a title, a description for search engines, an image for social shares, and — for content like blog posts — fields such as a date, an author, or tags. This is the page's _frontmatter_, and Studio edits all of it as plain forms.

Two surfaces show these fields: the **Page** panel in the Navigator, and the **Document Header** card on the page itself.

## The Page panel

Click **Page** in the **Document** group of the Navigator rail, or press :kbd[⌘6]. Its header reads **PAGE · document**, and its sections, top to bottom, depend on the file you have open:

![The Page panel showing Frontmatter, Page, and OpenGraph sections for a blog post](../../images/document-panel.png)

### Frontmatter

For a content page that belongs to a collection — a blog post, a product, a listing — this section lists the collection's fields, with required ones marked `*`. Each field gets a control that fits its type:

- Text fields, number fields, and date fields (dates as `YYYY-MM-DD`)
- On/off checkboxes
- A dropdown for fields with a fixed set of choices
- A media picker for image fields
- Comma-separated entry for list fields

Any extra field already present in the file appears too, even if the collection doesn't define it. Clearing a field removes it from the file entirely. Collections and their fields are defined in **[Content types](/docs/studio/projects/content-types)**.

### Layout

Site pages also get a **Layout** picker: keep the project default, choose a specific layout, or pick **None** — see **[Pages, layouts, components](/docs/studio/projects/pages-layouts-components)**.

### Page

The basics every page should have:

- **Title** — the browser-tab and search-result title.
- **Description** — the summary search engines show under the title.
- **Viewport** — leave the suggested default unless you have a specific reason not to.
- **Icon** — the small icon in the browser tab, picked from your media.

### OpenGraph

The card shown when the page is shared on social platforms: **Title**, **Description**, **Image**, and **Type**. If you fill in nothing else, fill in these and the Page section — they're what links to your site look like elsewhere.

### Custom Tags

The escape hatch for everything else that can live in a page's head — analytics, a verification token, a webfont. Pick a tag (`meta`, `link`, or `script`), type its attribute and value, and click the add button. Existing custom entries are listed with a remove button each; before you add the first one the section says what it's for, with the add form right beneath. Most sites never need this section.

## The Document Header card

Every page with frontmatter or head tags carries a **Document Header** card, and it sits on the page rather than in a panel: in Edit view it's the first block of the document itself, above your first paragraph, and it scrolls with the page. In Design view it's pinned above the artboards, at normal size, so the fields stay usable however far you've zoomed out.

The card states the page's title and its route, offers the layout picker, and lists the collection's fields — the same set as the Page panel's Frontmatter section, title included. Two disclosures sit underneath: **SEO** (description, viewport, icon, and the OpenGraph card) and **Raw head tags**, which lists any head entries no form owns, read-only. There's no control to summon or dismiss the card; a page that has a header shows one.

![The Document Header card above a post open in Edit view](../../images/properties-bar.png)

:::doc-note
On disk, all of this lives at the top of the page's own file, in a small labeled block above the content — the frontmatter. That's why metadata travels with the page: copy the file and everything comes along, and any text editor can read it.
:::

## Next

- Edit a whole collection's frontmatter at once in **[Grid mode](/docs/studio/editing/grid)**
- Define collections and their fields in **[Content types](/docs/studio/projects/content-types)**
