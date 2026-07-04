---
title: "Work — Aperture Studio"
state:
  projects:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: projects
    sort:
      field: order
      order: asc
---

:::::section{style.padding="clamp(3rem, 6vw, 5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::pv-section-header{props.eyebrow="Portfolio" props.heading="Selected work" props.subheading="Six recent projects across weddings, portraits, editorial, travel, food, and architecture — each a short story told in light."}

::::div{style.display="flex" style.flexWrap="wrap" style.gap="0.6rem" style.justifyContent="center" style.maxWidth="var(--max-width-narrow)" style.margin="0 auto"}
::pv-category-pill{props.label="Weddings"}

::pv-category-pill{props.label="Portraits"}

::pv-category-pill{props.label="Editorial"}

::pv-category-pill{props.label="Travel"}

::pv-category-pill{props.label="Food"}

::pv-category-pill{props.label="Architecture"}
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::::pv-project-grid
:::Array{items.ref="#/state/projects"}
::pv-project-card{props.title="${item.data.title}" props.category="${item.data.category}" props.year="${item.data.year}" props.cover="${item.data.cover}" props.href="/${item.data.slug}/" props.alt="${item.data.title}"}
:::
::::
:::::

::pv-cta{props.heading="Let's make something." props.text="Commissions, collaborations, and personal shoots — the studio takes on a handful of projects each season." props.cta="Start a Project" props.ctaHref="/contact/"}
