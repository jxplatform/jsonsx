---
title: "Content types"
description: "Define content types in Jx Studio — a source folder, a format, and a field schema — and create schema-backed entries from the Manage view."
code:
  - packages/studio/src/settings/contributed-section.ts
  - packages/studio/src/settings/schema-field-ui.ts
  - packages/studio/src/browse/browse.ts
  - extensions/parser/src/Content.class.json
---

# Content types

Content types are your site's CMS schema. Each one describes a collection — blog posts, team members, projects — by naming the folder its entries live in, the file format they use, and the fields every entry carries. Once a type exists, creating an on-model entry is one click. Open the builder from the **Settings** gear at the bottom of the activity bar, then _Settings > Content Types_: your types are listed on the left, and selecting one opens its editor on the right.

![The Content Types section with a type selected and its field schema open in the builder](/screenshots/content-type-builder.png)

## Create a content type

1. Click **New Entry** at the bottom of the type list.
2. Type a name — "Blog Posts" becomes `blog-posts` — and click **Create**.

The new type starts with a matching source folder (`content/blog-posts/`) and an empty field schema, and is selected ready to edit.

## Source and format

- **Source** — the project folder entries are read from. The default matches the type's name; change it to point anywhere inside your project.
- **Format** — the file format entries use, by name (for example Markdown or Csv). Leave it empty and the format is worked out from each file's extension.

## Build the field schema

The fields you add here become the form every entry fills in. Each field row has:

- A **name** — click it to rename.
- A **type** — string (text), number, boolean (yes/no), array (a list), object (a group of sub-fields), or reference.
- A **format** for string and array fields — **image**, **date**, or **color** — which upgrades the field's editor: image fields get the [media picker](/docs/studio/projects/media), date fields a date, and so on.
- A **Req** toggle marking the field as required.

An **object** field opens a nested area where you add sub-fields the same way. A **reference** field gets a **Target** picker naming another content type — that's how a post points at its author. The trash icon deletes a field.

## Rename or delete a type

With a type selected, edit its name in the editor's header to rename it, or click the trash icon beside the name to delete it. Deleting the type does not delete the entry files in its source folder.

## Create entries from Manage

Back in the [Manage view](/docs/studio/projects/browse), the **New** menu lists an item for every content type you've defined:

1. Click **New** and pick the type — for example **Blog-posts**.
2. Name the entry. Studio creates the file in the type's source folder with every schema field pre-filled with a sensible blank, and opens it.

Entries show up under Manage's **Content** filter labeled with their type, and when you open one, Studio recognizes which type it belongs to and presents its fields as a form — see **[Frontmatter and page metadata](/docs/studio/editing/frontmatter)**.

:::doc-note
Studio stores your types in the `content` section of `project.json` — one entry per type, recording its `source` folder, `format`, and field `schema`. Pages query these collections to list and display entries; see [Site architecture](/docs/framework/site).
:::

## Next

- **[Browse your project](/docs/studio/projects/browse)** — the Manage view where entries are created
- **[Project settings](/docs/studio/projects/settings)** — the rest of the Settings modal
