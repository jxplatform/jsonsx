---
title: "Starter templates for Jx Studio"
$head:
  - tagName: meta
    attributes:
      name: description
      content: "Start a new Jx project from a production-ready starter site: restaurants, shops, portfolios, SaaS landings, and more. Pick one in Studio's New Project dialog or clone it from the CLI."
  - tagName: meta
    attributes:
      property: "og:title"
      content: "Jx Studio starter templates"
  - tagName: meta
    attributes:
      property: "og:description"
      content: "Thirteen production-ready starter sites, in plain JSON and Markdown you own forever."
$elements:
  - "$ref": "../components/section-label.json"
  - "$ref": "../components/cta-button.json"
  - "$ref": "../components/starter-card.json"
---

::::::hero{style.padding="clamp(4.5rem, 10vw, 7rem) clamp(1rem, 3vw, 2rem) clamp(3rem, 6vw, 4rem)" style.textAlign="center" style.background="radial-gradient(ellipse 80% 50% at 50% -20%, rgba(59, 130, 246, 0.15), transparent)"}
:::::div{style.maxWidth="760px" style.margin="0 auto"}
::section-label{props.text="Starter templates"}

:::h1{style.fontSize="clamp(2.25rem, 5vw, 3.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.lineHeight="1.1" style.margin="0 0 1.25rem"}
Start from a template,\
:span[not a blank page.]{style.color="var(--color-accent)"}
:::

:::p{style.fontSize="clamp(1.0625rem, 2vw, 1.25rem)" style.color="var(--color-text-secondary)" style.lineHeight="1.7" style.margin="0 auto" style.maxWidth="620px"}
Thirteen production-ready sites across the industries people actually build for. Pick one in Studio's **New Project** dialog, or clone it from the CLI. Every template is plain JSON and Markdown, yours to keep and change forever.
:::
:::::
::::::

::::::gallery{style.padding="clamp(2rem, 5vw, 4rem) clamp(1rem, 3vw, 2rem) clamp(4rem, 8vw, 6rem)"}
:::::div{style.maxWidth="var(--max-width, 1200px)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(min(320px, 100%), 1fr))" style.gap="1.5rem"}
::starter-card{props.name="Bistro & Café" props.industry="Restaurant & Food" props.tagline="A menu-driven site for a restaurant, café, or bakery." props.image="/starters/restaurant.jpg" props.accent="#b45309" props.slug="restaurant"}

::starter-card{props.name="Summit Heating & Cooling" props.industry="Home Services & Trades" props.tagline="Reliable HVAC repair and installation, backed by 24/7 service." props.image="/starters/home-services.jpg" props.accent="#ea580c" props.slug="home-services"}

::starter-card{props.name="Meridian Advisory" props.industry="Professional Services" props.tagline="Numbers that move the business forward." props.image="/starters/professional-firm.jpg" props.accent="#1e3a8a" props.slug="professional-firm"}

::starter-card{props.name="Northshore Realty" props.industry="Real Estate" props.tagline="Find your place on the north shore." props.image="/starters/real-estate.jpg" props.accent="#0e7490" props.slug="real-estate"}

::starter-card{props.name="Cadence Cycles" props.industry="Retail & Shop" props.tagline="Find your next favorite ride." props.image="/starters/shop.jpg" props.accent="#16a34a" props.slug="shop"}

::starter-card{props.name="Aperture Studio" props.industry="Creative & Portfolio" props.tagline="Light, patience, and a good eye." props.image="/starters/portfolio.jpg" props.accent="#d97706" props.slug="portfolio"}

::starter-card{props.name="Ember Yoga & Fitness" props.industry="Health & Wellness" props.tagline="Boutique yoga, pilates & strength for every body." props.image="/starters/fitness-studio.jpg" props.accent="#db2777" props.slug="fitness-studio"}

::starter-card{props.name="Craft & Code Academy" props.industry="Education & Courses" props.tagline="Become a web developer in 14 weeks." props.image="/starters/course.jpg" props.accent="#2563eb" props.slug="course"}

::starter-card{props.name="Horizon Conf 2026" props.industry="Events & Conferences" props.tagline="A landing site for a one-day tech and design conference." props.image="/starters/event.jpg" props.accent="#7c3aed" props.slug="event"}

::starter-card{props.name="Rivertown Foundation" props.industry="Nonprofit & Community" props.tagline="Neighbors helping neighbors across Rivertown." props.image="/starters/nonprofit.jpg" props.accent="#15803d" props.slug="nonprofit"}

::starter-card{props.name="The Long Field" props.industry="Blog & Publication" props.tagline="Slow essays on design, technology, and craft." props.image="/starters/blog.jpg" props.accent="#0ea5e9" props.slug="blog"}

::starter-card{props.name="Flowlark" props.industry="SaaS & Product" props.tagline="Plan, ship, and scale in one place." props.image="/starters/saas.jpg" props.accent="#6366f1" props.slug="saas"}

::starter-card{props.name="Atrium" props.industry="Museum & Culture" props.tagline="A city museum in three languages, from one set of pages." props.image="/starters/museum.jpg" props.accent="#2438c8" props.slug="museum"}
:::::
::::::

::::::bottom-cta{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)" style.textAlign="center"}
:::::div{style.maxWidth="600px" style.margin="0 auto"}
:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
Open one in Studio and make it yours.
:::

:::p{style.color="var(--color-text-secondary)" style.margin="0 0 2rem" style.fontSize="1.0625rem" style.lineHeight="1.7"}
Choose a template in the New Project dialog, then design on the canvas, edit content, and commit to git, without leaving the app.
:::

:::div{style.display="flex" style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap"}
::cta-button{props.href="/download" props.label="Download Studio" props.variant="primary"}

::cta-button{props.href="/docs/start/first-project" props.label="Read the docs" props.variant="secondary"}
:::
:::::
::::::
