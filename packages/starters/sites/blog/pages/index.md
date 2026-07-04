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

::bl-masthead{props.eyebrow="Essays · Field notes · Since 2021" props.heading="The Long Field" props.subheading="Slow essays on design, technology, and the craft of making things well — written by hand, published most Sundays." props.cta="Read the latest" props.ctaHref="#latest" props.cta2="About the field" props.cta2Href="/about/" props.bg="/images/hero.jpg"}

::::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="1fr 1.4fr" style.gap="clamp(2rem, 5vw, 4rem)" style.alignItems="center" style.--md.gridTemplateColumns="1fr"}
::img{src="/images/author.jpg" alt="Marren Oda, writer and editor" loading="lazy" style.width="100%" style.height="auto" style.borderRadius="var(--radius)" style.boxShadow="0 12px 40px rgba(17,17,17,0.12)"}

::::div{style.fontSize="1.15rem" style.lineHeight="1.8"}

### A field to think out loud in

The Long Field is a one-person publication about design, technology, and the slow craft of making things well. No hot takes, no hustle — just field notes from the workbench, written when there's something worth saying.

I'm Marren, a writer and editor. I care about clear prose, quiet tools, and the kind of work that ages well. If that's your kind of thing, you're in the right place.

:::a{href="/about/" style.display="inline-block" style.marginTop="0.5rem" style.color="var(--color-primary)" style.fontWeight="600" style.textDecoration="none" style.fontSize="1.05rem"}
More about the field →
:::
::::
:::::
::::::

:::::section{id="latest" style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::bl-section-header{props.eyebrow="Latest writing" props.heading="Recent essays & field notes"}

::::bl-post-list
:::Array{items.ref="#/state/posts"}
::bl-post-card{props.title="${item.data.title}" props.excerpt="${item.data.excerpt}" props.date="${item.data.date}" props.tag="${item.data.tag}" props.cover="${item.data.cover}" props.href="/${item.id}/"}
:::
::::
:::::

:::::section{style.padding="0 1.5rem clamp(3.5rem, 8vw, 6rem)"}
::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto"}
::bl-newsletter-cta
::::
:::::
