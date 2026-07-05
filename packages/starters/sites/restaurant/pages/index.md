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
    limit: 5
---

::bit-hero{props.eyebrow="Riverbend · Est. 2016" props.heading="A table worth" props.headingAccent="lingering" props.headingTail=" at." props.subheading="Seasonal plates, house-made pastries, and small-batch coffee — served in a warm room just off Market Street." props.hours="Open today · 8am – 3pm · Walk-ins welcome" props.caption="The dining room · Market & 3rd" props.cta="Reserve a Table" props.ctaHref="/contact/" props.cta2="View the Menu" props.cta2Href="/menu/" props.bg="/images/hero.jpg"}

::::div{style.backgroundColor="var(--color-espresso)" style.color="var(--color-text-white)"}
:::p{style.margin="0" style.maxWidth="var(--max-width-wide)" style.marginLeft="auto" style.marginRight="auto" style.padding="0.85rem 1.5rem" style.textAlign="center" style.fontFamily="var(--font-body)" style.fontSize="0.76rem" style.fontWeight="600" style.textTransform="uppercase" style.letterSpacing="0.2em" style.color="var(--color-text-white)"}
Seasonal plates　·　House-baked pastry　·　Small-batch coffee　·　Open seven days　·　Est. 2016
:::
::::

:::bit-intro{props.image="/images/intro.jpg" props.imageAlt="A chef plating a seasonal dish in the kitchen"}

### More than a meal — a room worth slowing down in.

We opened Bistro & Café to build a place worth staying in. Everything on the menu begins with what's good this week — from the farm up the road — then roasted, baked, and plated by hand.

Come for the coffee at eight, stay for the roast chicken at eight. Nobody will rush you out the door.
:::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::bit-section-header{props.eyebrow="Our kitchen" props.heading="Cooked with care," props.headingAccent="sourced with intention" props.align="left"}

::::div{style.maxWidth="var(--max-width)" style.margin="2.5rem auto 0" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="clamp(1.75rem, 4vw, 3rem)" style.--md.gridTemplateColumns="1fr"}
::bit-feature{props.number="01" props.title="Seasonal & local" props.text="The menu changes with the harvest. We buy from growers we know by name and cook whatever's best that week."}

::bit-feature{props.number="02" props.title="Made in-house" props.text="Bread, pastry, stocks, and sauces — all made from scratch every morning before the doors open."}

::bit-feature{props.number="03" props.title="Small-batch coffee" props.text="A rotating single-origin, roasted just up the street and pulled to order behind the counter."}
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::bit-section-header{props.eyebrow="From the menu" props.heading="A few of our" props.headingAccent="favorites"}

::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.padding="clamp(1.75rem, 4vw, 2.75rem)" style.backgroundColor="var(--color-bg-white)" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)" style.boxShadow="0 24px 60px -42px rgba(30,21,15,0.5)"}
:::Array{items.ref="#/state/popular"}
::bit-menu-item{props.name="${item.data.name}" props.price="${item.data.price}" props.description="${item.data.description}"}
:::
::::

::::div{style.textAlign="center" style.marginTop="2.25rem"}
:::a{href="/menu/" style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.color="var(--color-primary)" style.fontFamily="var(--font-body)" style.fontWeight="700" style.textTransform="uppercase" style.letterSpacing="0.14em" style.fontSize="0.82rem" style.textDecoration="none" style.borderBottom="1px solid var(--color-primary)" style.paddingBottom="0.4rem"}
See the full menu →
:::
::::
:::::

:::::section{style.padding="0 0 clamp(3.5rem, 8vw, 6rem)"}
::bit-section-header{props.eyebrow="In the room" props.heading="A place to" props.headingAccent="slow down"}

::bit-gallery{props.img1="/images/gallery-1.jpg" props.img2="/images/gallery-2.jpg" props.img3="/images/gallery-3.jpg" props.img4="/images/gallery-4.jpg" props.alt="Dishes, coffee, and the dining room at Bistro & Café"}
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="1fr 1.15fr" style.gap="clamp(2.5rem, 6vw, 4.5rem)" style.alignItems="center" style.--md.gridTemplateColumns="1fr"}
::bit-hours{props.heading="Hours" props.status="Open today"}

::bit-review{props.quote="The kind of neighborhood spot you wish was on your corner. The roast chicken is worth the trip." props.author="Dana R." props.role="Regular since 2019"}
::::
:::::

::bit-cta{props.eyebrow="Reservations" props.heading="Save your" props.headingAccent="table" props.text="Weekends fill up fast. Reserve online in a minute, or just walk in and say hello." props.cta="Reserve a Table" props.ctaHref="/contact/"}
