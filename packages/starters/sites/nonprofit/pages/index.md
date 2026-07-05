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

::np-hero{props.eyebrow="Rivertown · Since 2007" props.heading="Together, we build a" props.headingAccent="warmer" props.headingTail=" Rivertown." props.subheading="We're a community foundation turning everyday generosity into food, mentorship, housing, and jobs for our neighbors — right here at home." props.cta="Donate" props.ctaHref="/get-involved/" props.cta2="See our programs" props.cta2Href="/programs/" props.badgeNumber="640" props.badgeLabel="neighbors volunteering this month" props.bg="/images/hero.jpg"}

:::::np-impact-band{props.eyebrow="Our impact in 2024" props.heading="What we did" props.headingAccent="together"}
::::div{style.display="grid" style.gridTemplateColumns="repeat(4, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="repeat(2, 1fr)"}
::np-stat{props.icon="🍎" props.number="128k" props.label="Meals provided" props.note="Fresh groceries and hot meals for local families."}

::np-stat{props.icon="🙌" props.number="640" props.label="Active volunteers" props.note="Neighbors giving their time every month."}

::np-stat{props.icon="🏠" props.number="180" props.label="Households housed" props.note="Families kept in stable, safe homes."}

::np-stat{props.icon="🌳" props.number="17" props.label="Years serving Rivertown" props.note="Rooted right here since 2007."}
::::
:::::

:::np-intro{props.eyebrow="Our mission" props.image="/images/about.jpg" props.imageAlt="Rivertown Foundation volunteers gathered together" props.signNumber="17" props.signLabel="years rooted in Rivertown"}

### No neighbor should face hard times alone.

Rivertown Foundation connects local generosity to the people and programs that need it most — meeting immediate needs today while opening doors to a more stable tomorrow.

Every dollar, every hour, and every box of groceries stays **right here in our community.**

:::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-mint)"}
::np-section-header{props.eyebrow="What we do" props.heading="Programs that meet" props.headingAccent="real needs" props.subheading="Five neighbor-powered programs, one goal: helping every family in Rivertown thrive."}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.75rem" style.--md.gridTemplateColumns="1fr"}
:::Array{items.ref="#/state/programs"}
::np-program-card{props.title="${item.data.title}" props.summary="${item.data.summary}" props.image="${item.data.image}" props.tag="Program" props.href="/programs/"}
:::
::::

::::div{style.textAlign="center" style.marginTop="2.75rem"}
:::a{href="/programs/" style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.backgroundColor="var(--color-bg-white)" style.border="1px solid var(--color-border-strong)" style.color="var(--color-primary-deep)" style.padding="0.9rem 1.9rem" style.borderRadius="999px" style.fontWeight="800" style.textDecoration="none" style.fontSize="1.02rem"}
Explore all five programs →
:::
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::np-section-header{props.eyebrow="Get involved" props.heading="Three ways to" props.headingAccent="make a difference"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.75rem" style.--md.gridTemplateColumns="1fr"}
::np-step{props.num="❤" props.title="Give" props.text="A one-time or monthly gift puts groceries on tables and mentors in classrooms — 100% locally." props.badgeBg="var(--color-accent-soft)" props.badgeColor="var(--color-accent)" props.href="/get-involved/" props.linkText="Donate now"}

::np-step{props.num="🙌" props.title="Volunteer" props.text="Pack boxes, tutor a student, or tend the garden. Every skill and every hour finds a home here." props.badgeBg="var(--color-primary-soft)" props.badgeColor="var(--color-primary)" props.href="/get-involved/" props.linkText="Find a role"}

::np-step{props.num="🤝" props.title="Partner" props.text="Businesses and faith groups: sponsor a program, host a drive, or open a hiring pipeline." props.badgeBg="var(--color-gold-soft)" props.badgeColor="#b07d1e" props.href="/get-involved/" props.linkText="Partner with us"}
::::
:::::

:::::section{style.padding="clamp(1rem, 4vw, 2rem) 1.5rem clamp(3.5rem, 8vw, 6rem)" style.backgroundColor="var(--color-bg-cream)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::np-testimonial{props.quote="When we lost my husband's job, the Food Pantry and Housing team caught us before we fell. A year later, I'm the one volunteering. This is what community looks like." props.author="Marisol T." props.role="Neighbor & volunteer" props.image="/images/cta-bg.jpg" props.imageAlt="Rivertown neighbors sharing a meal together" props.stat="400+" props.statLabel="families served every single week"}
::::
:::::

::np-cta{props.eyebrow="Your gift, doubled" props.heading="Every gift stays in" props.headingAccent="Rivertown" props.text="A generous donor is matching all gifts this month, dollar for dollar. Give today and your impact goes twice as far." props.cta="Donate Now" props.ctaHref="/get-involved/" props.cta2="More ways to help" props.cta2Href="/get-involved/"}
