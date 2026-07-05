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

:::::section{style.padding="clamp(3rem, 6vw, 4.75rem) 1.5rem clamp(2.5rem, 5vw, 3.5rem)" style.backgroundColor="var(--color-bg-cream)" style.textAlign="center"}
::bit-section-header{props.eyebrow="Breakfast · Lunch · Dinner" props.heading="The" props.headingAccent="Menu" props.subheading="Our kitchen shifts with the seasons — here's what we're serving this week. Served daily; the kitchen closes half an hour before we do."}
:::::

:::::section{style.columnCount="2" style.columnGap="clamp(2.5rem, 5vw, 5rem)" style.maxWidth="1020px" style.margin="0 auto" style.padding="clamp(3rem, 6vw, 4.75rem) 1.5rem" style.--md.columnCount="1" style.--md.maxWidth="var(--max-width-narrow)"}
::::bit-menu-group{props.heading="Starters" props.note="To begin — small, bright plates."}
:::Array{items.ref="#/state/starters"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::

::::bit-menu-group{props.heading="Mains" props.note="From the pass — hearty and seasonal."}
:::Array{items.ref="#/state/mains"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::

::::bit-menu-group{props.heading="Desserts" props.note="Something sweet to finish."}
:::Array{items.ref="#/state/desserts"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::

::::bit-menu-group{props.heading="Drinks" props.note="Coffee, and the good stuff."}
:::Array{items.ref="#/state/drinks"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::
:::::

::bit-cta{props.eyebrow="Reservations" props.heading="Hungry" props.headingAccent="yet?" props.text="Join us for breakfast, lunch, or dinner — or reserve a table for the weekend." props.cta="Reserve a Table" props.ctaHref="/contact/"}
