---
title: "Curriculum — Craft & Code Academy"
state:
  modules:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: modules
    sort:
      field: order
      order: asc
---

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::co-section-header{props.eyebrow="14 weeks · 6 modules" props.heading="The full curriculum" props.subheading="A structured path from your first line of code to a deployed, full-stack application — with mentorship at every step."}
:::::

:::::section{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem"}
::::div{style.display="grid" style.gap="1rem"}
:::Array{items.ref="#/state/modules"}
::co-module-card{props.order="${item.data.order}" props.title="${item.data.title}" props.summary="${item.data.summary}" props.duration="${item.data.duration}"}
:::
::::
:::::

:::::section{style.padding="clamp(3rem, 8vw, 5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::co-section-header{props.eyebrow="Explore interactively" props.heading="Open a module to see its lessons"}

::co-curriculum-accordion
:::::

::co-cta{props.heading="This could be your next 14 weeks." props.text="Every module builds toward a capstone you'll be proud to show. Reserve your seat in the next cohort." props.cta="Enroll Now" props.ctaHref="/enroll/"}
