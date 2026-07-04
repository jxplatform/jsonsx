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

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::hs-section-header{props.eyebrow="Heating · Cooling · Maintenance" props.heading="Our HVAC services" props.subheading="One local team for everything that keeps your home comfortable — repairs, replacements, and seasonal care."}
:::::

::hs-trust-bar

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/services"}
::hs-service-card{props.icon="${item.data.icon}" props.name="${item.data.name}" props.summary="${item.data.summary}" props.cta="Get a quote" props.href="/contact/"}
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
