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

::::::section{style.padding="clamp(7rem, 12vw, 10rem) 0 clamp(3rem, 6vw, 4.5rem)"}
::pv-section-header{props.eyebrow="Portfolio" props.heading="Selected work" props.subheading="Six recent projects — weddings, portraits, editorial, travel, food, and architecture."}

::::div{style.display="flex" style.flexWrap="wrap" style.gap="0.6rem" style.maxWidth="var(--max-width)" style.margin="1.75rem auto 0" style.padding="0 clamp(1.5rem, 4vw, 4rem)"}
::pv-category-pill{props.label="Weddings"}

::pv-category-pill{props.label="Portraits"}

::pv-category-pill{props.label="Editorial"}

::pv-category-pill{props.label="Travel"}

::pv-category-pill{props.label="Food"}

::pv-category-pill{props.label="Architecture"}
::::
::::::

::::::section{style.padding="0 0 clamp(4rem, 8vw, 6rem)"}
::::pv-project-grid
:::Array{items.ref="#/state/projects"}
::pv-project-card{props.number="0${item.data.order}" props.title="${item.data.title}" props.category="${item.data.category}" props.year="${item.data.year}" props.cover="${item.data.cover}" props.href="/${item.data.slug}/" props.alt="${item.data.title}"}
:::
::::
::::::

::pv-cta{props.heading="Let's make something." props.text="Commissions, collaborations, and personal shoots — the studio takes on a handful of projects each season." props.cta="Start a Project" props.ctaHref="/contact/"}
