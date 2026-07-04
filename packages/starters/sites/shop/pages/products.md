---
title: "Shop Bikes & Gear — Cadence Cycles"
state:
  products:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: product
    sort:
      field: order
      order: asc
---

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::shp-section-header{props.eyebrow="The shop" props.heading="Every ride, one roof" props.subheading="From race-day carbon to a kid's first pedal bike. Filter by category to find your fit — then tap through for the full spec."}
:::::

::::::section{style.padding="clamp(3rem, 8vw, 5rem) 1.5rem"}
::shp-product-filter{}

:::::div{id="shop-grid" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.maxWidth="var(--max-width)" style.margin="0 auto" style.--md.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
::::Array{items.ref="#/state/products"}
:::div{data-category="${item.data.category}"}
::shp-product-card{props.title="${item.data.title}" props.price="${item.data.price}" props.category="${item.data.category}" props.image="${item.data.image}" props.href="/products/${item.data.sku}/"}
:::
::::
:::::
::::::

::shp-cta{props.heading="Not sure which bike is you?" props.text="Tell us where you ride and we'll match you to the right frame, size, and setup — no pressure." props.cta="Ask a Mechanic" props.ctaHref="/contact/"}
