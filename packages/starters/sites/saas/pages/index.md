---
title: "Flowlark — Plan, ship, and scale in one place"
state:
  testimonials:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: testimonials
    sort:
      field: order
      order: asc
    limit: 4
---

::sa-hero{props.eyebrow="✦ Now with automations & analytics" props.heading="The product platform for teams that ship." props.subheading="Flowlark brings planning, building, and shipping into one fast, delightful workspace — so your team spends less time on busywork and more time making things." props.cta="Get started free" props.ctaHref="/pricing/" props.cta2="See the features" props.cta2Href="/features/" props.note="Free forever plan · No credit card required" props.image="/images/hero.jpg" props.imageAlt="The Flowlark product dashboard showing projects, timelines, and analytics"}

::sa-logo-cloud{}

:::::section{style.padding="clamp(4rem, 8vw, 6rem) 1.5rem"}
::sa-section-header{props.eyebrow="Why Flowlark" props.heading="Everything your team needs, nothing it doesn’t" props.subheading="One workspace that replaces the tangle of trackers, docs, and spreadsheets your team juggles today."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="1fr"}
::sa-feature-card{props.icon="⚡" props.title="Ship faster" props.text="Plan work, track progress, and hand off cleanly — all in a workspace that keeps everyone in sync."}

::sa-feature-card{props.icon="🤖" props.title="Automate the busywork" props.text="Trigger updates, assignments, and reminders automatically. Set a rule once and let it run."}

::sa-feature-card{props.icon="📊" props.title="See what matters" props.text="Live dashboards turn your team’s activity into insight — no exports, no stale slides."}

::sa-feature-card{props.icon="🧩" props.title="Fits your stack" props.text="Connect the tools you already use. Flowlark plays nicely with the rest of your workflow."}

::sa-feature-card{props.icon="🔒" props.title="Secure by default" props.text="Encryption in transit and at rest, granular permissions, SSO, and audit logs when you need them."}

::sa-feature-card{props.icon="🌍" props.title="Built for teams" props.text="From two people to two thousand, Flowlark scales with you without slowing anyone down."}
::::
:::::

:::::section{style.padding="0 0 clamp(2rem, 5vw, 4rem)" style.backgroundColor="var(--color-bg-cream)"}
::::sa-feature-split{props.image="/images/feature-1.jpg" props.imageAlt="Team collaborating in the Flowlark workspace"}
:::div
::sa-section-header{props.eyebrow="Collaborate" props.heading="One workspace, every team" props.align="left"}

Bring product, design, and engineering into a shared space where plans, discussions, and decisions live side by side. No more digging through threads to find the latest.
:::

:::div{style.display="flex" style.flexDirection="column" style.gap="0.75rem" style.marginTop="1.5rem"}
::sa-check-item{props.text="Shared roadmaps and timelines"}

::sa-check-item{props.text="Comments and mentions in context"}

::sa-check-item{props.text="Real-time updates across the team"}
:::
::::

::::sa-feature-split{props.image="/images/feature-2.jpg" props.imageAlt="Analytics dashboard inside Flowlark" props.reverse="true"}
:::div
::sa-section-header{props.eyebrow="Measure" props.heading="Insight without the spreadsheet" props.align="left"}

Dashboards update themselves as your team works. Track velocity, spot bottlenecks, and share progress with a link instead of a status meeting.
:::

:::div{style.display="flex" style.flexDirection="column" style.gap="0.75rem" style.marginTop="1.5rem"}
::sa-check-item{props.text="Live velocity and cycle-time charts"}

::sa-check-item{props.text="Custom reports in a few clicks"}

::sa-check-item{props.text="Shareable, always-current links"}
:::
::::
:::::

:::::section{style.padding="clamp(4rem, 8vw, 6rem) 0"}
::sa-section-header{props.eyebrow="Pricing" props.heading="Simple pricing that scales with you" props.subheading="Start free, upgrade when you’re ready. Switch between monthly and annual any time."}

::sa-pricing{}
:::::

:::::section{style.padding="clamp(4rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::sa-section-header{props.eyebrow="Compare plans" props.heading="Every plan, side by side"}

::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.overflowX="auto" style.borderRadius="var(--radius)" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-white)"}

|                     | Starter   | Pro            | Scale             |
| ------------------- | --------- | -------------- | ----------------- |
| Projects            | 3         | Unlimited      | Unlimited         |
| Automations         | —         | ✓              | ✓                 |
| Analytics dashboard | —         | ✓              | ✓                 |
| SSO & SCIM          | —         | —              | ✓                 |
| Audit logs          | —         | —              | ✓                 |
| Support             | Community | Priority email | Dedicated manager |
| Uptime SLA          | —         | —              | 99.9%             |

::::
:::::

:::::section{style.padding="clamp(4rem, 8vw, 6rem) 1.5rem"}
::sa-section-header{props.eyebrow="Loved by teams" props.heading="Teams do their best work on Flowlark"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(2, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/testimonials"}
::sa-testimonial-card{props.quote="${item.data.quote}" props.author="${item.data.author}" props.company="${item.data.company}"}
:::
::::
:::::

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="1rem" style.--md.gridTemplateColumns="repeat(2, 1fr)"}
::sa-stat{props.value="12k+" props.label="Teams building on Flowlark"}

::sa-stat{props.value="40%" props.label="Less time spent on status updates"}

::sa-stat{props.value="99.9%" props.label="Uptime, backed by an SLA"}

::sa-stat{props.value="4.9/5" props.label="Average customer rating"}
::::
:::::

:::::section{style.padding="clamp(4rem, 8vw, 6rem) 1.5rem"}
::sa-section-header{props.eyebrow="FAQ" props.heading="Questions, answered" props.subheading="Everything you need to know before you get started."}

::sa-faq{}
:::::

::sa-cta{props.heading="Ready to give your team its time back?" props.text="Start free in minutes. No credit card, no sales call — just your team, shipping." props.cta="Get started free" props.ctaHref="/pricing/" props.cta2="Talk to sales" props.cta2Href="/contact/"}
