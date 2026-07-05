---
title: "Northshore Realty — Search homes on the north shore"
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

::re-hero{props.eyebrow="142 active listings · updated daily" props.heading="Find the home that fits your life on the north shore." props.subheading="Search live listings from Bayport to Harbor Hills — filter by price, beds, and baths, then tour with agents who actually live here." props.cta="Search homes" props.ctaHref="/listings/" props.bg="/images/hero.jpg"}

:::::section{style.padding="clamp(3.5rem, 8vw, 5.5rem) 0"}
::re-section-header{props.eyebrow="Just listed" props.heading="Newest on the market" props.subheading="A first look at three homes that just came to the north shore market this week."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="0 1.5rem" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/featured"}
::re-listing-card{props.heading="${item.data.Title}" props.price="${item.data.price}" props.beds="${item.data.beds}" props.baths="${item.data.baths}" props.sqft="${item.data.sqft}" props.city="${item.data.city}" props.status="${item.data.status}" props.image="${item.data.image}" props.href="/${item.data.slug}/"}
:::
::::

::::div{style.maxWidth="var(--max-width)" style.margin="2.25rem auto 0" style.padding="0 1.5rem"}
:::a{href="/listings/" style.display="inline-flex" style.alignItems="center" style.gap="0.55rem" style.padding="0.8rem 1.5rem" style.border="1px solid var(--color-border-strong)" style.borderRadius="999px" style.color="var(--color-text-primary)" style.fontWeight="700" style.textDecoration="none" style.fontSize="0.98rem"}
Browse all 6 listings →
:::
::::
:::::

:::::section{id="neighborhoods" style.padding="clamp(3.5rem, 8vw, 5.5rem) 0" style.backgroundColor="var(--color-bg-cream)" style.borderTop="1px solid var(--color-border)" style.borderBottom="1px solid var(--color-border)"}
::re-section-header{props.eyebrow="Where to look" props.heading="Explore the neighborhoods" props.subheading="Six distinct pockets of the north shore, from waterfront modern to quiet cottage streets."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="0 1.5rem" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.35rem" style.--md.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
::re-neighborhood{props.name="Bayport" props.count="24" props.price="$720k" props.image="/images/listing-2.jpg" props.href="/listings/"}

::re-neighborhood{props.name="Maplewood" props.count="18" props.price="$465k" props.image="/images/listing-1.jpg" props.href="/listings/"}

::re-neighborhood{props.name="Lakeview" props.count="12" props.price="$410k" props.image="/images/listing-3.jpg" props.href="/listings/"}

::re-neighborhood{props.name="Harbor Hills" props.count="9" props.price="$1.1M" props.image="/images/listing-5.jpg" props.href="/listings/"}

::re-neighborhood{props.name="Cedar Grove" props.count="15" props.price="$355k" props.image="/images/listing-4.jpg" props.href="/listings/"}

::re-neighborhood{props.name="Northshore" props.count="21" props.price="$540k" props.image="/images/listing-6.jpg" props.href="/listings/"}
::::
:::::

:::::section{style.padding="clamp(3rem, 7vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-dark)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::p{style.textTransform="uppercase" style.letterSpacing="0.16em" style.fontSize="0.74rem" style.fontWeight="700" style.color="var(--color-accent-bright)" style.margin="0 0 1.75rem"}
By the numbers
:::

:::div{style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="2rem" style.--sm.gridTemplateColumns="repeat(2, 1fr)"}
::re-stat{props.value="20+" props.label="Years on the north shore"}

::re-stat{props.value="1,400+" props.label="Homes closed"}

::re-stat{props.value="98%" props.label="Of asking price achieved"}

::re-stat{props.value="4.9★" props.label="Average client rating"}
:::
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 5.5rem) 0"}
::re-section-header{props.eyebrow="Why Northshore" props.heading="A calmer, clearer way to buy" props.subheading="Everything you need to make a confident move — none of the pressure you don't."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="0 1.5rem" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.35rem" style.--md.gridTemplateColumns="1fr"}
::re-feature{props.icon="🗺" props.title="Local expertise" props.text="We've closed hundreds of homes on the north shore. We know the streets, the schools, and the fair price."}

::re-feature{props.icon="🔎" props.title="Transparent search" props.text="Filter by price, beds, and baths right on the site — no sign-up walls, no spam, just homes that fit."}

::re-feature{props.icon="🤝" props.title="Agents, not salespeople" props.text="Advice first. Our agents are paid to get you the right home, not the most expensive one."}
::::
:::::

::re-agent-band{props.heading="Talk to an agent who lives here." props.text="Tell us your budget and must-haves and we'll send a shortlist of homes worth seeing — usually the same day." props.cta="Book a call" props.ctaHref="/contact/"}

:::::section{style.padding="clamp(3.5rem, 8vw, 5.5rem) 0" style.backgroundColor="var(--color-bg-cream)" style.borderTop="1px solid var(--color-border)"}
::re-section-header{props.eyebrow="Client stories" props.heading="People who found home with us"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="0 1.5rem" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.35rem" style.--md.gridTemplateColumns="1fr"}
::re-testimonial{props.quote="They found us a house two blocks from the water and under budget. I still can't believe it." props.author="The Okafor Family" props.role="Bought in Bayport"}

::re-testimonial{props.quote="Sold in nine days for over asking. Calm, honest, and always a step ahead." props.author="Marta Lindqvist" props.role="Sold in Maplewood"}

::re-testimonial{props.quote="First-time buyers and terrified. Our agent walked us through every step twice." props.author="Devon & Ray" props.role="Bought in Lakeview"}
::::
:::::

::re-cta{props.heading="Ready to start your search?" props.text="Tell us what you're looking for and your budget — we'll send a shortlist of homes worth seeing." props.cta="Talk to an agent" props.ctaHref="/contact/" props.cta2="Browse listings" props.cta2Href="/listings/"}
