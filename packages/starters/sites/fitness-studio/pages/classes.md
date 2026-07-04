---
title: "Classes & Schedule — Ember Yoga & Fitness"
state:
  schedule:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: classes
    sort:
      field: order
      order: asc
---

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::fs-section-header{props.eyebrow="Weekly schedule" props.heading="Find your class" props.subheading="From slow restorative flows to high-intensity circuits — here's everything on the mat this week."}
:::::

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem"}
::::fs-class-grid
:::Array{items.ref="#/state/schedule"}
::fs-class-card{props.name="${item.data.name}" props.level="${item.data.level}" props.time="${item.data.time}" props.instructor="${item.data.instructor}" props.focus="${item.data.focus}"}
:::
::::
:::::

:::::section{style.padding="clamp(1rem, 4vw, 3rem) 1.5rem clamp(3.5rem, 8vw, 6rem)" style.backgroundColor="var(--color-bg-cream)"}
::fs-section-header{props.eyebrow="Good to know" props.heading="Before your first class"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="1fr"}
::fs-feature{props.icon="🕒" props.title="Arrive early" props.text="Doors open 15 minutes before class. Come a little early to sign in and settle onto your mat."}

::fs-feature{props.icon="🧺" props.title="We've got the gear" props.text="Mats, blocks, straps, and weights are all provided. Just bring water and comfortable clothes."}

::fs-feature{props.icon="🙂" props.title="No experience needed" props.text="Tell your instructor it's your first time — they'll offer options for every pose and movement."}
::::
:::::

::fs-cta{props.heading="Ready to roll out your mat?" props.text="Book your spot online in under a minute. First-timers get a free intro session." props.cta="Book a Class" props.ctaHref="/contact/"}
