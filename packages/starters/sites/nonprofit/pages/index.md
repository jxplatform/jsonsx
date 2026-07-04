---
title: "Rivertown Foundation — Neighbors helping neighbors"
state:
  programs:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: programs
    sort:
      field: order
      order: asc
    limit: 3
---

::np-hero{props.eyebrow="Rivertown · Est. 2007" props.heading="Together, we build a stronger Rivertown." props.subheading="We're a community nonprofit turning everyday generosity into food, mentorship, housing, and jobs for our neighbors — right here at home." props.cta="Donate Now" props.ctaHref="/get-involved/" props.cta2="See Our Programs" props.cta2Href="/programs/" props.bg="/images/hero.jpg"}

:::np-intro{props.image="/images/about.jpg" props.imageAlt="Rivertown Foundation volunteers gathered together"}

### Our mission

Rivertown Foundation exists to make sure no neighbor faces hard times alone. We connect local generosity to the people and programs that need it most — meeting immediate needs today while opening doors to a more stable tomorrow.

Every dollar, every hour, and every box of groceries stays right here in our community.
:::

:::::section{style.padding="clamp(3.5rem, 8vw, 5rem) 1.5rem" style.backgroundColor="var(--color-primary)" style.color="var(--color-text-white)"}
::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto 2.5rem" style.textAlign="center"}
:::p{style.textTransform="uppercase" style.letterSpacing="0.16em" style.fontSize="0.8rem" style.fontWeight="600" style.color="#bbf7d0" style.margin="0 0 0.75rem"}
Our impact in 2024
:::

:::h2{style.fontFamily="var(--font-heading)" style.fontSize="clamp(1.9rem, 4vw, 2.6rem)" style.fontWeight="700" style.lineHeight="1.15" style.margin="0"}
What we did together last year
:::
::::

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="2rem" style.--md.gridTemplateColumns="repeat(2, 1fr)"}
::np-stat{props.number="128k" props.label="Meals provided" props.note="Fresh groceries and hot meals for local families."}

::np-stat{props.number="640" props.label="Active volunteers" props.note="Neighbors giving their time every month."}

::np-stat{props.number="180" props.label="Households housed" props.note="Families kept in stable, safe homes."}

::np-stat{props.number="17" props.label="Years serving Rivertown" props.note="Rooted here since 2007."}
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::np-section-header{props.eyebrow="What we do" props.heading="Programs that meet real needs" props.subheading="Five community programs, one goal: helping every neighbor thrive."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/programs"}
::np-program-card{props.title="${item.data.title}" props.summary="${item.data.summary}" props.image="${item.data.image}"}
:::
::::

::::div{style.textAlign="center" style.marginTop="2.5rem"}
:::a{href="/programs/" style.display="inline-block" style.color="var(--color-primary)" style.fontWeight="700" style.textDecoration="none" style.fontSize="1.05rem"}
Explore all five programs →
:::
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::np-section-header{props.eyebrow="Get involved" props.heading="Three ways to make a difference"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="1fr"}
::np-step{props.num="♥" props.title="Give" props.text="A one-time or monthly gift puts groceries on tables and mentors in classrooms — 100% locally."}

::np-step{props.num="✋" props.title="Volunteer" props.text="Pack boxes, tutor a student, or tend the garden. Every skill and every hour helps."}

::np-step{props.num="📣" props.title="Spread the word" props.text="Share our work, host a drive, or bring your team for a day of service."}
::::

::::div{style.textAlign="center" style.marginTop="2.5rem"}
:::a{href="/get-involved/" style.display="inline-block" style.color="var(--color-primary)" style.fontWeight="700" style.textDecoration="none" style.fontSize="1.05rem"}
See all the ways to help →
:::
::::
:::::

:::::section{style.padding="clamp(1rem, 4vw, 2rem) 1.5rem clamp(3.5rem, 8vw, 6rem)"}
::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto"}
::np-testimonial{props.quote="When we lost my husband's job, the Food Pantry and Housing team caught us before we fell. A year later I'm the one volunteering. This is what community looks like." props.author="Marisol T." props.role="Neighbor & volunteer"}
::::
:::::

::np-cta{props.eyebrow="Your gift, doubled" props.heading="Every gift stays in Rivertown" props.text="A generous donor is matching all gifts this month, dollar for dollar. Give today and your impact goes twice as far." props.cta="Donate Now" props.ctaHref="/get-involved/" props.cta2="More Ways to Help" props.cta2Href="/get-involved/" props.bg="/images/cta-bg.jpg"}
