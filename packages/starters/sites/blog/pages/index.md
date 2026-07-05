---
title: "The Long Field — Essays on design, technology & craft"
state:
  posts:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: posts
    sort:
      field: order
      order: asc
---

::bl-masthead{props.edition="Field Notes · Vol. IV · Published most Sundays" props.heading="The Long Field" props.subheading="Slow essays on design, technology, and the craft of making things well — written by hand, one at a time." props.colophon="Est. 2021 · Set in Fraunces & Newsreader · Marren Oda, editor" props.cta="Read the latest" props.ctaHref="#latest"}

::::::div{style.backgroundColor="var(--color-ink)" style.color="var(--color-text-white)" style.padding="0.7rem 1.5rem" style.fontFamily="var(--font-body)" style.fontSize="0.74rem" style.fontWeight="500" style.textTransform="uppercase" style.letterSpacing="0.16em" style.textAlign="center" style.overflow="hidden" style.whiteSpace="nowrap" style.textOverflow="ellipsis"}
In this issue — Designing for slowness · The quiet craft of revision · Notes from a long walk · Tools that disappear · The city as a text
::::::

:::::section{id="latest" style.padding="clamp(3rem, 7vw, 5rem) 1.5rem"}
::bl-section-header{props.eyebrow="Six recent essays" props.heading="The Index" props.subheading="A running list of what's been written lately — newest thinking at the top."}

::::bl-post-list
:::Array{items.ref="#/state/posts"}
::bl-post-card{props.number="${item.data.order}" props.title="${item.data.title}" props.excerpt="${item.data.excerpt}" props.date="${item.data.date}" props.tag="${item.data.tag}" props.href="/${item.id}/"}
:::
::::
:::::

::::::section{style.padding="clamp(3rem, 7vw, 5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)" style.borderTop="1.5px solid var(--color-rule)" style.borderBottom="1.5px solid var(--color-rule)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="1.1fr 0.9fr" style.gap="clamp(2rem, 6vw, 5rem)" style.alignItems="center" style.--md.gridTemplateColumns="1fr"}
::::div
:::p{style.fontFamily="var(--font-heading)" style.fontStyle="italic" style.fontWeight="400" style.fontSize="clamp(1.6rem, 3.6vw, 2.6rem)" style.lineHeight="1.35" style.margin="0" style.color="var(--color-text-primary)"}
"No hot takes, no hustle — just field notes from the workbench, written when there's something worth saying."
:::
::::

::::div

### A field to think out loud in

The Long Field is a one-person publication about design, technology, and the slow craft of making things well. I'm Marren — a writer and editor who cares about clear prose, quiet tools, and work that ages well.

:::a{href="/about/" style.display="inline-block" style.marginTop="0.5rem" style.fontFamily="var(--font-body)" style.fontSize="0.78rem" style.fontWeight="600" style.textTransform="uppercase" style.letterSpacing="0.16em" style.color="var(--color-primary)" style.textDecoration="none" style.borderBottom="1px solid var(--color-primary)" style.paddingBottom="0.15rem"}
More about the field →
:::
::::
:::::
::::::

::bl-newsletter-cta{props.eyebrow="The Sunday Dispatch" props.heading="One essay, most Sundays." props.text="Field notes on design, technology, and craft — sent when there's something worth saying."}
