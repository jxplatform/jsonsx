---
title: Jx Studio — the visual IDE for the web. Free & open source.
$head:
  - tagName: meta
    attributes:
      name: description
      content: Jx Studio is a free, open-source visual IDE for building real websites
        — design on a canvas, edit content, wire up logic, and commit to git.
        Every change saves as plain files you own forever.
  - tagName: meta
    attributes:
      property: og:title
      content: Jx Studio — the visual IDE for the web.
  - tagName: meta
    attributes:
      property: og:description
      content: Design, manage, and ship websites from one desktop app. Saves as plain
        JSON and Markdown. Open source. Zero lock-in.
  - tagName: meta
    attributes:
      property: og:type
      content: website
$elements:
  - $ref: ../components/cta-button.json
  - $ref: ../components/mode-card.json
  - $ref: ../components/step-card.json
  - $ref: ../components/check-item.json
  - $ref: ../components/stat-card.json
  - $ref: ../components/pillar-card.json
  - $ref: ../components/section-label.json
  - $ref: ../components/interactive-demo.json
---

:::::hero{style.padding="clamp(5rem, 12vw, 9rem) clamp(1rem, 3vw, 2rem) clamp(3rem, 6vw, 5rem)" style.textAlign="center" style.background="radial-gradient(ellipse 80% 50% at 50% -20%, rgba(59, 130, 246, 0.15), transparent)"}
::::div{style.maxWidth="960px" style.margin="0 auto"}
:::div{style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.padding="0.375rem 0.875rem" style.borderRadius="999px" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-surface)" style.fontSize="0.8125rem" style.color="var(--color-text-secondary)" style.marginBottom="2rem"}
::span{style.width="6px" style.height="6px" style.borderRadius="50%" style.backgroundColor="#22c55e" style.display="inline-block"}

Free · Open source · macOS, Windows & Linux
:::

:::h1{style.fontSize="clamp(2.5rem, 6vw, 4.5rem)" style.fontWeight="700" style.letterSpacing="-0.04em" style.lineHeight="1.05" style.margin="0 0 1.5rem" style.color="var(--color-text-primary)"}
Build websites visually.\
:span[Own every file.]{style.color="var(--color-accent)"}
:::

:::p{style.fontSize="clamp(1.0625rem, 2vw, 1.3125rem)" style.color="var(--color-text-secondary)" style.lineHeight="1.7" style.margin="0 auto 1rem" style.maxWidth="680px"}
Jx Studio is a desktop visual IDE for building real websites. Design on a canvas, edit content inline, wire up interactivity, and commit to git — without leaving the app. Every change saves as plain JSON and Markdown you keep forever.
:::

:::p{style.fontSize="1rem" style.color="var(--color-text-muted)" style.margin="0 auto 2.5rem" style.maxWidth="600px" style.fontFamily="var(--font-mono)" style.letterSpacing="0.02em"}
The feel of a visual builder. The power of a framework. The permanence of plain files.
:::

:::div{style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap" style.marginBottom="0.75rem"}
::cta-button{props.href="/download" props.label="Download Studio" props.variant="primary"}

::cta-button{props.href="/docs/start/first-project" props.label="Install via CLI" props.variant="secondary"}
:::

:::p{style.fontSize="0.8125rem" style.color="var(--color-text-muted)" style.margin="0 0 3rem"}
Free forever · macOS, Windows & Linux · or `bun create @jxsuite my-site`
:::

:::div{style.maxWidth="960px" style.margin="0 auto"}
::img{style.display="block" style.width="100%" style.height="auto" style.borderRadius="var(--radius-lg)" style.border="1px solid var(--color-border)" style.boxShadow="0 24px 64px rgba(0, 0, 0, 0.45)" src="/screenshots/hero.png" width="3840" height="2400" alt="Jx Studio editing a website — layers panel, live canvas, and element inspector" loading="eager" decoding="async"}
:::
::::
:::::

::::::studio-capabilities{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="What you do in Studio"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
One window. The whole website.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="600px" style.margin="0 auto" style.fontSize="1.0625rem" style.lineHeight="1.7"}
From the first file to the final commit — organize, write, design, and wire up interactivity, all on one canvas.
:::
::::

::::div{style.textAlign="center" style.marginTop="2.5rem"}
:::a{style.color="var(--color-accent)" style.textDecoration="none" style.fontWeight="600" style.fontSize="1rem" href="/studio"}
Take the full tour of Studio →
:::
::::
:::::
::::::

::::::files{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="clamp(3rem, 6vw, 5rem)" style.alignItems="center" style.--md.gridTemplateColumns="1fr"}
::::div
::section-label{props.text="No lock-in"}

:::h2{style.fontSize="clamp(1.5rem, 3vw, 2.25rem)" style.fontWeight="700" style.letterSpacing="-0.02em" style.lineHeight="1.2" style.margin="0 0 1rem"}
The visual builder that doesn't own your files.
:::

:::p{style.color="var(--color-text-secondary)" style.fontSize="1.0625rem" style.lineHeight="1.7" style.margin="0 0 2rem"}
Most visual builders trap your work in a proprietary format you can't read, can't version, and can't leave. Jx Studio reads and writes the same JSON and Markdown files you'd write by hand. Close the app — your site is still there, still readable, still yours.
:::

:::div{style.display="flex" style.flexDirection="column" style.gap="0.75rem"}
::check-item{props.text="Opens any Jx project from disk — no import step"}

::check-item{props.text="Saves standard JSON and Markdown — readable by any tool"}

::check-item{props.text="Works offline — no cloud, no account"}

::check-item{props.text="Git-friendly output — clean diffs, no binary blobs"}
:::
::::

::::div{style.display="flex" style.flexDirection="column" style.gap="1rem"}
:::div{style.padding="1.5rem" style.borderRadius="var(--radius)" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-surface)" style.fontFamily="var(--font-mono)" style.fontSize="0.8125rem" style.lineHeight="2" style.color="var(--color-text-secondary)"}
:span[Workflow]{style.display="block" style.fontSize="0.6875rem" style.letterSpacing="0.1em" style.textTransform="uppercase" style.color="var(--color-accent)" style.marginBottom="0.5rem"}
1\. Design in Studio\
2\. Commit & push from Studio's git panel\
3\. Your host builds on push\
4\. Live on a CDN in seconds
:::

:::div{style.padding="1.5rem" style.borderRadius="var(--radius)" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-surface)"}
:span[No servers required]{style.display="block" style.fontFamily="var(--font-mono)" style.fontSize="0.6875rem" style.letterSpacing="0.1em" style.textTransform="uppercase" style.color="var(--color-accent)" style.marginBottom="0.75rem"}
:span[No database. No PHP runtime. No origin server. Static HTML on a global CDN — fast everywhere, costs pennies, online forever.]{style.fontSize="0.9375rem" style.lineHeight="1.6" style.color="var(--color-text-secondary)"}
:::
::::
:::::
::::::

::::::comparison{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="The Landscape"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
The visual builder that hands you the files.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="560px" style.margin="0 auto" style.fontSize="1.0625rem"}
Webflow and Wix give you a canvas but keep your work. Astro and Hugo give you the files but no canvas. Jx gives you both.
:::
::::
:::::
::::::

:::::stats{style.padding="clamp(3rem, 6vw, 4rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::div{style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" style.gap="1rem"}
::stat-card{props.value="0kb" props.label="JavaScript on static pages by default"}

::stat-card{props.value="$0" props.label="License cost — MIT, no subscription"}

::stat-card{props.value="MIT" props.label="Yours to fork, self-host, and keep"}

::stat-card{props.value="JSON" props.label="Every page is a plain file you own"}
:::
::::
:::::

::::::under-the-hood{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="Under the hood · For developers"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
Studio is a window onto one idea: your site is JSON.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="620px" style.margin="0 auto" style.fontSize="1.0625rem" style.lineHeight="1.7"}
Everything you design compiles from — and saves back to — plain JSON-DOM. Read it, hand-edit it, diff it, or generate it with an LLM. Studio and the compiler are two views of the same files.
:::
::::

::interactive-demo

:::div{style.marginTop="3rem" style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" style.gap="1rem"}
::pillar-card{props.icon="📄" props.title="File-Based CMS" props.description="JSON documents and Markdown content. No database, no admin panel. Git is your CMS — branch, merge, review, deploy." props.features="Content collections · Markdown + directives · Frontmatter schemas · Dynamic routes"}

::pillar-card{props.icon="⚡" props.title="Reactive Framework" props.description="Fine-grained reactivity, web components, and template bindings. Interactive islands hydrate only where needed." props.features="Vue-powered reactivity · Web Components · Template literals · Zero JS by default"}

::pillar-card{props.icon="🚀" props.title="Static Generator" props.description="Compiles to pure HTML, CSS, and minimal JS. Deploy to any static host — Cloudflare Pages, GitHub Pages, Vercel, or a $5 VPS." props.features="Zero runtime · Image optimization · Static HTML output"}
:::

::::div{style.textAlign="center" style.marginTop="2.5rem" style.display="flex" style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap" style.alignItems="center" style.flexDirection="column"}
:::p{style.color="var(--color-text-muted)" style.fontSize="0.9375rem" style.margin="0" style.fontFamily="var(--font-mono)"}
Rather script than click? `bun create @jxsuite my-site`
:::

::cta-button{props.href="https://github.com/jxsuite/jx" props.label="View on GitHub" props.variant="secondary" props.newTab="true"}
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
::step-card{props.number="1" props.title="Author" props.description="Design visually in Studio, or hand-write JSON and Markdown. Every format is a plain file in git."}

::step-card{props.number="2" props.title="Commit & push" props.description="Commit and sync straight from Studio's git panel — or the CLI. No deploy scripts, no origin server."}

::step-card{props.number="3" props.title="Go live" props.description="Your host builds on push — Cloudflare, GitHub Pages, a Node or Bun adapter, or any static server. Live on a CDN in seconds."}
:::
:::::
::::::

:::::bottom-cta{style.padding="clamp(5rem, 10vw, 8rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)" style.textAlign="center" style.background="radial-gradient(ellipse 60% 50% at 50% 100%, rgba(59, 130, 246, 0.1), transparent)"}
::::div{style.maxWidth="640px" style.margin="0 auto"}
:::h2{style.fontSize="clamp(2rem, 4vw, 3rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1.5rem" style.lineHeight="1.1"}
The websites of 2030\
:span[are built in 2026.]{style.color="var(--color-accent)"}
:::

:::p{style.color="var(--color-text-secondary)" style.margin="0 0 2.5rem" style.fontSize="1.0625rem" style.lineHeight="1.7"}
No accounts, no subscriptions, no vendor approval. Download Studio, or clone the repo and go.
:::

:::div{style.display="flex" style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap"}
::cta-button{props.href="/download" props.label="Download Studio" props.variant="primary"}

::cta-button{props.href="/docs/start/first-project" props.label="Read the docs" props.variant="secondary"}
:::
::::
:::::
