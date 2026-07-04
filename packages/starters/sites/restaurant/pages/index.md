---
title: "Bistro & Café — Seasonal plates & small-batch coffee"
state:
  popular:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: menu
    sort:
      field: order
      order: asc
    limit: 4
---

::bit-hero{props.eyebrow="Riverbend · Est. 2016" props.heading="A table worth lingering at." props.subheading="Seasonal plates, house-made pastries, and small-batch coffee — served in a warm room just off Market Street." props.cta="Reserve a Table" props.ctaHref="/contact/" props.cta2="View the Menu" props.cta2Href="/menu/" props.bg="/images/hero.jpg"}

:::bit-intro{props.image="/images/intro.jpg" props.imageAlt="Chef plating a seasonal dish"}

### More than a meal

We opened Bistro & Café to build a room worth slowing down in. Everything on the menu starts with what's good this week — from the farm up the road, roasted, baked, and plated by hand.

Come for the coffee, stay for the roast chicken.
:::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::bit-section-header{props.eyebrow="Our kitchen" props.heading="Cooked with care, sourced with intention"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="1fr"}
::bit-feature{props.icon="🌿" props.title="Seasonal & local" props.text="The menu changes with the harvest. We buy from growers we know by name."}

::bit-feature{props.icon="🥖" props.title="Made in-house" props.text="Bread, pastry, stocks, and sauces — all made from scratch every morning."}

::bit-feature{props.icon="☕" props.title="Small-batch coffee" props.text="A rotating single-origin, roasted locally and pulled to order."}
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::bit-section-header{props.eyebrow="From the menu" props.heading="A few favorites"}

::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto"}
:::Array{items.ref="#/state/popular"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::

::::div{style.textAlign="center" style.marginTop="2rem"}
:::a{href="/menu/" style.display="inline-block" style.color="var(--color-primary)" style.fontWeight="600" style.textDecoration="none" style.fontSize="1.05rem"}
See the full menu →
:::
::::
:::::

::bit-gallery{props.img1="/images/gallery-1.jpg" props.img2="/images/gallery-2.jpg" props.img3="/images/gallery-3.jpg" props.img4="/images/gallery-4.jpg" props.alt="Dishes and the dining room at Bistro & Café"}

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="2.5rem" style.alignItems="center" style.--md.gridTemplateColumns="1fr"}
::bit-hours{props.heading="Hours"}

::bit-review{props.quote="The kind of neighborhood spot you wish was on your corner. The roast chicken is worth the trip." props.author="Dana R." props.role="Regular since 2019"}
::::
:::::

::bit-cta{props.heading="Save your table" props.text="Weekends fill up fast. Reserve online, or just walk in and say hello." props.cta="Reserve a Table" props.ctaHref="/contact/"}
