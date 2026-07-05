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
::ev-section-header{props.eyebrow="June 12, 2026 · The Foundry" props.heading="One day, three tracks" props.subheading="Everything runs across a single day in Portland. Filter the planner by track, or scroll for the full timeline."}
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::ev-section-header{props.eyebrow="Plan your day" props.heading="Filter by track" props.subheading="Tap a track to focus the agenda — everything updates instantly, no page reload."}

::ev-agenda-tabs
:::::

:::::section{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.padding="clamp(2rem, 5vw, 3.5rem) 1.5rem clamp(3.5rem, 8vw, 6rem)"}
::ev-section-header{props.heading="The full timeline" props.subheading="Every session on the day, grouped by track." props.align="left"}

::::div{style.marginBottom="2.75rem"}
:::h3{style.display="flex" style.alignItems="center" style.gap="0.7rem" style.fontFamily="var(--font-heading)" style.fontSize="1.35rem" style.fontWeight="700" style.margin="0 0 1.4rem" style.color="var(--color-text-primary)"}
:span[]{style.width="0.7rem" style.height="0.7rem" style.borderRadius="50%" style.background="var(--color-accent)" style.boxShadow="0 0 12px rgba(34,224,255,0.7)"} Main Stage
:::

:::Array{items.ref="#/state/mainStage"}
::ev-session-row{props.time="${item.data.time}" props.title="${item.data.title}" props.track="${item.data.track}" props.speaker="${item.data.speaker}"}
:::
::::

::::div{style.marginBottom="2.75rem"}
:::h3{style.display="flex" style.alignItems="center" style.gap="0.7rem" style.fontFamily="var(--font-heading)" style.fontSize="1.35rem" style.fontWeight="700" style.margin="0 0 1.4rem" style.color="var(--color-text-primary)"}
:span[]{style.width="0.7rem" style.height="0.7rem" style.borderRadius="50%" style.background="var(--color-lime)" style.boxShadow="0 0 12px rgba(198,255,77,0.7)"} Workshops
:::

:::Array{items.ref="#/state/workshops"}
::ev-session-row{props.time="${item.data.time}" props.title="${item.data.title}" props.track="${item.data.track}" props.speaker="${item.data.speaker}"}
:::
::::

::::div
:::h3{style.display="flex" style.alignItems="center" style.gap="0.7rem" style.fontFamily="var(--font-heading)" style.fontSize="1.35rem" style.fontWeight="700" style.margin="0 0 1.4rem" style.color="var(--color-text-primary)"}
:span[]{style.width="0.7rem" style.height="0.7rem" style.borderRadius="50%" style.background="#ff6bb0" style.boxShadow="0 0 12px rgba(255,61,154,0.7)"} Design
:::

:::Array{items.ref="#/state/design"}
::ev-session-row{props.time="${item.data.time}" props.title="${item.data.title}" props.track="${item.data.track}" props.speaker="${item.data.speaker}"}
:::
::::
:::::

:::ev-venue{props.image="/images/venue.jpg" props.imageAlt="The Foundry main hall in Portland" props.reverse="true"}

### The venue: The Foundry

A restored ironworks turned event hall in Portland's Central Eastside — high ceilings, fast Wi-Fi, and coffee that never runs out. Both stages, all workshop rooms, and the hallway track are steps apart under one roof.

Doors open at 8 AM sharp. Bring a laptop for the workshop track.
:::

::ev-cta{props.eyebrow="Don't miss it" props.heading="Your seat is waiting" props.text="Sessions fill on a first-come basis on the day. A ticket guarantees your spot in every track." props.cta="Get tickets" props.ctaHref="/tickets/"}
