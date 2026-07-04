---
title: "Programs — Rivertown Foundation"
state:
  programs:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: programs
    sort:
      field: order
      order: asc
---

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::np-section-header{props.eyebrow="Our programs" props.heading="How we show up for Rivertown" props.subheading="Five neighbor-powered programs that meet urgent needs today and build a stronger community for tomorrow."}
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--lg.gridTemplateColumns="repeat(2, 1fr)" style.--md.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/programs"}
::np-program-card{props.title="${item.data.title}" props.summary="${item.data.summary}" props.image="${item.data.image}"}
:::
::::
:::::

:::::section{style.padding="clamp(1rem, 4vw, 2rem) 1.5rem clamp(3.5rem, 8vw, 5rem)" style.backgroundColor="var(--color-bg-cream)"}
::np-section-header{props.eyebrow="The difference you make" props.heading="Small gifts, big outcomes"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="2rem" style.--md.gridTemplateColumns="repeat(2, 1fr)"}
::np-stat{props.number="128k" props.label="Meals provided"}

::np-stat{props.number="1,200" props.label="Youth mentored"}

::np-stat{props.number="180" props.label="Households housed"}

::np-stat{props.number="310" props.label="Jobs secured"}
::::
:::::

::np-cta{props.eyebrow="Fuel the work" props.heading="Help us grow every program" props.text="Your gift helps us keep the pantry stocked, the mentors trained, and the doors open for every neighbor who needs us." props.cta="Donate Now" props.ctaHref="/get-involved/" props.cta2="Volunteer With Us" props.cta2Href="/get-involved/" props.bg="/images/cta-bg.jpg"}
