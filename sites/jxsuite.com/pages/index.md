---
title: "Jx Suite — The JSON-Native Web Platform"
$head:
  - tagName: meta
    attributes:
      name: description
      content: "Jx is a visual builder, a file-based CMS, a reactive runtime, and a static site compiler — all operating on the same plain JSON files. MIT licensed. Deploy anywhere."
  - tagName: meta
    attributes:
      property: "og:title"
      content: "Jx Suite — The websites of 2030, built in 2026."
  - tagName: meta
    attributes:
      property: "og:description"
      content: "A visual builder, file-based CMS, reactive runtime, and static site compiler — all on plain JSON files."
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
:::div{style.display="inline-flex" style.alignItems="center" style.gap="0.5rem" style.padding="0.375rem 0.875rem" style.borderRadius="999px" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-surface)" style.fontSize="0.8125rem" style.color="var(--color-text-secondary)" style.marginBottom="2rem" style.fontFamily="var(--font-mono)" style.textTransform="uppercase" style.letterSpacing="0.05em"}
THE JSON-NATIVE WEB PLATFORM
:::

:::h1{style.fontSize="clamp(2.5rem, 6vw, 4.5rem)" style.fontWeight="700" style.letterSpacing="-0.04em" style.lineHeight="1.05" style.margin="0 0 1.5rem" style.color="var(--color-text-primary)"}
The websites of 2030,\
:span[built in 2026.]{style.color="var(--color-accent)"}
:::

:::p{style.fontSize="clamp(1.0625rem, 2vw, 1.3125rem)" style.color="var(--color-text-secondary)" style.lineHeight="1.7" style.margin="0 auto 2.5rem" style.maxWidth="700px"}
Jx is a visual builder, a file-based CMS, a reactive runtime, and a static site compiler — all operating on the same plain JSON files. Build anything the web can do. Ship it as static HTML. Edit it visually. Version it in git. Own it forever.
:::

:::div{style.display="flex" style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap" style.marginBottom="3rem"}
::cta-button{props.href="/studio" props.label="Try Jx Studio →" props.variant="primary"}

::cta-button{props.href="/docs/spec" props.label="Read the Spec" props.variant="secondary"}
:::

:::div{style.display="flex" style.gap="1.5rem" style.justifyContent="center" style.flexWrap="wrap" style.fontFamily="var(--font-mono)" style.fontSize="0.8125rem" style.color="var(--color-text-muted)" style.letterSpacing="0.02em"}
MIT licensed · Standards-driven · Deploy anywhere · ~10kB runtime
:::
:::::
::::::

::::::thesis{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="The Core Idea"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1.5rem"}
One file. Structure, style, behavior, content.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="680px" style.margin="0 auto" style.fontSize="1.0625rem" style.lineHeight="1.7"}
The web has three pillars — HTML, CSS, JavaScript — and the hardest part of building for it has always been the plumbing between them. Every framework since 1995 has been a strategy for closing that gap. Every visual builder has been a strategy for modeling that plumbing without inventing lock-in.
:::
::::

::::div{style.maxWidth="680px" style.margin="0 auto 2.5rem" style.textAlign="center"}
:::p{style.color="var(--color-text-primary)" style.fontSize="1.125rem" style.lineHeight="1.7" style.fontWeight="500"}
Jx closes the gap differently. The DOM already integrates structure, style, and behavior. We just made it the source format.
:::
::::

::::div{style.maxWidth="720px" style.margin="0 auto"}
:::code-panel{props.filename="my-counter.json" props.badge="SOURCE"}

```
{
  "tagName": "my-counter",
  "state": {
    "count": 0,
    "increment": { "$prototype": "Function", "body": "state.count++" }
  },
  "style": {
    "display": "flex",
    "gap": "1rem",
    ":hover": { "background": "var(--surface-hover)" }
  },
  "children": [
    { "tagName": "span", "textContent": "${state.count}" },
    { "tagName": "button", "textContent": "+", "onclick": { "$ref": "#/state/increment" } }
  ]
}
```

:::

:::p{style.textAlign="center" style.fontFamily="var(--font-mono)" style.fontSize="0.8125rem" style.color="var(--color-text-muted)" style.marginTop="1.5rem" style.lineHeight="1.6"}
This is the source. It's also what the visual builder edits. It's also what the static compiler reads. One artifact, every consumer.
:::
::::
:::::
::::::

::::::products{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="Four Tools, One Source of Truth"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
Four tools. One source of truth.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="600px" style.margin="0 auto" style.fontSize="1.0625rem" style.lineHeight="1.7"}
Most stacks are five products glued together. Jx is one model, expressed four ways.
:::
::::

:::div{style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" style.gap="1rem"}
::pillar-card{props.icon="🎨" props.title="Jx Studio" props.description="Design, edit, and ship from one canvas. Responsive design with real breakpoints. WYSIWYG markdown editing. Inline scripting. Schema-driven content forms. Component library management." props.features="Visual IDE · Adobe Spectrum · Desktop + browser · Component library"}

::pillar-card{props.icon="📄" props.title="File-Based CMS" props.description="Content collections live as Markdown, JSON, and CSV files on disk. Schema-validated. Queryable. Git-versioned. No backend to maintain, no admin panel to secure, no migration anxiety." props.features="Content collections · Schema validation · Git-versioned · No database"}

::pillar-card{props.icon="⚡" props.title="Reactive Runtime" props.description="Web Components for encapsulation. @vue/reactivity for signals (TC39-aligned). Template literals for dynamic content. CSS custom properties and nesting for theming. ~10kB production footprint." props.features="TC39 Signals · Web Components · Template literals · ~10kB"}

::pillar-card{props.icon="🚀" props.title="Static Compiler" props.description="Compile to plain HTML, CSS, and JS. Deploy to any CDN for pennies. File-based routing, content collections, image optimization, sitemap generation — out of the box." props.features="Zero runtime option · Image optimization · Sitemap · Deploy anywhere"}
:::
:::::
::::::

::::::agencies{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)" style.background="linear-gradient(180deg, var(--color-bg-primary) 0%, var(--color-bg-secondary) 100%)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.marginBottom="3rem"}
::section-label{props.text="For Agencies"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1.5rem"}
The WordPress replacement your developers will thank you for.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="680px" style.fontSize="1.0625rem" style.lineHeight="1.7"}
Stop maintaining plugin compatibility matrices. Stop fielding 2am breach alerts. Stop quoting custom development for "just one little interactive thing." Jx gives your team a visual builder with the unlimited ceiling of the web platform and the maintenance profile of a static site.
:::
::::

:::div{style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" style.gap="1.5rem" style.marginBottom="2.5rem"}
::feature-card{props.icon="⚡" props.iconBg="rgba(59, 130, 246, 0.1)" props.iconColor="var(--color-accent)" props.title="Faster builds" props.description="Component libraries become real assets. The hero block from one client is the starting point for the next."}

::feature-card{props.icon="💰" props.iconBg="rgba(34, 197, 94, 0.1)" props.iconColor="#22c55e" props.title="Recurring revenue without recurring work" props.description="Static hosting costs pennies. No CVE patching. Care plans become margin instead of overhead."}

::feature-card{props.icon="✓" props.iconBg="rgba(168, 85, 247, 0.1)" props.iconColor="#a855f7" props.title="Say yes to anything" props.description="Interactive calculators. Real-time forms. AI features. E-commerce. Dashboards. All in the visual canvas, all in plain JSON."}
:::

::cta-button{props.href="/agencies" props.label="See how agencies use Jx →" props.variant="secondary"}
:::::
::::::

::::::developers{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.marginBottom="3rem"}
::section-label{props.text="For Developers"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1.5rem"}
A schema, a runtime, and a compiler. No magic.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="680px" style.fontSize="1.0625rem" style.lineHeight="1.7"}
Jx is a JSON Schema 2020-12 dialect. Documents validate against standard tooling. The reactivity model is @vue/reactivity, converging on the TC39 signals proposal. The runtime is ~10kB, light DOM, with manual slot distribution for Web Components composition. Server functions are a clean RPC boundary — bundled per-adapter at build time.
:::
::::

::::div{style.overflowX="auto" style.borderRadius="var(--radius-lg)" style.border="1px solid var(--color-border)" style.marginBottom="2.5rem"}

| What you get    | How it works                                           |
| --------------- | ------------------------------------------------------ |
| Component model | Web Components with explicit `$props` at the boundary  |
| Reactivity      | Vue signals, TC39-aligned, no virtual DOM              |
| Templating      | Standard JS template literals (`${state.count}`)       |
| Styling         | CSS nesting + custom properties, scoped per element    |
| Routing         | File-based, URLPattern-compliant, dynamic via `$paths` |
| Content         | Schema-validated collections (MD / JSON / CSV)         |
| Server          | Opt-in `timing: "server"`, bundled to one worker       |
| Output          | Static HTML/CSS/JS, deployable to any CDN              |
| Escape hatch    | Drop to raw JS via `$src` whenever you need            |

::::

:::div{style.display="flex" style.gap="0.75rem" style.flexWrap="wrap"}
::cta-button{props.href="/docs/spec" props.label="Read the Spec →" props.variant="secondary"}

::cta-button{props.href="https://github.com/jxsuite/jx" props.label="Browse on GitHub →" props.variant="secondary"}
:::
:::::
::::::

::::::enthusiasts{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)" style.background="linear-gradient(180deg, var(--color-bg-primary) 0%, var(--color-bg-secondary) 100%)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.marginBottom="3rem"}
::section-label{props.text="For Web Platform Enthusiasts"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1.5rem"}
We're not inventing primitives. We're connecting the ones the browser already ships.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="680px" style.fontSize="1.0625rem" style.lineHeight="1.7"}
Five years ago, building Jx would have meant inventing half a dozen new primitives. Today, the platform ships every one of them. Web Components for encapsulation. CSS custom properties for theming. CSS nesting for locality. Template literals for interpolation. Signals as a TC39 proposal. Git for collaboration.
:::

:::p{style.color="var(--color-text-primary)" style.maxWidth="680px" style.fontSize="1.0625rem" style.lineHeight="1.7" style.fontWeight="500" style.marginTop="1.5rem"}
The realization that makes Jx possible: the DOM is the integrated runtime model of the web. Serialize it, and you have a source format that's native to the platform — no JSX, no SFCs, no proprietary IR. Just data that mirrors what the browser already understands.
:::
::::

:::div{style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" style.gap="1.5rem" style.marginBottom="2.5rem"}
::feature-card{props.icon="📐" props.iconBg="rgba(59, 130, 246, 0.1)" props.iconColor="var(--color-accent)" props.title="Standards-aligned by construction" props.description="JSON Schema 2020-12. JSON Pointer (RFC 6901). URLPattern. CSS @custom-media. Web Components v1. We extend known dialects; we don't invent new ones."}

::feature-card{props.icon="📝" props.iconBg="rgba(34, 197, 94, 0.1)" props.iconColor="#22c55e" props.title="Markdown as the content layer" props.description="The native language of AI agents. Human-readable. Lossless via remark directives. Your content is ready for answer engines, search engines, and human eyes."}

::feature-card{props.icon="🌐" props.iconBg="rgba(168, 85, 247, 0.1)" props.iconColor="#a855f7" props.title="No virtual DOM, no compiler magic" props.description="The runtime is the DOM. The reactivity is signals. The composition is slots. If you understand the browser, you understand Jx."}
:::

::cta-button{props.href="/blog/the-dom-was-always-the-answer" props.label="Read \"The DOM was always the answer\" →" props.variant="secondary"}
:::::
::::::

::::::project-structure{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.display="grid" style.gridTemplateColumns="1fr 1fr" style.gap="3rem" style.alignItems="center" style.--md.gridTemplateColumns="1fr"}

:::div
::section-label{props.text="Project Structure"}

:h2[A site is a directory.]{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1.5rem"}

:p[No database. No admin panel. No proprietary store. Your entire site is plain files in git — readable, diffable, version-controlled, deployable anywhere. Studio is a tool that operates on this directory. If you stopped using Studio tomorrow, your site is still here, still editable, still deployable.]{style.color="var(--color-text-secondary)" style.fontSize="1.0625rem" style.lineHeight="1.7"}
:::

:::code-panel{props.filename="my-site/" props.badge="FILE TREE"}

```
my-site/
├── project.json          # Site config
├── pages/                # File-based routes
│   ├── index.json
│   └── blog/[slug].json
├── components/           # Reusable Jx components
├── layouts/              # Page shells
├── content/              # Markdown / JSON / CSV
│   └── blog/*.md
├── public/               # Static assets
└── dist/                 # Build output
```

:::
::::
:::::
::::::

::::::stats{style.padding="clamp(3rem, 6vw, 4rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
:::div{style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" style.gap="1rem"}
::stat-card{props.value="~10kB" props.label="Runtime footprint in production"}

::stat-card{props.value="0" props.label="Databases to maintain"}

::stat-card{props.value="100" props.label="Typical Lighthouse score"}

::stat-card{props.value="MIT" props.label="Licensed forever"}

::stat-card{props.value="$0.02" props.label="Typical monthly hosting cost"}
:::
:::::
::::::

::::::comparison{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
::section-label{props.text="The Landscape"}

:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
How Jx compares.
:::

:::p{style.color="var(--color-text-secondary)" style.maxWidth="560px" style.margin="0 auto" style.fontSize="1.0625rem"}
The question in every visitor's head — answered directly.
:::
::::

::::div{style.overflowX="auto" style.borderRadius="var(--radius-lg)" style.border="1px solid var(--color-border)"}

|                    | Visual Builder | Maintenance | Performance | Lock-in  | Ceiling         |
| ------------------ | -------------- | ----------- | ----------- | -------- | --------------- |
| WordPress          | ✓              | Heavy       | Patchy      | High     | Plugin-limited  |
| Headless + Next.js | —              | Heavy       | Strong      | Medium   | Unlimited       |
| Astro              | —              | Light       | Strong      | Open     | Unlimited       |
| Webflow            | ✓              | Light       | Strong      | Total    | Webflow-limited |
| **Jx**             | **✓**          | **Light**   | **Strong**  | **Open** | **Unlimited**   |

::::
:::::
::::::

::::::showcase{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.textAlign="center"}
:::h2{style.fontSize="clamp(1.75rem, 4vw, 2.5rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1.5rem"}
Built with Jx.
:::

:::p{style.color="var(--color-text-muted)" style.fontSize="1.0625rem" style.lineHeight="1.7" style.maxWidth="480px" style.margin="0 auto 2rem" style.fontStyle="italic"}
The first Jx-built sites are launching this quarter. Want yours featured?
:::

::cta-button{props.href="/contact" props.label="Get in touch →" props.variant="secondary"}
:::::
::::::

::::::get-started{style.padding="clamp(5rem, 10vw, 8rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)" style.background="radial-gradient(ellipse 60% 50% at 50% 100%, rgba(59, 130, 246, 0.08), transparent)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto"}
::::div{style.textAlign="center" style.marginBottom="3rem"}
:::h2{style.fontSize="clamp(2rem, 4vw, 3rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
Three ways in.
:::
::::

:::div{style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" style.gap="1.5rem"}
::step-card{props.number="1" props.title="Try Studio in your browser" props.description="No install. Open Jx Studio, build a real component in five minutes, see what the JSON-DOM model feels like."}

::step-card{props.number="2" props.title="Spin up a project locally" props.description="Clone the repo, run bun install, then bun run dev. You'll be on localhost with the example gallery in under a minute."}

::step-card{props.number="3" props.title="Talk to us about an agency engagement" props.description="Pilot projects, team training, custom component libraries. White-glove support to fold Jx into your shop."}
:::

::::div{style.display="flex" style.gap="0.75rem" style.justifyContent="center" style.flexWrap="wrap" style.marginTop="3rem"}
::cta-button{props.href="/studio" props.label="Open Studio →" props.variant="primary"}

::cta-button{props.href="/docs/getting-started" props.label="Read the Quickstart →" props.variant="secondary"}

::cta-button{props.href="/contact" props.label="Book a Call →" props.variant="secondary"}
::::
:::::
::::::
