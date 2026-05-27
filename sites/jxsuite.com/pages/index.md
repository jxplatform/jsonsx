---
title: "Jx Suite — The full-stack website framework. Open source. Zero lock-in."
$head:
  - tagName: meta
    attributes:
      name: description
      content: "A complete website framework: file-based CMS, reactive components, visual composer, and static site generator. MIT licensed. Deploy anywhere."
  - tagName: meta
    attributes:
      property: "og:title"
      content: "Jx Suite — The full-stack website framework."
  - tagName: meta
    attributes:
      property: "og:description"
      content: "File-based CMS. Reactive framework. Visual composer. Static generator. Open source. Zero lock-in."
  - tagName: meta
    attributes:
      property: "og:type"
      content: website
$elements:
  - "$ref": "../components/cta-button.json"
  - "$ref": "../components/feature-card.json"
  - "$ref": "../components/step-card.json"
  - "$ref": "../components/check-item.json"
  - "$ref": "../components/code-panel.json"
  - "$ref": "../components/stat-card.json"
  - "$ref": "../components/pillar-card.json"
  - "$ref": "../components/section-label.json"
---

::::::hero{style.padding="clamp(5rem, 12vw, 10rem) clamp(1rem, 3vw, 2rem) clamp(4rem, 8vw, 6rem)" style.textAlign="center" style.background="radial-gradient(ellipse 80% 50% at 50% -20%, rgba(59, 130, 246, 0.15), transparent)"}
:::::div{style.maxWidth="900px" style.margin="0 auto"}
:::div{style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.padding="0.375rem 0.875rem" style.borderRadius="999px" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-surface)" style.fontSize="0.8125rem" style.color="var(--color-text-secondary)" style.marginBottom="2rem"}
::span{style.width="6px" style.height="6px" style.borderRadius="50%" style.backgroundColor="#22c55e" style.display="inline-block"}

Open source · MIT License · Deploy anywhere
:::

:::h1{style.fontSize="clamp(2.5rem, 6vw, 4.5rem)" style.fontWeight="700" style.letterSpacing="-0.04em" style.lineHeight="1.05" style.margin="0 0 1.5rem" style.color="var(--color-text-primary)"}
Build any website.\
:span[Ship as static HTML.]{style.color="var(--color-accent)"}
:::

:::p{style.fontSize="clamp(1.0625rem, 2vw, 1.3125rem)" style.color="var(--color-text-secondary)" style.lineHeight="1.7" style.margin="0 auto 1rem" style.maxWidth="680px"}
Jx Suite is a complete website framework — file-based CMS, reactive components, visual composer, and static site generator — in one open-source toolkit.
:::

:::p{style.fontSize="1rem" style.color="var(--color-text-muted)" style.margin="0 auto 2.5rem" style.maxWidth="600px" style.fontFamily="var(--font-mono)" style.letterSpacing="0.02em"}
The freedom of hand-coded HTML. The speed of a visual builder. The power of a framework.
:::

:::div{style.display="flex" style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap" style.marginBottom="3rem"}
::cta-button{props.href="/docs/getting-started" props.label="Get Started" props.variant="primary"}

::cta-button{props.href="https://github.com/jxsuite/jx" props.label="View on GitHub" props.variant="secondary"}
:::

::::div{style.backgroundColor="var(--color-bg-surface)" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)" style.padding="0.75rem 1.25rem" style.fontFamily="var(--font-mono)" style.fontSize="0.875rem" style.color="var(--color-text-secondary)" style.display="inline-flex" style.alignItems="center" style.gap="0.75rem"}
:::span{style.color="var(--color-text-muted)"}
$
:::

bun create @jxsuite my-site
::::
:::::
::::::

::::::pillars{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="The Four Pillars"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
Everything a website needs. Nothing it doesn't.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="600px" style.margin="0 auto" style.fontSize="1.0625rem" style.lineHeight="1.7"}
Four integrated systems that replace the WordPress stack, the headless CMS, the build tool, and the page builder — with plain files in git.
:::
::::

:::div{style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" style.gap="1rem"}
::pillar-card{props.icon="📄" props.title="File-Based CMS" props.description="JSON documents and Markdown content. No database. No admin panel. Git is your CMS — branch, merge, review, deploy." props.features="Content collections · Markdown + directives · Frontmatter schemas · Dynamic routes"}

::pillar-card{props.icon="⚡" props.title="Reactive Framework" props.description="Signals-based reactivity, web components, and template bindings. Interactive islands hydrate only where needed." props.features="TC39 Signals · Web Components · Template literals · Zero JS by default"}

::pillar-card{props.icon="🎨" props.title="Visual Composer" props.description="Jx Studio — a visual IDE for designing, editing, and scripting websites. Every change saves to plain JSON files on disk." props.features="Design mode · Content editing · Script editor · Responsive preview"}

::pillar-card{props.icon="🚀" props.title="Static Generator" props.description="Compiles to pure HTML, CSS, and minimal JS. Deploy to any static host — Cloudflare Pages, GitHub Pages, Vercel, or a $5 VPS." props.features="Zero runtime · Image optimization · Code splitting · <100ms builds"}
:::
:::::
::::::

::::::comparison{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="The Landscape"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
The only tool that checks every box.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="560px" style.margin="0 auto" style.fontSize="1.0625rem"}
Every alternative solves one problem and creates another. Jx is the synthesis.
:::
::::

::::div{style.overflowX="auto" style.borderRadius="var(--radius-lg)" style.border="1px solid var(--color-border)"}

|                    | Visual Builder | Low Maintenance | Fast Output   | No Lock-in |
| ------------------ | -------------- | --------------- | ------------- | ---------- |
| WordPress          | ✓              | ✗ Heavy         | ✗ Patchy      | ✗ High     |
| Headless + Next.js | ✗ None         | ✗ Heavy         | ✓ Strong      | ~ Medium   |
| Astro / Hugo       | ✗ None         | ✓ Light         | ✓ Strong      | ✓ Open     |
| Webflow            | ✓ Yes          | ✓ Light         | ✓ Strong      | ✗ Total    |
| Wix / Squarespace  | ✓ Yes          | ✓ Light         | ✗ Slow        | ✗ Total    |
| **Jx Suite**       | **✓ Yes**      | **✓ Zero**      | **✓ Perfect** | **✓ MIT**  |

::::
:::::
::::::

::::::stats{style.padding="clamp(3rem, 6vw, 4rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::div{style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" style.gap="1rem"}
::stat-card{props.value="100" props.label="Lighthouse score out of the box"}

::stat-card{props.value="$0/yr" props.label="Maintenance cost — no plugins, no patches"}

::stat-card{props.value="MIT" props.label="Licensed forever — no vendor, no fees"}

::stat-card{props.value="<1s" props.label="Build time for a typical 50-page site"}
:::
:::::
::::::

::::::code-example{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="How It Works"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
JSON in, HTML out.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="560px" style.margin="0 auto" style.fontSize="1.0625rem"}
Write a JSON document — or design it visually in Studio. The compiler produces static HTML with zero JavaScript by default.
:::
::::

::::div{style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="1.5rem" style.--md.gridTemplateColumns="1fr"}
:::code-panel{props.filename="hero.json" props.badge="INPUT"}

```
{
  "tagName": "section",
  "style": {
    "padding": "4rem 2rem",
    "textAlign": "center"
  },
  "children": [
    {
      "tagName": "h1",
      "textContent": "Welcome to ${state.name}"
    },
    {
      "tagName": "p",
      "textContent": "${state.description}"
    }
  ]
}
```

:::

:::code-panel{props.filename="index.html" props.badge="OUTPUT"}

```
<section style="padding:4rem 2rem;
  text-align:center">
  <h1>Welcome to Acme Corp</h1>
  <p>We build things that matter.</p>
</section>

<!-- Zero JavaScript. Pure HTML + CSS.
     Deploys to any static host. -->
```

:::
::::
:::::
::::::

::::::workflow{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="Workflow"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
Three steps to production.
:::
::::

:::div{style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="2rem" style.--md.gridTemplateColumns="1fr"}
::step-card{props.number="1" props.title="Author" props.description="Design visually in Studio, write JSON by hand, or author content in Markdown. Every format is a plain file in git."}

::step-card{props.number="2" props.title="Commit" props.description="Push to your repository. CI builds static HTML in under a second. No origin server, no database migrations, no deploy scripts."}

::step-card{props.number="3" props.title="Live" props.description="Ship to Cloudflare Pages, GitHub Pages, Vercel, or any web server. Static files on a CDN — fast everywhere, costs pennies."}
:::
:::::
::::::

::::::bottom-cta{style.padding="clamp(5rem, 10vw, 8rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)" style.textAlign="center" style.background="radial-gradient(ellipse 60% 50% at 50% 100%, rgba(59, 130, 246, 0.1), transparent)"}
:::::div{style.maxWidth="640px" style.margin="0 auto"}
:::h2{style.fontSize="clamp(2rem, 4vw, 3rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1.5rem" style.lineHeight="1.1"}
The websites of 2030\
:span[are built in 2026.]{style.color="var(--color-accent)"}
:::

:::p{style.color="var(--color-text-secondary)" style.margin="0 0 2.5rem" style.fontSize="1.0625rem" style.lineHeight="1.7"}
Start building with Jx Suite. No accounts, no subscriptions, no vendor approval. Clone the repo and go.
:::

:::div{style.display="flex" style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap"}
::cta-button{props.href="/docs/getting-started" props.label="Get Started" props.variant="primary"}

::cta-button{props.href="/features" props.label="Explore Features" props.variant="secondary"}
:::
:::::
::::::
