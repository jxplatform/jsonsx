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

::pv-hero{props.eyebrow="Photography & Creative Studio" props.heading="Light, patience, and a good eye." props.subheading="Image-forward work for people and places — weddings, portraits, editorial, and everything in the frame between." props.cta="Enter the work" props.ctaHref="/work/" props.bg="/images/hero.jpg"}

::::::section{style.padding="clamp(4rem, 9vw, 7rem) 0"}
::pv-section-header{props.eyebrow="Selected work" props.heading="A few recent stories" props.subheading="A small edit from the archive — each project a short story told in light."}

:::::div{style.marginTop="clamp(2rem, 4vw, 3rem)"}
::::pv-project-grid
:::Array{items.ref="#/state/featured"}
::pv-project-card{props.number="0${item.data.order}" props.title="${item.data.title}" props.category="${item.data.category}" props.year="${item.data.year}" props.cover="${item.data.cover}" props.href="/${item.data.slug}/" props.alt="${item.data.title}"}
:::
::::
:::::

::::div{style.textAlign="center" style.marginTop="clamp(2.5rem, 5vw, 3.5rem)" style.padding="0 1.5rem"}
:::a{href="/work/" style.display="inline-flex" style.alignItems="center" style.gap="0.6rem" style.color="var(--color-text-primary)" style.fontSize="0.78rem" style.fontWeight="600" style.textTransform="uppercase" style.letterSpacing="0.2em" style.textDecoration="none" style.borderBottom="1px solid var(--color-primary)" style.paddingBottom="0.5rem"}
View all work →
:::
::::
::::::

:::::pv-about-split{props.image="/images/about.jpg" props.imageAlt="Aperture Studio photographer at work" props.reverse="true"}
::::p{style.display="flex" style.alignItems="center" style.gap="0.85rem" style.margin="0 0 1.5rem" style.textTransform="uppercase" style.letterSpacing="0.24em" style.fontSize="0.7rem" style.fontWeight="500" style.color="var(--color-primary)"}
Behind the lens
::::

::::h2{style.fontFamily="var(--font-heading)" style.fontWeight="400" style.fontSize="clamp(2rem, 4vw, 3rem)" style.lineHeight="1.05" style.letterSpacing="-0.01em" style.margin="0 0 1.25rem" style.color="var(--color-text-primary)"}
A small, image-forward practice
::::

Aperture Studio is led by a photographer who prefers available light and unhurried days. We shoot a little, edit hard, and hand back a tight set of frames you will actually want to live with. We work across the country and answer every inquiry personally.

::::a{href="/about/" style.display="inline-flex" style.alignItems="center" style.gap="0.6rem" style.marginTop="1.75rem" style.color="var(--color-text-primary)" style.fontSize="0.78rem" style.fontWeight="600" style.textTransform="uppercase" style.letterSpacing="0.2em" style.textDecoration="none" style.borderBottom="1px solid var(--color-primary)" style.paddingBottom="0.5rem"}
More about the studio →
::::
:::::

::pv-cta{props.heading="Have something worth photographing?" props.text="Tell us about the day, the story, or the space. We take on a limited number of projects each season." props.cta="Start a Project" props.ctaHref="/contact/"}
