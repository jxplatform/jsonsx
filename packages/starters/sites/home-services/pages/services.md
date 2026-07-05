---
title: "Services — Summit Heating & Cooling"
state:
  services:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: services
    sort:
      field: order
      order: asc
---

:::::section{style.position="relative" style.overflow="hidden" style.backgroundColor="var(--color-bg-dark)" style.color="var(--color-text-white)" style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem"}
::::div{style.position="absolute" style.top="0" style.left="0" style.right="0" style.height="6px" style.background="var(--hazard)"}
::::

::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.textAlign="center" style.position="relative"}
:::div{style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.fontFamily="var(--font-heading)" style.textTransform="uppercase" style.letterSpacing="0.14em" style.fontSize="0.82rem" style.fontWeight="600" style.color="var(--color-primary)" style.marginBottom="1rem"}
Heating · Cooling · Maintenance
:::

# Our HVAC services

:::div{style.fontSize="1.15rem" style.lineHeight="1.7" style.color="#cdd8e0" style.marginTop="1rem" style.maxWidth="52ch" style.marginLeft="auto" style.marginRight="auto"}
One local team for everything that keeps your home comfortable — repairs, replacements, and seasonal care, all at flat, upfront prices.
:::
::::
:::::

::hs-trust-bar

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/services"}
::hs-service-card{props.icon="${item.data.icon}" props.name="${item.data.name}" props.summary="${item.data.summary}" props.cta="Get a quote" props.href="/contact/"}
:::
::::
:::::

:::::section{style.padding="clamp(3.25rem, 7vw, 5rem) 1.5rem" style.backgroundColor="var(--color-bg-steel)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::div{style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.fontFamily="var(--font-heading)" style.textTransform="uppercase" style.letterSpacing="0.14em" style.fontSize="0.82rem" style.fontWeight="600" style.color="var(--color-primary)" style.marginBottom="2rem"}
Backed by the numbers
:::

:::div{style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="2rem" style.--md.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
::hs-stat{props.icon="🏔️" props.value="20+" props.label="Years in business"}

::hs-stat{props.icon="🔧" props.value="18,000+" props.label="Jobs completed"}

::hs-stat{props.icon="⚡" props.value="60 min" props.label="Average response time"}

::hs-stat{props.icon="🛡️" props.value="10-Yr" props.label="Parts & labor warranty"}
:::
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::hs-section-header{props.eyebrow="Not sure what you need?" props.heading="We'll help you figure it out"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="1fr"}
::hs-feature{props.icon="🔎" props.title="Free diagnostics" props.text="We find the root cause before recommending a repair or replacement."}

::hs-feature{props.icon="📋" props.title="Repair or replace?" props.text="Get an honest cost-benefit breakdown so you can make the right call."}

::hs-feature{props.icon="🏷️" props.title="Rebates & financing" props.text="We'll point you to available rebates and flexible payment options."}
::::
:::::

::hs-cta{props.eyebrow="No obligation" props.heading="Book service or get a quote" props.text="Same-day appointments across Northern Colorado, plus 24/7 emergency repair when the heat or AC goes out." props.cta="Get a Free Quote" props.ctaHref="/contact/" props.phone="(970) 555-0148" props.phoneHref="tel:+19705550148" props.bg="/images/cta-bg.jpg"}
