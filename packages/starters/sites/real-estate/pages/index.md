---
title: "Northshore Realty — Homes for sale on the north shore"
state:
  featured:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: listings
    sort:
      field: order
      order: asc
    limit: 3
---

::re-hero{props.eyebrow="Buy · Sell · Invest" props.heading="Find your place on the north shore." props.subheading="Browse handpicked homes from Bayport to Harbor Hills, filter by price and bedrooms, and work with agents who actually live here." props.cta="Search Homes" props.ctaHref="/listings/" props.bg="/images/hero.jpg"}

:::::section{style.padding="clamp(3.5rem, 8vw, 5.5rem) 1.5rem"}
::re-section-header{props.eyebrow="Featured homes" props.heading="Just listed" props.subheading="A first look at three of our newest listings across the north shore."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/featured"}
::re-listing-card{props.heading="${item.data.Title}" props.price="${item.data.price}" props.beds="${item.data.beds}" props.baths="${item.data.baths}" props.sqft="${item.data.sqft}" props.city="${item.data.city}" props.image="${item.data.image}" props.href="/${item.data.slug}/"}
:::
::::

::::div{style.textAlign="center" style.marginTop="2.5rem"}
:::a{href="/listings/" style.display="inline-block" style.backgroundColor="var(--color-primary)" style.color="var(--color-text-white)" style.padding="0.85rem 2rem" style.borderRadius="var(--radius)" style.fontWeight="700" style.textDecoration="none" style.fontSize="1.05rem"}
Browse all listings →
:::
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 5.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::re-section-header{props.eyebrow="Why Northshore" props.heading="A calmer way to buy and sell"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="1fr"}
::re-feature{props.icon="🏡" props.title="Local expertise" props.text="We've closed hundreds of homes on the north shore. We know the streets, the schools, and the fair price."}

::re-feature{props.icon="🔎" props.title="Transparent search" props.text="Filter by price and bedrooms right on the site — no sign-up walls, no spam, just the homes that fit."}

::re-feature{props.icon="🤝" props.title="Agents, not salespeople" props.text="Advice first. Our agents are paid to get you the right home, not the most expensive one."}
::::
:::::

:::::section{style.padding="clamp(3rem, 7vw, 4.5rem) 1.5rem"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="1rem" style.--sm.gridTemplateColumns="repeat(2, 1fr)"}
::re-stat{props.value="20+" props.label="Years on the north shore"}

::re-stat{props.value="1,400+" props.label="Homes closed"}

::re-stat{props.value="98%" props.label="Of asking price achieved"}

::re-stat{props.value="4.9★" props.label="Average client rating"}
::::
:::::

:::re-intro{props.image="/images/about.jpg" props.imageAlt="A Northshore Realty agent meeting clients at a home"}

### More than a transaction

Buying or selling a home is one of the biggest decisions you'll make. We treat it that way — with patience, straight answers, and a team that picks up the phone.

From the first showing to closing day, you'll have one point of contact who knows your search inside and out.
:::

:::::section{style.padding="clamp(3.5rem, 8vw, 5.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::re-section-header{props.eyebrow="Client stories" props.heading="People who found home with us"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="1fr"}
::re-testimonial{props.quote="They found us a house two blocks from the water and under budget. I still can't believe it." props.author="The Okafor Family" props.role="Bought in Bayport"}

::re-testimonial{props.quote="Sold in nine days for over asking. Calm, honest, and always a step ahead." props.author="Marta L." props.role="Sold in Maplewood"}

::re-testimonial{props.quote="First-time buyers and terrified. Our agent walked us through every step twice." props.author="Devon & Ray" props.role="Bought in Lakeview"}
::::
:::::

::re-cta{props.heading="Ready to start your search?" props.text="Tell us what you're looking for and your budget — we'll send a shortlist of homes worth seeing." props.cta="Talk to an Agent" props.ctaHref="/contact/"}
