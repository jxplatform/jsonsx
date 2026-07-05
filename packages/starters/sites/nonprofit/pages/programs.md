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

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem clamp(2.5rem, 5vw, 3.5rem)" style.backgroundColor="var(--color-bg-cream)"}
::np-section-header{props.eyebrow="Our programs" props.heading="How we show up for" props.headingAccent="Rivertown" props.subheading="Five neighbor-powered programs that meet urgent needs today and build a stronger community for tomorrow."}
:::::

:::::section{style.padding="clamp(3rem, 7vw, 5rem) 1.5rem"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.75rem" style.--lg.gridTemplateColumns="repeat(2, 1fr)" style.--md.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/programs"}
::np-program-card{props.title="${item.data.title}" props.summary="${item.data.summary}" props.image="${item.data.image}" props.tag="Program" props.href="/get-involved/"}
:::
::::
:::::

:::::np-impact-band{props.eyebrow="The difference you make" props.heading="Small gifts," props.headingAccent="big outcomes"}
::::div{style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="repeat(2, 1fr)"}
::np-stat{props.icon="🍎" props.number="128k" props.label="Meals provided" props.note="Fresh, dignified groceries through the Riverside Food Pantry."}

::np-stat{props.icon="📚" props.number="1,200" props.label="Youth mentored" props.note="Weekly one-to-one time with a caring adult."}

::np-stat{props.icon="🏠" props.number="180" props.label="Households housed" props.note="Emergency help that keeps families in their homes."}

::np-stat{props.icon="💼" props.number="310" props.label="Jobs secured" props.note="Living-wage careers through training and coaching."}
::::
:::::

::np-cta{props.eyebrow="Fuel the work" props.heading="Help us grow" props.headingAccent="every program" props.text="Your gift keeps the pantry stocked, the mentors trained, and the doors open for every neighbor who needs us." props.cta="Donate Now" props.ctaHref="/get-involved/" props.cta2="Volunteer with us" props.cta2Href="/get-involved/"}
