---
title: "Cadence Cycles — Shop road, mountain, gravel & kids' bikes"
state:
  featured:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: product
    sort:
      field: order
      order: asc
    limit: 4
---

::shp-hero{props.eyebrow="Featured build · New season" props.heading="Meet the Apex Carbon Road." props.subheading="Our flagship carbon race bike — hand-built, fitted in-store, and ready to fly. The bike our mechanics fight over on group-ride day." props.price="$3,299" props.badge="Bestseller" props.rating="4.9" props.cta="Add to cart" props.ctaHref="/products/apex-carbon-road/" props.cta2="Shop all bikes" props.cta2Href="/products/" props.image="/images/product-1.jpg" props.imageAlt="Apex Carbon Road bike"}

:::::section{style.padding="clamp(2.75rem, 6vw, 4rem) 0 clamp(1.5rem, 3vw, 2rem)"}
::shp-section-header{props.eyebrow="Shop by category" props.heading="Find your ride" props.subheading="Five ways to roll, from race-day carbon to a kid's first pedal bike."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="0 1.5rem" style.display="grid" style.gridTemplateColumns="repeat(5, 1fr)" style.gap="1rem" style.--md.gridTemplateColumns="repeat(3, 1fr)" style.--sm.gridTemplateColumns="repeat(2, 1fr)"}
::shp-category-tile{props.icon="🚴" props.name="Road" props.count="2 models" props.href="/products/"}

::shp-category-tile{props.icon="🚵" props.name="Mountain" props.count="2 models" props.href="/products/"}

::shp-category-tile{props.icon="🧭" props.name="Gravel" props.count="1 model" props.href="/products/"}

::shp-category-tile{props.icon="🧒" props.name="Kids" props.count="1 model" props.href="/products/"}

::shp-category-tile{props.icon="🎒" props.name="Accessories" props.count="2 items" props.href="/products/"}
::::
:::::

:::::section{style.padding="clamp(2.5rem, 6vw, 4rem) 0"}
::shp-section-header{props.eyebrow="Just in" props.heading="Fresh on the floor" props.subheading="The bikes our mechanics are most excited about this season."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="0 1.5rem" style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/featured"}
::shp-product-card{props.title="${item.data.title}" props.price="${item.data.price}" props.oldPrice="${item.data.oldPrice}" props.badge="${item.data.badge}" props.category="${item.data.category}" props.image="${item.data.image}" props.href="/products/${item.data.sku}/"}
:::
::::

::::div{style.maxWidth="var(--max-width)" style.margin="2.25rem auto 0" style.padding="0 1.5rem" style.textAlign="center"}
:::a{href="/products/" style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.padding="0.85rem 1.75rem" style.borderRadius="999px" style.border="1px solid var(--color-line-strong)" style.color="var(--color-text-primary)" style.fontWeight="700" style.textDecoration="none" style.fontSize="1rem"}
Shop all 8 products →
:::
::::
:::::

:::::section{style.padding="clamp(3rem, 7vw, 5rem) 1.5rem" style.backgroundColor="var(--color-bg-dark)" style.color="var(--color-text-white)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::p{style.display="inline-flex" style.alignItems="center" style.gap="0.45rem" style.margin="0 0 1.75rem" style.fontSize="0.72rem" style.fontWeight="800" style.textTransform="uppercase" style.letterSpacing="0.14em" style.color="var(--color-brand-bright)"}
Why ride with Cadence
:::

:::div{style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="2rem" style.--md.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
::shp-trust{props.icon="🔧" props.title="Built by mechanics" props.text="Every bike is assembled and safety-checked by a certified mechanic before it leaves the floor."}

::shp-trust{props.icon="📏" props.title="Fitted to you" props.text="A proper sizing and fit session comes free with every bike — no guesswork, no aches."}

::shp-trust{props.icon="🚚" props.title="Free shipping $50+" props.text="Orders over fifty ship free, and bikes arrive road-ready with a free first tune-up."}

::shp-trust{props.icon="↩" props.title="30-day returns" props.text="Changed your mind? Return anything within 30 days. We want you on the right bike."}
:::
::::
:::::

:::::section{style.padding="clamp(3rem, 7vw, 5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::shp-section-header{props.eyebrow="At the workshop" props.heading="Book a service" props.subheading="Tune-ups, custom builds, and fixes done right — priced up front."}

::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="1rem" style.--sm.gridTemplateColumns="1fr"}
::shp-service{props.icon="⚙️" props.title="Standard tune-up" props.text="Gears, brakes, and a full safety check dialled in." props.price="$79"}

::shp-service{props.icon="🛞" props.title="Wheel & tyre" props.text="Tubeless setups, truing, and flat repairs while you wait." props.price="$35"}

::shp-service{props.icon="🚲" props.title="Custom build" props.text="Bring a frame or dream one up — we'll spec and build it." props.price="From $150"}

::shp-service{props.icon="📐" props.title="Pro bike fit" props.text="A full body-and-bike fitting session with a fit specialist." props.price="$120"}
::::
:::::

:::::section{style.padding="clamp(3rem, 7vw, 5rem) 1.5rem"}
::shp-section-header{props.eyebrow="From the saddle" props.heading="Riders keep coming back"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.35rem" style.--md.gridTemplateColumns="1fr"}
::shp-review{props.quote="Bought my first gravel bike here and they spent an hour fitting it. It rides like it was made for me." props.author="Priya N." props.role="Weekend adventurer"}

::shp-review{props.quote="The workshop saved my race weekend with a same-day drivetrain rebuild. These folks know bikes." props.author="Marcus T." props.role="Cat 3 racer"}

::shp-review{props.quote="Got my daughter's first pedal bike here. Free tune-up as she grew into it — such a nice touch." props.author="Dana R." props.role="Cargo-bike parent"}
::::
:::::

::shp-newsletter{}

::shp-cta{props.heading="Come take one for a spin" props.text="Test-ride anything on the floor, or roll in for a tune-up. We're on the corner of Spoke & 4th." props.cta="Plan your visit" props.ctaHref="/contact/" props.cta2="Shop bikes" props.cta2Href="/products/"}
