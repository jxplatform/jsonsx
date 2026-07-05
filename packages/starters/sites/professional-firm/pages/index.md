---
title: "Meridian Advisory — Tax, assurance & CFO counsel for growing companies"
state:
  latest:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: insights
    sort:
      field: order
      order: asc
    limit: 3
---

::pf-hero{props.eyebrow="Tax · Assurance · Advisory" props.marker="Est. 2007 · Harborview" props.heading="Financial clarity for companies built to last." props.lede="Meridian Advisory is a boutique CPA and advisory firm for founders and growing companies — disciplined books, a lower tax bill, and a partner in every consequential decision." props.aside="We read the whole picture — margins, runway, and the decision in front of you — before the deadline, not after." props.cta="Book a consultation" props.ctaHref="/contact/" props.cta2="Read the Quarterly" props.cta2Href="/insights/"}

::pf-statband{props.n1="18" props.l1="Years advising founders" props.n2="240+" props.l2="Companies served" props.n3="$40M" props.l3="Tax saved for clients" props.n4="96%" props.l4="Client retention"}

::pf-logo-bar{props.label="Trusted by founders, operators & boards"}

:::::section{style.padding="clamp(4rem, 8vw, 6rem) 1.5rem"}
::pf-section-header{props.eyebrow="Practice" props.index="Four disciplines" props.heading="Advisory across the full financial stack" props.subheading="Engage us for a single service or a fully outsourced finance function. Compliance handled, strategy included."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.borderBottom="1px solid var(--color-hairline)"}
::pf-service-row{props.number="01" props.tag="Tax" props.title="Tax planning & preparation" props.text="Year-round strategy and clean filings for the business and its owners — federal, state, and multi-entity, handled proactively." props.href="/services/"}

::pf-service-row{props.number="02" props.tag="Assurance" props.title="Audit & assurance" props.text="Reviews, compilations, and audit-readiness that satisfy lenders, investors, and regulators without the disruption." props.href="/services/"}

::pf-service-row{props.number="03" props.tag="Finance" props.title="Fractional CFO" props.text="Forecasting, cash management, and board-ready reporting — senior finance judgment, applied a few days a month." props.href="/services/"}

::pf-service-row{props.number="04" props.tag="Books" props.title="Bookkeeping & monthly close" props.text="Accurate, reconciled books and a five-day close, so your numbers are ready the moment a decision is." props.href="/services/"}
::::
:::::

::::section{style.backgroundColor="var(--color-bg-cream)" style.borderTop="1px solid var(--color-rule)" style.borderBottom="1px solid var(--color-rule)"}
:::pf-intro{props.image="/images/about.jpg" props.imageAlt="The Meridian Advisory team reviewing financials together" props.kicker="The practice"}

### We are not a once-a-year tax shop.

Meridian pairs disciplined accounting with genuine advisory — the kind of partner who knows your margins, your runway, and your goals, and who picks up the phone before the deadline.

The result is fewer surprises, a lower tax bill, and decisions made with real numbers instead of guesses.
:::
::::

:::::section{style.padding="clamp(4rem, 8vw, 6rem) 1.5rem"}
::pf-section-header{props.eyebrow="The Quarterly" props.index="Selected notes" props.heading="Guidance from our desk"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.borderBottom="1px solid var(--color-hairline)"}
:::Array{items.ref="#/state/latest"}
::pf-insight-row{props.number="0${item.data.order}" props.title="${item.data.title}" props.excerpt="${item.data.excerpt}" props.date="${item.data.date}" props.category="${item.data.category}" props.readingTime="${item.\_meta.readingTime}" props.href="/insights/${item.id}/"}
:::
::::

::::div{style.maxWidth="var(--max-width)" style.margin="2.25rem auto 0" style.textAlign="right"}
:::a{href="/insights/" style.fontFamily="var(--font-sans)" style.fontSize="0.75rem" style.fontWeight="600" style.textTransform="uppercase" style.letterSpacing="0.14em" style.color="var(--color-ink)" style.textDecoration="none" style.borderBottom="1px solid var(--color-accent)" style.paddingBottom="0.2rem"}
Read the full Quarterly →
:::
::::
:::::

::::::section{style.padding="clamp(4rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)" style.borderTop="1px solid var(--color-rule)"}
::pf-section-header{props.eyebrow="People" props.index="The partners" props.heading="Senior advisors, not a rotating cast"}

:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="clamp(1.5rem, 3vw, 2.5rem)" style.--lg.gridTemplateColumns="repeat(2, 1fr)" style.--sm.gridTemplateColumns="1fr"}
::pf-team-member{props.photo="/images/team-1.jpg" props.name="Dana Whitfield" props.role="Managing Partner, CPA" props.bio="Founded Meridian in 2007 after a decade in public accounting. Leads CFO engagements and complex tax strategy."}

::pf-team-member{props.photo="/images/team-2.jpg" props.name="Priya Nair" props.role="Partner, Tax" props.bio="Advises founders on entity structure, credits, and multi-state tax. Believes the best planning happens in November."}

::pf-team-member{props.photo="/images/team-3.jpg" props.name="Marcus Bell" props.role="Director, Advisory" props.bio="Runs forecasting and fundraising support for growth-stage clients. A former operator who has sat on your side of the table."}

::pf-team-member{props.photo="/images/team-4.jpg" props.name="Elena Sorokin" props.role="Manager, Assurance" props.bio="Leads reviews and audit-readiness work. Makes diligence painless for teams raising their next round."}
:::::
::::::

::pf-cta{props.eyebrow="Consultation" props.heading="Let's talk about your numbers" props.text="Book a free 30-minute consultation. We'll review where you are and where a sharper financial partner could take you." props.cta="Book a consultation" props.ctaHref="/contact/"}
