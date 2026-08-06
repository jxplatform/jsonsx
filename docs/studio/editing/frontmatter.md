---
title: "Frontmatter and page metadata"
description: "Fill in titles, descriptions, social cards, and content-type fields with Jx Studio's Page panel and Document Header card — and preview the merged head."
spec:
  - site-architecture.md#8.6
code:
  - packages/studio/src/panels/head-panel.ts
  - packages/studio/src/panels/frontmatter-panel.ts
  - packages/studio/src/panels/frontmatter-fields.ts
  - packages/studio/src/panels/provenance.ts
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
- An entry picker for a field that points at another collection, so you choose an existing entry instead of typing its id from memory

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

Its bar names what the document is — the collection it belongs to, or **Document** when it belongs to none — and, for a page, prints the route it will be published at. Underneath sit the **Title** field, the layout picker for site pages, and the collection's own fields: the same set as the Page panel's Frontmatter section. There's no control to summon or dismiss the card; a document that has a header shows one.

![The Document Header card above a post open in Edit view](../../images/properties-bar.png)

Two disclosures close the card: **SEO**, and **Raw head tags** — every head entry no form owns, listed read-only, so a tag you can't see can't surprise you. The Page panel remains the place to add and remove those.

## The SEO block

Open **SEO** and the first thing the card shows is not a form but two pictures of the finished page: a **Search result** preview — breadcrumb, title, description — and a **Social card** preview with its image, domain, headline and summary. Below them is the resolved-field list, then the warnings, and only then the controls that change any of it.

:::doc-note
**The previews show the merged head, not just what this page declares.** A page's metadata is layered: the project's own `$head`, then the layout's, then the page's, with the later layer winning key by key. The title follows the same idea — the page's own title, or the project name, or `Jx Site` if nothing supplies one. What the previews draw is the result, which is what a search engine or a chat app will actually see.
:::

### The resolved fields

One row per value that reaches the browser — Title, Description, Social title, Social description, Social image, Social type — each showing the merged value, a character count against the length at which that field gets cut (`47/160`), and a chip saying where the value came from.

A value this page sets shows the ordinary set dot. A value it inherits is marked **inherited** and names its donor: _from Base_ for a layout, _from Site head_ or _from Site name_ for the project, _from the build_ for a value the build supplies on your behalf. The two chips that lead somewhere are clickable and open the setting in Project Settings; the layout and build chips are plain text, because the card has no verb for them.

That marking is the whole point of the block. A page inheriting its description from the site is not a page missing a description, and until the preview said which was which, the two looked identical.

### The warnings

A named list, in plain language, of things that are wrong or absent — and it is decided on the **merged** value, so a page that inherits a description is never told it has none. Among them:

- Nothing names a title, so the build ships `Jx Site`.
- No description reaches this page from the site, its layout, or the page itself — a result row will show whatever text the engine picks instead.
- No `og:title`, `og:description`, or `og:image` — a shared link with no headline, no summary, or a text-only card.
- A field is longer than its budget, with the actual length: _Description is 187 characters; summaries are cut near 160._
- Project Settings names no site URL, so the build emits no canonical link and no `og:url`.
- A `<title>` element inside `$head` is discarded — the build writes the title from the document's own title property.

When there is nothing to say, the block says that too: _Nothing to flag — every previewed field resolves to a value._

:::doc-tip
**There is no score.** Counters and named warnings only. A single number out of a hundred adds unrelated facts together into a verdict, and the verdict is what ends up being optimized; a count beside a limit and a named consequence tell you the same thing without ranking anything.
:::

### The fields themselves

Under the warnings are the controls: **Description** and **Viewport**, the **Icon** picker, and the four OpenGraph fields. They edit exactly what the Page panel's Page and OpenGraph sections edit — the same values, from wherever you happen to be working.

:::doc-note
On disk, all of this lives at the top of the page's own file, in a small labeled block above the content — the frontmatter. That's why metadata travels with the page: copy the file and everything comes along, and any text editor can read it.
:::

## Next

- Edit a whole collection's frontmatter at once in **[Grid mode](/docs/studio/editing/grid)**
- Define collections and their fields in **[Content types](/docs/studio/projects/content-types)**
- How the three layers merge, and what the build adds, in **[SEO and metadata](/docs/framework/site/seo)**
