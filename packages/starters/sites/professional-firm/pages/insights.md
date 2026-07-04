---
title: "Insights — Meridian Advisory"
state:
  articles:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: insights
    sort:
      field: order
      order: asc
---

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::pf-section-header{props.eyebrow="Insights" props.heading="Practical guidance for owners and operators" props.subheading="Short, useful notes on tax, cash flow, and the financial decisions that shape a growing company."}
:::::

:::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="0 1.5rem" style.marginTop="clamp(2rem, 5vw, 3.5rem)"}
::img{src="/images/insight-cover.jpg" alt="Financial charts and reports on a desk" loading="lazy" style.width="100%" style.height="clamp(220px, 32vw, 380px)" style.objectFit="cover" style.borderRadius="var(--radius)" style.display="block"}
:::

:::::section{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::::div{style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/articles"}
::pf-insight-card{props.title="${item.data.title}" props.excerpt="${item.data.excerpt}" props.date="${item.data.date}" props.author="${item.data.author}" props.href="/insights/${item.id}/"}
:::
::::
:::::

::pf-cta{props.heading="Have a question these raised?" props.text="Every one of these notes started with a client conversation. Start yours with a free consultation." props.cta="Book a Consultation" props.ctaHref="/contact/"}
