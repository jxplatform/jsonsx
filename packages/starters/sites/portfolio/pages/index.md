---
title: "Aperture Studio — Photography & Creative Studio"
state:
  featured:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: projects
    sort:
      field: order
      order: asc
    limit: 4
---

::pv-hero{props.eyebrow="Photography & Creative Studio" props.heading="Light, patience, and a good eye." props.subheading="Aperture Studio makes image-forward work for people and places — weddings, portraits, editorial, and everything in the frame between." props.cta="View the Work" props.ctaHref="/work/" props.cta2="Start a Project" props.cta2Href="/contact/" props.bg="/images/hero.jpg"}

:::::section{style.padding="clamp(4rem, 9vw, 7rem) 1.5rem"}
::pv-section-header{props.eyebrow="Selected work" props.heading="A few recent stories" props.subheading="A small edit from the archive. Every project begins with a conversation and ends with prints worth keeping."}

::::pv-project-grid
:::Array{items.ref="#/state/featured"}
::pv-project-card{props.title="${item.data.title}" props.category="${item.data.category}" props.year="${item.data.year}" props.cover="${item.data.cover}" props.href="/${item.data.slug}/" props.alt="${item.data.title}"}
:::
::::

::::div{style.textAlign="center" style.marginTop="3rem"}
:::a{href="/work/" style.display="inline-block" style.color="var(--color-primary)" style.fontWeight="600" style.textDecoration="none" style.fontSize="0.9rem" style.letterSpacing="0.05em" style.textTransform="uppercase"}
View all work →
:::
::::
:::::

:::::pv-about-split{props.image="/images/about.jpg" props.imageAlt="Aperture Studio photographer at work" props.reverse="true"}

### Behind the lens

Aperture Studio is a small, image-forward practice led by a photographer who prefers available light and unhurried days. We shoot a little, edit hard, and hand back a tight set of frames you will actually want to live with.

We work across the country and answer every inquiry personally.

:::a{href="/about/" style.display="inline-block" style.marginTop="1.25rem" style.color="var(--color-primary)" style.fontWeight="600" style.textDecoration="none" style.fontSize="0.9rem" style.letterSpacing="0.05em" style.textTransform="uppercase"}
More about the studio →
:::
:::::

::pv-cta{props.heading="Have something worth photographing?" props.text="Tell us about the day, the story, or the space. We take on a limited number of projects each season." props.cta="Start a Project" props.ctaHref="/contact/"}
