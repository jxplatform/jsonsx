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

:::::section{style.padding="clamp(2.5rem, 5vw, 3.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)" style.borderBottom="1px solid var(--color-border)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::p{style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.textTransform="uppercase" style.letterSpacing="0.12em" style.fontSize="0.72rem" style.fontWeight="800" style.color="var(--color-primary)" style.margin="0 0 0.9rem"}
The shop · 8 in stock
:::

:::h1{style.fontFamily="var(--font-heading)" style.fontSize="clamp(2.2rem, 4.5vw, 3.2rem)" style.fontWeight="800" style.letterSpacing="-0.03em" style.lineHeight="1.02" style.margin="0 0 0.75rem" style.color="var(--color-text-primary)"}
Every ride, one roof
:::

:::p{style.fontSize="1.1rem" style.color="var(--color-text-muted)" style.margin="0" style.maxWidth="60ch" style.lineHeight="1.6"}
From race-day carbon to a kid's first pedal bike. Filter by category on the left — the grid updates instantly, no page reloads — then tap any bike for the full spec.
:::
::::
:::::

::::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="clamp(2.5rem, 6vw, 4rem) 1.5rem" style.display="grid" style.gridTemplateColumns="268px 1fr" style.gap="clamp(1.5rem, 3vw, 2.5rem)" style.alignItems="start" style.--md.gridTemplateColumns="1fr"}
::shp-product-filter{}

:::::div
::::div{style.display="flex" style.alignItems="baseline" style.justifyContent="space-between" style.gap="1rem" style.flexWrap="wrap" style.marginBottom="1.25rem"}
:::div{style.fontWeight="700" style.fontSize="1rem" style.color="var(--color-text-primary)"}
Every bike & accessory, in stock
:::

:::div{style.display="inline-flex" style.alignItems="center" style.gap="0.4rem" style.fontSize="0.85rem" style.color="var(--color-text-muted)" style.fontWeight="600"}
↕ Sorted by featured
:::
::::

::::div{id="shop-grid" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.25rem" style.--lg.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/products"}
::shp-product-card{data-category="${item.data.category}" props.title="${item.data.title}" props.price="${item.data.price}" props.oldPrice="${item.data.oldPrice}" props.badge="${item.data.badge}" props.category="${item.data.category}" props.image="${item.data.image}" props.href="/products/${item.data.sku}/"}
:::
::::
:::::
::::::

::shp-cta{props.heading="Not sure which bike is you?" props.text="Tell us where you ride and we'll match you to the right frame, size, and setup — no pressure." props.cta="Ask a mechanic" props.ctaHref="/contact/" props.cta2="Book a fitting" props.cta2Href="/contact/"}
