---
title: "The Quarterly — Meridian Advisory"
state:
  articles:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: insights
    sort:
      field: order
      order: asc
---

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)" style.borderBottom="1px solid var(--color-rule)"}
::pf-section-header{props.eyebrow="The Quarterly" props.index="Vol. XVIII · Winter 2025" props.heading="Practical guidance for owners and operators" props.subheading="Short, useful notes on tax, cash flow, and the financial decisions that shape a growing company — a running index, newest at the top."}
:::::

:::::section{style.padding="clamp(3.5rem, 7vw, 5.5rem) 1.5rem"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.borderBottom="1px solid var(--color-hairline)"}
:::Array{items.ref="#/state/articles"}
::pf-insight-row{props.number="0${item.data.order}" props.title="${item.data.title}" props.excerpt="${item.data.excerpt}" props.date="${item.data.date}" props.category="${item.data.category}" props.readingTime="${item.\_meta.readingTime}" props.href="/insights/${item.id}/"}
:::
::::
:::::

::pf-cta{props.eyebrow="Consultation" props.heading="Have a question these raised?" props.text="Every one of these notes started with a client conversation. Start yours with a free consultation." props.cta="Book a consultation" props.ctaHref="/contact/"}
