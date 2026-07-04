---
title: "Cadence Cycles — Neighborhood bike shop for every rider"
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

::shp-hero{props.eyebrow="Riverbend · Since 2009" props.heading="Find your next favorite ride." props.subheading="A neighborhood bike shop stacked with road, mountain, gravel, and kids' bikes — plus the gear, service, and expert fittings to keep you rolling." props.cta="Shop Bikes" props.ctaHref="/products/" props.cta2="Our Story" props.cta2Href="/about/" props.bg="/images/hero.jpg"}

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="1.5rem" style.--sm.gridTemplateColumns="repeat(2, 1fr)"}
::shp-stat{props.value="15 yrs" props.label="On Spoke Avenue"}

::shp-stat{props.value="1,200+" props.label="Bikes fitted"}

::shp-stat{props.value="48 hr" props.label="Service turnaround"}

::shp-stat{props.value="4.9★" props.label="Rider rating"}
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::shp-section-header{props.eyebrow="Fresh on the floor" props.heading="Featured rides" props.subheading="A few of the bikes our mechanics are most excited about this season."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/featured"}
::shp-product-card{props.title="${item.data.title}" props.price="${item.data.price}" props.category="${item.data.category}" props.image="${item.data.image}" props.href="/products/${item.data.sku}/"}
:::
::::

::::div{style.textAlign="center" style.marginTop="2.5rem"}
:::a{href="/products/" style.display="inline-block" style.color="var(--color-primary)" style.fontWeight="600" style.textDecoration="none" style.fontSize="1.05rem"}
Browse the full shop →
:::
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::shp-section-header{props.eyebrow="Why Cadence" props.heading="More than a bike sale"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="1fr"}
::shp-feature{props.icon="🔧" props.title="On-site service" props.text="A full workshop with certified mechanics. Most tune-ups turned around in 48 hours or less."}

::shp-feature{props.icon="📏" props.title="Proper fitting" props.text="Every bike we sell is sized and adjusted to you before it leaves the floor — no guesswork."}

::shp-feature{props.icon="🤝" props.title="Lifetime support" props.text="Free first tune-up on every new bike, and honest advice for the life of the ride."}
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::shp-section-header{props.eyebrow="At the workshop" props.heading="Book a service" props.subheading="Tune-ups, custom builds, and fixes done right, priced up front."}

::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="1rem" style.--sm.gridTemplateColumns="1fr"}
::shp-service{props.icon="⚙️" props.title="Standard tune-up" props.text="Gears, brakes, and a full safety check dialled in." props.price="$79"}

::shp-service{props.icon="🛞" props.title="Wheel & tyre" props.text="Tubeless setups, truing, and flat repairs while you wait." props.price="$35"}

::shp-service{props.icon="🚲" props.title="Custom build" props.text="Bring a frame or dream one up — we'll spec and build it." props.price="From $150"}

::shp-service{props.icon="📐" props.title="Pro bike fit" props.text="A full body-and-bike fitting session with a fit specialist." props.price="$120"}
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::shp-section-header{props.eyebrow="From the saddle" props.heading="Riders keep coming back"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="1fr"}
::shp-review{props.quote="Bought my first gravel bike here and they spent an hour fitting it. It rides like it was made for me." props.author="Priya N." props.role="Weekend adventurer"}

::shp-review{props.quote="The workshop saved my race weekend with a same-day drivetrain rebuild. These folks know bikes." props.author="Marcus T." props.role="Cat 3 racer"}

::shp-review{props.quote="Got my daughter's first pedal bike here. Free tune-up as she grew into it — such a nice touch." props.author="Dana R." props.role="Cargo-bike parent"}
::::
:::::

::shp-cta{props.heading="Come take one for a spin" props.text="Test-ride anything on the floor, or roll in for a tune-up. We're on the corner of Spoke & 4th." props.cta="Plan Your Visit" props.ctaHref="/contact/"}
