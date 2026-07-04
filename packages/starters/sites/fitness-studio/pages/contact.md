---
title: "Book a Class & Visit — Ember Yoga & Fitness"
---

:::::section{style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem" style.backgroundColor="var(--color-bg-cream)"}
::fs-section-header{props.eyebrow="Get started" props.heading="Book a class & say hello" props.subheading="Reserve your spot below, or drop by the studio on Willow Avenue. First class is always free."}
:::::

::::::section{style.maxWidth="var(--max-width)" style.margin="0 auto" style.padding="clamp(3rem, 6vw, 4.5rem) 1.5rem"}
:::::div{style.display="grid" style.gridTemplateColumns="1.2fr 1fr" style.gap="clamp(2rem, 5vw, 3.5rem)" style.--md.gridTemplateColumns="1fr"}

::::form{action="#" method="post" style.display="grid" style.gap="1rem" style.alignContent="start"}

### Reserve your spot

::input{type="text" name="name" placeholder="Your name" required="true" aria-label="Your name" style.width="100%" style.padding="0.75rem 0.9rem" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)" style.fontSize="1rem" style.fontFamily="inherit"}

::input{type="email" name="email" placeholder="Email address" required="true" aria-label="Email address" style.width="100%" style.padding="0.75rem 0.9rem" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)" style.fontSize="1rem" style.fontFamily="inherit"}

::input{type="text" name="class" placeholder="Which class? e.g. Vinyasa Flow" aria-label="Class you're interested in" style.width="100%" style.padding="0.75rem 0.9rem" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)" style.fontSize="1rem" style.fontFamily="inherit"}

::input{type="date" name="date" aria-label="Preferred date" style.width="100%" style.padding="0.75rem 0.9rem" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)" style.fontSize="1rem" style.fontFamily="inherit"}

::textarea{name="message" rows="4" placeholder="New to yoga? Any injuries or goals we should know about?" aria-label="Message" style.width="100%" style.padding="0.75rem 0.9rem" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)" style.fontSize="1rem" style.fontFamily="inherit"}

:::button{type="submit" style.backgroundColor="var(--color-primary)" style.color="var(--color-text-white)" style.padding="0.85rem 1.75rem" style.border="none" style.borderRadius="var(--radius)" style.fontSize="1rem" style.fontWeight="600" style.cursor="pointer" style.justifySelf="start"}
Request a spot
:::

:::p{style.fontSize="0.85rem" style.color="var(--color-text-muted)" style.margin="0.25rem 0 0"}
This is a demo form. Wire it to your booking provider or email in `pages/contact.md`.
:::

::::

::::div{style.display="grid" style.gap="1.5rem" style.alignContent="start"}
::fs-hours{props.heading="Studio Hours"}

:::div{style.padding="2rem" style.backgroundColor="var(--color-bg-cream)" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)"}

#### Find the studio

412 Willow Avenue

Bridgewater, CA 90210

Call or text us at [(555) 240-7788](tel:+15552407788)

:::
::::

:::::
::::::
