---
title: "Ember Yoga & Fitness — Boutique yoga, pilates & strength"
state:
  preview:
    $prototype: ContentCollection
    $src: "@jxsuite/parser/ContentCollection.class.json"
    contentType: classes
    sort:
      field: order
      order: asc
    limit: 3
---

::fs-hero{props.eyebrow="Bridgewater · Boutique Studio" props.heading="Move, breathe, belong." props.subheading="Yoga, pilates, HIIT, and strength — taught in small classes by coaches who learn your name. All levels, always welcome." props.cta="Book a Class" props.ctaHref="/contact/" props.cta2="View Classes" props.cta2Href="/classes/" props.bg="/images/hero.jpg"}

:::fs-intro{props.image="/images/about.jpg" props.imageAlt="Instructor guiding a student through a stretch"}

### A studio that meets you where you are

Ember is a small, light-filled studio built around one idea: everyone deserves to feel strong and at ease in their own body. Our classes cap at sixteen, so you get real attention and real progress.

Come for the yoga, stay for the community.
:::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::fs-section-header{props.eyebrow="Why Ember" props.heading="Practice that fits your life"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.25rem" style.--md.gridTemplateColumns="1fr"}
::fs-feature{props.icon="🧘" props.title="Small classes" props.text="Capped at sixteen, so every session is hands-on and adjustments are personal."}

::fs-feature{props.icon="🌱" props.title="All levels welcome" props.text="Never done yoga? Lifting for years? Every class offers a version that fits you."}

::fs-feature{props.icon="💗" props.title="Coaches who care" props.text="Certified instructors who remember your name, your goals, and your last class."}
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::fs-section-header{props.eyebrow="Find your practice" props.heading="Three ways to move"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--md.gridTemplateColumns="1fr"}
:::div
::img{src="/images/class-1.jpg" alt="A flowing yoga pose" loading="lazy" style.width="100%" style.aspectRatio="1 / 1" style.objectFit="cover" style.borderRadius="var(--radius)" style.display="block" style.marginBottom="0.9rem"}
**Yoga & Flow** — Vinyasa, power, and restorative practice to build heat and calm the mind.
:::

:::div
::img{src="/images/class-2.jpg" alt="A pilates class in session" loading="lazy" style.width="100%" style.aspectRatio="1 / 1" style.objectFit="cover" style.borderRadius="var(--radius)" style.display="block" style.marginBottom="0.9rem"}
**Pilates & Core** — Low-impact mat work that builds deep strength, posture, and control.
:::

:::div
::img{src="/images/class-3.jpg" alt="Strength training with free weights" loading="lazy" style.width="100%" style.aspectRatio="1 / 1" style.objectFit="cover" style.borderRadius="var(--radius)" style.display="block" style.marginBottom="0.9rem"}
**Strength & HIIT** — Coached lifting and interval training to build lean, functional power.
:::
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::fs-section-header{props.eyebrow="This week" props.heading="A few classes on the schedule"}

::::fs-class-grid
:::Array{items.ref="#/state/preview"}
::fs-class-card{props.name="${item.data.name}" props.level="${item.data.level}" props.time="${item.data.time}" props.instructor="${item.data.instructor}" props.focus="${item.data.focus}"}
:::
::::

::::div{style.textAlign="center" style.marginTop="2rem"}
:::a{href="/classes/" style.display="inline-block" style.color="var(--color-primary)" style.fontWeight="600" style.textDecoration="none" style.fontSize="1.05rem"}
See the full schedule →
:::
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::fs-section-header{props.eyebrow="Memberships" props.heading="Simple pricing, no lock-in"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="1.5rem" style.--lg.gridTemplateColumns="1fr"}
::fs-pricing-card{props.tier="Drop-in" props.price="$22" props.per="/ class" props.description="Perfect for trying us out or dropping by between trips." props.cta="Book a class" props.ctaHref="/contact/" props.perk1="Any single class" props.perk2="Mat & props included" props.perk3="No commitment"}

::fs-pricing-card{props.tier="Monthly Unlimited" props.price="$129" props.per="/ month" props.badge="Most popular" props.featured="true" props.description="Unlimited classes for people who want a real routine." props.cta="Start membership" props.ctaHref="/contact/" props.perk1="Unlimited classes" props.perk2="All class types" props.perk3="Free mat storage" props.perk4="10% off workshops" props.perk5="Freeze anytime"}

::fs-pricing-card{props.tier="Annual Unlimited" props.price="$1,290" props.per="/ year" props.description="Two months free plus perks for our most committed members." props.cta="Go annual" props.ctaHref="/contact/" props.perk1="Everything in Monthly" props.perk2="Two months free" props.perk3="4 guest passes a year" props.perk4="Priority booking" props.perk5="Free intro session"}
::::

::::div{style.textAlign="center" style.marginTop="2rem"}
:::a{href="/pricing/" style.display="inline-block" style.color="var(--color-primary)" style.fontWeight="600" style.textDecoration="none" style.fontSize="1.05rem"}
Compare all plans →
:::
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::fs-section-header{props.eyebrow="Meet the team" props.heading="Instructors who show up for you"}

::::div{style.maxWidth="var(--max-width-narrow)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="1.5rem" style.--sm.gridTemplateColumns="1fr"}
::fs-instructor-card{props.name="Maya Chen" props.specialty="Vinyasa & Restorative Yoga" props.image="/images/instructor-1.jpg" props.bio="Founder of Ember and a 500-hour certified teacher. Maya's classes are equal parts challenge and calm."}

::fs-instructor-card{props.name="Devon Hart" props.specialty="Power Yoga & Strength" props.image="/images/instructor-2.jpg" props.bio="A former collegiate athlete turned coach, Devon makes strength training approachable for absolutely everyone."}
::::
:::::

:::::section{style.padding="clamp(3.5rem, 8vw, 6rem) 1.5rem"}
::fs-section-header{props.eyebrow="Loved by members" props.heading="What our community says"}

::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="1.5rem" style.--md.gridTemplateColumns="1fr"}
::fs-review{props.quote="I walked in having never done yoga and left already booking my next class. The instructors actually watch you and help." props.author="Jordan M." props.role="Member since 2022"}

::fs-review{props.quote="The small classes make all the difference. It feels less like a gym and more like a group of friends who happen to work out." props.author="Aisha K." props.role="Unlimited member"}
::::
:::::

::fs-cta{props.heading="Your first class is on us" props.text="New to Ember? Book a free intro session and find the practice that fits you." props.cta="Book a Class" props.ctaHref="/contact/"}
