---
title: "Repeaters"
description: "Repeaters in Jx Studio: turn one element into a repeating list, bind it to your data, and use each item's fields inside the template."
code:
  - packages/studio/src/editor/convert-to-repeater.ts
  - packages/studio/src/editor/repeater-scope.ts
  - packages/studio/src/panels/properties-panel.ts
---

# Repeaters

A repeater renders one element once per item of a list — design a single card, bind it to your products, and get a card per product. The element you design becomes the repeater's _template_; the list it follows can be state, a content collection, or a data source.

## Turn an element into a repeater

1. Design one instance of the repeating thing — one card, one row, one gallery tile.
2. Right-click it (on the canvas or in [Layers](/docs/studio/design/layers)) and choose **Repeat…**.
3. In the dialog, pick the **Items source** — a list from the document's state, or **Create new…** to declare a fresh one by name.
4. Optionally pick a **Filter** or **Sort** function, if the document defines any.
5. Click **Create Repeater**.

![The Repeat dialog with an items source selected](../../images/repeat-dialog.png)

Your element is now the template of a repeater, marked **↻** in Layers. The repeated items render directly where the element stood — no wrapper is added around them.

## Bind the list

The items source is what makes a repeater useful. It can be:

- **A plain list in state** — start with `Create new…` and fill in items later in the **State** panel.
- **A content collection** — every blog post, product, or team member in your project's content. See **[Content types](/docs/studio/projects/content-types)**.
- **A data source** — anything that produces a list, like a `Request` fetching from an API.

Declaring and feeding these lives in **[Script & logic](/docs/studio/logic)**. With the repeater selected, the [Properties panel](/docs/studio/design/properties) shows a **Repeating list** section where you can rebind **Items** and add or change **Filter** and **Sort** after the fact.

## Edit the template

Select the repeater and click **Edit template →** in the **Repeating list** section — or just click into the repeated content on the canvas. On the design canvas the template renders once, as the single element you design; switch on the **Preview** toggle to see the list expanded with its real items (see **[Modes and preview](/docs/studio/interface/modes)**).

Inside the template, each item's data is in scope:

- While editing text, the **Insert data** button on the block action bar offers `item` — the current item — and `index`, its position, alongside the item's own fields: `item.data.title` for a content collection's fields, or `item.name`-style fields for lists of records.
- In the Properties panel, binding menus offer the current item and its position wherever a `$ref` binding is available.

Bind the template's text and attributes to item fields and every rendered copy fills itself in from its own item.

:::doc-warning
The template is one element styled once — changes to it apply to every repeated item. To make one item special, style by position with a selector like `:first-child` (see **[Hover states and selectors](/docs/studio/design/states-and-selectors)**) or use data-driven styling.
:::

:::doc-note
A repeater is stored in the file as an `Array` node with `items` (the binding), `map` (the template), and optional `filter` and `sort`. The reactive model behind it is described in **[Reactivity](/docs/framework/concepts/reactivity)**.
:::

## Next

- Feed repeaters from collections — **[Content types](/docs/studio/projects/content-types)**
- Make the template a reusable component — **[Working with components](/docs/studio/design/components)**
