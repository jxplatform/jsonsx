---
title: "Schedule — Horizon Conf 2026"
state:
  mainStage:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: sessions
    filter:
      - field: track
        op: "=="
        value: Main Stage
    sort:
      field: order
      order: asc
  workshops:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: sessions
    filter:
      - field: track
        op: "=="
        value: Workshops
    sort:
      field: order
      order: asc
  design:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: sessions
    filter:
      - field: track
        op: "=="
        value: Design
    sort:
      field: order
      order: asc
---

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::ev-section-header{props.eyebrow="June 12, 2026" props.heading="One day, three tracks" props.subheading="Everything runs across a single day at The Foundry. Use the planner below to filter by track, or scroll for the full lineup."}
:::::

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem"}
::ev-section-header{props.eyebrow="Plan your day" props.heading="Filter by track" props.subheading="Tap a track to focus the agenda. Everything updates instantly — no page reload."}

::ev-agenda-tabs
:::::

:::::section{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.padding="clamp(2rem, 5vw, 3.5rem) 1.5rem"}
::ev-section-header{props.heading="The full lineup" props.subheading="Every session, grouped by track." props.align="left"}

::::div{style.marginBottom="3rem"}
:::h3{style.fontFamily="var(--font-heading)" style.fontSize="1.4rem" style.fontWeight="700" style.color="var(--color-primary)" style.margin="0 0 0.5rem" style.paddingBottom="0.5rem" style.borderBottom="2px solid var(--color-primary)"}
Main Stage
:::
:::Array{items.ref="#/state/mainStage"}
::ev-session-row{props.time="${item.data.time}" props.title="${item.data.title}" props.track="${item.data.track}" props.speaker="${item.data.speaker}"}
:::
::::

::::div{style.marginBottom="3rem"}
:::h3{style.fontFamily="var(--font-heading)" style.fontSize="1.4rem" style.fontWeight="700" style.color="var(--color-primary)" style.margin="0 0 0.5rem" style.paddingBottom="0.5rem" style.borderBottom="2px solid var(--color-primary)"}
Workshops
:::
:::Array{items.ref="#/state/workshops"}
::ev-session-row{props.time="${item.data.time}" props.title="${item.data.title}" props.track="${item.data.track}" props.speaker="${item.data.speaker}"}
:::
::::

::::div{style.marginBottom="1rem"}
:::h3{style.fontFamily="var(--font-heading)" style.fontSize="1.4rem" style.fontWeight="700" style.color="var(--color-primary)" style.margin="0 0 0.5rem" style.paddingBottom="0.5rem" style.borderBottom="2px solid var(--color-primary)"}
Design
:::
:::Array{items.ref="#/state/design"}
::ev-session-row{props.time="${item.data.time}" props.title="${item.data.title}" props.track="${item.data.track}" props.speaker="${item.data.speaker}"}
:::
::::
:::::

:::ev-venue{props.image="/images/venue.jpg" props.imageAlt="The Foundry main hall in Portland" props.reverse="true"}

### The venue: The Foundry

A restored ironworks turned event hall in Portland's Central Eastside — high ceilings, fast Wi-Fi, and coffee that never runs out. Both stages, all workshop rooms, and the hallway track are steps apart under one roof.

Doors open at 8:00 AM. Bring a laptop for the workshop track.
:::

::ev-cta{props.eyebrow="Don't miss it" props.heading="Your seat is waiting" props.text="Sessions fill on a first-come basis on the day. A ticket guarantees your spot in every track." props.cta="Get Tickets" props.ctaHref="/tickets/"}
