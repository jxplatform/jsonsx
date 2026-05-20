---
title: "Jx Suite — Design visually. Ship as static HTML."
$head:
  - tagName: meta
    attributes:
      name: description
      content: "An open-source visual IDE and declarative JSON framework for building fast, maintainable websites. Zero runtime by default."
  - tagName: meta
    attributes:
      property: "og:title"
      content: "Jx Suite — Design visually. Ship as static HTML."
  - tagName: meta
    attributes:
      property: "og:description"
      content: "An open-source visual IDE and declarative JSON framework for building fast, maintainable websites. Zero runtime by default."
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
---

::::::hero-section{style.padding="clamp(4rem, 10vw, 8rem) clamp(1rem, 3vw, 2rem) clamp(3rem, 6vw, 5rem)" style.textAlign="center" style.background="radial-gradient(ellipse 80% 50% at 50% -20%, rgba(59, 130, 246, 0.12), transparent)"}
:::::div{style.maxWidth="800px" style.margin="0 auto"}
:::div{style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.padding="0.375rem 0.875rem" style.borderRadius="999px" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-surface)" style.fontSize="0.8125rem" style.color="var(--color-text-secondary)" style.marginBottom="2rem"}
::span{style.width="6px" style.height="6px" style.borderRadius="50%" style.backgroundColor="#22c55e" style.display="inline-block"}

Open source · MIT License
:::

:::h1{style.fontSize="clamp(2.25rem, 5vw, 3.75rem)" style.fontWeight="700" style.letterSpacing="-0.035em" style.lineHeight="1.1" style.margin="0 0 1.5rem" style.color="var(--color-text-primary)"}
Design visually.\
:span[Ship as static HTML.]{style.color="var(--color-text-secondary)"}
:::

:::p{style.fontSize="clamp(1.0625rem, 2vw, 1.25rem)" style.color="var(--color-text-secondary)" style.lineHeight="1.7" style.margin="0 auto 2.5rem" style.maxWidth="600px"}
Jx Suite is an open-source visual IDE and declarative JSON framework for building fast, maintainable websites. Zero runtime by default. No lock-in.
:::

:::div{style.display="flex" style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap" style.marginBottom="3rem"}
::cta-button{props.href="/docs/getting-started" props.label="Get Started" props.variant="primary"}

::cta-button{props.href="https://github.com/jxsuite/jx" props.label="View on GitHub" props.variant="secondary"}
:::

::::div{style.backgroundColor="var(--color-bg-surface)" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)" style.padding="0.75rem 1.25rem" style.fontFamily="var(--font-mono)" style.fontSize="0.875rem" style.color="var(--color-text-secondary)" style.display="inline-flex" style.alignItems="center" style.gap="0.75rem"}
:::span{style.color="var(--color-text-muted)"}
$
:::

bun create jx-suite my-site
::::
:::::
::::::

:::::::product-showcase{style.padding="clamp(3rem, 6vw, 5rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
::::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::::div{style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="clamp(2rem, 4vw, 4rem)" style.alignItems="center" style.--md.gridTemplateColumns="1fr"}
::::div
:::div{style.fontSize="0.75rem" style.fontWeight="600" style.color="var(--color-accent)" style.textTransform="uppercase" style.letterSpacing="0.08em" style.fontFamily="var(--font-mono)" style.marginBottom="1rem"}
JX Studio
:::

:::h2{style.fontSize="clamp(1.5rem, 3vw, 2.25rem)" style.fontWeight="700" style.letterSpacing="-0.02em" style.lineHeight="1.2" style.margin="0 0 1rem"}
A visual IDE for the web
:::

:::p{style.color="var(--color-text-secondary)" style.fontSize="1.0625rem" style.lineHeight="1.7" style.margin="0 0 2rem"}
Design components on a canvas. Inspect and edit properties. See changes live. Everything saves to plain JSON files on disk — no database, no lock-in.
:::

:::div{style.display="flex" style.flexDirection="column" style.gap="0.75rem"}
::check-item{props.text="Visual canvas with drag-and-drop component editing"}

::check-item{props.text="Property inspector with live style editing"}

::check-item{props.text="Responsive breakpoint preview"}

::check-item{props.text="File-based — everything is JSON on disk"}
:::
::::

:::div{style.backgroundColor="var(--color-bg-secondary)" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius-lg)" style.aspectRatio="16/10" style.display="flex" style.alignItems="center" style.justifyContent="center" style.overflow="hidden"}
::img{style.objectFit="contain" src="/studio.png" width="100%" height="100%"}
:::
:::::
::::::
:::::::

:::::feature-grid-section{style.padding="clamp(3rem, 6vw, 5rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::h2{style.fontSize="clamp(1.5rem, 3vw, 2rem)" style.fontWeight="700" style.letterSpacing="-0.02em" style.margin="0 0 0.75rem" style.textAlign="center"}
Everything you need, nothing you don't
:::

:::p{style.color="var(--color-text-secondary)" style.textAlign="center" style.maxWidth="560px" style.margin="0 auto 3rem" style.fontSize="1.0625rem"}
A complete toolkit for building modern static websites — from visual design to production deploy.
:::

:::div{style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" style.gap="1px" style.backgroundColor="var(--color-border)" style.borderRadius="var(--radius-lg)" style.overflow="hidden" style.border="1px solid var(--color-border)"}
::feature-card{props.icon="{ }" props.iconBg="rgba(59, 130, 246, 0.1)" props.iconColor="var(--color-accent)" props.iconSize="0.75rem" props.title="Declarative JSON" props.description="Define UI, state, and behavior as structured JSON. No JSX, no templates, no build-step syntax."}

::feature-card{props.icon="0kb" props.iconBg="rgba(34, 197, 94, 0.1)" props.iconColor="#22c55e" props.title="Zero Runtime" props.description="Compiles to plain HTML and CSS. No JavaScript ships by default. Reactive islands hydrate only where needed."}

::feature-card{props.icon="IDE" props.iconBg="rgba(168, 85, 247, 0.1)" props.iconColor="#a855f7" props.title="Visual Studio" props.description="Design on a visual canvas. Inspect properties, edit styles, drag and drop — all in the browser."}

::feature-card{props.icon="</>" props.iconBg="rgba(251, 146, 60, 0.1)" props.iconColor="#fb923c" props.title="Web Components" props.description="Compile JSON to standard custom elements. Use them in any framework, static HTML, or standalone."}

::feature-card{props.icon="⚡" props.iconBg="rgba(234, 179, 8, 0.1)" props.iconColor="#eab308" props.iconSize="0.8125rem" props.title="Reactive Islands" props.description="Vue-powered reactivity ships only where you need it. Static by default, interactive on demand."}

::feature-card{props.icon="/·/" props.iconBg="rgba(14, 165, 233, 0.1)" props.iconColor="#0ea5e9" props.title="File-Based Routing" props.description="Drop a JSON file in pages/ and it becomes a route. Dynamic params, layouts, and content collections built in."}
:::
::::
:::::

::::::code-example{style.padding="clamp(3rem, 6vw, 5rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::h2{style.fontSize="clamp(1.5rem, 3vw, 2rem)" style.fontWeight="700" style.letterSpacing="-0.02em" style.margin="0 0 0.75rem" style.textAlign="center"}
JSON in, HTML out
:::

:::p{style.color="var(--color-text-secondary)" style.textAlign="center" style.maxWidth="560px" style.margin="0 auto 3rem" style.fontSize="1.0625rem"}
Write a JSON document. The compiler produces static HTML with zero JavaScript — or a reactive web component when you need interactivity.
:::

::::div{style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="1.5rem" style.--md.gridTemplateColumns="1fr"}
:::code-panel{props.filename="counter.json" props.badge="INPUT"}

```
{
  "tagName": "my-counter",
  "state": {
    "count": 0,
    "increment": {
      "$prototype": "Function",
      "body": "state.count++"
    }
  },
  "children": [
    { "tagName": "span", "textContent": "${state.count}" },
    { "tagName": "button", "textContent": "+" }
  ]
}
```

:::

:::code-panel{props.filename="index.html" props.badge="OUTPUT"}

```
<!-- Static output: zero JS -->
<my-counter>
  <span>0</span>
  <button>+</button>
</my-counter>

<!-- Reactive island: ~5kb hydration -->
<script type="module">
  import { MyCounter } from
    './counter.js'
</script>
```

:::
::::
:::::
::::::

:::::how-it-works{style.padding="clamp(3rem, 6vw, 5rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::h2{style.fontSize="clamp(1.5rem, 3vw, 2rem)" style.fontWeight="700" style.letterSpacing="-0.02em" style.margin="0 0 0.75rem" style.textAlign="center"}
How it works
:::

:::p{style.color="var(--color-text-secondary)" style.textAlign="center" style.maxWidth="480px" style.margin="0 auto 3rem" style.fontSize="1.0625rem"}
Three steps from JSON to production.
:::

:::div{style.display="grid" style.gridTemplateColumns="repeat(3, 1fr)" style.gap="2rem" style.--md.gridTemplateColumns="1fr"}
::step-card{props.number="1" props.title="Write JSON" props.description="Define components, pages, state, and behavior as structured JSON documents. Or design them visually in Studio."}

::step-card{props.number="2" props.title="Compile" props.description="The compiler produces static HTML and CSS with zero JavaScript by default. Reactive islands hydrate only where needed."}

::step-card{props.number="3" props.title="Deploy" props.description="Ship to any static host — Netlify, Vercel, Cloudflare Pages, or a plain web server. No server runtime required."}
:::
::::
:::::

:::::cta-banner{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)" style.textAlign="center" style.background="radial-gradient(ellipse 60% 50% at 50% 100%, rgba(59, 130, 246, 0.08), transparent)"}
::::div{style.maxWidth="560px" style.margin="0 auto"}
:::h2{style.fontSize="clamp(1.5rem, 3vw, 2.25rem)" style.fontWeight="700" style.letterSpacing="-0.02em" style.margin="0 0 1rem"}
Ready to build?
:::

:::p{style.color="var(--color-text-secondary)" style.margin="0 0 2rem" style.fontSize="1.0625rem" style.lineHeight="1.7"}
Start building your next site with Jx Suite. JSON in, HTML out. Zero lock-in.
:::

:::div{style.display="flex" style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap"}
::cta-button{props.href="/docs/getting-started" props.label="Get Started" props.variant="primary"}

::cta-button{props.href="/docs/spec" props.label="Read the Spec" props.variant="secondary"}
:::
::::
:::::
