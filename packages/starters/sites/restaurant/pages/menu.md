---
title: "Menu — Bistro & Café"
state:
  starters:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: menu
    filter:
      - field: course
        op: "=="
        value: Starters
    sort:
      field: order
      order: asc
  mains:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: menu
    filter:
      - field: course
        op: "=="
        value: Mains
    sort:
      field: order
      order: asc
  desserts:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: menu
    filter:
      - field: course
        op: "=="
        value: Desserts
    sort:
      field: order
      order: asc
  drinks:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: menu
    filter:
      - field: course
        op: "=="
        value: Drinks
    sort:
      field: order
      order: asc
---

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::bit-section-header{props.eyebrow="Breakfast · Lunch · Dinner" props.heading="The Menu" props.subheading="Our menu shifts with the seasons — here's what we're serving right now."}
:::::

:::::section{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem"}
::::bit-menu-group{props.heading="Starters"}
:::Array{items.ref="#/state/starters"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::

::::bit-menu-group{props.heading="Mains"}
:::Array{items.ref="#/state/mains"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::

::::bit-menu-group{props.heading="Desserts"}
:::Array{items.ref="#/state/desserts"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::

::::bit-menu-group{props.heading="Drinks"}
:::Array{items.ref="#/state/drinks"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::
:::::

::bit-cta{props.heading="Hungry yet?" props.text="Join us for breakfast, lunch, or dinner — or reserve a table for the weekend." props.cta="Reserve a Table" props.ctaHref="/contact/"}
